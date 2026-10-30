import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context';
import type { PoolDb } from '../db/pool';
import { insertCaptureWithAnalysis, insertItem, insertReference, saveDirect } from '../test-support/library';
import { createIsolatedDatabase, insertAccount, insertAgentConnection, testConfig, testContext } from '../testing';
import { getCapture, deleteCapture } from '../services/captures';
import { getDiscoveries, rebuildFeedSnapshots } from '../services/discovery';
import { recordPreference } from '../services/preferences';
import { getRecommendationConnection } from '../services/interest-graph';
import { projectAccountInterestGraph } from './projector';
import {
  attachAssertionSupport,
  insertEvidence,
  recordSourceRevision,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from './evidence';
import {
  addEdgeSupport,
  createGraphRun,
  insertGraphRecommendation,
  insertRecommendationProof,
  setGraphRunState,
  upsertPersonalEdge,
} from './store';
import { retractGraphEvidence, revalidateGraphProof } from './validity';
import type { GraphPredicate } from './schema';

/**
 * Feed/photo graph-read integration (VAL-FEED-002 / VAL-FEED-004 / the
 * VAL-EVID-004 read half, feature feed-proof-snapshot-integration).
 *
 * The read population under test:
 *
 *  - the FEED pool admits the LATEST successful compatible graph run's
 *    cards only (never a newer queued/running/failed/unpublished run), each
 *    carrying a currently valid pinned proof, and pins the recommendation
 *    selected for every snapshot position so "Why this" cannot silently
 *    swap another run's reason;
 *  - OLD snapshot/cursor pages revalidate current support at read time:
 *    sole-source retraction/expiry, support-edge suppression/removal and
 *    capture correction skip the invalid cards WITHOUT reshuffling the
 *    surviving positions, inserting newer-run cards or duplicating them,
 *    while independent valid evidence, other snapshot positions and
 *    explicit saves survive;
 *  - a scoped Discover-more recommendation for an item that is also in a
 *    taste snapshot serves as the feed card's reason only while its scoped
 *    proof holds — a retracted/expired scoped Why this never surfaces
 *    through feed context;
 *  - the CAPTURE page (the photo read) serves the latest published run's
 *    photo cards bound to the capture's CURRENT active analysis and
 *    withdraws them on retraction, correction or support loss;
 *  - graph-off accounts keep their compatible legacy pool byte-identically
 *    and a rollback filters graph-only snapshot positions.
 *
 * Everything runs on ONE isolated database (`feedproof`). All feed pages
 * read with the maximum page limit (24) so a page covers the whole snapshot.
 */

let isoDb: PoolDb;
let dropIso: () => Promise<void>;

beforeAll(async () => {
  const iso = await createIsolatedDatabase('feedproof');
  isoDb = iso.db;
  dropIso = iso.drop;
});
afterAll(async () => {
  await dropIso();
});

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });
const graphOff = testConfig({});
const PAGE = 24;

async function accountOn(config = graphOn) {
  const principal = await insertAccount(isoDb);
  return { principal, ctx: testContext(principal, { db: isoDb, config }) };
}

// --- Corpus fixtures ----------------------------------------------------------------

interface EvidenceFixture {
  evidenceId: string;
  revision: number;
  familyKey: string;
}

/** A corpus identity with a linked cultural reference (work-like by default). */
async function corpusNode(over: { kind?: 'work' | 'creator' | 'place'; name?: string } = {}) {
  const kind = over.kind ?? 'work';
  const name = `${over.name ?? kind}-${randomUUID().slice(0, 6)}`;
  const referenceId = await insertReference({ name }, isoDb);
  const node = await upsertGraphIdentity(isoDb, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: name,
    nodeKind: kind,
    domain: 'art',
    senseKey: 'painting',
    culturalReferenceId: referenceId,
  });
  return { node, referenceId, name };
}

/** One reviewed evidence row (CC0 museum record), with optional expiry. */
async function evidenceFixture(over: { expiresAt?: Date | null } = {}): Promise<EvidenceFixture> {
  const family = `artic:${randomUUID()}`;
  const recorded = await recordSourceRevision(isoDb, {
    provider: 'artic_open_access',
    url: `https://www.artic.edu/artworks/${randomUUID().slice(0, 8)}`,
    title: 'A reviewed collection record',
    publisher: 'A museum',
    attribution: 'A museum',
    license: 'CC0 1.0',
    sourceFamilyKey: family,
    allowedDisplayMetadata: { title: 'A reviewed collection record', license: 'CC0 1.0' },
    retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
    rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none' },
    documentHash: randomUUID(),
    rightsExpiresAt: null,
  });
  const inserted = await insertEvidence(isoDb, {
    sourceRevisionId: recorded.sourceRevisionId,
    permittedExcerpt: `Reviewed support ${randomUUID().slice(0, 8)}.`,
    validationMethod: 'provider_metadata',
    validationVersion: 'test-1',
    evidenceKind: 'fact',
    reviewedBy: 'corpus review',
    reviewedAt: new Date('2026-10-28T00:00:00Z'),
    expiresAt: over.expiresAt ?? null,
  });
  return { evidenceId: inserted.row.id, revision: inserted.revision, familyKey: family };
}

/** A validated, currently justified assertion with the given evidence rows. */
async function justifiedEdge(input: { subject: string; predicate: GraphPredicate; object: string; evidence?: EvidenceFixture[] }) {
  const supports = input.evidence ?? [await evidenceFixture()];
  const upserted = await upsertGraphAssertion(isoDb, {
    subjectNodeId: input.subject,
    predicate: input.predicate,
    objectNodeId: input.object,
    associationSubtype: null,
    status: 'validated',
  });
  for (const support of supports) {
    await attachAssertionSupport(isoDb, {
      assertionId: upserted.row.id,
      evidenceId: support.evidenceId,
      derivation: 'primary',
      sourceFamilyKey: support.familyKey,
    });
  }
  const { rows } = await isoDb.query<{ id: string; revision: number }>(
    'SELECT id, revision FROM graph_assertions WHERE id = $1',
    [upserted.row.id],
  );
  return { assertionId: rows[0]!.id, revision: rows[0]!.revision, evidence: supports };
}

/** An explicit saved-root support edge (the shape a projector pins for a save). */
async function savedRootEdge(accountId: string, rootItemId: string): Promise<string> {
  const savedItemId = await saveDirect(accountId, rootItemId, [], isoDb);
  const edge = await upsertPersonalEdge(isoDb, {
    ownerAccountId: accountId,
    target: { kind: 'item', discoveryItemId: rootItemId },
    origin: 'explicit',
    policyVersion: 'graph-policy-1',
  });
  await addEdgeSupport(isoDb, {
    ownerAccountId: accountId,
    edgeId: edge.id,
    originKind: 'saved_item',
    savedItemId,
  });
  return edge.id;
}

/** A derived (tentative) support edge on a shared identity: the suppression target. */
async function derivedNodeEdge(accountId: string, nodeId: string): Promise<string> {
  const edge = await upsertPersonalEdge(isoDb, {
    ownerAccountId: accountId,
    target: { kind: 'node', nodeId },
    origin: 'derived',
    policyVersion: 'graph-policy-1',
  });
  return edge.id;
}

interface GraphCardFixture {
  itemId: string;
  runId: string;
  recId: string;
  proofId: string;
}

interface CardDef {
  itemId: string;
  path: Awaited<ReturnType<typeof justifiedEdge>>;
  supportEdgeIds: readonly string[];
  intent?: 'personal' | 'photo';
  reason?: string;
  title?: string;
  rank?: number;
}

/** Publishes one COMPLETE, published expansion run carrying the given cards. */
async function publishedRun(accountId: string, cards: readonly CardDef[]): Promise<GraphCardFixture[]> {
  const run = await createGraphRun(isoDb, {
    ownerAccountId: accountId,
    runKind: 'expansion',
    policyVersion: 'graph-policy-1',
  });
  await setGraphRunState(isoDb, { runId: run.id, ownerAccountId: accountId, state: 'complete', published: true });
  const out: GraphCardFixture[] = [];
  for (const c of cards) {
    const rec = await insertGraphRecommendation(isoDb, {
      ownerAccountId: accountId,
      runId: run.id,
      discoveryItemId: c.itemId,
      origin: 'catalog',
      title: c.title ?? 'A connected work',
      displayReason: c.reason ?? 'By the same creator',
      rank: c.rank ?? 1,
    });
    const proof = await insertRecommendationProof(isoDb, {
      ownerAccountId: accountId,
      recommendationId: rec.id,
      graphRunId: run.id,
      intent: c.intent ?? 'personal',
      reasonTemplate: 'same_creator',
      assertions: [{ id: c.path.assertionId, revision: c.path.revision }],
      evidence: c.path.evidence.map((e) => ({ id: e.evidenceId, revision: e.revision })),
      supportEdgeIds: c.supportEdgeIds,
    });
    out.push({ itemId: c.itemId, runId: run.id, recId: rec.id, proofId: proof.id });
  }
  return out;
}

/** A graph run row in an arbitrary state (with optional card rows that must never serve). */
async function runInState(
  accountId: string,
  state: 'queued' | 'running' | 'failed' | 'complete',
  over: { published?: boolean } = {},
  cards: readonly CardDef[] = [],
) {
  const run = await createGraphRun(isoDb, {
    ownerAccountId: accountId,
    runKind: 'expansion',
    policyVersion: 'graph-policy-1',
  });
  await setGraphRunState(isoDb, {
    runId: run.id,
    ownerAccountId: accountId,
    state,
    published: over.published ?? false,
  });
  const out: GraphCardFixture[] = [];
  for (const c of cards) {
    const rec = await insertGraphRecommendation(isoDb, {
      ownerAccountId: accountId,
      runId: run.id,
      discoveryItemId: c.itemId,
      origin: 'catalog',
      title: c.title ?? 'A newer card',
      displayReason: 'A newer run reason',
    });
    const proof = await insertRecommendationProof(isoDb, {
      ownerAccountId: accountId,
      recommendationId: rec.id,
      graphRunId: run.id,
      intent: c.intent ?? 'personal',
      reasonTemplate: 'same_creator',
      assertions: [{ id: c.path.assertionId, revision: c.path.revision }],
      evidence: c.path.evidence.map((e) => ({ id: e.evidenceId, revision: e.revision })),
      supportEdgeIds: c.supportEdgeIds,
    });
    out.push({ itemId: c.itemId, runId: run.id, recId: rec.id, proofId: proof.id });
  }
  return { runId: run.id, cards: out };
}

/** A taste-seed card (a legacy pool member with its own reason). */
async function seedCard(accountId: string, itemId: string, reason: string): Promise<string> {
  const run = await isoDb.query<{ id: string }>(
    `INSERT INTO taste_seed_runs (owner_account_id, state, taste_revision) VALUES ($1, 'complete', 0) RETURNING id`,
    [accountId],
  );
  // The pool's seed arm reads taste_seed_categories (state 'ready'), so the
  // fixture publishes the category exactly like the real seed job does.
  await isoDb.query(
    `INSERT INTO taste_seed_categories (run_id, category, state, card_count, ready_at) VALUES ($1, 'watch', 'ready', 1, now())`,
    [run.rows[0]!.id],
  );
  const pq = await isoDb.query<{ id: string }>(
    `INSERT INTO provider_queries (provider, operation, taste_seed_run_id) VALUES ('qloo', 'insights', $1) RETURNING id`,
    [run.rows[0]!.id],
  );
  const rec = await isoDb.query<{ id: string }>(
    `INSERT INTO recommendations (taste_seed_run_id, discovery_item_id, category, rank, title, origin, display_reason, provider_query_ids)
     VALUES ($1, $2, 'watch', 1, 'A seeded film', 'qloo', $3, ARRAY[$4::uuid]) RETURNING id`,
    [run.rows[0]!.id, itemId, reason, pq.rows[0]!.id],
  );
  return rec.rows[0]!.id;
}

// --- Feed introspection helpers ------------------------------------------------------

interface SnapshotRow {
  id: string;
  taste_revision: number;
  ordered_item_ids: string[];
  pinned_recommendation_ids: string[] | null;
  created_at: Date;
}

async function latestSnapshot(accountId: string): Promise<SnapshotRow> {
  const { rows } = await isoDb.query<SnapshotRow>(
    `SELECT id, taste_revision, ordered_item_ids, pinned_recommendation_ids, created_at
       FROM feed_snapshots WHERE owner_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [accountId],
  );
  return rows[0]!;
}

function cursorFor(snapshot: Pick<SnapshotRow, 'id' | 'taste_revision'>, position = 0): string {
  return Buffer.from(JSON.stringify({ f: snapshot.id, r: snapshot.taste_revision, p: position }), 'utf8').toString('base64url');
}

async function feedIds(ctx: ServiceContext, over: { refresh?: boolean; cursor?: string; limit?: number } = {}) {
  return getDiscoveries(ctx, {
    limit: over.limit ?? PAGE,
    refresh: over.refresh ?? false,
    cursor: over.cursor,
  });
}

async function evidenceIdOf(proofId: string): Promise<string> {
  const { rows } = await isoDb.query<{ id: string }>(
    'SELECT evidence_ids[1] AS id FROM recommendation_graph_proofs WHERE id = $1',
    [proofId],
  );
  if (!rows[0]?.id) throw new Error(`proof ${proofId} has no evidence pin`);
  return rows[0].id;
}

async function proofIdFor(accountId: string, recommendationId: string): Promise<string> {
  const { rows } = await isoDb.query<{ id: string }>(
    'SELECT id FROM recommendation_graph_proofs WHERE owner_account_id = $1 AND recommendation_id = $2 ORDER BY proof_version DESC LIMIT 1',
    [accountId, recommendationId],
  );
  if (!rows[0]) throw new Error(`no proof for recommendation ${recommendationId}`);
  return rows[0].id;
}

// --- Feed pool integration (VAL-FEED-002) -------------------------------------------

describe('feed graph pool integration (VAL-FEED-002)', () => {
  it("serves only the latest published run's cards; newer queued/running/failed/unpublished runs, proof-less rows and stored-invalid proofs never enter the pool", async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;

    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    // Each path is its OWN assertion (distinct node pairs): a later
    // justifiedEdge on the same pair would bump the shared revision and make
    // the earlier card's pin stale.
    const goodPath = await justifiedEdge({ subject: work.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const otherWork = await corpusNode();
    const invalidPath = await justifiedEdge({ subject: otherWork.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const rootEdge = await savedRootEdge(accountId, await insertItem({ accountId }, { title: 'A saved root film' }, isoDb));

    const itemFor = (title: string) => insertItem({ accountId }, { title }, isoDb);
    const goodItem = await itemFor('Published graph card');
    const prooflessItem = await itemFor('Proof-less graph card');
    const invalidItem = await itemFor('Stored-invalid graph card');
    const published = await publishedRun(accountId, [
      { itemId: goodItem, path: goodPath, supportEdgeIds: [rootEdge], reason: 'By the same creator', rank: 1 },
      { itemId: prooflessItem, path: goodPath, supportEdgeIds: [rootEdge], rank: 2 },
      { itemId: invalidItem, path: invalidPath, supportEdgeIds: [rootEdge], rank: 3 },
    ]);
    // A proof-less card of the published run must not serve.
    await isoDb.query('DELETE FROM recommendation_graph_proofs WHERE id = $1', [published[1]!.proofId]);
    // A stored-invalid proof (sole-source retraction flips the durable state) must not serve.
    await retractGraphEvidence(isoDb, { evidenceId: invalidPath.evidence[0]!.evidenceId, reason: 'test retraction' });

    // Newer runs in every non-serving state, each carrying its own card rows.
    const path = goodPath;
    const qItem = await itemFor('Queued run card');
    await runInState(accountId, 'queued', {}, [{ itemId: qItem, path, supportEdgeIds: [rootEdge] }]);
    const rItem = await itemFor('Running run card');
    await runInState(accountId, 'running', {}, [{ itemId: rItem, path, supportEdgeIds: [rootEdge] }]);
    const fItem = await itemFor('Failed run card');
    await runInState(accountId, 'failed', {}, [{ itemId: fItem, path, supportEdgeIds: [rootEdge] }]);
    const uItem = await itemFor('Unpublished run card');
    await runInState(accountId, 'complete', { published: false }, [{ itemId: uItem, path, supportEdgeIds: [rootEdge] }]);

    const page = await feedIds(ctx, { refresh: true });
    const ids = page.items.map((c) => c.id);
    expect(ids).toContain(goodItem);
    for (const bad of [prooflessItem, invalidItem, qItem, rItem, fItem, uItem]) {
      expect(ids, `item ${bad}`).not.toContain(bad);
    }
    const card = page.items.find((c) => c.id === goodItem)!;
    expect(card.recommendation_id).toBe(published[0]!.recId);
    expect(card.is_example).toBe(false);
    expect(card.evidence_available).toBe(true);
  });

  it("a failed newer run preserves the prior run's eligible cards; a newer successful run replaces the pool, and a queued graph job reports expansion running", async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const path = await justifiedEdge({ subject: work.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const rootEdge = await savedRootEdge(accountId, await insertItem({ accountId }, { title: 'Root film' }, isoDb));
    const item1 = await insertItem({ accountId }, { title: 'First published card' }, isoDb);
    await publishedRun(accountId, [{ itemId: item1, path, supportEdgeIds: [rootEdge], reason: 'First reason' }]);

    // A failed newer run publishes nothing; the prior eligible card survives.
    await runInState(accountId, 'failed');
    const afterFailure = await feedIds(ctx, { refresh: true });
    expect(afterFailure.items.map((c) => c.id)).toContain(item1);

    // A queued graph expansion job makes the feed honestly report background work.
    await isoDb.query(
      `INSERT INTO jobs (owner_account_id, type, state, payload) VALUES ($1, 'expand_interest_graph', 'queued', '{}')`,
      [accountId],
    );
    const polled = await feedIds(ctx, { refresh: true });
    expect(polled.expansion).toMatchObject({ state: 'running' });

    // A newer SUCCESSFUL run replaces the pool: its card serves, the prior run's card no longer does.
    const item2 = await insertItem({ accountId }, { title: 'Second published card' }, isoDb);
    const second = await publishedRun(accountId, [
      { itemId: item2, path, supportEdgeIds: [rootEdge], reason: 'Second reason' },
    ]);
    const afterSuccess = await feedIds(ctx, { refresh: true });
    const ids = afterSuccess.items.map((c) => c.id);
    expect(ids).toContain(item2);
    expect(ids).not.toContain(item1);
    expect(afterSuccess.items.find((c) => c.id === item2)!.recommendation_id).toBe(second[0]!.recId);
  });

  it('natural evidence expiry blocks its feed card at read time while an independent-evidence card survives (VAL-EVID-004)', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const rootEdge = await savedRootEdge(accountId, await insertItem({ accountId }, { title: 'Root film' }, isoDb));

    // Two cards of one published run: the first rests SOLELY on evidence that
    // expires, the second on its own independent family that outlives it
    // (VAL-EVID-004: sole-source expiry blocks the dependent card).
    const expiring = await evidenceFixture({ expiresAt: new Date(Date.now() + 30 * 60_000) });
    const expiringPath = await justifiedEdge({
      subject: work.node.id,
      predicate: 'CREATED_BY',
      object: creator.node.id,
      evidence: [expiring],
    });
    const expiringItem = await insertItem({ accountId }, { title: 'Expiring-evidence card' }, isoDb);

    const otherWork = await corpusNode();
    const otherCreator = await corpusNode({ kind: 'creator' });
    const otherPath = await justifiedEdge({ subject: otherWork.node.id, predicate: 'CREATED_BY', object: otherCreator.node.id });
    const stableItem = await insertItem({ accountId }, { title: 'Stable-evidence card' }, isoDb);
    await publishedRun(accountId, [
      { itemId: expiringItem, path: expiringPath, supportEdgeIds: [rootEdge] },
      { itemId: stableItem, path: otherPath, supportEdgeIds: [rootEdge] },
    ]);

    const fresh = await feedIds(ctx, { refresh: true });
    expect(fresh.items.map((c) => c.id)).toContain(expiringItem);

    // Read at a clock past the evidence expiry: the dependent card is gone,
    // the independent-evidence card of the same run survives.
    const laterCtx = testContext(principal, { db: isoDb, config: graphOn, now: () => new Date(Date.now() + 2 * 3600_000) });
    const later = await feedIds(laterCtx, { refresh: true });
    const laterIds = later.items.map((c) => c.id);
    expect(laterIds).not.toContain(expiringItem);
    expect(laterIds).toContain(stableItem);
  });

  it('rebuildFeedSnapshots surfaces a just-published run on the next (non-refresh) read', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const path = await justifiedEdge({ subject: work.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const rootEdge = await savedRootEdge(accountId, await insertItem({ accountId }, { title: 'Root film' }, isoDb));

    const cardItem = await insertItem({ accountId }, { title: 'Freshly published card' }, isoDb);
    const before = await feedIds(ctx, { refresh: true });
    expect(before.items.map((c) => c.id)).not.toContain(cardItem);
    await publishedRun(accountId, [{ itemId: cardItem, path, supportEdgeIds: [rootEdge] }]);

    // The worker-side rebuild (the graph handler's post-publication step): the
    // next plain poll read serves the new run's card without a manual refresh.
    await rebuildFeedSnapshots(isoDb, { kind: 'account', accountId }, { config: graphOn });
    const polled = await feedIds(ctx, {});
    expect(polled.items.map((c) => c.id)).toContain(cardItem);
  });
});

// --- Old snapshot revalidation (VAL-FEED-004 / VAL-EVID-004) --------------------------

describe('old snapshot revalidation (VAL-FEED-004 / VAL-EVID-004)', () => {
  it('old cursors skip revoked graph cards without reshuffling, duplication or new-run insertion', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const creator = await corpusNode({ kind: 'creator' });
    const rootEdge = await savedRootEdge(accountId, await insertItem({ accountId }, { title: 'Root film' }, isoDb));

    // Four graph cards of ONE published run: each its OWN assertion (distinct
    // subject nodes, so no shared revision bumps), each with live support —
    // the edge-deletion victim gets its OWN edge so removing it cannot touch
    // the survivors' support. Plus two seed cards.
    const victimEdge = await derivedNodeEdge(accountId, creator.node.id);
    const items: string[] = [];
    const defs: CardDef[] = [];
    for (let i = 0; i < 4; i++) {
      const item = await insertItem({ accountId }, { title: `Graph card ${i}` }, isoDb);
      const subject = await corpusNode();
      const path = await justifiedEdge({ subject: subject.node.id, predicate: 'CREATED_BY', object: creator.node.id });
      items.push(item);
      defs.push({
        itemId: item,
        path,
        supportEdgeIds: i === 2 ? [victimEdge] : [rootEdge],
        reason: `Graph reason ${i}`,
        rank: i + 1,
      });
    }
    const cards = await publishedRun(accountId, defs);
    const seedA = await insertItem({ accountId }, { title: 'Seed film A' }, isoDb);
    const seedB = await insertItem({ accountId }, { title: 'Seed film B' }, isoDb);
    await seedCard(accountId, seedA, 'Seeded from your picks A');
    await seedCard(accountId, seedB, 'Seeded from your picks B');

    // Snapshot N: the positions the cursor will keep serving.
    await feedIds(ctx, { refresh: true });
    const snapshot = await latestSnapshot(accountId);
    expect(snapshot.pinned_recommendation_ids).not.toBeNull();
    expect(snapshot.pinned_recommendation_ids!.length).toBe(snapshot.ordered_item_ids.length);
    const ordered = snapshot.ordered_item_ids;
    const baseline = await feedIds(ctx, { cursor: cursorFor(snapshot) });
    expect(baseline.items.map((c) => c.id)).toEqual(ordered);

    // Victim 1+2: sole-source retraction flips their proofs invalid.
    await retractGraphEvidence(isoDb, { evidenceId: await evidenceIdOf(cards[0]!.proofId), reason: 'test retraction' });
    await retractGraphEvidence(isoDb, { evidenceId: await evidenceIdOf(cards[1]!.proofId), reason: 'test retraction' });
    // Victim 3: the pinned support edge is deleted (support removal).
    await isoDb.query(
      'DELETE FROM personal_interest_edges WHERE id = ANY(SELECT support_edge_id FROM recommendation_graph_proof_support_edges WHERE proof_id = $1)',
      [cards[2]!.proofId],
    );

    // A newer successful run with a brand-new card: it must NOT insert itself
    // into the old snapshot's positions (and its own assertion must not bump
    // the survivors' pinned revisions).
    const newerWork = await corpusNode();
    const newerCreator = await corpusNode({ kind: 'creator' });
    const newerPath = await justifiedEdge({ subject: newerWork.node.id, predicate: 'CREATED_BY', object: newerCreator.node.id });
    const newerItem = await insertItem({ accountId }, { title: 'Newer run card' }, isoDb);
    await publishedRun(accountId, [{ itemId: newerItem, path: newerPath, supportEdgeIds: [rootEdge] }]);

    const after = await feedIds(ctx, { cursor: cursorFor(snapshot) });
    const served = after.items.map((c) => c.id);
    const expected = ordered.filter((id) => id !== items[0] && id !== items[1] && id !== items[2]);
    expect(served).toEqual(expected);
    expect(served).not.toContain(newerItem);
    expect(new Set(served).size).toBe(served.length);
    // The snapshot row itself was not rewritten: same order, same pinning.
    const afterSnapshot = await latestSnapshot(accountId);
    expect(afterSnapshot.id).toBe(snapshot.id);
    expect(afterSnapshot.ordered_item_ids).toEqual(ordered);
    // Surviving positions keep their pinned recommendation ids.
    expect(afterSnapshot.pinned_recommendation_ids).toContain(cards[3]!.recId);

    // The revoked card's disclosure is honestly unavailable, without substitution.
    const connection = await getRecommendationConnection(ctx, cards[0]!.recId);
    expect(connection.state).toBe('unavailable');
    expect(connection.reason.text).toBeNull();
  });

  it('independent valid evidence and explicit saves survive sole-source retraction', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const rootEdge = await savedRootEdge(accountId, await insertItem({ accountId }, { title: 'Root film' }, isoDb));

    // One assertion carried by TWO independent families: card X's proof pins
    // ONLY family X (sole source), card Y's proof pins ONLY family Y. Retracting
    // X's sole evidence invalidates X and leaves Y alive on its own witness
    // (the assertion itself stays justified on family Y).
    const familyX = await evidenceFixture();
    const familyY = await evidenceFixture();
    const path = await justifiedEdge({
      subject: work.node.id,
      predicate: 'CREATED_BY',
      object: creator.node.id,
      evidence: [familyX, familyY],
    });
    const xItem = await insertItem({ accountId }, { title: 'Sole-source card' }, isoDb);
    const yItem = await insertItem({ accountId }, { title: 'Independent-evidence card' }, isoDb);
    const [, yCard] = (await publishedRun(accountId, [
      { itemId: xItem, path: { ...path, evidence: [familyX] }, supportEdgeIds: [rootEdge], rank: 1 },
      { itemId: yItem, path: { ...path, evidence: [familyY] }, supportEdgeIds: [rootEdge], rank: 2 },
    ])) as [GraphCardFixture, GraphCardFixture];
    // Y's owner explicitly saved its card item after the snapshot existed.
    const savedY = await saveDirect(accountId, yItem, [], isoDb);

    await feedIds(ctx, { refresh: true });
    await retractGraphEvidence(isoDb, { evidenceId: familyX.evidenceId, reason: 'test retraction' });

    const page = await feedIds(ctx, { cursor: cursorFor(await latestSnapshot(accountId)) });
    const ids = page.items.map((c) => c.id);
    expect(ids).not.toContain(xItem);
    expect(ids).toContain(yItem);
    const yCardDto = page.items.find((c) => c.id === yItem)!;
    expect(yCardDto.saved).toBe(true);
    expect(yCardDto.recommendation_id).toBe(yCard!.recId);
    // The explicit save row and the connection both survive.
    const { rows: saves } = await isoDb.query('SELECT id FROM saved_items WHERE id = $1', [savedY]);
    expect(saves).toHaveLength(1);
    const connection = await getRecommendationConnection(ctx, yCard!.recId);
    expect(connection.state).toBe('connected');
    expect(connection.reason.text).toBe('By the same creator');
  });

  it('suppressed or withdrawn support skips the card and makes its reason unavailable (stale-reason suppression)', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const path = await justifiedEdge({ subject: work.node.id, predicate: 'CREATED_BY', object: creator.node.id });

    // A derived (tentative) support edge: the tentative-interest suppression target.
    const edge = await derivedNodeEdge(accountId, creator.node.id);
    const cardItem = await insertItem({ accountId }, { title: 'Derived-root card' }, isoDb);
    const card = (await publishedRun(accountId, [{ itemId: cardItem, path, supportEdgeIds: [edge] }]))[0]!;

    await feedIds(ctx, { refresh: true });
    const first = await feedIds(ctx, { cursor: cursorFor(await latestSnapshot(accountId)) });
    expect(first.items.map((c) => c.id)).toContain(cardItem);
    expect((await getRecommendationConnection(ctx, card.recId)).state).toBe('connected');

    // Suppression withdraws the tentative support: card skipped, reason unavailable.
    await isoDb.query(`UPDATE personal_interest_edges SET state = 'suppressed' WHERE id = $1`, [edge]);
    const afterSuppress = await feedIds(ctx, { cursor: cursorFor(await latestSnapshot(accountId)) });
    expect(afterSuppress.items.map((c) => c.id)).not.toContain(cardItem);
    const suppressed = await getRecommendationConnection(ctx, card.recId);
    expect(suppressed.state).toBe('unavailable');
    expect(suppressed.unavailable_reason).toBeTruthy();
    expect(suppressed.reason.text).toBeNull();
  });

  it('graph-off reads keep the legacy pool and filter graph-only snapshot positions on rollback', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const path = await justifiedEdge({ subject: work.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const rootEdge = await savedRootEdge(accountId, await insertItem({ accountId }, { title: 'Root film' }, isoDb));

    const graphItem = await insertItem({ accountId }, { title: 'Graph card' }, isoDb);
    await publishedRun(accountId, [{ itemId: graphItem, path, supportEdgeIds: [rootEdge] }]);
    const seedItem = await insertItem({ accountId }, { title: 'Seed card' }, isoDb);
    await seedCard(accountId, seedItem, 'Seeded from your picks');

    await feedIds(ctx, { refresh: true });
    const snapshot = await latestSnapshot(accountId);
    const ordered = snapshot.ordered_item_ids;
    expect(ordered).toContain(graphItem);

    // Rollback (flags off): the old cursor filters the graph-only position,
    // the legacy seed position keeps its place, nothing reshuffles.
    const offCtx = testContext(principal, { db: isoDb, config: graphOff });
    const offPage = await feedIds(offCtx, { cursor: cursorFor(snapshot) });
    const expected = ordered.filter((id) => id !== graphItem);
    expect(offPage.items.map((c) => c.id)).toEqual(expected);

    // A fresh graph-off snapshot is the unchanged legacy pool (no graph arm).
    const fresh = await feedIds(offCtx, { refresh: true });
    const freshIds = fresh.items.map((c) => c.id);
    expect(freshIds).toContain(seedItem);
    expect(freshIds).not.toContain(graphItem);
  });
});

// --- Pinned feed contexts (VAL-FEED-003 domain half) --------------------------------

describe('pinned feed contexts (Why this is tied to the selected recommendation)', () => {
  it("a newer run's reason never replaces the pinned one; invalid pinned support steps aside only within the snapshot's own recommendations", async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const path = await justifiedEdge({ subject: work.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const rootEdge = await savedRootEdge(accountId, await insertItem({ accountId }, { title: 'Root film' }, isoDb));

    // The item has BOTH a seed rec (older) and a graph rec (newer, valid).
    const sharedItem = await insertItem({ accountId }, { title: 'Shared item' }, isoDb);
    const seedRec = await seedCard(accountId, sharedItem, 'Seeded from your picks');
    const [graphCard] = (await publishedRun(accountId, [
      { itemId: sharedItem, path, supportEdgeIds: [rootEdge], reason: 'Pinned graph reason' },
    ])) as [GraphCardFixture];

    await feedIds(ctx, { refresh: true });
    const snapshot = await latestSnapshot(accountId);
    const first = await feedIds(ctx, { cursor: cursorFor(snapshot) });
    const card = first.items.find((c) => c.id === sharedItem)!;
    expect(card.recommendation_id).toBe(graphCard.recId);
    expect((await getRecommendationConnection(ctx, card.recommendation_id!)).reason.text).toBe('Pinned graph reason');

    // A newer successful run republishes the SAME item with a new reason:
    // the old snapshot keeps its pinned recommendation, a fresh snapshot adopts the new one.
    const newerWork = await corpusNode();
    const newerCreator = await corpusNode({ kind: 'creator' });
    const newPath = await justifiedEdge({ subject: newerWork.node.id, predicate: 'CREATED_BY', object: newerCreator.node.id });
    const [newerCard] = (await publishedRun(accountId, [
      { itemId: sharedItem, path: newPath, supportEdgeIds: [rootEdge], reason: 'Newer run reason' },
    ])) as [GraphCardFixture];
    const stillPinned = await feedIds(ctx, { cursor: cursorFor(snapshot) });
    expect(stillPinned.items.find((c) => c.id === sharedItem)!.recommendation_id).toBe(graphCard.recId);
    const refreshed = await feedIds(ctx, { refresh: true });
    expect(refreshed.items.find((c) => c.id === sharedItem)!.recommendation_id).toBe(newerCard.recId);

    // Retract the PINNED rec's sole evidence: within the old snapshot the
    // context steps aside to the snapshot's own older seed reason — never to
    // the newer run's reason — and the card survives on its independent support.
    const pinnedEvidence = await evidenceIdOf(graphCard.proofId);
    await retractGraphEvidence(isoDb, { evidenceId: pinnedEvidence, reason: 'test retraction' });
    const after = await feedIds(ctx, { cursor: cursorFor(snapshot) });
    const afterCard = after.items.find((c) => c.id === sharedItem)!;
    expect(afterCard.recommendation_id).toBe(seedRec);
    const connection = await getRecommendationConnection(ctx, afterCard.recommendation_id!);
    expect(connection.reason.text).toBe('Seeded from your picks');
    // The pinned rec's own disclosure yields unavailable rather than substitution.
    expect((await getRecommendationConnection(ctx, graphCard.recId)).state).toBe('unavailable');
  });
});

// --- Scoped feed-context reasons ------------------------------------------------------

describe('scoped feed-context reasons', () => {
  it('a scoped recommendation for a taste-snapshot item serves its reason only while its scoped proof holds', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const path = await justifiedEdge({ subject: work.node.id, predicate: 'CREATED_BY', object: creator.node.id });

    // The item is in the taste snapshot (the pool member) ...
    const sharedItem = await insertItem({ accountId }, { title: 'Scoped-and-seeded item' }, isoDb);
    const seedRec = await seedCard(accountId, sharedItem, 'Seeded from your picks');
    // ... and an agent's scoped Discover more produced a NEWER recommendation for it.
    const agent = await insertAgentConnection({ accountId }, {}, isoDb);
    const { rows: job } = await isoDb.query<{ id: string }>(
      `INSERT INTO discovery_jobs (owner_account_id, origin_item_id, agent_connection_id, scoped_authority_required, status)
       VALUES ($1, $2, $3, true, 'complete') RETURNING id`,
      [accountId, sharedItem, agent.principal.connectionId],
    );
    const { rows: scopedRec } = await isoDb.query<{ id: string }>(
      `INSERT INTO recommendations (discovery_job_id, discovery_item_id, category, rank, title, origin, display_reason)
       VALUES ($1, $2, 'watch', 1, 'Scoped candidate', 'catalog', 'Scoped graph reason') RETURNING id`,
      [job[0]!.id, sharedItem],
    );
    await isoDb.query(
      `INSERT INTO scoped_discovery_result_proofs
         (owner_account_id, discovery_job_id, recommendation_id, assertion_ids, assertion_revisions,
          evidence_ids, evidence_revisions, reason_template, reason_template_version,
          root_node_id, mid_node_id, candidate_node_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'same_creator', 'grammar-1', $8, $9, $9)`,
      [
        accountId,
        job[0]!.id,
        scopedRec[0]!.id,
        [path.assertionId],
        [path.revision],
        [path.evidence[0]!.evidenceId],
        [path.evidence[0]!.revision],
        work.node.id,
        creator.node.id,
      ],
    );

    // While the scoped proof holds, the newest serving context is the scoped reason.
    await feedIds(ctx, { refresh: true });
    const snapshot = await latestSnapshot(accountId);
    const first = await feedIds(ctx, { cursor: cursorFor(snapshot) });
    const card = first.items.find((c) => c.id === sharedItem)!;
    expect(card.recommendation_id).toBe(scopedRec[0]!.id);
    expect((await getRecommendationConnection(ctx, card.recommendation_id!)).reason.text).toBe('Scoped graph reason');

    // Retract the scoped proof's sole evidence: the scoped reason is excluded
    // from feed context (the seed reason serves), never surfaced as retracted.
    await retractGraphEvidence(isoDb, { evidenceId: path.evidence[0]!.evidenceId, reason: 'test retraction' });
    const after = await feedIds(ctx, { cursor: cursorFor(snapshot) });
    const afterCard = after.items.find((c) => c.id === sharedItem)!;
    expect(afterCard.recommendation_id).toBe(seedRec);
    expect((await getRecommendationConnection(ctx, afterCard.recommendation_id!)).reason.text).toBe('Seeded from your picks');
    const scopedConnection = await getRecommendationConnection(ctx, scopedRec[0]!.id);
    expect(scopedConnection.state).toBe('unavailable');
    expect(scopedConnection.reason.text).toBeNull();
  });
});

// --- Photo graph reads (the capture page) ---------------------------------------------

/** A saved capture with a derived personal edge supported by its analysis reference. */
async function savedCaptureWithNode(accountId: string) {
  const ref = await insertReference({ name: `Fixture work ${randomUUID().slice(0, 6)}` }, isoDb);
    const node = await upsertGraphIdentity(isoDb, {
      canonicalKey: `atlas:${randomUUID()}`,
      canonicalName: `Fixture work ${randomUUID().slice(0, 6)}`,
      nodeKind: 'work',
      domain: 'art',
      senseKey: 'painting',
      culturalReferenceId: ref,
    });
    const cap = await insertCaptureWithAnalysis({ accountId }, {}, isoDb);
    const { rows: captureReference } = await isoDb.query<{ id: string }>(
      `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor, text_only, read_text)
       VALUES ($1, $2, 'depicted', 0.82, 'resolved', true, false, NULL) RETURNING id`,
      [cap.analysisId, ref],
    );
    await saveDirect(accountId, cap.itemId, [], isoDb);
    const edge = await upsertPersonalEdge(isoDb, {
      ownerAccountId: accountId,
      target: { kind: 'node', nodeId: node.id },
      origin: 'derived',
      policyVersion: 'graph-policy-1',
    });
    await addEdgeSupport(isoDb, {
      ownerAccountId: accountId,
      edgeId: edge.id,
      originKind: 'capture_reference',
      captureId: cap.captureId,
      analysisId: cap.analysisId,
      captureReferenceId: captureReference[0]!.id,
    });
    return { captureId: cap.captureId, analysisId: cap.analysisId, captureItemId: cap.itemId, edgeId: edge.id };
}

describe('photo graph reads (the capture page)', () => {
  it("serves the latest published run's photo cards bound to the capture's active analysis, and withdraws them on retraction, correction or support loss", async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const cap = await savedCaptureWithNode(accountId);
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const path = await justifiedEdge({ subject: work.node.id, predicate: 'CREATED_BY', object: creator.node.id });

    const photoItem = await insertItem({ accountId }, { title: 'Photo-connected work' }, isoDb);
    const [photoCard] = (await publishedRun(accountId, [
      { itemId: photoItem, path, supportEdgeIds: [cap.edgeId], intent: 'photo', reason: 'About the work in your photo' },
    ])) as [GraphCardFixture];

    const detail = await getCapture(ctx, { id: cap.captureId });
    const recIds = detail.recommendations.map((r) => r.id);
    expect(recIds).toContain(photoItem);
    const photoCardDto = detail.recommendations.find((r) => r.id === photoItem)!;
    expect(photoCardDto.recommendation_id).toBe(photoCard.recId);
    expect(photoCardDto.is_example).toBe(false);
    expect((await getRecommendationConnection(ctx, photoCard.recId)).reason.text).toBe('About the work in your photo');

    // A newer queued run's photo rows never leak into the photo read.
    const newerItem = await insertItem({ accountId }, { title: 'Queued photo card' }, isoDb);
    await runInState(accountId, 'queued', {}, [{ itemId: newerItem, path, supportEdgeIds: [cap.edgeId], intent: 'photo' }]);
    const queuedRead = await getCapture(ctx, { id: cap.captureId });
    expect(queuedRead.recommendations.map((r) => r.id)).not.toContain(newerItem);

    // Sole-source retraction withdraws the photo card immediately; the save survives.
    const photoEvidence = await evidenceIdOf(photoCard.proofId);
    await retractGraphEvidence(isoDb, { evidenceId: photoEvidence, reason: 'test retraction' });
    const afterRetract = await getCapture(ctx, { id: cap.captureId });
    expect(afterRetract.recommendations.map((r) => r.id)).not.toContain(photoItem);
    expect((await getRecommendationConnection(ctx, photoCard.recId)).state).toBe('unavailable');
    expect(afterRetract.saved).toBe(true);

    // Correction: activating a different analysis withdraws the card whose
    // photo support belongs to the superseded analysis. The re-published card
    // rests on FRESH evidence (the original path's sole evidence was just
    // retracted above).
    const reconnected = await insertItem({ accountId }, { title: 'Re-published photo card' }, isoDb);
    const republishedWork = await corpusNode();
    const republishedCreator = await corpusNode({ kind: 'creator' });
    const republishedPath = await justifiedEdge({
      subject: republishedWork.node.id,
      predicate: 'CREATED_BY',
      object: republishedCreator.node.id,
    });
    const republished = await publishedRun(accountId, [
      { itemId: reconnected, path: republishedPath, supportEdgeIds: [cap.edgeId], intent: 'photo', reason: 'About the work in your photo' },
    ]);
    const correctedRead = await getCapture(ctx, { id: cap.captureId });
    expect(correctedRead.recommendations.map((r) => r.id)).toContain(reconnected);
    await isoDb.query(
      `INSERT INTO analyses (capture_id, version, compiler_version, title, interpretation, section_statuses)
       VALUES ($1, 2, 'test', 'A corrected reading', 'A different reading.', '{"observations":"complete"}')`,
      [cap.captureId],
    );
    await isoDb.query(
      `UPDATE captures SET active_analysis_id = (SELECT id FROM analyses WHERE capture_id = $1 ORDER BY version DESC LIMIT 1) WHERE id = $1`,
      [cap.captureId],
    );
    const afterCorrection = await getCapture(ctx, { id: cap.captureId });
    expect(afterCorrection.recommendations.map((r) => r.id)).not.toContain(reconnected);
    expect((await getRecommendationConnection(ctx, republished[0]!.recId)).state).toBe('unavailable');
    // Support loss (the reference support row deactivated by the projector)
    // also withdraws the card even after the analysis is restored.
    await isoDb.query('UPDATE captures SET active_analysis_id = $2 WHERE id = $1', [cap.captureId, cap.analysisId]);
    await isoDb.query('UPDATE personal_interest_support SET active = false WHERE edge_id = $1', [cap.edgeId]);
    const afterSupportLoss = await getCapture(ctx, { id: cap.captureId });
    expect(afterSupportLoss.recommendations.map((r) => r.id)).not.toContain(reconnected);
  });

  it('keeps the legacy capture rail unchanged when the graph flags are off', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const legacyItem = await insertItem({ accountId }, { title: 'Analysis card' }, isoDb);
    const legacyCapture = await insertCaptureWithAnalysis({ accountId }, { recommendItemIds: [legacyItem] }, isoDb);
    const cap = await savedCaptureWithNode(accountId);
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const path = await justifiedEdge({ subject: work.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const photoItem = await insertItem({ accountId }, { title: 'Photo graph card' }, isoDb);
    await publishedRun(accountId, [
      { itemId: photoItem, path, supportEdgeIds: [cap.edgeId], intent: 'photo', reason: 'About the work in your photo' },
    ]);

    const offCtx = testContext(principal, { db: isoDb, config: graphOff });
    const legacyRead = await getCapture(offCtx, { id: legacyCapture.captureId });
    expect(legacyRead.recommendations.map((r) => r.id)).toEqual([legacyItem]);

    const graphRead = await getCapture(ctx, { id: cap.captureId });
    expect(graphRead.recommendations.map((r) => r.id)).toContain(photoItem);
  });
});

// --- Capture deletion withdrawal (VAL-DELETE-005) ------------------------------------

describe('capture deletion withdraws graph cards immediately', () => {
  it('a pinned old cursor skips a card whose sole support died with the capture, without any projector pass; independent support survives', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const cap = await savedCaptureWithNode(accountId);
    const work = await corpusNode();
    const creator = await corpusNode({ kind: 'creator' });
    const path = await justifiedEdge({ subject: work.node.id, predicate: 'CREATED_BY', object: creator.node.id });

    const captureItem = await insertItem({ accountId }, { title: 'Capture-supported card' }, isoDb);
    const independentItem = await insertItem({ accountId }, { title: 'Independent card' }, isoDb);
    // The independent card rests on an EXPLICIT save (a real preference
    // event), so it is projector-stable: a later pass re-derives its support
    // and the card survives while the capture card stays withdrawn.
    const independentRootFilm = await insertItem({ accountId }, { title: 'Independent root film' }, isoDb);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: independentRootFilm });
    const { rows: rootSaved } = await isoDb.query<{ id: string }>(
      `SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2`,
      [accountId, independentRootFilm],
    );
    const rootEdgeRow = await upsertPersonalEdge(isoDb, {
      ownerAccountId: accountId,
      target: { kind: 'item', discoveryItemId: independentRootFilm },
      origin: 'explicit',
      policyVersion: 'graph-policy-1',
    });
    await addEdgeSupport(isoDb, {
      ownerAccountId: accountId,
      edgeId: rootEdgeRow.id,
      originKind: 'saved_item',
      savedItemId: rootSaved[0]!.id,
    });
    const rootEdge = rootEdgeRow.id;
    const [captureCard, independentCard] = (await publishedRun(accountId, [
      { itemId: captureItem, path, supportEdgeIds: [cap.edgeId] },
      { itemId: independentItem, path, supportEdgeIds: [rootEdge] },
    ])) as [GraphCardFixture, GraphCardFixture];

    await feedIds(ctx, { refresh: true });
    const snapshot = await latestSnapshot(accountId);
    const first = await feedIds(ctx, { cursor: cursorFor(snapshot) });
    expect(first.items.map((c) => c.id)).toContain(captureItem);
    expect(first.items.map((c) => c.id)).toContain(independentItem);

    // The capture dies AFTER the snapshot is pinned. No projection pass runs:
    // the read itself must withdraw the card whose only support was the capture.
    await deleteCapture(ctx, { id: cap.captureId });
    const after = await feedIds(ctx, { cursor: cursorFor(snapshot) });
    expect(after.items.map((c) => c.id)).not.toContain(captureItem);
    expect(after.items.map((c) => c.id)).toContain(independentItem);
    expect((await getRecommendationConnection(ctx, captureCard.recId)).state).toBe('unavailable');
    expect((await getRecommendationConnection(ctx, independentCard.recId)).state).toBe('connected');

    // The withdrawal is durable: a later projector pass converges to the same
    // answer and never resurrects the withdrawn card.
    await projectAccountInterestGraph(isoDb, { accountId, config: graphOn, source: 'mutation_intent' });
    const converged = await feedIds(ctx, { cursor: cursorFor(snapshot) });
    expect(converged.items.map((c) => c.id)).not.toContain(captureItem);
    expect(converged.items.map((c) => c.id)).toContain(independentItem);
  });
});

// --- Batched verdict parity -----------------------------------------------------------

describe('batched page verdicts', () => {
  it('the page-level verdict engine agrees with per-proof revalidation on the pinned dependencies and is stricter about live support', async () => {
    const { graphRecommendationServingVerdicts } = await import('./feed-reads');
    const { principal } = await accountOn();
    const accountId = principal.accountId;
    const creator = await corpusNode({ kind: 'creator' });
    const rootEdge = await savedRootEdge(accountId, await insertItem({ accountId }, { title: 'Root film' }, isoDb));

    // Valid card.
    const validWork = await corpusNode();
    const validPath = await justifiedEdge({ subject: validWork.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const validItem = await insertItem({ accountId }, { title: 'Valid card' }, isoDb);
    const [validCard] = (await publishedRun(accountId, [
      { itemId: validItem, path: validPath, supportEdgeIds: [rootEdge] },
    ])) as [GraphCardFixture];
    // Sole-source-retracted card (its own assertion and evidence).
    const retractedWork = await corpusNode();
    const retractedPath = await justifiedEdge({ subject: retractedWork.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const retractedItem = await insertItem({ accountId }, { title: 'Retracted card' }, isoDb);
    const [retractedCard] = (await publishedRun(accountId, [
      { itemId: retractedItem, path: retractedPath, supportEdgeIds: [rootEdge] },
    ])) as [GraphCardFixture];
    await retractGraphEvidence(isoDb, { evidenceId: retractedPath.evidence[0]!.evidenceId, reason: 'test retraction' });
    // Support-withdrawn card (valid pinned dependencies, deleted support edge).
    const withdrawnWork = await corpusNode();
    const withdrawnPath = await justifiedEdge({ subject: withdrawnWork.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const withdrawnItem = await insertItem({ accountId }, { title: 'Withdrawn-support card' }, isoDb);
    const withdrawnEdge = await derivedNodeEdge(accountId, creator.node.id);
    const [withdrawnCard] = (await publishedRun(accountId, [
      { itemId: withdrawnItem, path: withdrawnPath, supportEdgeIds: [withdrawnEdge] },
    ])) as [GraphCardFixture];
    await isoDb.query('DELETE FROM personal_interest_edges WHERE id = $1', [withdrawnEdge]);

    const verdicts = await graphRecommendationServingVerdicts(isoDb, {
      ownerAccountId: accountId,
      recommendationIds: [validCard.recId, retractedCard.recId, withdrawnCard.recId],
      at: new Date(),
    });
    expect(verdicts.get(validCard.recId)).toMatchObject({ serves: true });
    expect(verdicts.get(retractedCard.recId)).toMatchObject({ serves: false });
    expect(verdicts.get(withdrawnCard.recId)).toMatchObject({ serves: false });
    // Parity with the per-proof reader on the pinned-dependency axis.
    for (const [recId, verdict] of verdicts) {
      const perProof = await revalidateGraphProof(isoDb, { proofId: await proofIdFor(accountId, recId) });
      if (recId === withdrawnCard.recId) {
        // Deliberately stricter: the pinned dependencies still revalidate, but
        // the private support the card rests on is gone, so serving is false.
        expect(perProof.valid).toBe(true);
        expect(verdict.serves).toBe(false);
      } else {
        expect(verdict.serves, `rec ${recId}`).toBe(perProof.valid);
      }
    }
  });
});
