import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { upsertReference } from '../compiler/store';
import type { ServiceContext } from '../context';
import type { Db, PoolDb } from '../db/pool';
import { AppError } from '../errors';
import { JobCancelledError } from '../jobs/handler';
import { resolvePrincipal } from '../services/auth';
import { narrowConnection } from '../services/agent-platform';
import { revokeAgentConnection, updateAgentConnection } from '../services/agent-connections';
import { addCollectionItem, createCollection, deleteCollection, removeCollectionItem } from '../services/collections';
import { getJob } from '../services/jobs';
import { getItem, startRelatedDiscovery } from '../services/items';
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
import { expandAccountInterestGraph } from './expansion';
import { linkGraphReferenceIdentities } from './identity-links';
import { pauseGraphDiscovery } from './refresh';
import { projectAccountInterestGraph } from './projector';
import { discoveryGrantAuthorityForJob } from './scoped-discovery';
import { runScopedGraphDiscovery } from './scoped-discovery-graph';

/**
 * The publication fence and read denial of the approved grant-scoped
 * Discover more producer (VAL-DISC-007; completes VAL-DISC-009).
 *
 * The scoped graph pass publishes under the authority it was ENQUEUED with:
 * inside its publication transaction it locks the initiating connection's
 * row and the origin collection's row (FOR SHARE, held through the commit),
 * then rechecks the pinned epoch against CURRENT live state — connection
 * liveness, authorization version, the per-collection grant epoch, collection
 * ownership and the origin's membership. Real owner revocation, v1/v2
 * narrowing, grant remove/regrant, membership removal and collection
 * deletion therefore serialize with publication in BOTH orders:
 *
 *  - authority/resource change FIRST: the fence sees the changed live state
 *    and rejects the work — nothing publishes, no provider call happens, and
 *    retry, redelivery or a later regrant can never adopt the newer epoch
 *    (the authority row is immutable and the fence compares its pins);
 *  - publisher FIRST: the change waits on the held locks, the publication
 *    commits under valid authority, and the change then lands — after which
 *    agent reads of the previously published results deny IMMEDIATELY
 *    (authentication, job polling and the cached related rail all recheck
 *    current grant/membership per request).
 *
 * A deleted origin collection cascades the immutable authority row away, so
 * the discovery job carries a durable scoped marker: with graph discovery
 * enabled, a scoped job whose authority is gone fails closed — it can never
 * silently fall back to the legacy provider path. With graph discovery
 * disabled, the existing Discover more behavior stays byte-identical (the
 * provider path runs and reads deny the same way they always did).
 *
 * Independently account-authorized graph work stays account-owned: revoking
 * an unrelated agent grant never invalidates an expansion's authority, and
 * the discovery pause never fences this explicit per-origin operation.
 */

const graphOn = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});
const graphOff = testConfig();

/** Verified live Qloo entity ids (see the manifest provenance). */
const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';

let isoDb: PoolDb;
let dropIso: () => Promise<void>;

beforeAll(async () => {
  const created = await createIsolatedDatabase('scrdrev');
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

async function qlooPersonReference(db: PoolDb, qlooId: string, name: string): Promise<string> {
  return upsertReference(db, {
    canonicalKey: `qloo:${qlooId}`,
    name,
    type: 'creator',
    externalIds: { qloo: qlooId, qloo_types: ['urn:entity:person'] },
  });
}

interface ScopedLibrary {
  accountId: string;
  owner: { accountId: string };
  ownerCtx: ServiceContext;
  origin: string;
  col: { id: string };
  connectionId: string;
  credential: string;
  seuratRef: string;
  actx: ServiceContext;
}

/** One fresh scoped library on the shared corpus database: owner + granted agent. */
async function scopedLibrary(): Promise<ScopedLibrary> {
  const owner = await insertAccount(isoDb);
  const ctx = testContext(owner, { db: isoDb, config: graphOn });
  const rodinRef = await qlooPersonReference(isoDb, RODIN_QLOO_ID, 'Auguste Rodin');
  const seuratRef = await qlooPersonReference(isoDb, SEURAT_QLOO_ID, 'Georges Seurat');
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
    owner,
    ownerCtx: ctx,
    origin,
    col,
    connectionId: agent.principal.connectionId,
    credential: agent.credential,
    seuratRef,
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

/** The fresh per-request agent principal the REST/MCP layers resolve on every call. */
async function freshAgentCtx(lib: ScopedLibrary, config = graphOn): Promise<ServiceContext> {
  const principal = await resolvePrincipal(isoDb, { authorization: `Bearer ${lib.credential}` });
  expect(principal?.kind).toBe('agent');
  return testContext(principal!, { db: isoDb, config });
}

/**
 * A Db view of one dedicated pool client that joins the CALLER's already-open
 * transaction instead of issuing its own BEGIN/COMMIT: the real pass runs its
 * exact production statements while the test holds the commit barrier on
 * that connection.
 */
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
 * Fails honestly on timeout, so a barrier test cannot pass by racing past the
 * park: the mutator's in-flight query MUST be observed as a lock waiter.
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Polls until the parked publisher provably holds the row lock: a NOWAIT
 * conflicting probe fails with SQLSTATE 55P03 exactly while the pass holds
 * the fence lock. This makes firing the mutator deterministic — the mutator
 * can then ONLY queue, never land first.
 */
async function waitForHeldLock(sql: string, params: readonly unknown[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await isoDb.query(sql, params);
    } catch (err) {
      if ((err as { code?: string }).code === '55P03') return;
      throw err;
    }
    if (Date.now() >= deadline)
      throw new Error(`publisher never acquired the fence lock (${sql.slice(0, 60)}…) within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
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

// --- The fence rejects stale authority (authority/resource change first) ---------

describe('scoped publication fence rejects stale authority (VAL-DISC-007)', () => {
  it('an unchanged authority publishes: the positive control', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const out = await runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) });
    expect(out.state).toBe('complete');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
  });

  it('a revoked connection rejects the delayed work: no publication, typed failure, retry cannot adopt', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId,
    }))!;
    // Real owner revocation, before the delayed work runs.
    await revokeAgentConnection(lib.ownerCtx, { id: lib.connectionId });

    const qloo = noCallQloo();
    const err = await appErrorOf(() =>
      runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) }),
    );
    expect(err.code).toBe('token_revoked');
    // Nothing published, no provider spend, and the parent honestly never completed.
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
    expect(qloo.calls).toEqual([]);
    const { rows: dj } = await isoDb.query<{ status: string }>('SELECT status FROM discovery_jobs WHERE id = $1', [
      discoveryJobId,
    ]);
    expect(dj[0]!.status).not.toBe('complete');
    const { rows: job } = await isoDb.query<{ state: string; error_code: string | null }>(
      'SELECT state, error_code FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(job[0]).toMatchObject({ state: 'failed', error_code: 'token_revoked' });

    // Redelivery of the same pinned authority still rejects: the immutable
    // row cannot adopt the post-revocation state.
    const replayErr = await appErrorOf(() =>
      runScopedGraphDiscovery(isoDb, { authority, category: 'play', ensureActive: async () => {} }),
    );
    expect(replayErr.code).toBe('token_revoked');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
  });

  it('an expired connection rejects the delayed work: token_expired, nothing published', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    await isoDb.query(`UPDATE agent_connections SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      lib.connectionId,
    ]);
    const err = await appErrorOf(() => runJob(jobId, { db: isoDb, config: graphOn }));
    expect(err.code).toBe('token_expired');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
  });

  it('a v2 narrowed connection (version bump) rejects the delayed work and keeps the pinned epoch', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const before = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId,
    }))!;
    // Real owner narrowing: the v2 path bumps the authorization version.
    await narrowConnection(lib.ownerCtx, lib.connectionId, { scopes: ['collections:read'] });

    const err = await appErrorOf(() => runJob(jobId, { db: isoDb, config: graphOn }));
    expect(err.code).toBe('token_revoked');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
    // The pinned authority row itself never adopted the newer version.
    const after = await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId,
    });
    expect(after?.authorization_version).toBe(before.authorization_version);
    const { rows: live } = await isoDb.query<{ authorization_version: number }>(
      'SELECT authorization_version FROM agent_connections WHERE id = $1',
      [lib.connectionId],
    );
    expect(live[0]!.authorization_version).toBe(before.authorization_version! + 1);
  });

  it('a v1 grant replace removing the collection rejects the delayed work; regrant cannot adopt the old epoch', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId,
    }))!;
    // Real owner v1 replace: the granted collection is removed (the grant row
    // vanishes at an unchanged authorization version).
    await updateAgentConnection(lib.ownerCtx, { id: lib.connectionId, body: { collection_ids: [] } });
    const err = await appErrorOf(() => runJob(jobId, { db: isoDb, config: graphOn }));
    expect(err.code).toBe('not_found');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 0, proofs: 0 });

    // The owner regrants the same collection (a fresh grant epoch at the
    // unchanged version): the delayed job STILL rejects — only a fresh
    // enqueue pins the new epoch.
    await updateAgentConnection(lib.ownerCtx, { id: lib.connectionId, body: { collection_ids: [lib.col.id] } });
    const replayErr = await appErrorOf(() =>
      runScopedGraphDiscovery(isoDb, { authority, category: 'play', ensureActive: async () => {} }),
    );
    expect(replayErr.code).toBe('not_found');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 0, proofs: 0 });

    // A fresh enqueue under the regranted epoch publishes normally.
    const fresh = await enqueueScoped(lib);
    const out = await runJob(fresh.jobId, { db: isoDb, config: graphOn });
    expect(out.state).toBe('complete');
    expect(await scopedRows(isoDb, fresh.discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const freshAuthority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId: fresh.discoveryJobId,
    }))!;
    expect(freshAuthority.collection_granted_at!.getTime()).toBeGreaterThan(
      authority.collection_granted_at!.getTime(),
    );
  });

  it('a removed origin membership rejects the delayed work (agent-initiated and owner-initiated)', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    // Real owner membership removal from the granted collection.
    await removeCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: lib.origin });
    const err = await appErrorOf(() => runJob(jobId, { db: isoDb, config: graphOn }));
    expect(err.code).toBe('not_found');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 0, proofs: 0 });

    // The resource fence is the same for a first-party owner-initiated scoped
    // discovery: membership loss rejects the delayed work.
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: lib.origin, body: {} });
    const ownerStarted = await startRelatedDiscovery(lib.ownerCtx, {
      id: lib.origin,
      body: { collection_id: lib.col.id, category: 'play' },
    });
    await removeCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: lib.origin });
    const ownerErr = await appErrorOf(() => runJob(ownerStarted.job_id, { db: isoDb, config: graphOn }));
    expect(ownerErr.code).toBe('not_found');
    expect(await scopedRows(isoDb, ownerStarted.discovery_job_id)).toEqual({ recs: 0, proofs: 0 });
  });

  it('a deleted origin collection fails the scoped job closed: never the legacy provider path', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    // Real owner collection deletion: the immutable authority row cascades
    // away and the discovery job's collection context is gone.
    await deleteCollection(lib.ownerCtx, { id: lib.col.id });
    const qloo = noCallQloo();
    const err = await appErrorOf(() =>
      runJob(jobId, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) }),
    );
    expect(err.code).toBe('not_found');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
    expect(qloo.calls).toEqual([]);
    // The queue job recorded the typed failure (no provider fallback ran).
    const { rows: job } = await isoDb.query<{ state: string; error_code: string | null }>(
      'SELECT state, error_code FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(job[0]).toMatchObject({ state: 'failed', error_code: 'not_found' });
  });

  it('the discovery pause never fences the explicit scoped operation', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    // Pause stops background expansion/research dispatch and publication —
    // never this explicit per-origin operation the grant authorizes.
    await pauseGraphDiscovery(isoDb, lib.accountId);
    const out = await runJob(jobId, { db: isoDb, config: graphOn });
    expect(out.state).toBe('complete');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
  });

  it('lease loss inside the publication transaction fences the scoped pass', async () => {
    const lib = await scopedLibrary();
    const { discoveryJobId } = await enqueueScoped(lib);
    const authority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId,
    }))!;
    let cancelled: unknown;
    await runScopedGraphDiscovery(isoDb, {
      authority,
      category: 'play',
      ensureActive: async () => {
        throw new JobCancelledError('lease lost');
      },
    }).catch((err: unknown) => {
      cancelled = err;
    });
    expect(cancelled).toBeInstanceOf(JobCancelledError);
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
  });
});

// --- Publisher-first barriers: authority held through the commit ------------------

describe('publisher-first barriers serialize owner changes with scoped publication (VAL-DISC-007)', () => {
  it('a real revocation waits behind the publisher; reads deny immediately after it lands', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId,
    }))!;

    const client = await isoDb.pool.connect();
    let committed = false;
    await client.query('BEGIN');
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    // The real pass on a dedicated open transaction, parked at its lease
    // fence (inside the publication transaction, all authority locks held).
    const pass = runScopedGraphDiscovery(openTransactionDb(client), {
      authority,
      category: 'play',
      ensureActive: () => gate,
    });
    void pass.catch(() => undefined);
    // Wait until the pass provably holds the connection lock, THEN fire.
    await waitForHeldLock('SELECT 1 FROM agent_connections WHERE id = $1 FOR UPDATE NOWAIT', [lib.connectionId]);
    // The real owner revocation on its own connection.
    const revoke = revokeAgentConnection(lib.ownerCtx, { id: lib.connectionId });
    void revoke.catch(() => undefined);
    try {
      // A second, unrelated account's scoped discovery still progresses while
      // this publisher is parked and the revocation is queued (no
      // cross-account lock coupling).
      const other = await scopedLibrary();
      const otherStarted = await enqueueScoped(other);
      const otherOut = await runJob(otherStarted.jobId, { db: isoDb, config: graphOn });
      expect(otherOut.state).toBe('complete');
      expect(await scopedRows(isoDb, otherStarted.discoveryJobId)).toEqual({ recs: 1, proofs: 1 });

      // The revocation must QUEUE on the publisher's held authority lock —
      // never slip before the commit.
      await waitForLockWaiters('%UPDATE agent_connections SET revoked_at%', 1);

      // The publisher commits first, under the authority it holds.
      openGate();
      const outcome = await pass;
      expect(outcome.state).toBe('complete');
      await client.query('COMMIT');
      committed = true;
      await revoke;
    } finally {
      openGate();
      await pass.catch(() => undefined);
      await revoke.catch(() => undefined);
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // Ordered commit: the results were published under valid authority…
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const { rows: revoked } = await isoDb.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM agent_connections WHERE id = $1',
      [lib.connectionId],
    );
    expect(revoked[0]!.revoked_at).not.toBeNull();

    // …and the now-revoked agent denies IMMEDIATELY on the next request.
    await expect(resolvePrincipal(isoDb, { authorization: `Bearer ${lib.credential}` })).rejects.toMatchObject({
      code: 'token_revoked',
    });

    // The owner still reads their own scoped results (the queue job has not
    // been redelivered yet, so its polling state is still the active one).
    const ownerItem = await getItem(lib.ownerCtx, { id: lib.origin, query: {} });
    expect(ownerItem.related.map((r) => r.title)).toEqual(['Georges Seurat']);

    // The queue job's redelivery cannot adopt post-revocation authority: it
    // rejects without destroying the validly published results, and the
    // owner's polling then honestly records the rejected redelivery.
    const replayErr = await appErrorOf(() => runJob(jobId, { db: isoDb, config: graphOn }));
    expect(replayErr.code).toBe('token_revoked');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const ownerJobAfter = await getJob(lib.ownerCtx, { id: authority.job_id });
    expect(ownerJobAfter.state).toBe('failed');
    expect(ownerJobAfter.error).toMatchObject({ code: 'token_revoked' });
    const ownerItemAfter = await getItem(lib.ownerCtx, { id: lib.origin, query: {} });
    expect(ownerItemAfter.related_state).toBe('cached');
    expect(ownerItemAfter.related.map((r) => r.title)).toEqual(['Georges Seurat']);
  });

  it('a real membership removal waits behind the publisher; job and result reads deny after it lands', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId,
    }))!;

    const client = await isoDb.pool.connect();
    let committed = false;
    await client.query('BEGIN');
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const pass = runScopedGraphDiscovery(openTransactionDb(client), {
      authority,
      category: 'play',
      ensureActive: () => gate,
    });
    void pass.catch(() => undefined);
    // Wait until the pass provably holds the collection lock, THEN fire.
    await waitForHeldLock('SELECT 1 FROM collections WHERE id = $1 FOR UPDATE NOWAIT', [lib.col.id]);
    // The real owner membership removal on its own connection.
    const removal = removeCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: lib.origin });
    void removal.catch(() => undefined);
    try {
      // The removal must queue on the publisher's held collection lock.
      await waitForLockWaiters('%FROM collections WHERE id = $1 AND owner_account_id = $2 FOR UPDATE%', 1);
      openGate();
      const outcome = await pass;
      expect(outcome.state).toBe('complete');
      await client.query('COMMIT');
      committed = true;
      await removal;
    } finally {
      openGate();
      await pass.catch(() => undefined);
      await removal.catch(() => undefined);
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const published = await publishedItemIds(isoDb, discoveryJobId);
    expect(published).toHaveLength(1);

    // The queue job's redelivery cannot adopt the changed membership.
    const replayErr = await appErrorOf(() => runJob(jobId, { db: isoDb, config: graphOn }));
    expect(replayErr.code).toBe('not_found');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });

    // The grant is untouched, but the changed origin membership denies job
    // polling, the origin read and the previously published cached result.
    const actx = await freshAgentCtx(lib);
    const err1 = await appErrorOf(() => getJob(actx, { id: authority.job_id }));
    expect(err1.code).toBe('not_found');
    const err2 = await appErrorOf(() => getItem(actx, { id: lib.origin, query: {} }));
    expect(err2.code).toBe('not_found');
    const err3 = await appErrorOf(() => getItem(actx, { id: published[0]!, query: {} }));
    expect(err3.code).toBe('not_found');
    const ownerItem = await getItem(lib.ownerCtx, { id: lib.origin, query: {} });
    expect(ownerItem.related_state).toBe('cached');
  });

  it('a real v1 narrowing waits behind the publisher; scoped reads deny on the narrowed grant', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId,
    }))!;

    const client = await isoDb.pool.connect();
    let committed = false;
    await client.query('BEGIN');
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const pass = runScopedGraphDiscovery(openTransactionDb(client), {
      authority,
      category: 'play',
      ensureActive: () => gate,
    });
    void pass.catch(() => undefined);
    // Wait until the pass provably holds the connection lock, THEN fire.
    await waitForHeldLock('SELECT 1 FROM agent_connections WHERE id = $1 FOR UPDATE NOWAIT', [lib.connectionId]);
    // The real owner v1 grant replace on its own connection: it locks the
    // connection row first.
    const narrowing = updateAgentConnection(lib.ownerCtx, { id: lib.connectionId, body: { collection_ids: [] } });
    void narrowing.catch(() => undefined);
    try {
      // The narrowing must queue behind the publisher's held authority lock.
      await waitForLockWaiters('%FOR UPDATE OF ac%', 1);
      openGate();
      const outcome = await pass;
      expect(outcome.state).toBe('complete');
      await client.query('COMMIT');
      committed = true;
      await narrowing;
    } finally {
      openGate();
      await pass.catch(() => undefined);
      await narrowing.catch(() => undefined);
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const published = await publishedItemIds(isoDb, discoveryJobId);
    expect(published).toHaveLength(1);

    // The queue job's redelivery cannot adopt the narrowed grant epoch.
    const replayErr = await appErrorOf(() => runJob(jobId, { db: isoDb, config: graphOn }));
    expect(replayErr.code).toBe('not_found');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });

    // The published results stay owner-visible, but the narrowed agent loses
    // job polling, the origin read and the cached result item.
    const actx = await freshAgentCtx(lib);
    const err1 = await appErrorOf(() => getJob(actx, { id: authority.job_id }));
    expect(err1.code).toBe('not_found');
    const err2 = await appErrorOf(() => getItem(actx, { id: lib.origin, query: {} }));
    expect(err2.code).toBe('not_found');
    const err3 = await appErrorOf(() => getItem(actx, { id: published[0]!, query: {} }));
    expect(err3.code).toBe('not_found');
    const ownerItem = await getItem(lib.ownerCtx, { id: lib.origin, query: {} });
    expect(ownerItem.related_state).toBe('cached');
  });
});

// --- Reader denial after access loss (previously published results) --------------

describe('previously published scoped results deny after access loss (VAL-DISC-009)', () => {
  it('a revoked connection denies authentication immediately; the owner keeps their results', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const out = await runJob(jobId, { db: isoDb, config: graphOn });
    expect(out.state).toBe('complete');
    expect(await scopedRows(isoDb, discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const published = await publishedItemIds(isoDb, discoveryJobId);
    await revokeAgentConnection(lib.ownerCtx, { id: lib.connectionId });
    await expect(resolvePrincipal(isoDb, { authorization: `Bearer ${lib.credential}` })).rejects.toMatchObject({
      code: 'token_revoked',
    });
    const ownerItem = await getItem(lib.ownerCtx, { id: lib.origin, query: {} });
    expect(ownerItem.related.map((r) => r.id)).toContain(published[0]!);
  });

  it('a narrowed grant denies job polling, the origin read and the cached result item', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId,
    }))!;
    expect((await runJob(jobId, { db: isoDb, config: graphOn })).state).toBe('complete');
    const published = await publishedItemIds(isoDb, discoveryJobId);
    expect(published).toHaveLength(1);

    // Real owner narrowing after publication.
    await updateAgentConnection(lib.ownerCtx, { id: lib.connectionId, body: { collection_ids: [] } });
    const actx = await freshAgentCtx(lib);
    const err1 = await appErrorOf(() => getJob(actx, { id: authority.job_id }));
    expect(err1.code).toBe('not_found');
    const err2 = await appErrorOf(() => getItem(actx, { id: lib.origin, query: {} }));
    expect(err2.code).toBe('not_found');
    const err3 = await appErrorOf(() => getItem(actx, { id: published[0]!, query: {} }));
    expect(err3.code).toBe('not_found');
    // The owner's own surfaces are unaffected.
    expect((await getJob(lib.ownerCtx, { id: authority.job_id })).state).toBe('complete');
  });

  it('a removed origin membership denies job polling and result reads while the grant stands', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = (await discoveryGrantAuthorityForJob(isoDb, {
      ownerAccountId: lib.accountId,
      discoveryJobId,
    }))!;
    expect((await runJob(jobId, { db: isoDb, config: graphOn })).state).toBe('complete');
    const published = await publishedItemIds(isoDb, discoveryJobId);
    await removeCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: lib.origin });
    const actx = await freshAgentCtx(lib);
    const err1 = await appErrorOf(() => getJob(actx, { id: authority.job_id }));
    expect(err1.code).toBe('not_found');
    const err2 = await appErrorOf(() => getItem(actx, { id: lib.origin, query: {} }));
    expect(err2.code).toBe('not_found');
    const err3 = await appErrorOf(() => getItem(actx, { id: published[0]!, query: {} }));
    expect(err3.code).toBe('not_found');
  });

  it('unrelated accounts and private sentinels stay invisible cross-account', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    expect((await runJob(jobId, { db: isoDb, config: graphOn })).state).toBe('complete');
    const published = await publishedItemIds(isoDb, discoveryJobId);
    expect(published).toHaveLength(1);

    // A second account with its own granted agent: nothing of the first
    // account's private results, origins or jobs is disclosed.
    const other = await scopedLibrary();
    const err1 = await appErrorOf(() => getJob(other.actx, { id: jobId }));
    expect(err1.code).toBe('not_found');
    const err2 = await appErrorOf(() => getItem(other.actx, { id: lib.origin, query: {} }));
    expect(err2.code).toBe('not_found');
    const err3 = await appErrorOf(() => getItem(other.actx, { id: published[0]!, query: {} }));
    expect(err3.code).toBe('not_found');
  });
});

// --- Producer deny matrix (two-account, fail closed before any work) ---------------

describe('the scoped producer fails closed before any work (VAL-DISC-009)', () => {
  it('missing collections:read, a foreign collection and a non-member origin persist nothing', async () => {
    const lib = await scopedLibrary();
    const other = await scopedLibrary();
    const authorityCount = async () => {
      const { rows } = await isoDb.query<{ n: number }>('SELECT count(*)::int AS n FROM discovery_grant_authorities');
      return Number(rows[0]!.n);
    };
    const before = await authorityCount();

    // Missing collections:read on a grant-limited connection.
    const narrowScopedAgent = await insertAgentConnection(
      lib.owner,
      { scopes: ['captures:read'], libraryAccess: 'selected_collections', collectionIds: [lib.col.id] },
      isoDb,
    );
    const missingScope = await appErrorOf(() =>
      startRelatedDiscovery(testContext(narrowScopedAgent.principal, { db: isoDb, config: graphOn }), {
        id: lib.origin,
        body: { collection_id: lib.col.id, category: 'play' },
      }),
    );
    expect(missingScope.code).toBe('scope_denied');

    // A foreign (never granted) collection id is non-disclosing.
    const foreign = await appErrorOf(() =>
      startRelatedDiscovery(lib.actx, { id: lib.origin, body: { collection_id: other.col.id, category: 'play' } }),
    );
    expect(foreign.code).toBe('not_found');

    // The other account's origin inside this agent's granted collection is
    // indistinguishable from a missing item.
    const foreignOrigin = await appErrorOf(() =>
      startRelatedDiscovery(lib.actx, { id: other.origin, body: { collection_id: lib.col.id, category: 'play' } }),
    );
    expect(foreignOrigin.code).toBe('not_found');

    // An origin that is not a member of its own granted collection.
    const unsaved = await insertItem(
      { accountId: lib.accountId },
      { kind: 'artist', category: 'play', title: 'Georges Seurat', qloo: SEURAT_QLOO_ID, referenceId: lib.seuratRef },
      isoDb,
    );
    const nonMember = await appErrorOf(() =>
      startRelatedDiscovery(lib.actx, { id: unsaved, body: { collection_id: lib.col.id, category: 'play' } }),
    );
    expect(nonMember.code).toBe('not_found');

    expect(await authorityCount()).toBe(before);
  });
});

// --- Account-owned work stays account-owned; graph-off stays legacy ------------------

describe('account-owned graph work and the graph-off contract remain correct', () => {
  it('an independently authorized expansion survives an unrelated agent grant revocation', async () => {
    const lib = await scopedLibrary();
    // An agent grant on the account, revoked: it never held expansion
    // authority, so its loss cannot invalidate the account-owned work.
    await revokeAgentConnection(lib.ownerCtx, { id: lib.connectionId });

    // The account's explicit saved Rodin item (saved into the collection by
    // the fixture's service call) is an expansion root; the corpus path
    // admits the co-documented candidate onto the account's own item.
    await insertItem(
      { accountId: lib.accountId },
      { kind: 'artist', category: 'play', title: 'A real artist', qloo: SEURAT_QLOO_ID, referenceId: lib.seuratRef },
      isoDb,
    );
    await projectAccountInterestGraph(isoDb, {
      accountId: lib.accountId,
      config: graphOn,
      source: 'mutation_intent',
    });
    const result = await expandAccountInterestGraph(isoDb, { accountId: lib.accountId, config: graphOn });
    expect(result.expanded).toBe(true);
    expect(result.counts.personalRoots).toBe(1);
    expect(result.counts.admitted).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(1);
    const { rows: runs } = await isoDb.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'",
      [lib.accountId],
    );
    expect(Number(runs[0]!.n)).toBe(1);
  });

  it('graph-off keeps the legacy provider behavior for scoped jobs after revocation and reads deny anyway', async () => {
    const lib = await scopedLibrary();
    const agentGraphOff = testContext(
      (await resolvePrincipal(isoDb, { authorization: `Bearer ${lib.credential}` }))!,
      { db: isoDb, config: graphOff },
    );
    const started = await startRelatedDiscovery(agentGraphOff, {
      id: lib.origin,
      body: { collection_id: lib.col.id, category: 'play' },
    });
    await revokeAgentConnection(lib.ownerCtx, { id: lib.connectionId });

    // Legacy contract: the provider path still runs to completion (results
    // stay owner-visible) and the revoked agent's reads deny per request.
    const qloo = new FakeQloo(
      {
        insights: () => ({
          entities: [
            {
              entity_id: 'FX-SCOPED-LEGACY-1',
              name: 'Fixture Scoped Legacy Painter',
              types: [],
              properties: {},
              tags: [],
            },
          ],
          tags: [],
        }),
      },
      { live: true },
    );
    const out = await runJob(started.job_id, { db: isoDb, config: graphOff, providers: testProviders({ qloo }) });
    expect(out.state).toBe('complete');
    expect(qloo.calls.length).toBeGreaterThan(0);
    const { rows: recs } = await isoDb.query<{ origin: string }>(
      'SELECT origin FROM recommendations WHERE discovery_job_id = $1',
      [started.discovery_job_id],
    );
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.origin !== 'catalog')).toBe(true);
    await expect(resolvePrincipal(isoDb, { authorization: `Bearer ${lib.credential}` })).rejects.toMatchObject({
      code: 'token_revoked',
    });
  });
});
