import type { QueryResultRow } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db, TransactionOptions } from '../db/pool';
import { closeTestDb, getTestDb, insertAccount, testConfig } from '../testing';
import { PROJECTION_SUPPORT_VERSION } from './schema';
import { dispatchGraphExpansion } from './sweeper';
import { interestGraphExpansionDedupeKey } from '../jobs/dedupe';
import { claimJobs } from '../jobs/queue';
import { loadGraphRefreshRow } from './refresh';

/**
 * Ordered expansion dispatch (DISC-SCR-012, VAL-DISC-003).
 *
 * Per-account eligibility, the active-job check, the dedupe-key selection, the
 * enqueue and the dispatch stamp must be ONE ordered operation. The old shape
 * read eligibility and the stamp in one snapshot, enqueued from that stale row
 * and stamped afterwards, so a stalled sweep could resume long after its
 * snapshot: by then its window key's earlier job had failed (freeing the key)
 * and a newer stamp-keyed job was active — the stalled sweep then enqueued a
 * SECOND simultaneous expansion under the freed key.
 *
 * These cases hold the real `dispatchGraphExpansion` at exact statement
 * boundaries (the stalled-sweep seam), move the world the way the newer
 * dispatches' committed effects look, and require: never two queued/running
 * expansions for one account; concurrent real sweeps serialize per account;
 * a failed dispatch leaves nothing behind (enqueue and stamp roll back
 * together); worker reclaim and terminal retry preserve pending due work.
 */

const db = getTestDb();
afterAll(closeTestDb);

const config = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});

/** T0: a fixed clock far from the real now so windows are unambiguous. */
const T0 = new Date('2026-10-28T12:00:00Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

async function newAccount(): Promise<string> {
  return (await insertAccount(db)).accountId;
}

/** A caught-up, ready projection: the sweeper's only eligible shape. */
async function projectAccount(accountId: string): Promise<void> {
  await db.query(
    `INSERT INTO personal_graph_state (owner_account_id, state, target_taste_revision, applied_taste_revision, projection_revision, support_version)
     VALUES ($1, 'ready', 3, 3, 1, $2)`,
    [accountId, PROJECTION_SUPPORT_VERSION],
  );
}

/** Controlled marker/stamp writes the sweeper's clock comparisons see exactly. */
async function setRefresh(
  accountId: string,
  row: { dueSince?: Date | null; lastExpansion?: Date | null },
): Promise<void> {
  await db.query(
    `INSERT INTO graph_refresh_state (owner_account_id, expansion_due_since, last_expansion_at)
     VALUES ($1, $2, $3)
       ON CONFLICT (owner_account_id)
         DO UPDATE SET expansion_due_since = $2, last_expansion_at = $3, updated_at = now()`,
    [accountId, row.dueSince ?? null, row.lastExpansion ?? null],
  );
}

async function expansionJobs(
  accountId: string,
): Promise<{ id: string; state: string; dedupe_key: string | null }[]> {
  const { rows } = await db.query<{ id: string; state: string; dedupe_key: string | null }>(
    `SELECT id, state, dedupe_key FROM jobs
      WHERE owner_account_id = $1 AND type = 'expand_interest_graph' ORDER BY created_at`,
    [accountId],
  );
  return rows;
}

async function activeExpandJobs(accountId: string): Promise<{ id: string; state: string }[]> {
  const { rows } = await db.query<{ id: string; state: string }>(
    `SELECT id, state FROM jobs
      WHERE owner_account_id = $1 AND type = 'expand_interest_graph' AND state IN ('queued','running')
      ORDER BY created_at`,
    [accountId],
  );
  return rows;
}

// --- The stalled-sweep seam --------------------------------------------------------

type Intercept = (text: string) => 'park' | 'fail' | null;

/**
 * A Db view over the shared pool that intercepts matching statements. The
 * per-account dispatch transaction's statements run on the same view, so a
 * parked statement is held UNSENT (a client-side stall) until released and a
 * failing one rejects. The production function itself is untouched.
 */
function interceptDb(inner: Db, decide: Intercept, gate: Promise<void>, onParked?: () => void): Db {
  const wrap = (handle: Db): Db => {
    const self: Db = {
      inTransaction: handle.inTransaction,
      query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
        const action = decide(text);
        if (action === 'park') {
          onParked?.();
          return gate.then(() => handle.query<R>(text, params));
        }
        if (action === 'fail') return Promise.reject(new Error('simulated dispatch failure'));
        return handle.query<R>(text, params);
      },
      transaction<T>(fn: (tx: Db) => Promise<T>, options?: TransactionOptions) {
        return handle.transaction<T>((tx) => fn(wrap(tx)), options);
      },
    };
    return self;
  };
  return wrap(inner);
}

/** Holds the FIRST enqueue statement unsent — the between-read-and-enqueue stall. */
function stalledDb(parkOn: (text: string) => boolean): { db: Db; reached: Promise<void>; release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { db: interceptDb(db, (text) => (parkOn(text) ? 'park' : null), gate, signal), reached, release };
}

/** Rejects matching statements — a dispatch failure after the enqueue. */
function failingDb(failOn: (text: string) => boolean): Db {
  return interceptDb(db, (text) => (failOn(text) ? 'fail' : null), Promise.resolve());
}

/**
 * Resolves once at least `atLeast` backends are WAITING on a lock whose
 * in-flight query matches `pattern`. Fails honestly on timeout, so the
 * serialization assertion cannot pass by racing past the park.
 */
async function waitForLockWaiters(pattern: string, atLeast: number, timeoutMs = 5_000): Promise<void> {
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A committed job row standing for a window the newer dispatches own. */
async function insertWindowJob(
  accountId: string,
  over: { dedupeKey: string; state: 'queued' | 'failed' },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO jobs (owner_account_id, type, payload, dedupe_key, state, attempt, max_attempts, finished_at, error_code)
     VALUES ($1, 'expand_interest_graph', $2::jsonb, $3, $4, $5, 3, $6, $7)
     RETURNING id`,
    [
      accountId,
      JSON.stringify({ account_id: accountId }),
      over.dedupeKey,
      over.state,
      over.state === 'failed' ? 3 : 0,
      over.state === 'failed' ? new Date() : null,
      over.state === 'failed' ? 'service_unavailable' : null,
    ],
  );
  return rows[0]!.id;
}

describe('ordered expansion dispatch (DISC-SCR-012)', () => {
  it('a stalled stale-stamp sweep never enqueues a second active expansion after key reuse', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    const stampS = at(-120_000);
    await setRefresh(accountId, { dueSince: at(-60_000), lastExpansion: stampS });

    // The earlier window's job under key(S) already failed terminally, so its
    // key is free again — the scrutiny's precondition for key reuse.
    await insertWindowJob(accountId, {
      dedupeKey: interestGraphExpansionDedupeKey({ accountId, lastExpansionAt: stampS }),
      state: 'failed',
    });

    // Sweep A reads its candidate snapshot (stamp S; the failed key(S) job
    // does not occupy the active window) and then stalls with its enqueue
    // unsent — the exact between-snapshot-and-enqueue gap.
    const park = stalledDb((text) => text.includes('INSERT INTO jobs'));
    const dispatchA = dispatchGraphExpansion(park.db, { config, ownerAccountId: accountId, now: at(0) });
    await park.reached;

    // While A is stalled the world moves on: the stamp the newer dispatches
    // stamped twice (S→T1→T2), their new-window job became ACTIVE under the
    // current stamp's key, and fresh support made the account due again.
    const stampT1 = at(-60_000);
    const stampT2 = at(-30_000);
    await setRefresh(accountId, { dueSince: at(-60_000), lastExpansion: stampT1 });
    const activeJobId = await insertWindowJob(accountId, {
      dedupeKey: interestGraphExpansionDedupeKey({ accountId, lastExpansionAt: stampT1 }),
      state: 'queued',
    });
    await setRefresh(accountId, { dueSince: at(-10_000), lastExpansion: stampT2 });

    park.release();
    const sweptA = await dispatchA;

    // Never two queued/running expansions for one account: the active job is
    // the newer window's, not a second one under the freed key(S).
    const active = await activeExpandJobs(accountId);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(activeJobId);

    // The stalled sweep dispatched nothing and consumed no due-ness; its
    // stale clock never regressed the dispatch stamp.
    expect(sweptA.accounts).toEqual([]);
    const refresh = await loadGraphRefreshRow(db, accountId);
    expect(refresh!.expansion_due_since!.toISOString()).toBe(at(-10_000).toISOString());
    expect(refresh!.last_expansion_at!.toISOString()).toBe(stampT2.toISOString());
  });

  it('concurrent real sweeps serialize per account: the second rechecks under the ordered lock and skips', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });

    // Sweep A stalls INSIDE its per-account operation with the enqueue unsent;
    // whatever it holds is held through its commit.
    const park = stalledDb((text) => text.includes('INSERT INTO jobs'));
    const dispatchA = dispatchGraphExpansion(park.db, { config, ownerAccountId: accountId, now: at(0) });
    await park.reached;

    // Sweep B is a real dispatch on the pool, far enough past A's window that
    // ONLY the active-job check can keep it from dispatching again.
    const dispatchB = dispatchGraphExpansion(db, {
      config,
      ownerAccountId: accountId,
      now: at(16 * 60_000 + 1_000),
    });

    let sweptA: Awaited<typeof dispatchA> | undefined;
    let sweptB: Awaited<typeof dispatchB> | undefined;
    try {
      // B must queue BEHIND A's per-account operation at the shared account
      // authority lock (the same FOR NO KEY UPDATE row pause/resume and both
      // publishers take), not run its read-then-enqueue unsynchronized.
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);
    } finally {
      park.release();
      [sweptA, sweptB] = await Promise.all([dispatchA, dispatchB]);
    }

    expect(sweptA!.accounts).toHaveLength(1);
    expect(sweptA!.accounts[0]!.reused).toBe(false);
    // B's recheck under the lock saw A's active job and dispatched nothing.
    expect(sweptB!.accounts).toEqual([]);
    expect(await expansionJobs(accountId)).toHaveLength(1);
    // Exactly one dispatch stamp, A's; B never stamped and the marker stays.
    const refresh = await loadGraphRefreshRow(db, accountId);
    expect(refresh!.last_expansion_at!.toISOString()).toBe(at(0).toISOString());
    expect(refresh!.expansion_due_since!.toISOString()).toBe(at(-60_000).toISOString());
  });

  it('a failed dispatch rolls enqueue and stamp back together: pending due work is preserved', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });

    // The stamp write fails after the enqueue succeeded: the dispatch is one
    // operation, so nothing it did may survive — never an unstamped job.
    const dispatch = dispatchGraphExpansion(failingDb((text) => text.includes('INSERT INTO graph_refresh_state')), {
      config,
      ownerAccountId: accountId,
      now: at(0),
    });
    await expect(dispatch).rejects.toThrow('simulated dispatch failure');
    expect(await expansionJobs(accountId)).toHaveLength(0);
    const refresh = await loadGraphRefreshRow(db, accountId);
    expect(refresh!.last_expansion_at).toBeNull();
    expect(refresh!.expansion_due_since!.toISOString()).toBe(at(-60_000).toISOString());

    // The pending due work survives for the next sweep.
    const recovered = await dispatchGraphExpansion(db, { config, ownerAccountId: accountId, now: at(1_000) });
    expect(recovered.accounts).toHaveLength(1);
    expect((await loadGraphRefreshRow(db, accountId))!.last_expansion_at!.toISOString()).toBe(at(1_000).toISOString());
  });

  it('a running job whose lease expired is reclaimed in place, never double-dispatched', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });

    const first = await dispatchGraphExpansion(db, { config, ownerAccountId: accountId, now: at(0) });
    expect(first.accounts).toHaveLength(1);
    const jobId = first.accounts[0]!.jobId;

    // A worker claimed the window and died mid-run; the lease has expired.
    await db.query(
      `UPDATE jobs SET state = 'running', lease_owner = 'dead-worker', lease_expiry = now() - interval '1 minute'
        WHERE id = $1`,
      [jobId],
    );

    // The sweep sees an ACTIVE expansion — running counts, expired lease or
    // not — and hands nothing new to the queue; due-ness stays untouched.
    const during = await dispatchGraphExpansion(db, { config, ownerAccountId: accountId, now: at(30_000) });
    expect(during.accounts).toEqual([]);
    expect(await expansionJobs(accountId)).toHaveLength(1);

    // Reclaim is the SAME row: one job, one dedupe key, one budget anchor.
    const [reclaimed] = await claimJobs(db, {
      workerId: 'reclaiming-worker',
      limit: 1,
      leaseMs: 60_000,
      ids: [jobId],
    });
    expect(reclaimed!.id).toBe(jobId);
    expect(await expansionJobs(accountId)).toHaveLength(1);
    expect((await loadGraphRefreshRow(db, accountId))!.expansion_due_since).toBeInstanceOf(Date);
  });

  it('a terminally failed window re-arms under a fresh key on the next sweep, with one active job', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });

    const first = await dispatchGraphExpansion(db, { config, ownerAccountId: accountId, now: at(0) });
    expect(first.accounts).toHaveLength(1);
    const firstKey = (await expansionJobs(accountId))[0]!.dedupe_key;

    // The window's job failed terminally; fresh support became due after the
    // stamp — the failed window's pending work must be retried, not lost and
    // not duplicated.
    await db.query(
      `UPDATE jobs SET state = 'failed', attempt = 3, finished_at = now()
        WHERE owner_account_id = $1 AND type = 'expand_interest_graph'`,
      [accountId],
    );
    await setRefresh(accountId, { dueSince: at(30_000), lastExpansion: at(0) });

    const second = await dispatchGraphExpansion(db, { config, ownerAccountId: accountId, now: at(45_000) });
    expect(second.accounts).toHaveLength(1);
    expect(second.accounts[0]!.trigger).toBe('due');
    expect(second.accounts[0]!.reused).toBe(false);

    const jobs = await expansionJobs(accountId);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.dedupe_key).not.toBe(firstKey);
    const active = await activeExpandJobs(accountId);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(second.accounts[0]!.jobId);
  });
});
