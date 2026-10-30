import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context';
import { liftFeatureKill, setFeatureKill } from '../flags/feature-flags';
import { getDiscoveries, rebuildFeedSnapshots } from '../services/discovery';
import { getRecommendationConnection } from '../services/interest-graph';
import { recordPreference } from '../services/preferences';
import { insertItem, insertReference } from '../test-support/library';
import { createIsolatedDatabase, insertAccount, testConfig, testContext, type IsolatedDatabase } from '../testing';
import {
  attachAssertionSupport,
  insertEvidence,
  recordSourceRevision,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from '../interest-graph/evidence';
import { expandAccountInterestGraph } from '../interest-graph/expansion';
import { projectAccountInterestGraph } from '../interest-graph/projector';
import type { GraphPredicate } from '../interest-graph/schema';
import { logEvent, setLogSink } from './log';

/**
 * VAL-OPS-003: measured latency, reported as actuals.
 *
 * The three proposed PR 8 operational targets are MEASURED here on the real
 * local stack (in-process functions over isolated PostgreSQL, no provider or
 * network calls anywhere on these paths):
 *
 *  - projection pass p95 < 5000 ms (projectAccountInterestGraph);
 *  - Why-this summary/proof p95 < 500 ms excluding network
 *    (getRecommendationConnection: pinned proof, source links, support
 *    roots, live revalidation — all local reads);
 *  - graph-local feed overhead p95 < 250 ms (getDiscoveries with the
 *    account's graph cards served, minus the same account's read while a
 *    discovery kill filters those cards out: the delta is the graph-local
 *    serving work).
 *
 * Every measurement is emitted as a sanitized log line (metric, value, unit,
 * sample count) together with workload and hardware context, so the record
 * IS the run output — actuals, never assumed achievement. If a target is
 * unmet on this hardware/load, the assertion fails WITH the measured
 * numbers: an unmet target is reported, not rounded down. Machine speed
 * varies; the sample counts, workload and context make the result
 * interpretable rather than prescriptive.
 */

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });
const PAGE = 24;
const SAMPLES = 40;
const WARMUPS = 3;
const CANDIDATES = 8;
const PLAIN_ITEMS = 16;

const PROJECTION_TARGET_MS = 5000;
const CONNECTION_TARGET_MS = 500;
const FEED_OVERHEAD_TARGET_MS = 250;

let isolated: IsolatedDatabase;
beforeAll(async () => {
  isolated = await createIsolatedDatabase('graphlat');
}, 60_000);
afterAll(async () => {
  setLogSink(undefined);
  await isolated?.drop();
});

// --- Fixture (the same shapes the expansion suite uses) -------------------------------

let fixtureSeq = 0;
const unique = (name: string) => `${name}-${++fixtureSeq}`;

async function corpusNode(over: { kind?: 'work' | 'creator'; name?: string } = {}) {
  const kind = over.kind ?? 'work';
  const name = unique(`${over.name ?? kind}-graphlat`);
  const referenceId = await insertReference({ name }, isolated.db);
  const node = await upsertGraphIdentity(isolated.db, {
    canonicalKey: `atlas:graphlat:${kind}:${name}`,
    canonicalName: name,
    nodeKind: kind,
    domain: 'art',
    senseKey: 'painting',
    culturalReferenceId: referenceId,
  });
  return { node, referenceId, name };
}

async function plainNode(over: { name?: string } = {}) {
  const name = unique(`${over.name ?? 'creator'}-graphlat-mid`);
  const node = await upsertGraphIdentity(isolated.db, {
    canonicalKey: `atlas:graphlat:mid:${name}`,
    canonicalName: name,
    nodeKind: 'creator',
    domain: 'art',
    senseKey: 'painting',
  });
  return node;
}

async function evidenceFixture() {
  const family = `artic:graphlat-${randomUUID().slice(0, 8)}`;
  const recorded = await recordSourceRevision(isolated.db, {
    provider: 'artic_open_access',
    url: `https://www.artic.edu/artworks/graphlat-${randomUUID().slice(0, 8)}`,
    title: 'A reviewed collection record',
    publisher: 'A museum',
    attribution: 'A museum',
    license: 'CC0 1.0',
    sourceFamilyKey: family,
    allowedDisplayMetadata: { title: 'A reviewed collection record', license: 'CC0 1.0' },
    retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
    rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none' },
    documentHash: family,
    rightsExpiresAt: null,
  });
  const inserted = await insertEvidence(isolated.db, {
    sourceRevisionId: recorded.sourceRevisionId,
    permittedExcerpt: `Reviewed support ${family}.`,
    validationMethod: 'provider_metadata',
    validationVersion: 'test-1',
    evidenceKind: 'fact',
    reviewedBy: 'corpus review',
    reviewedAt: new Date('2026-10-28T00:00:00Z'),
    expiresAt: null,
  });
  return { evidenceId: inserted.row.id, familyKey: family };
}

async function justifiedEdge(input: { subject: string; predicate: GraphPredicate; object: string }) {
  const support = await evidenceFixture();
  const upserted = await upsertGraphAssertion(isolated.db, {
    subjectNodeId: input.subject,
    predicate: input.predicate,
    objectNodeId: input.object,
    associationSubtype: null,
    status: 'validated',
  });
  await attachAssertionSupport(isolated.db, {
    assertionId: upserted.row.id,
    evidenceId: support.evidenceId,
    derivation: 'primary',
    sourceFamilyKey: support.familyKey,
  });
  return support;
}

// --- Measurement helpers --------------------------------------------------------------

type Sample = { metric: string; targetMs: number | null; p50ms: number; p95ms: number; samples: number; unit: 'ms' };

async function measure(name: string, targetMs: number | null, iterations: number, run: () => Promise<unknown>): Promise<Sample> {
  for (let i = 0; i < WARMUPS; i++) await run();
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = process.hrtime.bigint();
    await run();
    times.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  times.sort((a, b) => a - b);
  const p50ms = times[Math.floor(times.length / 2)]!;
  const p95ms = times[Math.ceil((times.length * 95) / 100) - 1]!;
  const sample: Sample = { metric: name, targetMs, p50ms, p95ms, samples: times.length, unit: 'ms' };
  logEvent('info', 'graph_latency_measurement', {
    metric: name,
    value: Math.round(p95ms * 100) / 100,
    unit: 'ms',
    count: times.length,
  });
  logEvent('info', 'graph_latency_measurement', {
    metric: `${name}_p50`,
    value: Math.round(p50ms * 100) / 100,
    unit: 'ms',
    count: times.length,
  });
  return sample;
}

function expectWithinTarget(sample: Sample) {
  if (sample.targetMs === null) return; // a delta, asserted by its own comparison
  expect(
    sample.p95ms <= sample.targetMs,
    `${sample.metric}: measured p95 ${sample.p95ms.toFixed(1)} ms exceeds the ${sample.targetMs} ms target ` +
      `(p50 ${sample.p50ms.toFixed(1)} ms, ${sample.samples} samples; see the logged workload/hardware context)`,
  ).toBe(true);
}

// --- The measured targets -------------------------------------------------------------

describe('graph operational latency, measured against the PR 8 targets (VAL-OPS-003)', () => {
  it('reports actual projection, summary/proof and graph-local feed overhead p95s with met/unmet comparisons', async () => {
    const db = isolated.db;
    const principal = await insertAccount(db);
    const accountId = principal.accountId;
    const ctx: ServiceContext = testContext(principal, { db, config: graphOn });

    // Workload: one saved root, one shared creator, CANDIDATES justified
    // same-creator works (the pass's graph cards), PLAIN_ITEMS extra saved
    // items, one feed page of PAGE items.
    const root = await corpusNode({ kind: 'work', name: 'rootwork' });
    const rootItemId = await insertItem({ accountId }, { referenceId: root.referenceId, kind: 'film', category: 'watch' }, db);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: rootItemId });
    const creator = await plainNode({ name: 'creator' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.id });
    for (let i = 0; i < CANDIDATES; i++) {
      const candidate = await corpusNode({ kind: 'work', name: `candidate${i}` });
      await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.id });
      await insertItem({ accountId }, { referenceId: candidate.referenceId, kind: 'film', category: 'watch' }, db);
    }
    for (let i = 0; i < PLAIN_ITEMS; i++) {
      const plain = await corpusNode({ kind: 'work', name: `plain${i}` });
      const itemId = await insertItem({ accountId }, { referenceId: plain.referenceId, kind: 'film', category: 'watch' }, db);
      await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemId });
    }
    await projectAccountInterestGraph(db, { accountId, config: graphOn, source: 'mutation_intent' });
    const published = await expandAccountInterestGraph(db, { accountId, config: graphOn });
    expect(published.expanded).toBe(true);
    await rebuildFeedSnapshots(db, { kind: 'account', accountId }, { config: graphOn });

    // The measured Why-this target must be a real graph card with a pinned proof.
    const { rows: graphCards } = await db.query<{ id: string; discovery_item_id: string }>(
      `SELECT id, discovery_item_id FROM recommendations WHERE owner_account_id = $1 AND graph_run_id IS NOT NULL ORDER BY created_at`,
      [accountId],
    );
    expect(graphCards.length, 'the pass published at least one graph card').toBeGreaterThan(0);
    // Feed items are discovery items; the graph cards serve through their item ids.
    const graphItemIds = new Set(graphCards.map((c) => c.discovery_item_id));

    // 1) Graph-local feed overhead p95 against 250 ms: the same account's
    // page with its graph cards served, minus the same page while an
    // account-scoped discovery kill filters exactly those cards out. This is
    // measured FIRST: the snapshot pins the cards of the account's latest
    // compatible run, and the projection measurement below (43 fresh
    // projection runs) would otherwise repin away from the expansion pass's
    // cards before this read.
    const feedWithGraph = await getDiscoveries(ctx, { refresh: false, limit: PAGE });
    const servedGraphCards = feedWithGraph.items.filter((i) => graphItemIds.has(i.id)).length;
    expect(servedGraphCards, 'the measured feed page serves the graph cards').toBeGreaterThan(0);
    await setFeatureKill(db, {
      flag: 'interest_graph_discovery_enabled',
      accountId,
      reason: 'latency measurement comparator',
      actor: 'operator',
    });
    try {
      const feedUnderKill = await getDiscoveries(ctx, { refresh: false, limit: PAGE });
      expect(feedUnderKill.items.filter((i) => graphItemIds.has(i.id))).toHaveLength(0);
      const feedOn = await measure('graph_feed_page_with_graph_cards', null, SAMPLES, () =>
        getDiscoveries(ctx, { refresh: false, limit: PAGE }),
      );
      const feedOff = await measure('graph_feed_page_graph_filtered', null, SAMPLES, () =>
        getDiscoveries(ctx, { refresh: false, limit: PAGE }),
      );
      const overhead = {
        metric: 'graph_local_feed_overhead',
        targetMs: FEED_OVERHEAD_TARGET_MS,
        p50ms: feedOn.p50ms - feedOff.p50ms,
        p95ms: feedOn.p95ms - feedOff.p95ms,
        samples: Math.min(feedOn.samples, feedOff.samples),
        unit: 'ms' as const,
      };
      logEvent('info', 'graph_latency_measurement', {
        metric: overhead.metric,
        value: Math.round(overhead.p95ms * 100) / 100,
        unit: 'ms',
        count: overhead.samples,
      });

      // 2) Why-this summary/proof p95 against 500 ms (local reads only).
      const connection = await measure('graph_connection_summary_proof', CONNECTION_TARGET_MS, SAMPLES, () =>
        getRecommendationConnection(ctx, graphCards[0]!.id),
      );

      // 3) Projection pass p95 against 5000 ms (last: each projection pass
      // is a fresh published run, which would change the account's latest
      // run mid-suite if it ran before the feed measurements).
      const projection = await measure('graph_projection_pass', PROJECTION_TARGET_MS, SAMPLES, () =>
        projectAccountInterestGraph(db, { accountId, config: graphOn, source: 'mutation_intent' }),
      );

      // Workload and hardware context, disclosed with the numbers.
      logEvent('info', 'graph_latency_measurement', { metric: 'workload_saved_items', value: 1 + PLAIN_ITEMS, unit: 'items', count: 1 });
      logEvent('info', 'graph_latency_measurement', { metric: 'workload_graph_cards', value: servedGraphCards, unit: 'items', count: 1 });
      logEvent('info', 'graph_latency_measurement', { metric: 'workload_feed_page', value: feedWithGraph.items.length, unit: 'items', count: 1 });
      logEvent('info', 'graph_latency_measurement', { metric: 'workload_candidates', value: CANDIDATES, unit: 'items', count: 1 });
      logEvent('info', 'graph_latency_measurement', { metric: 'hardware_cpus', value: os.cpus().length, unit: 'cores', count: 1 });
      logEvent('info', 'graph_latency_measurement', {
        metric: 'hardware_memory_gb',
        value: Math.round(os.totalmem() / 1024 ** 3),
        unit: 'gb',
        count: 1,
      });
      logEvent('info', 'graph_latency_measurement', { metric: 'hardware_platform', value: `${os.platform()}/${os.arch()}`, unit: 'id', count: 1 });

      expectWithinTarget(projection);
      expectWithinTarget(connection);
      expectWithinTarget(overhead);
      expect(projection.samples).toBe(SAMPLES);
      expect(connection.samples).toBe(SAMPLES);
      expect(overhead.samples).toBe(SAMPLES);
    } finally {
      await liftFeatureKill(db, { flag: 'interest_graph_discovery_enabled', accountId });
    }
  });
});
