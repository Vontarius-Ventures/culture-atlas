import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { upsertReference } from '../compiler/store';
import type { ServiceContext } from '../context';
import type { PoolDb } from '../db/pool';
import { AppError } from '../errors';
import { addCollectionItem, createCollection } from '../services/collections';
import { startRelatedDiscovery } from '../services/items';
import { insertItem, runJob } from '../test-support/library';
import {
  createIsolatedDatabase,
  insertAccount,
  insertAgentConnection,
  testConfig,
  testContext,
  testProviders,
} from '../testing';
import { admitGraphCorpus } from './corpus';
import { getCorpusManifestFile } from './corpus-manifest';
import { attachAssertionSupport, insertEvidence, recordSourceRevision, upsertGraphAssertion } from './evidence';
import { linkGraphReferenceIdentities } from './identity-links';
import { discoveryGrantAuthorityForJob, type ScopedDiscoveryGrantAuthority } from './scoped-discovery';
import { runScopedGraphDiscovery, type ScopedGraphDiscoveryOutcome } from './scoped-discovery-graph';

/**
 * The successive nested materialization/tail SQL waits of the scoped pass's
 * ONE anchored work window (repairs round-9 DISC-SCR-041, the remaining
 * nested-wait part of DISC-SCR-035).
 *
 * The ordered-window repair anchored the window (migration 400's immutable
 * `work_deadline_at`) and refreshed the `SET LOCAL statement_timeout /
 * lock_timeout` bound at STAGE boundaries — but every `upsertDiscoveryItem`
 * in the results-materialization loop and every tail recommendation/proof
 * INSERT then inherited the SAME earlier relative timeout: two individually
 * allowed waits could cumulatively outrun the anchored remainder while the
 * pass kept holding its grant/collection/parent (and capture) locks. The
 * final rollback boundary prevented expired publication but did not bound
 * that excess lock retention.
 *
 * Both cases run on their OWN isolated database with the committed reviewed
 * pilot corpus, because the fixture's extra reviewed evidence and the extra
 * application references are SHARED rows (global assertions, global
 * identity→reference bindings): each scenario admits exactly the corpus
 * state its old publication needs before widening it.
 *
 *  - The barrier case proves the repaired discipline with REAL two-
 *    connection canonical-key upsert holders: a short anchored window whose
 *    FIRST new candidate's competing insert releases mid-window (the upsert
 *    succeeds, consuming real time) while the SECOND's stays locked must
 *    reject the SECOND wait AT the anchored deadline — never a full
 *    earlier-remainder window past it — with the whole pass rolled back (no
 *    partial materialization), the old result/proof rows preserved
 *    untouched, the grant/collection/parent authority locks released
 *    promptly at rejection, and the immutable redelivery anchor rejecting
 *    identically.
 *  - The live-window control proves the positive path: successive REAL
 *    materialization lock waits inside a live window still publish, and the
 *    deterministic materialization order (equal template scores → node id
 *    ascending) matches the published ranks — the tie-break the barrier
 *    case's holder assignment relies on.
 *
 * The fixture widens the corpus with two more `work_on_display_at` creator
 * bridges on the Art Institute of Chicago — the SAME DOCUMENTED_ASSOCIATION
 * composition the reviewed corpus ships for Rodin and Seurat, each grounded
 * in one reviewed AIC open-access collection record — so a Rodin-origin walk
 * admits a second and third creator candidate (Cézanne, Van Gogh) whose
 * application references resolve through the corpus identities' confirmed
 * Wikidata mappings. Nothing here makes any provider call: every run fails
 * closed on the recording fake.
 */

const graphOn = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});

/** Verified live Qloo entity ids (see the manifest provenance). */
const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';

/** The corpus identities' confirmed Wikidata mappings (see the manifest provenance). */
const CEZANNE_WIKIDATA_ID = 'Q35548';
const VANGOGH_WIKIDATA_ID = 'Q5582';
/** The two extra candidates' application-reference canonical keys. */
const CEZANNE_KEY = `wikidata:${CEZANNE_WIKIDATA_ID}`;
const VANGOGH_KEY = `wikidata:${VANGOGH_WIKIDATA_ID}`;

const AIC_KEY = 'atlas:place:art-institute-of-chicago';
const CEZANNE_NODE_KEY = 'atlas:creator:paul-cezanne';
const VANGOGH_NODE_KEY = 'atlas:creator:vincent-van-gogh';

/** A fake Qloo that RECORDS every call and fails closed on each one. */
function noCallQloo(): FakeQloo {
  return new FakeQloo({}, { live: true });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ScopedLibrary {
  accountId: string;
  origin: string;
  col: { id: string };
  connectionId: string;
  actx: ServiceContext;
}

/**
 * One reviewed `work_on_display_at` creator bridge on the Art Institute of
 * Chicago: the same DOCUMENTED_ASSOCIATION composition the reviewed corpus
 * ships for Rodin and Seurat, grounded in one reviewed AIC open-access
 * collection record (the same cited objects the manifest documents — The
 * Basket of Apples for Cézanne, The Bedroom for Van Gogh — each naming its
 * creator and its AIC gallery). This is an isolated-database TEST fixture:
 * it never claims corpus review beyond its own database and exists only so
 * the materialization stage performs successive real unique-index waits.
 */
async function admitCreatorBridge(db: PoolDb, which: 'cezanne' | 'vangogh'): Promise<void> {
  const fixture = {
    cezanne: {
      nodeKey: CEZANNE_NODE_KEY,
      familyKey: 'artic:111436:window-test-bridge',
      url: 'https://www.artic.edu/artworks/111436?window-test-bridge=cezanne',
      title: 'The Basket of Apples — AIC collection record (window-test bridge)',
      excerpt: 'Paul Cezanne (French, 1839–1906)',
    },
    vangogh: {
      nodeKey: VANGOGH_NODE_KEY,
      familyKey: 'artic:28560:window-test-bridge',
      url: 'https://www.artic.edu/artworks/28560?window-test-bridge=vangogh',
      title: 'The Bedroom — AIC collection record (window-test bridge)',
      excerpt: 'Vincent van Gogh (Dutch, 1853–1890)',
    },
  }[which];
  const creatorId = await nodeIdOf(db, fixture.nodeKey);
  const aicId = await nodeIdOf(db, AIC_KEY);
  const recorded = await recordSourceRevision(db, {
    provider: 'artic_open_access',
    url: fixture.url,
    title: fixture.title,
    publisher: 'The Art Institute of Chicago',
    attribution: 'The Art Institute of Chicago',
    license: 'CC0 1.0',
    locator: 'artist_display, gallery_title',
    sourceFamilyKey: fixture.familyKey,
    allowedDisplayMetadata: {
      title: fixture.title,
      publisher: 'The Art Institute of Chicago',
      license: 'CC0 1.0',
    },
    retentionPolicy: { content: 'permitted metadata fields only (no article text)', basis: 'CC0 metadata release' },
    rights: {
      license: 'CC0 1.0',
      permitted_use: ['storage', 'display'],
      expiry: 'none',
      basis: 'The AIC API states all non-description data in its responses is CC0 1.0; the cited fields are non-description data.',
    },
    documentHash: `scoped-window-materialization:${fixture.familyKey}`,
    rightsExpiresAt: null,
    retrievedAt: new Date('2026-10-29T00:00:00Z'),
  });
  const inserted = await insertEvidence(db, {
    sourceRevisionId: recorded.sourceRevisionId,
    permittedExcerpt: fixture.excerpt,
    validationMethod: 'provider_metadata',
    validationVersion: 'artic-api-1.16',
    evidenceKind: 'fact',
    reviewedBy: 'scoped window materialization test review',
    reviewedAt: new Date('2026-10-29T00:00:00Z'),
  });
  const upserted = await upsertGraphAssertion(db, {
    subjectNodeId: creatorId,
    predicate: 'DOCUMENTED_ASSOCIATION',
    objectNodeId: aicId,
    associationSubtype: 'work_on_display_at',
    status: 'validated',
  });
  await attachAssertionSupport(db, {
    assertionId: upserted.row.id,
    evidenceId: inserted.row.id,
    derivation: 'primary',
    sourceFamilyKey: fixture.familyKey,
  });
}

async function nodeIdOf(db: PoolDb, canonicalKey: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM graph_nodes WHERE canonical_key = $1', [
    canonicalKey,
  ]);
  if (!rows[0]) throw new Error(`expected the corpus identity ${canonicalKey}`);
  return rows[0]!.id;
}

/** One fresh scoped library on the given corpus database: owner + granted agent. */
async function scopedLibrary(db: PoolDb): Promise<ScopedLibrary> {
  const owner = await insertAccount(db);
  const ctx = testContext(owner, { db, config: graphOn });
  const rodinRef = await upsertReference(db, {
    canonicalKey: `qloo:${RODIN_QLOO_ID}`,
    name: 'Auguste Rodin',
    type: 'creator',
    externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
  });
  await upsertReference(db, {
    canonicalKey: `qloo:${SEURAT_QLOO_ID}`,
    name: 'Georges Seurat',
    type: 'creator',
    externalIds: { qloo: SEURAT_QLOO_ID, qloo_types: ['urn:entity:person'] },
  });
  const origin = await insertItem(
    { accountId: owner.accountId },
    { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
    db,
  );
  const col = await createCollection(ctx, { name: `Museum visits ${randomUUID().slice(0, 6)}` });
  await addCollectionItem(ctx, { id: col.id, item_id: origin, body: {} });
  const agent = await insertAgentConnection(
    owner,
    { scopes: ['collections:read', 'captures:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
    db,
  );
  await linkGraphReferenceIdentities(db);
  return {
    accountId: owner.accountId,
    origin,
    col,
    connectionId: agent.principal.connectionId,
    actx: testContext(agent.principal, { db, config: graphOn }),
  };
}

/**
 * The two extra candidates' application references, created at the exact
 * point a scenario needs them present. Until these exist the walk reaches
 * the Cézanne/Van Gogh nodes but resolves no reference, so a pass honestly
 * counts them as `candidatesWithoutReferences` and publishes only Seurat;
 * after it, all three candidates materialize.
 */
async function createNewCandidateReferences(db: PoolDb): Promise<void> {
  await upsertReference(db, {
    canonicalKey: CEZANNE_KEY,
    name: 'Paul Cézanne',
    type: 'creator',
    externalIds: { wikidata: CEZANNE_WIKIDATA_ID },
  });
  await upsertReference(db, {
    canonicalKey: VANGOGH_KEY,
    name: 'Vincent van Gogh',
    type: 'creator',
    externalIds: { wikidata: VANGOGH_WIKIDATA_ID },
  });
  await linkGraphReferenceIdentities(db);
}

/**
 * The deterministic processing order of the two extra candidates: every
 * admitted creator shares one midpoint (the Art Institute of Chicago) and
 * one approved template (`co_documented_association`), so scores tie and the
 * pass's documented order is node id ascending. The live-window control
 * below PINS this computation against the actually published ranks.
 */
async function expectedNewKeyOrder(db: PoolDb): Promise<[string, string]> {
  const { rows } = await db.query<{ key: string }>(
    `SELECT r.canonical_key AS key
       FROM graph_nodes n
       JOIN cultural_references r ON r.id = n.cultural_reference_id
      WHERE n.canonical_key IN ($1, $2)
      ORDER BY n.id`,
    [CEZANNE_NODE_KEY, VANGOGH_NODE_KEY],
  );
  if (rows.length !== 2) throw new Error('expected both extra candidate references durably linked');
  return [rows[0]!.key, rows[1]!.key];
}

/** Enqueue the real REST selected-collection operation and return its identities. */
async function enqueueScoped(
  db: PoolDb,
  lib: ScopedLibrary,
): Promise<{ jobId: string; discoveryJobId: string }> {
  const started = await startRelatedDiscovery(lib.actx, {
    id: lib.origin,
    body: { collection_id: lib.col.id, category: 'play' },
  });
  return { jobId: started.job_id, discoveryJobId: started.discovery_job_id };
}

async function authorityOf(
  db: PoolDb,
  lib: ScopedLibrary,
  discoveryJobId: string,
): Promise<ScopedDiscoveryGrantAuthority> {
  const authority = await discoveryGrantAuthorityForJob(db, {
    ownerAccountId: lib.accountId,
    discoveryJobId,
  });
  if (!authority) throw new Error('expected the enqueued scoped authority row');
  return authority;
}

/**
 * Re-anchors the discovery's ONE scoped work window by walking the
 * authority's own allowed closed path (exactly the retry/redelivery
 * semantics): DELETE + fresh INSERT keeping every pinned epoch and only
 * controlling the immutable work deadline the way the enqueue wrote it.
 */
async function reanchorWorkDeadline(db: PoolDb, discoveryJobId: string, workDeadlineAt: Date): Promise<void> {
  const { rowCount } = await db.query(
    `WITH old AS (DELETE FROM discovery_grant_authorities WHERE discovery_job_id = $1 RETURNING *)
     INSERT INTO discovery_grant_authorities
       (owner_account_id, discovery_job_id, job_id, agent_connection_id, authorization_version,
        collection_granted_at, origin_collection_id, origin_item_id, origin_saved_item_id, work_deadline_at)
     SELECT owner_account_id, discovery_job_id, job_id, agent_connection_id, authorization_version,
            collection_granted_at, origin_collection_id, origin_item_id, origin_saved_item_id, $2
       FROM old`,
    [discoveryJobId, workDeadlineAt],
  );
  if (rowCount !== 1) throw new Error('expected exactly one re-anchored authority row');
}

async function scopedRows(db: PoolDb, discoveryJobId: string): Promise<{ recs: number; proofs: number }> {
  const { rows: recs } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
    [discoveryJobId],
  );
  const { rows: proofs } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
    [discoveryJobId],
  );
  return { recs: Number(recs[0]!.n), proofs: Number(proofs[0]!.n) };
}

/** The ids the scoped parent published, in rank order. */
async function publishedItemIds(db: PoolDb, discoveryJobId: string): Promise<string[]> {
  const { rows } = await db.query<{ discovery_item_id: string }>(
    'SELECT discovery_item_id FROM recommendations WHERE discovery_job_id = $1 ORDER BY rank',
    [discoveryJobId],
  );
  return rows.map((r) => r.discovery_item_id);
}

/** The published items' canonical keys, in rank (== materialization) order. */
async function rankedCanonicalKeys(db: PoolDb, discoveryJobId: string): Promise<string[]> {
  const { rows } = await db.query<{ canonical_key: string }>(
    `SELECT di.canonical_key
       FROM recommendations r
       JOIN discovery_items di ON di.id = r.discovery_item_id
      WHERE r.discovery_job_id = $1
      ORDER BY r.rank`,
    [discoveryJobId],
  );
  return rows.map((r) => r.canonical_key);
}

/**
 * Fails honestly on timeout, so a barrier test cannot pass by racing past a
 * park: the observed wait MUST be a real lock waiter.
 */
async function waitForLockWaiters(db: PoolDb, pattern: string, atLeast: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND datname = current_database()`,
      [pattern],
    );
    if (Number(rows[0]!.n) >= atLeast) return;
    if (Date.now() >= deadline)
      throw new Error(`expected at least ${atLeast} lock waiter(s) matching ${pattern} within ${timeoutMs}ms`);
    await sleep(25);
  }
}

async function appErrorOf(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected the call to reject');
}

/**
 * A holder's timed ROLLBACK release (the competing same-key insert
 * disappears, so the parked pass's own upsert proceeds as a fresh insert).
 * The timer must never outlive the test that owns the client: `cancel()` in
 * the finally stops an un-fired timer and settles the promise; an
 * already-fired release settles when its ROLLBACK completes.
 */
function delayedRollback(client: PoolClient, ms: number): { promise: Promise<unknown>; cancel: () => void } {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  const timer = setTimeout(() => {
    client.query('ROLLBACK').then(() => resolve(undefined), () => resolve(undefined));
  }, ms);
  const cancel = () => {
    clearTimeout(timer);
    resolve(undefined);
  };
  return { promise, cancel };
}

/**
 * A competing uncommitted same-key catalog insert: it holds the owner's
 * (owner_account_id, canonical_key) unique-index entry, so the pass's
 * `INSERT ... ON CONFLICT` materialization upsert for that candidate blocks
 * on a real speculative-insertion lock wait until the holder rolls back —
 * exactly the waits other scoped jobs and the real compiler contend on.
 */
const COMPETING_INSERT = `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title)
   VALUES ($1, 'artist', 'play', $2, 'Competing parked insert')`;

async function runPass(
  db: PoolDb,
  authority: ScopedDiscoveryGrantAuthority,
): Promise<ScopedGraphDiscoveryOutcome> {
  return runScopedGraphDiscovery(db, { authority, category: 'play', ensureActive: async () => {} });
}

describe('the anchored window bounds successive nested materialization waits (DISC-SCR-041)', () => {
  it('two-connection successive canonical-key holders: the second materialization wait ends at the anchored deadline, whole rollback, old results intact, authority released', async () => {
    const created = await createIsolatedDatabase('scrdwmat');
    const isoDb = created.db;
    try {
      await admitGraphCorpus(isoDb, getCorpusManifestFile());
      const lib = await scopedLibrary(isoDb);
      const { jobId, discoveryJobId } = await enqueueScoped(isoDb, lib);
      const qloo = noCallQloo();

      // The OLD result: a first real run publishes while the two extra
      // candidates are not yet walkable — exactly one admitted result
      // (Seurat), one materialized item. This is the old publication a
      // near-expiry redelivery must preserve untouched.
      expect(
        (await runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) })).state,
      ).toBe('complete');
      expect(qloo.calls).toEqual([]);
      expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
      const oldItemIds = await publishedItemIds(isoDb, discoveryJobId);
      expect(oldItemIds).toHaveLength(1);

      // Now widen the corpus (the two reviewed creator bridges + the extra
      // candidates' application references): the replay's materialization
      // stage must upsert BOTH new catalog items, in the deterministic
      // order (equal template scores → node id ascending).
      await admitCreatorBridge(isoDb, 'cezanne');
      await admitCreatorBridge(isoDb, 'vangogh');
      await createNewCandidateReferences(isoDb);
      const [firstNewKey, secondNewKey] = await expectedNewKeyOrder(isoDb);

      // A short remaining window, exactly as a redelivery near the anchor's end
      // holds: the pass ENTERS legally and refreshes its bound at every actual
      // nested materialization wait.
      const windowMs = 2_500;
      const startedAt = Date.now();
      const windowEnd = startedAt + windowMs;
      await reanchorWorkDeadline(isoDb, discoveryJobId, new Date(windowEnd));
      const authority = await authorityOf(isoDb, lib, discoveryJobId);

      // Holder 1 parks the FIRST new candidate's key and releases mid-window;
      // holder 2 parks the SECOND and stays locked until long after the pass's
      // own refreshed bound must reject it.
      const h1 = await isoDb.pool.connect();
      const h2 = await isoDb.pool.connect();
      const releaseH1 = delayedRollback(h1, 1_500);
      const releaseH2 = delayedRollback(h2, 4_000);
      try {
        await h1.query('BEGIN');
        await h1.query(COMPETING_INSERT, [lib.accountId, firstNewKey]);
        await h2.query('BEGIN');
        await h2.query(COMPETING_INSERT, [lib.accountId, secondNewKey]);
        const pass = runPass(isoDb, authority);
        void pass.catch(() => undefined);
        // The first materialization wait is a REAL unique-index lock wait —
        // the pass really is inside the materialization loop when it rejects.
        await waitForLockWaiters(isoDb, '%INSERT INTO discovery_items%', 1);

        const err = await appErrorOf(() => pass);
        expect(err.code).toBe('service_unavailable');
        expect((err.details as { rule?: string }).rule).toBe('logical_deadline_expired');
        expect(err.retryable).toBe(false);
        const rejectedAt = Date.now();
        // Successive waits are real: the first holder's wait demonstrably
        // consumed time before the second one ever started…
        expect(rejectedAt - startedAt).toBeGreaterThanOrEqual(1_400);
        // …and the rejection landed while the SECOND holder was still parked
        // (its 4s release never fired): the pass stopped on its own bound.
        expect(rejectedAt - startedAt).toBeLessThan(3_500);
        // The second wait ended AT the anchored deadline, never the earlier
        // bound's full remaining window past it: the unfixed overshoot is the
        // whole first wait (~1.5s past the anchor), the refreshed one is the
        // statement-cancel latency alone.
        expect(rejectedAt - windowEnd).toBeLessThanOrEqual(400);
      } finally {
        releaseH1.cancel();
        releaseH2.cancel();
        await Promise.allSettled([releaseH1.promise, releaseH2.promise]);
        await h1.query('ROLLBACK').catch(() => undefined);
        await h2.query('ROLLBACK').catch(() => undefined);
        h1.release();
        h2.release();
      }

      // Prompt grant/collection/parent authority lock release: the rolled-back
      // pass holds nothing — every fence lock is acquirable NOWAIT the instant
      // the rejection returns, never held past the anchored window.
      await isoDb.query('SELECT 1 FROM agent_connections WHERE id = $1 FOR UPDATE NOWAIT', [lib.connectionId]);
      await isoDb.query('SELECT 1 FROM collections WHERE id = $1 FOR UPDATE NOWAIT', [lib.col.id]);
      await isoDb.query('SELECT 1 FROM discovery_jobs WHERE id = $1 FOR UPDATE NOWAIT', [discoveryJobId]);

      // Old result/proof preservation: the replay never reached its tail
      // DELETE, so the old publication is exactly what it was.
      expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
      expect(await publishedItemIds(isoDb, discoveryJobId)).toEqual(oldItemIds);

      // Rollback of the PARTIAL materialization: the first new candidate's
      // upsert SUCCEEDED mid-window (holder 1 released), yet no item row for
      // either new candidate exists — the whole pass rolled back together.
      const { rows: leftover } = await isoDb.query<{ canonical_key: string }>(
        'SELECT canonical_key FROM discovery_items WHERE owner_account_id = $1 AND canonical_key = ANY($2)',
        [lib.accountId, [firstNewKey, secondNewKey]],
      );
      expect(leftover).toEqual([]);

      // The redelivery anchor: the immutable window never moved, and the same
      // anchored job rejects the same typed way at entry — nothing published.
      const after = await authorityOf(isoDb, lib, discoveryJobId);
      expect(after.work_deadline_at.getTime()).toBe(authority.work_deadline_at.getTime());
      const replay = await appErrorOf(() => runPass(isoDb, after));
      expect(replay.code).toBe('service_unavailable');
      expect((replay.details as { rule?: string }).rule).toBe('logical_deadline_expired');
      expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
      expect(await publishedItemIds(isoDb, discoveryJobId)).toEqual(oldItemIds);
    } finally {
      await created.drop();
    }
  });

  it('live-window control: the pass publishes through successive REAL materialization lock waits, and rank order matches the documented tie-break', async () => {
    const created = await createIsolatedDatabase('scrdwmat');
    const isoDb = created.db;
    try {
      await admitGraphCorpus(isoDb, getCorpusManifestFile());
      await admitCreatorBridge(isoDb, 'cezanne');
      await admitCreatorBridge(isoDb, 'vangogh');
      const lib = await scopedLibrary(isoDb);
      await createNewCandidateReferences(isoDb);
      const { jobId, discoveryJobId } = await enqueueScoped(isoDb, lib);
      const qloo = noCallQloo();

      // Both extra candidates' canonical keys carry competing uncommitted
      // inserts that release mid-window: the pass must wait through the real
      // unique-index waits of BOTH materialization upserts inside the live
      // anchored window and still publish all three candidates.
      const [firstNewKey, secondNewKey] = await expectedNewKeyOrder(isoDb);
      const h1 = await isoDb.pool.connect();
      const h2 = await isoDb.pool.connect();
      const releaseH1 = delayedRollback(h1, 800);
      const releaseH2 = delayedRollback(h2, 1_600);
      try {
        await h1.query('BEGIN');
        await h1.query(COMPETING_INSERT, [lib.accountId, firstNewKey]);
        await h2.query('BEGIN');
        await h2.query(COMPETING_INSERT, [lib.accountId, secondNewKey]);
        const run = runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
        // A REAL materialization lock wait happened inside the live window.
        await waitForLockWaiters(isoDb, '%INSERT INTO discovery_items%', 1, 10_000);
        const out = await run;
        expect(out.state).toBe('complete');
      } finally {
        releaseH1.cancel();
        releaseH2.cancel();
        await Promise.allSettled([releaseH1.promise, releaseH2.promise]);
        await h1.query('ROLLBACK').catch(() => undefined);
        await h2.query('ROLLBACK').catch(() => undefined);
        h1.release();
        h2.release();
      }

      // All three creator candidates published with pinned proofs, zero
      // provider calls, and the deterministic rank order (equal template
      // scores → node id ascending) is exactly the computed order the
      // barrier case above relies on for its holder assignment.
      expect(qloo.calls).toEqual([]);
      expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 3, proofs: 3 });
      const keys = await rankedCanonicalKeys(isoDb, discoveryJobId);
      expect(keys).toHaveLength(3);
      expect(keys).toContain(`qloo:${SEURAT_QLOO_ID}`);
      expect(keys.filter((k) => k === CEZANNE_KEY || k === VANGOGH_KEY)).toEqual([firstNewKey, secondNewKey]);
    } finally {
      await created.drop();
    }
  });
});
