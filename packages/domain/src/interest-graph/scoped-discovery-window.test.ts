import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { upsertReference } from '../compiler/store';
import type { ServiceContext } from '../context';
import type { Db, PoolDb } from '../db/pool';
import { AppError } from '../errors';
import { addCollectionItem, createCollection, deleteCollection } from '../services/collections';
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
import { linkGraphReferenceIdentities } from './identity-links';
import { discoveryGrantAuthorityForJob, type ScopedDiscoveryGrantAuthority } from './scoped-discovery';
import { runScopedGraphDiscovery, type ScopedGraphDiscoveryOutcome } from './scoped-discovery-graph';

/**
 * The ordered publication window of the approved grant-scoped Discover more
 * producer (repairs round-8 DISC-SCR-035/038/040; VAL-DISC-007/008).
 *
 *  - DISC-SCR-040: the scoped publication transaction takes its collection
 *    lock BEFORE the discovery-parent lock, the same order the real
 *    deleteCollection path uses (collections FOR UPDATE, then the
 *    discovery_jobs.origin_collection_id ON DELETE SET NULL action must
 *    UPDATE the parent row). The old parent-first order could hold the
 *    parent while waiting on the collection the deleter held, a real 40P01
 *    deadlock cycle in both interleavings. Both concurrent orders are proven
 *    here with the REAL owner deletion and the real pass on two dedicated
 *    connections: deletion-first rejects the pass closed (the durable scoped
 *    marker keeps redelivery on the fail-closed path), and publisher-first
 *    commits the publication before the deletion lands — never a deadlock.
 *  - DISC-SCR-035: one anchored scoped work window (the immutable authority
 *    row's work_deadline_at, migration 400) survives retry and redelivery.
 *    Each of the pass's actual SQL and lock waits is bounded to the window's
 *    CURRENT remaining time — refreshed between waits, so two individually
 *    short waits cannot cumulatively outrun the anchor — and the final
 *    publication boundary re-reads the window with the database's own clock
 *    AFTER the tail DELETE/INSERT/proof writes, so an expired pass rolls
 *    back with no partial scoped results and no provider fallback.
 *  - DISC-SCR-038: grant authority is held as needed (the fence's FOR SHARE
 *    locks) and the connection's ACTUAL expiry is rechecked against a fresh
 *    database clock after the fence's own waits and after the tail writes,
 *    just before the commit — so a connection that expires during an
 *    intervening wait can never authorize new private output. The typed
 *    token_expired outcome stays distinct from the logical
 *    deadline-expired outcome of the work window.
 */

const graphOn = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});

/** Verified live Qloo entity ids (see the manifest provenance). */
const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';

let isoDb: PoolDb;
let dropIso: () => Promise<void>;

beforeAll(async () => {
  const created = await createIsolatedDatabase('scrdwin');
  isoDb = created.db;
  dropIso = created.drop;
  await admitGraphCorpus(isoDb, getCorpusManifestFile());
});
afterAll(async () => {
  await dropIso();
});

/** A fake Qloo that RECORDS every call and fails closed on each one. */
function noCallQloo(): FakeQloo {
  return new FakeQloo({}, { live: true });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ScopedLibrary {
  accountId: string;
  ownerCtx: ServiceContext;
  origin: string;
  col: { id: string };
  connectionId: string;
  actx: ServiceContext;
}

/** One fresh scoped library on the shared corpus database: owner + granted agent. */
async function scopedLibrary(): Promise<ScopedLibrary> {
  const owner = await insertAccount(isoDb);
  const ctx = testContext(owner, { db: isoDb, config: graphOn });
  const rodinRef = await upsertReference(isoDb, {
    canonicalKey: `qloo:${RODIN_QLOO_ID}`,
    name: 'Auguste Rodin',
    type: 'creator',
    externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
  });
  await upsertReference(isoDb, {
    canonicalKey: `qloo:${SEURAT_QLOO_ID}`,
    name: 'Georges Seurat',
    type: 'creator',
    externalIds: { qloo: SEURAT_QLOO_ID, qloo_types: ['urn:entity:person'] },
  });
  const origin = await insertItem(
    { accountId: owner.accountId },
    { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
    isoDb,
  );
  const col = await createCollection(ctx, { name: `Museum visits ${randomUUID().slice(0, 6)}` });
  await addCollectionItem(ctx, { id: col.id, item_id: origin, body: {} });
  const agent = await insertAgentConnection(
    owner,
    { scopes: ['collections:read', 'captures:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
    isoDb,
  );
  await linkGraphReferenceIdentities(isoDb);
  return {
    accountId: owner.accountId,
    ownerCtx: ctx,
    origin,
    col,
    connectionId: agent.principal.connectionId,
    actx: testContext(agent.principal, { db: isoDb, config: graphOn }),
  };
}

/** Enqueue the real REST selected-collection operation and return its identities. */
async function enqueueScoped(lib: ScopedLibrary): Promise<{ jobId: string; discoveryJobId: string }> {
  const started = await startRelatedDiscovery(lib.actx, {
    id: lib.origin,
    body: { collection_id: lib.col.id, category: 'play' },
  });
  return { jobId: started.job_id, discoveryJobId: started.discovery_job_id };
}

async function authorityOf(lib: ScopedLibrary, discoveryJobId: string): Promise<ScopedDiscoveryGrantAuthority> {
  const authority = await discoveryGrantAuthorityForJob(isoDb, {
    ownerAccountId: lib.accountId,
    discoveryJobId,
  });
  if (!authority) throw new Error('expected the enqueued scoped authority row');
  return authority;
}

/**
 * Re-anchors the discovery's ONE scoped work window by walking the
 * authority's own allowed closed path: DELETE (exactly the enqueue
 * transaction's dedupe-race cleanup) followed by a fresh INSERT that keeps
 * EVERY pinned epoch and only controls the immutable work deadline the way
 * the enqueue wrote it. This is exactly what retry/redelivery semantics
 * exercise: the row pins one window per discovery forever.
 */
async function reanchorWorkDeadline(discoveryJobId: string, workDeadlineAt: Date): Promise<void> {
  const { rowCount } = await isoDb.query(
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

async function scopedRows(discoveryJobId: string): Promise<{ recs: number; proofs: number }> {
  const { rows: recs } = await isoDb.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
    [discoveryJobId],
  );
  const { rows: proofs } = await isoDb.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
    [discoveryJobId],
  );
  return { recs: Number(recs[0]!.n), proofs: Number(proofs[0]!.n) };
}

/** The ids the scoped parent published, in rank order. */
async function publishedItemIds(discoveryJobId: string): Promise<string[]> {
  const { rows } = await isoDb.query<{ discovery_item_id: string }>(
    'SELECT discovery_item_id FROM recommendations WHERE discovery_job_id = $1 ORDER BY rank',
    [discoveryJobId],
  );
  return rows.map((r) => r.discovery_item_id);
}

/** The recommendation ROW ids (a delete+rebuild replay replaces them). */
async function recommendationIds(discoveryJobId: string): Promise<string[]> {
  const { rows } = await isoDb.query<{ id: string }>(
    'SELECT id FROM recommendations WHERE discovery_job_id = $1 ORDER BY rank',
    [discoveryJobId],
  );
  return rows.map((r) => r.id);
}

/** A Db view of one dedicated pool client that joins the CALLER's already-open transaction. */
function openTransactionDb(client: PoolClient): Db {
  const self: Db = {
    inTransaction: true,
    query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
      return client.query<R>(text, params as unknown[] | undefined);
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(self);
    },
  };
  return self;
}

/**
 * A transaction Db whose FIRST query matching `parkPattern` is held back
 * until `open()` — the pass runs its exact production statements while the
 * test controls exactly one scheduling boundary.
 */
function gatedTransactionDb(client: PoolClient, parkPattern: RegExp): { db: Db; open: () => void } {
  const base = openTransactionDb(client);
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let parked = false;
  const self: Db = {
    inTransaction: true,
    query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
      if (!parked && parkPattern.test(text)) {
        parked = true;
        return gate.then(() => base.query<R>(text, params));
      }
      return base.query<R>(text, params);
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(self);
    },
  };
  return { db: self, open: () => openGate() };
}

/**
 * Fails honestly on timeout, so a barrier test cannot pass by racing past the
 * park: the observed wait MUST be a real lock waiter.
 */
async function waitForLockWaiters(pattern: string, atLeast: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await isoDb.query<{ n: number }>(
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

/** NOWAIT probe proving the parked pass holds the discovery parent row lock. */
async function waitForHeldParentRow(discoveryJobId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await isoDb.query('SELECT id FROM discovery_jobs WHERE id = $1 FOR UPDATE NOWAIT', [discoveryJobId]);
    } catch (err) {
      if ((err as { code?: string }).code === '55P03') return;
      throw err;
    }
    if (Date.now() >= deadline) throw new Error('pass never acquired the discovery parent lock');
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
 * A holder's timed COMMIT release. The timer must never outlive the test
 * that owns the client: a floating COMMIT firing after the client went back
 * to the shared pool commits whatever LATER test borrowed that client —
 * silently releasing its locks mid-assertion (and, after pool end, an
 * unhandled "Client was closed"). `cancel()` in the finally stops an
 * un-fired timer and settles the promise; an already-fired release settles
 * when its COMMIT completes.
 */
function delayedCommit(client: PoolClient, ms: number): { promise: Promise<unknown>; cancel: () => void } {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  const timer = setTimeout(() => {
    client.query('COMMIT').then(() => resolve(undefined), () => resolve(undefined));
  }, ms);
  const cancel = () => {
    clearTimeout(timer);
    resolve(undefined);
  };
  return { promise, cancel };
}

async function runPass(
  authority: ScopedDiscoveryGrantAuthority,
): Promise<ScopedGraphDiscoveryOutcome> {
  return runScopedGraphDiscovery(isoDb, { authority, category: 'play', ensureActive: async () => {} });
}

// --- DISC-SCR-040: the collection lock precedes the discovery parent ----------

describe('the scoped pass orders its collection lock with real collection deletion (DISC-SCR-040)', () => {
  it('deletion-first: a deletion parked on the parent row lets the pass queue on the collection, then reject closed — no 40P01 cycle', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = await authorityOf(lib, discoveryJobId);

    // A dedicated connection parks the DISCOVERY PARENT row: the real
    // deleteCollection below takes the collections FOR UPDATE first and then
    // parks mid-delete on its ON DELETE SET NULL action for this row.
    const holder = await isoDb.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM discovery_jobs WHERE id = $1 FOR UPDATE', [discoveryJobId]);

      // The REAL owner deletion on its own connection: it holds the
      // collection lock and waits on the parent (the FK action).
      const del = deleteCollection(lib.ownerCtx, { id: lib.col.id });
      void del.catch(() => undefined);
      await waitForLockWaiters('%DELETE FROM collections%', 1);

      // The real pass: with the collection locked ahead of the parent it
      // QUEUES on the collection row (never taking the parent lock behind
      // the deletion), so the two transactions form no cycle.
      const pass = runPass(authority);
      void pass.catch(() => undefined);
      await waitForLockWaiters('%FROM collections WHERE id = $1 AND owner_account_id = $2 FOR SHARE%', 1);

      // The parked parent row releases: the deletion completes and commits,
      // and the pass then observes the collection is gone.
      await holder.query('COMMIT');
      await del;
      const err = await appErrorOf(() => pass);
      expect(err.code).toBe('not_found');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // Ordered resource-change outcome: nothing published, the deletion
    // landed (collection gone, parent de-collectioned, authority cascaded
    // away) and the durable marker keeps the job on the fail-closed path.
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
    const { rows: cols } = await isoDb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM collections WHERE id = $1',
      [lib.col.id],
    );
    expect(Number(cols[0]!.n)).toBe(0);
    const { rows: dj } = await isoDb.query<{ origin_collection_id: string | null; scoped_authority_required: boolean }>(
      'SELECT origin_collection_id, scoped_authority_required FROM discovery_jobs WHERE id = $1',
      [discoveryJobId],
    );
    expect(dj[0]!.origin_collection_id).toBeNull();
    expect(dj[0]!.scoped_authority_required).toBe(true);
    expect(
      await discoveryGrantAuthorityForJob(isoDb, { ownerAccountId: lib.accountId, discoveryJobId }),
    ).toBeNull();

    // Redelivery of the scoped job fails closed through the marker — never
    // the legacy provider path, never a stale publication.
    const qloo = noCallQloo();
    const replay = await appErrorOf(() =>
      runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) }),
    );
    expect(replay.code).toBe('not_found');
    expect(qloo.calls).toEqual([]);
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
  });

  it('publisher-first: the pass holds the collection lock before the parent, so a real deletion queues behind the publication — no 40P01 cycle', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = await authorityOf(lib, discoveryJobId);

    // The pass runs on a dedicated open transaction and is parked at its
    // origin re-read — a statement that comes AFTER both the fence locks
    // and the parent lock in either ordering of them. The real deletion
    // fires while the pass is parked: with the fence-first order it can
    // only queue on the held collection lock; with the old parent-first
    // order the deletion holds the collection, waits on the parent the
    // pass holds, and the pass then waits on the collection — the 40P01
    // cycle this repair removes.
    const client = await isoDb.pool.connect();
    let committed = false;
    const gated = gatedTransactionDb(client, /SELECT id, canonical_key FROM discovery_items/);
    let pass: Promise<ScopedGraphDiscoveryOutcome> | undefined;
    try {
      await client.query('BEGIN');
      pass = runScopedGraphDiscovery(gated.db, {
        authority,
        category: 'play',
        ensureActive: async () => {},
      });
      void pass.catch(() => undefined);
      // The pass parks at its origin re-read: it provably holds the parent
      // row lock at that point in either order.
      await waitForHeldParentRow(discoveryJobId);

      // The REAL owner deletion on its own connection.
      const del = deleteCollection(lib.ownerCtx, { id: lib.col.id });
      void del.catch(() => undefined);
      // The deletion must QUEUE behind the publisher's held collection lock
      // (it parks at its own FOR UPDATE acquire, before its DELETE runs).
      await waitForLockWaiters('%FROM collections WHERE id = $1 AND owner_account_id = $2 FOR UPDATE%', 1);

      // The publisher resumes and commits FIRST, under the authority it
      // holds; the deletion then lands.
      gated.open();
      const outcome = await pass;
      expect(outcome.state).toBe('complete');
      await client.query('COMMIT');
      committed = true;
      await del;
    } finally {
      // A failed attempt must never leave the pass parked on the gate with
      // the client's transaction open (a released mid-transaction client
      // poisons the shared pool for later tests). Un-park, let the pass
      // settle, then roll back and return a clean client.
      gated.open();
      await pass?.catch(() => undefined);
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // Ordered publisher-first outcome: the results were published under valid
    // authority, the deletion landed after them, and the durable marker
    // keeps every later redelivery on the fail-closed path.
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const published = await publishedItemIds(discoveryJobId);
    expect(published).toHaveLength(1);
    const { rows: dj } = await isoDb.query<{ origin_collection_id: string | null; scoped_authority_required: boolean }>(
      'SELECT origin_collection_id, scoped_authority_required FROM discovery_jobs WHERE id = $1',
      [discoveryJobId],
    );
    expect(dj[0]!.origin_collection_id).toBeNull();
    expect(dj[0]!.scoped_authority_required).toBe(true);
    expect(
      await discoveryGrantAuthorityForJob(isoDb, { ownerAccountId: lib.accountId, discoveryJobId }),
    ).toBeNull();
    const qloo = noCallQloo();
    const replay = await appErrorOf(() =>
      runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) }),
    );
    expect(replay.code).toBe('not_found');
    expect(qloo.calls).toEqual([]);
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
  });
});

// --- DISC-SCR-035: the anchored durable window bounds the real waits ------------

describe('the anchored scoped work window bounds every real wait (DISC-SCR-035)', () => {
  it('a window that already ended refuses the pass before any work — twice: redelivery inherits the same anchor, never a fresh one', async () => {
    const lib = await scopedLibrary();
    const { discoveryJobId } = await enqueueScoped(lib);
    // The job's window was anchored long before this claim (worker restart,
    // long queue) and has ended: every attempt inherits the same row.
    await reanchorWorkDeadline(discoveryJobId, new Date(Date.now() - 60_000));
    const authority = await authorityOf(lib, discoveryJobId);

    const first = await appErrorOf(() => runPass(authority));
    expect(first.code).toBe('service_unavailable');
    expect((first.details as { rule?: string })?.rule).toBe('logical_deadline_expired');
    expect(first.retryable).toBe(false);
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });

    // The redelivery inherits the SAME durable anchor: it rejects the same
    // way and the immutable row never moved.
    const second = await appErrorOf(() => runPass(authority));
    expect(second.code).toBe('service_unavailable');
    expect((second.details as { rule?: string })?.rule).toBe('logical_deadline_expired');
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
    const after = await authorityOf(lib, discoveryJobId);
    expect(after.work_deadline_at.getTime()).toBe(authority.work_deadline_at.getTime());
  });

  it('successive waits refresh the remaining bound: the second wait ends at the anchored deadline, never a full window later', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    // A live window publishes (the positive control for this fixture).
    expect(
      (await runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) })).state,
    ).toBe('complete');
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const before = await publishedItemIds(discoveryJobId);

    // The pinned dependency rows of this exact published path.
    const { rows: proof } = await isoDb.query<{ assertion_ids: string[]; evidence_ids: string[] }>(
      'SELECT assertion_ids, evidence_ids FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
      [discoveryJobId],
    );
    expect(proof).toHaveLength(1);

    // A short remaining window, exactly as a redelivery near the anchor's
    // end holds: the pass ENTERS legally.
    const windowMs = 1_400;
    const startedAt = Date.now();
    const windowEnd = startedAt + windowMs;
    await reanchorWorkDeadline(discoveryJobId, new Date(windowEnd));
    const authority = await authorityOf(lib, discoveryJobId);

    // Holder 1 parks the assertion pin rows and releases mid-window; holder
    // 2 parks the evidence pin rows and stays locked until the pass's own
    // refreshed bound rejects it (the cancellable release keeps a broken run
    // from leaking a floating COMMIT into a later test's client).
    const h1 = await isoDb.pool.connect();
    const h2 = await isoDb.pool.connect();
    const releaseH1 = delayedCommit(h1, 700);
    const releaseH2 = delayedCommit(h2, 4_000);
    try {
      await h1.query('BEGIN');
      await h1.query('SELECT id FROM graph_assertions WHERE id = ANY($1::uuid[]) FOR UPDATE', [
        proof[0]!.assertion_ids,
      ]);
      await h2.query('BEGIN');
      await h2.query('SELECT id FROM graph_evidence WHERE id = ANY($1::uuid[]) FOR UPDATE', [
        proof[0]!.evidence_ids,
      ]);
      const pass = runPass(authority);
      void pass.catch(() => undefined);

      // The rejection must land WHILE the second holder is still locked —
      // the pass stops on its own refreshed bound, not on a release.
      const err = await appErrorOf(() => pass);
      expect(err.code).toBe('service_unavailable');
      expect((err.details as { rule?: string })?.rule).toBe('logical_deadline_expired');
      const rejectedAt = Date.now();
      // The first wait demonstrably consumed time (successive waits, not an
      // immediate rejection)…
      expect(rejectedAt - startedAt).toBeGreaterThanOrEqual(600);
      // …and the second wait ended AT the anchored deadline, never a full
      // entry-bound window past it.
      expect(rejectedAt - windowEnd).toBeLessThanOrEqual(800);
    } finally {
      releaseH1.cancel();
      releaseH2.cancel();
      await Promise.allSettled([releaseH1.promise, releaseH2.promise]);
      await h1.query('ROLLBACK').catch(() => undefined);
      await h2.query('ROLLBACK').catch(() => undefined);
      h1.release();
      h2.release();
    }

    // The whole pass rolled back: the previously published rows survive
    // untouched — no partial scoped results.
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    expect(await publishedItemIds(discoveryJobId)).toEqual(before);
  });

  it('a tail wait past the anchored deadline rolls the writes back: the typed outcome, the old results intact, no provider fallback', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    expect(
      (await runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) })).state,
    ).toBe('complete');
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const before = await publishedItemIds(discoveryJobId);

    // The replay pass enters with a short remaining window.
    const windowMs = 1_000;
    const windowEnd = Date.now() + windowMs;
    await reanchorWorkDeadline(discoveryJobId, new Date(windowEnd));
    const authority = await authorityOf(lib, discoveryJobId);

    // The tail DELETE of the existing recommendations parks on a real
    // holder that stays locked until the pass's own anchored deadline rolls
    // the writes back: the pass's writes must not resume and commit after
    // expiry (the cancellable release never leaks a floating COMMIT).
    const holder = await isoDb.pool.connect();
    const releaseHolder = delayedCommit(holder, 4_000);
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM recommendations WHERE discovery_job_id = $1 FOR UPDATE', [discoveryJobId]);
      const pass = runPass(authority);
      void pass.catch(() => undefined);
      await waitForLockWaiters('%DELETE FROM recommendations%', 1);

      const err = await appErrorOf(() => pass);
      expect(err.code).toBe('service_unavailable');
      expect((err.details as { rule?: string })?.rule).toBe('logical_deadline_expired');
      expect(Date.now() - windowEnd).toBeLessThanOrEqual(900);
    } finally {
      releaseHolder.cancel();
      await releaseHolder.promise;
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // No partial scoped results: the previously published rows are exactly
    // what they were before the expired pass.
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    expect(await publishedItemIds(discoveryJobId)).toEqual(before);
  });

  it('a live window survives a real lock wait: the pass still publishes (the control)', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    expect(
      (await runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) })).state,
    ).toBe('complete');
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const before = await publishedItemIds(discoveryJobId);

    const { rows: proof } = await isoDb.query<{ assertion_ids: string[] }>(
      'SELECT assertion_ids FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
      [discoveryJobId],
    );
    // A full live window: a real mid-pass wait inside it must not reject.
    await reanchorWorkDeadline(discoveryJobId, new Date(Date.now() + 45_000));
    const authority = await authorityOf(lib, discoveryJobId);
    const recIdsBefore = await recommendationIds(discoveryJobId);

    const holder = await isoDb.pool.connect();
    const release = delayedCommit(holder, 400);
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM graph_assertions WHERE id = ANY($1::uuid[]) FOR UPDATE', [
        proof[0]!.assertion_ids,
      ]);
      const outcome = await runPass(authority);
      expect(outcome.state).toBe('complete');
      await release.promise;
    } finally {
      release.cancel();
      await release.promise;
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    // The replay rebuilt the rail under the live window (fresh recommendation
    // rows on the same materialized candidate item).
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    expect(await publishedItemIds(discoveryJobId)).toEqual(before);
    expect(await recommendationIds(discoveryJobId)).not.toEqual(recIdsBefore);
  });
});

// --- DISC-SCR-038: grant expiry is rechecked with a fresh clock at publication ---

describe('grant expiry during intervening waits rejects the publication (DISC-SCR-038)', () => {
  it('a connection that expires during the fence collection wait rejects with token_expired, never a publication', async () => {
    const lib = await scopedLibrary();
    const { discoveryJobId } = await enqueueScoped(lib);
    const authority = await authorityOf(lib, discoveryJobId);

    // The connection is still live when the fence starts, but expires while
    // the pass WAITS on a real collection mutation's lock.
    await isoDb.query(`UPDATE agent_connections SET expires_at = now() + interval '900 milliseconds' WHERE id = $1`, [
      lib.connectionId,
    ]);
    const holder = await isoDb.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM collections WHERE id = $1 FOR UPDATE', [lib.col.id]);
      const pass = runPass(authority);
      void pass.catch(() => undefined);
      await waitForLockWaiters('%FROM collections WHERE id = $1 AND owner_account_id = $2 FOR SHARE%', 1);
      // Let the connection actually expire while the pass is parked on the
      // collection wait; the work window (45 s) is still live — this is the
      // grant's own death, distinct from the logical deadline.
      await sleep(1_100);
      await holder.query('COMMIT');

      const err = await appErrorOf(() => pass);
      expect(err.code).toBe('token_expired');
      expect((err.details as { rule?: string } | null)?.rule ?? null).toBeNull();
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
  });

  it('a connection that expires during the tail writes rejects at the final boundary: the old results survive intact', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    expect(
      (await runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) })).state,
    ).toBe('complete');
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const before = await publishedItemIds(discoveryJobId);

    // A fresh live window for the replay (the deadline is NOT the story
    // here): only the grant expires, mid-pass, during the tail wait.
    await reanchorWorkDeadline(discoveryJobId, new Date(Date.now() + 45_000));
    const authority = await authorityOf(lib, discoveryJobId);
    await isoDb.query(`UPDATE agent_connections SET expires_at = now() + interval '800 milliseconds' WHERE id = $1`, [
      lib.connectionId,
    ]);

    const holder = await isoDb.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM recommendations WHERE discovery_job_id = $1 FOR UPDATE', [discoveryJobId]);
      const pass = runPass(authority);
      void pass.catch(() => undefined);
      await waitForLockWaiters('%DELETE FROM recommendations%', 1);
      // The grant expires while the tail DELETE waits.
      await sleep(1_000);
      await holder.query('COMMIT');

      const err = await appErrorOf(() => pass);
      expect(err.code).toBe('token_expired');
      expect((err.details as { rule?: string } | null)?.rule ?? null).toBeNull();
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // The whole publication rolled back: no partial scoped results, and the
    // previously published rows are exactly what they were.
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    expect(await publishedItemIds(discoveryJobId)).toEqual(before);
  });
});
