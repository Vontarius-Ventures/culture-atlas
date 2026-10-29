import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertReference } from '../compiler/store';
import type { ServiceContext } from '../context';
import type { Db, PoolDb } from '../db/pool';
import { JobCancelledError } from '../jobs/handler';
import { cancelJob, claimJobs, heartbeatJob } from '../jobs/queue';
import { addCollectionItem, createCollection } from '../services/collections';
import { startRelatedDiscovery } from '../services/items';
import { insertItem } from '../test-support/library';
import {
  createIsolatedDatabase,
  insertAccount,
  insertAgentConnection,
  testConfig,
  testContext,
} from '../testing';
import { admitGraphCorpus } from './corpus';
import { getCorpusManifestFile } from './corpus-manifest';
import { linkGraphReferenceIdentities } from './identity-links';
import { discoveryGrantAuthorityForJob, type ScopedDiscoveryGrantAuthority } from './scoped-discovery';
import { runScopedGraphDiscovery } from './scoped-discovery-graph';

/**
 * The queue attempt publication fence of the approved grant-scoped Discover
 * more producer (repairs round-8 DISC-SCR-039; VAL-DISC-007).
 *
 * The pass's unlocked liveness callback (the real Worker's stillOwnsJob read
 * on the pool) is NOT authority through the committing writes: the real
 * queue writers — cancelJob, the reclaiming claimJobs, reapJobs, the
 * heartbeat and job completion — are single-row jobs UPDATEs that can
 * commit between that read and the pass's commit while a tail write waits
 * on someone else's lock. The pass therefore carries its REAL queue attempt
 * authority (job id pinned by the authority row, claiming worker, claimed
 * attempt) into the publication transaction, LOCKS its own queue row there
 * (FOR NO KEY UPDATE — the compatible strength: it conflicts with every
 * queue writer's row lock while FK-dependent job_stages readers keep
 * flowing) and revalidates the full attempt authority under the lock:
 * running state, ownership, the pinned attempt, no cancellation and a live
 * lease. The lock holds through the commit, so both commit orders resolve:
 *
 *  - cancellation / lease-transfer FIRST (the writer committed after the
 *    unlocked liveness read but before the guard): the guard revalidates the
 *    CHANGED row, rejects, and the whole transaction rolls back — no stale
 *    rows, and the newer attempt's job row is left exactly as the real
 *    writer left it;
 *  - publisher FIRST (the writer arrives while the pass holds the row):
 *    the queue writer queues behind the publication and lands AFTER the
 *    commit — the pass publishes under exactly the authority it validated
 *    and the later cancellation/reclaim never retroactively fails it;
 *  - a same-worker new attempt (the same worker re-claimed its own job
 *    after a lease lapse) is a different attempt: the parked old pass
 *    rejects, and only the new attempt publishes;
 *  - the lease can still die by TIME while the row is locked: the final
 *    publication boundary rechecks the pinned lease expiry against a fresh
 *    database clock AFTER the tail writes, so a lease that expired during a
 *    tail wait rolls the whole pass back.
 *
 * The row lock is deliberately taken only at the tail (the walk stays
 * heartbeat-friendly), it is row-scoped (independent jobs keep flowing) and
 * every wait stays bounded by the anchored work window's current remainder
 * — never a queue heartbeat deadlock.
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
  const created = await createIsolatedDatabase('scrdq');
  isoDb = created.db;
  dropIso = created.drop;
  await admitGraphCorpus(isoDb, getCorpusManifestFile());
});
afterAll(async () => {
  await dropIso();
});

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

/** The REAL queue claim writer: leases the job to a worker and returns its attempt. */
async function claimScoped(jobId: string, workerId: string, leaseMs = 60_000): Promise<number> {
  const [job] = await claimJobs(isoDb, { workerId, limit: 1, leaseMs, ids: [jobId] });
  if (!job) throw new Error(`job ${jobId} not claimable`);
  return job.attempt;
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

/** NOWAIT probe proving the parked pass holds its queue attempt row lock. */
async function waitForHeldJobRow(jobId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await isoDb.query('SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE NOWAIT', [jobId]);
    } catch (err) {
      if ((err as { code?: string }).code === '55P03') return;
      throw err;
    }
    if (Date.now() >= deadline) throw new Error('pass never acquired its queue attempt row lock');
    await sleep(25);
  }
}

/** The parked guard query of the pass (DISC-SCR-039's locked revalidation). */
const GUARD_PATTERN = /SELECT lease_expiry FROM jobs/;

/** The pass's first tail write (the DELETE whose lock waits motivated round 8). */
const TAIL_DELETE_PATTERN = /DELETE FROM recommendations WHERE discovery_job_id = \$1/;

async function cancelledErrorOf(fn: () => Promise<unknown>): Promise<JobCancelledError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(JobCancelledError);
    return err as JobCancelledError;
  }
  throw new Error('expected the pass to reject');
}

// --- Writer-first: authority lost after the unlocked liveness read ----------

describe('queue authority lost after the unlocked liveness read rejects the scoped publication (DISC-SCR-039)', () => {
  it('a real cancellation committing between the liveness read and the tail rejects the guarded pass and rolls back', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = await authorityOf(lib, discoveryJobId);
    const attempt = await claimScoped(jobId, 'w1');

    // The pass parks INSIDE its publication transaction at the queue
    // revalidation itself: the unlocked liveness callback has already
    // returned true, and the guard's locked read is the very next statement.
    const client = await isoDb.pool.connect();
    try {
      await client.query('BEGIN');
      const gated = gatedTransactionDb(client, GUARD_PATTERN);
      const pass = runScopedGraphDiscovery(gated.db, {
        authority,
        category: 'play',
        ensureActive: async () => undefined,
        queue: { workerId: 'w1', attempt },
      });
      void pass.catch(() => undefined);

      // The REAL cancellation writer commits after the unlocked liveness
      // read returned true and before the guard locks the row.
      expect(await cancelJob(isoDb, jobId)).toBe('running');

      gated.open();
      await cancelledErrorOf(() => pass);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // Cancellation-first: nothing published, the whole transaction rolled
    // back, and the real writer's flag survived the rejection.
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
    const { rows: job } = await isoDb.query<{ cancel_requested_at: Date | null; state: string }>(
      'SELECT cancel_requested_at, state FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(job[0]!.cancel_requested_at).not.toBeNull();
    expect(job[0]!.state).toBe('running');
  });

  it('a real lease transfer committing between the liveness read and the tail rejects the old pass without clobbering the new attempt', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = await authorityOf(lib, discoveryJobId);
    const attempt = await claimScoped(jobId, 'w1');

    const client = await isoDb.pool.connect();
    try {
      await client.query('BEGIN');
      const gated = gatedTransactionDb(client, GUARD_PATTERN);
      const pass = runScopedGraphDiscovery(gated.db, {
        authority,
        category: 'play',
        ensureActive: async () => undefined,
        queue: { workerId: 'w1', attempt },
      });
      void pass.catch(() => undefined);

      // The lease lapses (the real single-row state the reclaimer reads)…
      await isoDb.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
      // …and the REAL reclaim writer transfers the lease to another worker.
      const reclaimAttempt = await claimScoped(jobId, 'w2');
      expect(reclaimAttempt).toBe(attempt + 1);

      gated.open();
      await cancelledErrorOf(() => pass);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // Lease-transfer-first: the old pass published nothing and its rollback
    // left the NEW attempt's authority exactly as the real writer set it.
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
    const { rows: job } = await isoDb.query<{ state: string; lease_owner: string | null; attempt: number }>(
      'SELECT state, lease_owner, attempt FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(job[0]).toMatchObject({ state: 'running', lease_owner: 'w2', attempt: attempt + 1 });
  });

  it('a same-worker new attempt supersedes the parked pass: the old attempt never publishes, the new one does', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = await authorityOf(lib, discoveryJobId);
    const attempt = await claimScoped(jobId, 'w1');

    const client = await isoDb.pool.connect();
    try {
      await client.query('BEGIN');
      const gated = gatedTransactionDb(client, GUARD_PATTERN);
      // The old attempt's pass, parked at the guard.
      const pass = runScopedGraphDiscovery(gated.db, {
        authority,
        category: 'play',
        ensureActive: async () => undefined,
        queue: { workerId: 'w1', attempt },
      });
      void pass.catch(() => undefined);

      // The SAME worker re-claims its own lapsed lease: stillOwnsJob's
      // unlocked read (same owner, running, not cancelled) would pass — only
      // the pinned attempt separates the two executions.
      await isoDb.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
      const newAttempt = await claimScoped(jobId, 'w1');
      expect(newAttempt).toBe(attempt + 1);

      gated.open();
      await cancelledErrorOf(() => pass);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });

    // The new attempt's pass — the one that owns the row now — publishes.
    const fresh = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: 'play',
      ensureActive: async () => undefined,
      queue: { workerId: 'w1', attempt: attempt + 1 },
    });
    expect(fresh.state).toBe('complete');
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
  });
});

// --- Publisher-first: the row lock orders later writers behind the commit ----

describe('queue writers arriving during the tail wait queue behind the publication commit (DISC-SCR-039)', () => {
  it('a cancellation and heartbeat arriving during the tail writes block on the held attempt row and land after the commit', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = await authorityOf(lib, discoveryJobId);
    const attempt = await claimScoped(jobId, 'w1');

    const client = await isoDb.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const gated = gatedTransactionDb(client, TAIL_DELETE_PATTERN);
      // The pass is parked AFTER its guard: it validated the live attempt
      // authority and HOLDS the queue row lock through this commit.
      const pass = runScopedGraphDiscovery(gated.db, {
        authority,
        category: 'play',
        ensureActive: async () => undefined,
        queue: { workerId: 'w1', attempt },
      });
      void pass.catch(() => undefined);

      // Wait until the pass provably holds its queue attempt row lock (the
      // guard validated a live attempt and parked at the first tail write)
      // BEFORE firing the racing writers.
      await waitForHeldJobRow(jobId);

      // The real cancellation and heartbeat writers arrive mid-tail: they
      // must QUEUE on the pass's held row lock, never commit inside the
      // publication's authority window.
      const cancelled = cancelJob(isoDb, jobId);
      void cancelled.catch(() => undefined);
      await waitForLockWaiters('%UPDATE jobs SET cancel_requested_at%', 1);
      const heartbeat = heartbeatJob(isoDb, jobId, 'w1', 60_000);
      void heartbeat.catch(() => undefined);
      await waitForLockWaiters('%UPDATE jobs SET lease_expiry%', 1);

      // An UNRELATED job's queue writers keep flowing while this pass holds
      // its own row (the lock is row-scoped, never a queue-wide stop).
      const other = await scopedLibrary();
      const otherStarted = await enqueueScoped(other);
      await claimScoped(otherStarted.jobId, 'wother');
      expect(await heartbeatJob(isoDb, otherStarted.jobId, 'wother', 60_000)).toBe(true);

      // The publication commits under exactly the authority it validated…
      gated.open();
      const outcome = await pass;
      expect(outcome.state).toBe('complete');
      await client.query('COMMIT');
      committed = true;

      // …then the queued writers land. The later cancellation never
      // retroactively fails the committed publication. The heartbeat
      // settles as soon as the row lock releases (the tail is bounded by
      // the work window — never a queue heartbeat deadlock); its boolean
      // only reports whether the racing cancellation's flag was already
      // visible to its RETURNING, which the two writers' resume order
      // does not fix.
      expect(await cancelled).toBe('running');
      const beat = await heartbeat;
      expect(typeof beat).toBe('boolean');
    } finally {
      client.release();
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    }

    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const { rows: job } = await isoDb.query<{
      state: string;
      lease_owner: string | null;
      cancel_requested_at: Date | null;
      lease_expiry: Date | null;
    }>('SELECT state, lease_owner, cancel_requested_at, lease_expiry FROM jobs WHERE id = $1', [jobId]);
    // The queued cancellation landed AFTER the commit (flagged, the row
    // otherwise untouched) and the queued heartbeat renewed the lease:
    // both real writers, ordered behind the publication, none of them
    // deadlocked by the tail's held row.
    expect(job[0]!.state).toBe('running');
    expect(job[0]!.lease_owner).toBe('w1');
    expect(job[0]!.cancel_requested_at).not.toBeNull();
    expect(job[0]!.lease_expiry!.getTime()).toBeGreaterThan(Date.now());
    const { rows: discovery } = await isoDb.query<{ status: string }>(
      'SELECT status FROM discovery_jobs WHERE id = $1',
      [discoveryJobId],
    );
    expect(discovery[0]!.status).toBe('complete');
  }, 20_000);
});

// --- The lease can still die by time inside the held row ---------------------

describe('a lease that expires during the tail wait rejects at the final publication boundary (DISC-SCR-039)', () => {
  it('the pinned lease expiry is rechecked after the tail writes: an expired lease rolls the whole pass back', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = await authorityOf(lib, discoveryJobId);
    // A short but real lease: live when the guard validates it, expired by
    // the time the tail writes finish.
    const attempt = await claimScoped(jobId, 'w1', 3_000);

    const client = await isoDb.pool.connect();
    try {
      await client.query('BEGIN');
      const gated = gatedTransactionDb(client, TAIL_DELETE_PATTERN);
      const pass = runScopedGraphDiscovery(gated.db, {
        authority,
        category: 'play',
        ensureActive: async () => undefined,
        queue: { workerId: 'w1', attempt },
      });
      void pass.catch(() => undefined);

      // The pass passes its guard (the short lease is still live) and parks
      // holding the queue row lock.
      await waitForHeldJobRow(jobId);

      // The lease dies by TIME while the pass is parked in its tail (the
      // held row lock stops every queue writer, but not the clock).
      await sleep(3_800);
      gated.open();

      // The tail writes run inside the transaction, and the final boundary
      // rejects on the pinned lease expiry BEFORE the commit.
      await cancelledErrorOf(() => pass);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
    const { rows: job } = await isoDb.query<{ state: string; lease_owner: string | null; attempt: number }>(
      'SELECT state, lease_owner, attempt FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(job[0]).toMatchObject({ state: 'running', lease_owner: 'w1', attempt });
  }, 30_000);
});

// --- The control: a live claimed lease publishes through the guarded tail -----

describe('a live claimed lease publishes through the guarded tail (the control)', () => {
  it('the guard passes a live attempt and the scoped results publish', async () => {
    const lib = await scopedLibrary();
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    const authority = await authorityOf(lib, discoveryJobId);
    const attempt = await claimScoped(jobId, 'w1');

    const out = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: 'play',
      ensureActive: async () => undefined,
      queue: { workerId: 'w1', attempt },
    });
    expect(out.state).toBe('complete');
    expect(out.results).toHaveLength(1);
    expect(await scopedRows(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
    const { rows: job } = await isoDb.query<{ state: string; lease_owner: string | null }>(
      'SELECT state, lease_owner FROM jobs WHERE id = $1',
      [jobId],
    );
    // Queue bookkeeping stays the Worker's: the pass fences, it does not complete.
    expect(job[0]).toMatchObject({ state: 'running', lease_owner: 'w1' });
  });
});
