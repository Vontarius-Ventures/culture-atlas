import { randomUUID } from 'node:crypto';
import { FakeQloo } from '@culture-atlas/providers/testing';
import type { QlooEntity } from '@culture-atlas/providers';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context';
import type { PoolDb } from '../db/pool';
import { GRAPH_PATH_GRAMMAR_VERSION } from './assertion-policy';
import { upsertReference } from '../compiler/store';
import { addCollectionItem, createCollection } from '../services/collections';
import { getJob } from '../services/jobs';
import { getItem, startRelatedDiscovery } from '../services/items';
import { recordPreference } from '../services/preferences';
import { insertItem, runJob } from '../test-support/library';
import { createIsolatedDatabase, insertAccount, insertAgentConnection, testConfig, testContext, testProviders } from '../testing';
import { admitGraphCorpus } from './corpus';
import { getCorpusManifestFile } from './corpus-manifest';
import { linkGraphReferenceIdentities } from './identity-links';
import { discoveryGrantAuthorityForJob } from './scoped-discovery';
import { runScopedGraphDiscovery } from './scoped-discovery-graph';
import { retractGraphEvidence } from './validity';

/**
 * The approved grant-scoped Discover more graph branch (VAL-DISC-008):
 * with graph discovery enabled, the existing selected-collection REST
 * POST /v1/items/{id}/discoveries / MCP discover_related operation — under its
 * existing collections:read grant — reaches a rights-cleared reviewed
 * cultural path and attaches at least one admitted result to the SCOPED
 * discovery parent, with zero live-model/paid-research/provider calls.
 *
 * Only the origin's own qualified identities and reviewed shared evidence
 * participate: no global taste, no other collection's roots, no legacy
 * account-feed fallback ever fills a scoped graph result. The immutable
 * migration-360 authority is only read (retry/dedupe retain the pinned
 * epoch), and no account-wide graph state (runs, frontier, interest edges,
 * feed snapshots) or implicit save is ever written. Graph-off keeps the
 * unchanged legacy provider behavior. Everything runs against the real
 * committed pilot manifest on isolated databases.
 */

const graphOn = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});
const graphOff = testConfig();

/** Verified live Qloo entity ids (see the manifest provenance). */
const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
/** One of FIVE same-named "Vincent van Gogh" persons Qloo returned: no mapping ships. */
const UNMAPPED_VANGOGH_QLOO_ID = 'FF1DECE6-AB12-47A4-AE63-55ABFA4DA279';

const AIC_KEY = 'atlas:place:art-institute-of-chicago';
const RODIN_KEY = 'atlas:creator:auguste-rodin';
const SEURAT_KEY = 'atlas:creator:georges-seurat';

/** A fake Qloo that RECORDS every call and fails closed on each one. */
function noCallQloo(): FakeQloo {
  return new FakeQloo({}, { live: true });
}

const e = (id: string, name: string): QlooEntity => ({ entity_id: id, name, types: [], properties: {}, tags: [] });

/** A fake Qloo that answers insights with unrelated entities (legacy control). */
function insightsQloo(prefix: string): FakeQloo {
  return new FakeQloo(
    {
      insights: () => ({
        entities: Array.from({ length: 4 }, (_, i) => e(`${prefix}-${i}`, `${prefix} entity ${i}`)),
        tags: [],
      }),
    },
    { live: true },
  );
}

async function qlooPersonReference(db: PoolDb, qlooId: string, name: string): Promise<string> {
  return upsertReference(db, {
    canonicalKey: `qloo:${qlooId}`,
    name,
    type: 'creator',
    externalIds: { qloo: qlooId, qloo_types: ['urn:entity:person'] },
  });
}

async function corpusAssertion(db: PoolDb, subjectKey: string, predicate: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id FROM graph_assertions a
       JOIN graph_nodes s ON s.id = a.subject_node_id AND s.canonical_key = $1
       JOIN graph_nodes o ON o.id = a.object_node_id AND o.canonical_key = $2
      WHERE a.predicate = $3`,
    [subjectKey, AIC_KEY, predicate],
  );
  return rows[0]!.id;
}

async function soleEvidenceOf(db: PoolDb, assertionId: string): Promise<string> {
  const { rows } = await db.query<{ evidence_id: string }>(
    `SELECT s.evidence_id
       FROM graph_assertion_support s
       JOIN graph_evidence e ON e.id = s.evidence_id
      WHERE s.assertion_id = $1 AND s.role = 'supports' AND e.validity_state = 'valid'`,
    [assertionId],
  );
  return rows[0]!.evidence_id;
}

interface ScopedLibrary {
  accountId: string;
  ownerCtx: ServiceContext;
  rodinRef: string;
  seuratRef: string;
  origin: string;
  col: { id: string };
  actx: ServiceContext;
}

/** One fresh scoped library on the isolated corpus database: owner + granted agent. */
async function scopedLibrary(db: PoolDb): Promise<ScopedLibrary> {
  const owner = await insertAccount(db);
  const ctx = testContext(owner, { db, config: graphOn });
  const rodinRef = await qlooPersonReference(db, RODIN_QLOO_ID, 'Auguste Rodin');
  const seuratRef = await qlooPersonReference(db, SEURAT_QLOO_ID, 'Georges Seurat');
  const origin = await insertItem(
    { accountId: owner.accountId },
    { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
    db,
  );
  const col = await createCollection(ctx, { name: `Museum visits ${randomUUID().slice(0, 6)}` });
  await addCollectionItem(ctx, { id: col.id, item_id: origin, body: {} });
  const { principal: agent } = await insertAgentConnection(
    owner,
    { scopes: ['collections:read', 'captures:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
    db,
  );
  return {
    accountId: owner.accountId,
    ownerCtx: ctx,
    rodinRef,
    seuratRef,
    origin,
    col,
    actx: testContext(agent, { db, config: graphOn }),
  };
}

/** The account-wide graph/feed state that a scoped graph pass must never write. */
async function accountWideState(db: PoolDb, accountId: string) {
  const single = async (sql: string) => {
    const { rows } = await db.query<{ n: number }>(sql, [accountId]);
    return Number(rows[0]!.n);
  };
  return {
    graphRuns: await single('SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1'),
    frontier: await single('SELECT count(*)::int AS n FROM graph_frontier WHERE owner_account_id = $1'),
    interestEdges: await single('SELECT count(*)::int AS n FROM personal_interest_edges WHERE owner_account_id = $1'),
    interestSupport: await single('SELECT count(*)::int AS n FROM personal_interest_support WHERE owner_account_id = $1'),
    feedSnapshots: await single('SELECT count(*)::int AS n FROM feed_snapshots WHERE owner_account_id = $1'),
    saves: await single('SELECT count(*)::int AS n FROM saved_items WHERE owner_account_id = $1'),
  };
}

async function scopedRecommendations(db: PoolDb, discoveryJobId: string) {
  const { rows } = await db.query<{
    id: string;
    discovery_item_id: string;
    title: string;
    category: string | null;
    rank: number;
    origin: string;
    display_reason: string | null;
  }>(
    `SELECT id, discovery_item_id, title, category, rank, origin, display_reason
       FROM recommendations WHERE discovery_job_id = $1 ORDER BY rank`,
    [discoveryJobId],
  );
  return rows;
}

async function scopedProofCount(db: PoolDb, discoveryJobId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
    [discoveryJobId],
  );
  return Number(rows[0]!.n);
}

describe('scoped graph Discover more execution (VAL-DISC-008)', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeAll(async () => {
    const created = await createIsolatedDatabase('scopedg');
    isoDb = created.db;
    dropIso = created.drop;
    await admitGraphCorpus(isoDb, getCorpusManifestFile());
  });
  afterAll(async () => {
    await dropIso();
  });

  it('an agent scoped enqueue reaches the reviewed corpus path: one admitted result on the scoped parent, zero provider calls', async () => {
    const lib = await scopedLibrary(isoDb);
    // Converge the durable bindings for the references created after import.
    await linkGraphReferenceIdentities(isoDb);
    const started = await startRelatedDiscovery(lib.actx, {
      id: lib.origin,
      body: { collection_id: lib.col.id, category: 'play' },
    });
    const authority = await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId: started.discovery_job_id,
    });
    expect(authority).toMatchObject({ job_type: 'discover_related', origin_item_id: lib.origin });

    const qloo = noCallQloo();
    const accountWideBefore = await accountWideState(isoDb, lib.accountId);
    const traceNotes: Array<{ kind: string; name: string; data?: Record<string, unknown> }> = [];
    const out = await runJob(started.job_id, {
      db: isoDb,
      config: graphOn,
      providers: testProviders({ qloo }),
      onTrace: (event) => traceNotes.push(event),
    });
    expect(out.state).toBe('complete');

    // Zero live provider calls: the graph branch is deterministic DB work.
    expect(qloo.calls).toEqual([]);

    // Exactly one admitted result, attached to the SCOPED discovery parent.
    const recs = await scopedRecommendations(isoDb, started.discovery_job_id);
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.origin).toBe('catalog');
    expect(rec.category).toBe('play');
    expect(rec.rank).toBe(1);
    expect(rec.display_reason).toBe('Also work on display at Art Institute of Chicago');

    // The result materializes onto the candidate's own reference: the shared
    // Seurat identity's compiler-shaped reference, as the account's item.
    const { rows: itemRows } = await isoDb.query<{
      id: string;
      kind: string;
      category: string | null;
      title: string;
      reference_id: string | null;
      external_ids: Record<string, unknown>;
    }>('SELECT id, kind, category, title, reference_id, external_ids FROM discovery_items WHERE id = $1', [
      rec.discovery_item_id,
    ]);
    expect(itemRows[0]).toMatchObject({
      kind: 'artist',
      category: 'play',
      title: 'Georges Seurat',
      reference_id: lib.seuratRef,
      external_ids: { qloo: SEURAT_QLOO_ID },
    });

    // The pinned per-result proof records the exact walked path.
    const { rows: proofs } = await isoDb.query<{
      owner_account_id: string;
      discovery_job_id: string;
      recommendation_id: string;
      assertion_ids: string[];
      assertion_revisions: number[];
      evidence_ids: string[];
      reason_template: string;
      reason_template_version: string;
      root_node_id: string;
      candidate_node_id: string;
      validity_state: string;
    }>(
      `SELECT owner_account_id, discovery_job_id, recommendation_id, assertion_ids, assertion_revisions,
              evidence_ids, reason_template, reason_template_version,
              root_node_id, candidate_node_id, validity_state
         FROM scoped_discovery_result_proofs WHERE recommendation_id = $1`,
      [rec.id],
    );
    expect(proofs).toHaveLength(1);
    const proof = proofs[0]!;
    expect(proof.owner_account_id).toBe(lib.accountId);
    expect(proof.discovery_job_id).toBe(started.discovery_job_id);
    expect(proof.reason_template).toBe('co_documented_association');
    expect(proof.reason_template_version).toBe(GRAPH_PATH_GRAMMAR_VERSION);
    expect(proof.validity_state).toBe('valid');
    expect(proof.evidence_ids.length).toBeGreaterThan(0);
    const rodinAssociation = await corpusAssertion(isoDb, RODIN_KEY, 'DOCUMENTED_ASSOCIATION');
    const seuratAssociation = await corpusAssertion(isoDb, SEURAT_KEY, 'DOCUMENTED_ASSOCIATION');
    expect([...proof.assertion_ids].sort()).toEqual([rodinAssociation, seuratAssociation].sort());
    expect(proof.assertion_revisions.every((r) => r >= 1)).toBe(true);
    const { rows: pathNodes } = await isoDb.query<{ canonical_key: string }>(
      'SELECT canonical_key FROM graph_nodes WHERE id = ANY($1::uuid[])',
      [[proof.root_node_id, proof.candidate_node_id]],
    );
    expect(pathNodes.map((n) => n.canonical_key).sort()).toEqual([RODIN_KEY, SEURAT_KEY].sort());

    // No account-wide graph state, feed snapshot or implicit save was written.
    expect(await accountWideState(isoDb, lib.accountId)).toEqual(accountWideBefore);
    const { rows: candidateSaves } = await isoDb.query(
      'SELECT 1 FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
      [lib.accountId, rec.discovery_item_id],
    );
    expect(candidateSaves).toHaveLength(0);

    // The immutable authority is only read: every pinned field survived the
    // run (the joined live job state legitimately advanced to complete).
    const after = await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId: started.discovery_job_id,
    });
    expect({ ...after, job_state: authority!.job_state }).toEqual(authority);
    expect(after!.job_state).toBe('complete');

    // Both REST surfaces read the scoped result: job polling and the item's
    // related cards (the grant-limited agent sees exactly its scoped results).
    const job = await getJob(lib.actx, { id: started.job_id });
    expect(job.state).toBe('complete');
    expect(job.result).toEqual({ type: 'discovery_job', id: started.discovery_job_id });
    expect(job.sections).toEqual([{ name: 'graph', status: 'complete' }]);
    // The producer trace records the bounded pass: ids, versions and honest
    // counters, with no private interest text (VAL-OPS-003).
    const note = traceNotes.find((n) => n.name === 'scoped_graph_discovery');
    expect(note).toMatchObject({
      kind: 'note',
      data: {
        discovery_job_id: started.discovery_job_id,
        job_id: started.job_id,
        authority_id: authority!.id,
        state: 'complete',
        results: 1,
        counts: expect.objectContaining({ resultsPublished: 1, proofsPublished: 1 }),
        ranking_policy_version: 'ranking-policy-1',
        grammar_version: GRAPH_PATH_GRAMMAR_VERSION,
      },
    });
    expect(Object.keys(note!.data!)).not.toContain('reason');
    const detail = await getItem(lib.actx, { id: lib.origin, query: { collection_id: lib.col.id } });
    expect(detail.related_state).toBe('cached');
    expect(detail.related.map((r) => r.id)).toEqual([rec.discovery_item_id]);
  });

  it('an owner-initiated scoped enqueue reaches the same reviewed path under owner authority', async () => {
    const lib = await scopedLibrary(isoDb);
    await linkGraphReferenceIdentities(isoDb);
    const started = await startRelatedDiscovery(lib.ownerCtx, {
      id: lib.origin,
      body: { collection_id: lib.col.id },
    });
    const authority = await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId: started.discovery_job_id,
    });
    expect(authority).toMatchObject({ agent_connection_id: null, authorization_version: null });

    const qloo = noCallQloo();
    const out = await runJob(started.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(out.state).toBe('complete');
    expect(qloo.calls).toEqual([]);
    const recs = await scopedRecommendations(isoDb, started.discovery_job_id);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.origin).toBe('catalog');
    expect(recs[0]!.display_reason).toBe('Also work on display at Art Institute of Chicago');

    const detail = await getItem(lib.ownerCtx, { id: lib.origin, query: { collection_id: lib.col.id } });
    expect(detail.related_state).toBe('cached');
    expect(detail.related.length).toBe(1);
  });

  it('a shared public sample origin enqueues under owner-bound save authority and publishes nothing fabricated', async () => {
    const lib = await scopedLibrary(isoDb);
    // A reviewed public sample saved into the granted collection: ownerless
    // shared item, membership grounded by the owner's own save row.
    const sample = await insertItem(null, { kind: 'film', title: 'Sample film for the graph pass' }, isoDb);
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: sample, body: {} });
    const { rows: saveRows } = await isoDb.query<{ id: string }>(
      'SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
      [lib.accountId, sample],
    );
    const accountWideBefore = await accountWideState(isoDb, lib.accountId);

    const started = await startRelatedDiscovery(lib.actx, {
      id: sample,
      body: { collection_id: lib.col.id, category: 'watch' },
    });
    const authority = await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId: started.discovery_job_id,
    });
    expect(authority).toMatchObject({
      job_type: 'discover_related',
      origin_item_id: sample,
      origin_saved_item_id: saveRows[0]!.id,
    });

    // A public sample carries no graph identities: the pass publishes nothing
    // rather than padding from another origin, account-wide state or taste.
    const qloo = noCallQloo();
    const out = await runJob(started.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(out.state).toBe('partial');
    expect(qloo.calls).toEqual([]);
    expect(await scopedRecommendations(isoDb, started.discovery_job_id)).toEqual([]);
    expect(await accountWideState(isoDb, lib.accountId)).toEqual(accountWideBefore);
    const item = await isoDb.query<{ owner_account_id: string | null; is_sample: boolean }>(
      'SELECT owner_account_id, is_sample FROM discovery_items WHERE id = $1',
      [sample],
    );
    expect(item.rows[0]).toEqual({ owner_account_id: null, is_sample: true });
  });

  it('replay/redelivery converges on the scoped parent without adopting a new epoch or duplicating results', async () => {
    const lib = await scopedLibrary(isoDb);
    await linkGraphReferenceIdentities(isoDb);
    const started = await startRelatedDiscovery(lib.actx, { id: lib.origin, body: { collection_id: lib.col.id } });
    const authority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId: started.discovery_job_id,
    }))!;

    // Two passes over the same pinned authority (a redelivery of the same job
    // runs the same deterministic pass) converge on the same scoped results.
    const first = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: null,
      ensureActive: async () => undefined,
    });
    expect(first.state).toBe('complete');
    // The walk evaluates every reachable root→candidate pair against the
    // approved grammar; exactly the reviewed Rodin–AIC–Seurat path admits.
    expect(first.counts).toMatchObject({
      rootReferences: 1,
      roots: 1,
      admitted: 1,
      resultsPublished: 1,
      proofsPublished: 1,
      candidatesMaterialized: 1,
    });
    expect(first.counts.candidatesEvaluated).toBeGreaterThan(0);
    expect(first.counts.assertionsTraversed).toBeGreaterThan(0);
    expect(first.counts.rejected).toBeGreaterThan(0);
    expect(first.truncated).toEqual({ assertions: false, candidates: false });
    expect(first.rankingPolicyVersion).toBe('ranking-policy-1');
    expect(first.grammarVersion).toBe(GRAPH_PATH_GRAMMAR_VERSION);

    const second = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: null,
      ensureActive: async () => undefined,
    });
    expect(second.state).toBe('complete');
    const recs = await scopedRecommendations(isoDb, started.discovery_job_id);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.discovery_item_id).toBe(first.results[0]!.discoveryItemId);
    expect(await scopedProofCount(isoDb, started.discovery_job_id)).toBe(1);

    // The authority row never moved: replay retains the enqueue-time epoch
    // (the joined live job state is not part of the pinned row).
    const after = await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId: started.discovery_job_id,
    });
    expect({ ...after, job_state: authority.job_state }).toEqual(authority);
  });

  it('an origin with no corpus identity yields no scoped result and never falls back to the account feed', async () => {
    const lib = await scopedLibrary(isoDb);
    await linkGraphReferenceIdentities(isoDb);
    // The legacy fallback's source pool: a completed taste seed with a real
    // Qloo-backed interest card an unrelated origin would otherwise seed from.
    const seededItem = await insertItem(
      { accountId: lib.accountId },
      { kind: 'film', category: 'watch', title: 'Seeded interest film', qloo: `seed-${randomUUID()}` },
      isoDb,
    );
    const seedRun = await isoDb.query<{ id: string }>(
      `INSERT INTO taste_seed_runs (owner_account_id, taste_revision, state, signal_count)
       VALUES ($1, 0, 'complete', 1) RETURNING id`,
      [lib.accountId],
    );
    const seedRunId = seedRun.rows[0]!.id;
    await isoDb.query(
      `INSERT INTO provider_queries (id, taste_seed_run_id, provider, operation, sanitized_request, results, status)
       VALUES ($1, $2, 'qloo', 'insights', '{}'::jsonb, NULL, 'ok')`,
      [randomUUID(), seedRunId],
    );
    await isoDb.query(
      `INSERT INTO recommendations (taste_seed_run_id, discovery_item_id, category, rank, title,
                                    external_ids, display_reason, origin, provider_query_ids)
       VALUES ($1, $2, 'watch', 1, 'Seeded interest film', '{}'::jsonb, 'From your interests.', 'qloo',
               ARRAY[$3::uuid])`,
      [seedRunId, seededItem, randomUUID()],
    );

    // An unmapped origin: the ambiguous van Gogh reference has no confirmed
    // corpus mapping, so no qualified root exists.
    const unmappedRef = await qlooPersonReference(isoDb, UNMAPPED_VANGOGH_QLOO_ID, 'Vincent van Gogh');
    const unmappedOrigin = await insertItem(
      { accountId: lib.accountId },
      { kind: 'artist', category: 'play', title: 'Vincent van Gogh', qloo: UNMAPPED_VANGOGH_QLOO_ID, referenceId: unmappedRef },
      isoDb,
    );
    const otherCol = await createCollection(lib.ownerCtx, { name: `Private ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(lib.ownerCtx, { id: otherCol.id, item_id: unmappedOrigin, body: {} });
    const { principal: agent } = await insertAgentConnection(
      { accountId: lib.accountId },
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [otherCol.id] },
      isoDb,
    );
    const otherActx = testContext(agent, { db: isoDb, config: graphOn });

    const started = await startRelatedDiscovery(otherActx, {
      id: unmappedOrigin,
      body: { collection_id: otherCol.id },
    });
    const qloo = noCallQloo();
    const out = await runJob(started.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    // Honest empty outcome: partial, zero results, zero provider calls, and
    // neither the seeded interest card nor any global taste filled the rail.
    expect(out.state).toBe('partial');
    expect(qloo.calls).toEqual([]);
    expect(await scopedRecommendations(isoDb, started.discovery_job_id)).toHaveLength(0);
    expect(await scopedProofCount(isoDb, started.discovery_job_id)).toBe(0);

    // Contrast: with the graph branch OFF, the SAME operation shape surfaces
    // the legacy account-feed fallback (unchanged legacy behavior).
    const legacy = await startRelatedDiscovery(otherActx, {
      id: unmappedOrigin,
      body: { collection_id: otherCol.id, category: 'watch' },
    });
    const legacyOut = await runJob(legacy.job_id, { db: isoDb, config: graphOff, providers: testProviders() });
    expect(legacyOut.state).toMatch(/complete|partial/);
    const legacyRecs = await scopedRecommendations(isoDb, legacy.discovery_job_id);
    expect(legacyRecs.length).toBeGreaterThan(0);
    expect(legacyRecs.map((r) => r.origin)).toEqual(['qloo']);
    expect(legacyRecs.map((r) => r.title)).toEqual(['Seeded interest film']);
    expect(await scopedProofCount(isoDb, legacy.discovery_job_id)).toBe(0);
  });

  it('graph-off keeps the legacy provider behavior and response contract on the same scoped enqueue', async () => {
    const lib = await scopedLibrary(isoDb);
    await linkGraphReferenceIdentities(isoDb);
    const started = await startRelatedDiscovery(lib.actx, {
      id: lib.origin,
      body: { collection_id: lib.col.id, category: 'watch' },
    });
    const authority = await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId: started.discovery_job_id,
    });
    expect(authority).toMatchObject({ job_type: 'discover_related' });

    const prefix = randomUUID().slice(0, 6);
    const out = await runJob(started.job_id, {
      db: isoDb,
      config: graphOff,
      providers: testProviders({ qloo: insightsQloo(prefix) }),
    });
    expect(out.state).toBe('complete');
    const recs = await scopedRecommendations(isoDb, started.discovery_job_id);
    expect(recs.length).toBeGreaterThan(0);
    // The unchanged legacy contract: provider-backed picks, the legacy reason,
    // no graph provenance and no scoped proof rows.
    expect(recs.every((r) => r.origin === 'qloo')).toBe(true);
    expect(recs.every((r) => r.display_reason === 'Loved by fans of Auguste Rodin.')).toBe(true);
    expect(await scopedProofCount(isoDb, started.discovery_job_id)).toBe(0);
    // The durable authority is still pinned for this discovery, unchanged by
    // the legacy path (only the live job state advanced).
    const after = await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId: started.discovery_job_id,
    });
    expect({ ...after, job_state: authority!.job_state }).toEqual(authority);
    expect(after!.job_state).toBe('complete');
  });

  it('a requested category outside the corpus path filters honestly instead of padding', async () => {
    const lib = await scopedLibrary(isoDb);
    await linkGraphReferenceIdentities(isoDb);
    const started = await startRelatedDiscovery(lib.actx, {
      id: lib.origin,
      body: { collection_id: lib.col.id, category: 'watch' },
    });
    const qloo = noCallQloo();
    const out = await runJob(started.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(out.state).toBe('partial');
    expect(qloo.calls).toEqual([]);
    expect(await scopedRecommendations(isoDb, started.discovery_job_id)).toHaveLength(0);
  });

  it('a hidden candidate never publishes a scoped result', async () => {
    const lib = await scopedLibrary(isoDb);
    await linkGraphReferenceIdentities(isoDb);
    // The account already owns an item on the candidate's reference; hiding it
    // (the real exclusion path) must keep it out of the scoped results.
    const candidateItem = await insertItem(
      { accountId: lib.accountId },
      { kind: 'artist', category: 'play', title: 'A real artist', qloo: SEURAT_QLOO_ID, referenceId: lib.seuratRef },
      isoDb,
    );
    await recordPreference(lib.ownerCtx, { action: 'hide', target_type: 'discovery_item', target_id: candidateItem });
    const started = await startRelatedDiscovery(lib.actx, { id: lib.origin, body: { collection_id: lib.col.id } });
    const qloo = noCallQloo();
    const out = await runJob(started.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(out.state).toBe('partial');
    expect(await scopedRecommendations(isoDb, started.discovery_job_id)).toHaveLength(0);
  });
});

describe('scoped graph publication and retraction honesty', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  // Each withdrawal is permanent (an identically reviewed re-admission reuses
  // the retracted evidence row, it does not resurrect it), so every case runs
  // against its own freshly admitted corpus.
  beforeEach(async () => {
    const created = await createIsolatedDatabase('scrdret');
    isoDb = created.db;
    dropIso = created.drop;
    await admitGraphCorpus(isoDb, getCorpusManifestFile());
  });
  afterEach(async () => {
    await dropIso();
  });

  async function runScoped(lib: ScopedLibrary, category: 'play' | null) {
    const started = await startRelatedDiscovery(lib.actx, {
      id: lib.origin,
      body: category ? { collection_id: lib.col.id, category } : { collection_id: lib.col.id },
    });
    const authority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId: started.discovery_job_id,
    }))!;
    return { started, authority };
  }

  it('sole-evidence retraction before the run leaves the path unjustified: no result is fabricated', async () => {
    const lib = await scopedLibrary(isoDb);
    await linkGraphReferenceIdentities(isoDb);
    const rodinAssociation = await corpusAssertion(isoDb, RODIN_KEY, 'DOCUMENTED_ASSOCIATION');
    await retractGraphEvidence(isoDb, {
      evidenceId: await soleEvidenceOf(isoDb, rodinAssociation),
      reason: 'withdrawn for review',
    });
    const { started } = await runScoped(lib, 'play');
    const qloo = noCallQloo();
    const out = await runJob(started.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(out.state).toBe('partial');
    expect(qloo.calls).toEqual([]);
    expect(await scopedRecommendations(isoDb, started.discovery_job_id)).toHaveLength(0);
  });

  it('a retraction racing publication cannot slip between validation and commit: it serializes behind the fence and invalidates the published proof', async () => {
    const lib = await scopedLibrary(isoDb);
    await linkGraphReferenceIdentities(isoDb);
    const rodinAssociation = await corpusAssertion(isoDb, RODIN_KEY, 'DOCUMENTED_ASSOCIATION');
    const evidenceId = await soleEvidenceOf(isoDb, rodinAssociation);
    const { started, authority } = await runScoped(lib, 'play');

    // The withdrawal is fired mid-pass (after the dependency pin locks were
    // taken and the pins revalidated at a fresh clock). It cannot commit in
    // between: the pinned rows are locked FOR SHARE until this pass
    // commits, so the racing retraction blocks and its dependent scan then
    // invalidates whatever the pass published. Nothing stale can survive.
    let racing: Promise<unknown> | undefined;
    const out = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: 'play',
      ensureActive: async () => {
        if (racing) return;
        racing = retractGraphEvidence(isoDb, { evidenceId, reason: 'withdrawn mid-pass' });
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
    });
    expect(out.state).toBe('complete');
    expect(out.counts.resultsPublished).toBe(1);
    const recs = await scopedRecommendations(isoDb, started.discovery_job_id);
    expect(recs).toHaveLength(1);
    expect(await scopedProofCount(isoDb, started.discovery_job_id)).toBe(1);

    // The blocked withdrawal lands right after the commit and invalidates the
    // scoped proof pinned to it: the published reason never outlives its
    // grounding, even when the race crossed the pass.
    const retraction = (await racing) as { scopedProofsInvalidated: number };
    expect(retraction.scopedProofsInvalidated).toBe(1);
    const { rows: after } = await isoDb.query<{ validity_state: string; invalidation_reason: string | null }>(
      'SELECT validity_state, invalidation_reason FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
      [started.discovery_job_id],
    );
    expect(after[0]!.validity_state).toBe('invalid');
    expect(after[0]!.invalidation_reason).not.toBeNull();
  });

  it('sole-evidence retraction after publication invalidates the scoped result proof immediately', async () => {
    const lib = await scopedLibrary(isoDb);
    await linkGraphReferenceIdentities(isoDb);
    const { started } = await runScoped(lib, 'play');
    const qloo = noCallQloo();
    const out = await runJob(started.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(out.state).toBe('complete');
    const recs = await scopedRecommendations(isoDb, started.discovery_job_id);
    expect(recs).toHaveLength(1);
    const { rows: before } = await isoDb.query<{ validity_state: string }>(
      'SELECT validity_state FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
      [started.discovery_job_id],
    );
    expect(before[0]!.validity_state).toBe('valid');

    // Withdrawing the walked path's sole evidence invalidates the pinned
    // scoped proof, so the published reason cannot outlive its grounding.
    const rodinAssociation = await corpusAssertion(isoDb, RODIN_KEY, 'DOCUMENTED_ASSOCIATION');
    const retraction = await retractGraphEvidence(isoDb, {
      evidenceId: await soleEvidenceOf(isoDb, rodinAssociation),
      reason: 'withdrawn after publication',
    });
    expect(retraction.scopedProofsInvalidated).toBe(1);
    const { rows: after } = await isoDb.query<{ validity_state: string; invalidation_reason: string | null }>(
      'SELECT validity_state, invalidation_reason FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
      [started.discovery_job_id],
    );
    expect(after[0]!.validity_state).toBe('invalid');
    expect(after[0]!.invalidation_reason).not.toBeNull();

    // Control: withdrawing evidence of an unrelated assertion that the proof
    // never pinned leaves the scoped proof untouched.
    const unrelated = await isoDb.query<{ id: string }>(
      `SELECT a.id FROM graph_assertions a
         JOIN graph_nodes s ON s.id = a.subject_node_id AND s.canonical_key = 'atlas:work:artic-28560'
         JOIN graph_nodes o ON o.id = a.object_node_id AND o.canonical_key = 'atlas:attribute:post-impressionism-art'
        WHERE a.predicate = 'HAS_ATTRIBUTE'`,
    );
    const unrelatedRetraction = await retractGraphEvidence(isoDb, {
      evidenceId: await soleEvidenceOf(isoDb, unrelated.rows[0]!.id),
      reason: 'unrelated withdrawal',
    });
    expect(unrelatedRetraction.scopedProofsInvalidated).toBe(0);
    const { rows: control } = await isoDb.query<{ validity_state: string }>(
      'SELECT validity_state FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
      [started.discovery_job_id],
    );
    expect(control[0]!.validity_state).toBe('invalid');
  });
});
