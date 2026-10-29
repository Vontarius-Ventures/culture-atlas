import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAnonymousSession } from '../testing';
import type { Queryable } from '../db/pool';
import {
  backoffMs,
  cancelJob,
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  getJobById,
  heartbeatJob,
  markJobCancelled,
  reapJobs,
  setJobStage,
  stillOwnsJob,
} from './queue';
import { getStage, recordStage, runStageOnce } from './stages';

const db = getTestDb();
afterAll(closeTestDb);

/** Tests claim by id so parallel test files never steal each other's jobs. */
async function newPollJob(dedupeKey?: string) {
  const s = await insertAnonymousSession(db);
  return enqueueJob(db, {
    type: 'sensor_poll',
    owner: { kind: 'session', sessionId: s.sessionId },
    payload: { sensor_connection_id: randomUUID() },
    dedupeKey,
    maxAttempts: 2,
  });
}

async function claimById(jobId: string, workerId: string) {
  const [job] = await claimJobs(db, { workerId, limit: 1, leaseMs: 30_000, ids: [jobId] });
  if (!job) throw new Error('could not claim job');
  return job;
}

describe('job queue', () => {
  it('reuses an active job with the same dedupe key', async () => {
    const key = `test:${randomUUID()}`;
    const first = await newPollJob(key);
    const second = await enqueueJob(db, {
      type: 'sensor_poll',
      owner: null,
      payload: { sensor_connection_id: randomUUID() },
      dedupeKey: key,
    });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it('validates payloads against the job type schema', async () => {
    await expect(
      enqueueJob(db, { type: 'sensor_poll', owner: null, payload: { sensor_connection_id: 'nope' } }),
    ).rejects.toThrow();
  });

  it('leases with SKIP LOCKED so two workers never claim the same job', async () => {
    const { job } = await newPollJob();
    const [a, b] = await Promise.all([
      claimJobs(db, { workerId: 'w-a', limit: 10, leaseMs: 30_000, ids: [job.id] }),
      claimJobs(db, { workerId: 'w-b', limit: 10, leaseMs: 30_000, ids: [job.id] }),
    ]);
    const owners = [...a, ...b].filter((j) => j.id === job.id);
    expect(owners).toHaveLength(1);
    const owner = owners[0]!;
    expect(owner.state).toBe('running');
    expect(owner.attempt).toBe(1);
    // Only the lease holder can complete it.
    const other = owner.lease_owner === 'w-a' ? 'w-b' : 'w-a';
    expect(await completeJob(db, job.id, other, owner.attempt, { state: 'complete' })).toBe(false);
    expect(await heartbeatJob(db, job.id, owner.lease_owner!, owner.attempt, 30_000)).toBe(true);
    expect(await completeJob(db, job.id, owner.lease_owner!, owner.attempt, { state: 'complete' })).toBe(true);
    expect((await getJobById(db, job.id))?.state).toBe('complete');
  });

  it('claims a queued job while another transaction is writing a trace or stage row for it', async () => {
    // Inserting a row that references jobs(id) takes FOR KEY SHARE on the job
    // (e.g. tracing an agent's get_job poll). A claim must not skip the job
    // because of that, or a worker sees it queued yet cannot lease it.
    const { job } = await newPollJob();
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO trace_events (job_id, kind, name) VALUES ($1, 'note', 'poll')`, [job.id]);
      await tx.query(`INSERT INTO job_stages (job_id, stage, status, attempt) VALUES ($1, 'probe', 'running', 0)`, [job.id]);
      const claimed = await claimJobs(db, { workerId: 'w-fk', limit: 1, leaseMs: 30_000, ids: [job.id] });
      expect(claimed.map((j) => j.id)).toEqual([job.id]);
    });
  });

  it('requeues retryable failures with backoff, then fails after max attempts', async () => {
    const { job } = await newPollJob();
    const first = await claimById(job.id, 'w1');
    const r1 = await failJob(db, job.id, 'w1', first.attempt, { code: 'provider_unavailable', message: 'down', retryable: true }, { retryAfterMs: 0 });
    expect(r1?.state).toBe('queued');
    const second = await claimById(job.id, 'w1');
    const r2 = await failJob(db, job.id, 'w1', second.attempt, { code: 'provider_unavailable', message: 'down', retryable: true });
    expect(r2?.state).toBe('failed');
    const stored = await getJobById(db, job.id);
    expect(stored?.error_code).toBe('provider_unavailable');
    expect(stored?.finished_at).not.toBeNull();
  });

  it('recovers a job whose lease expired', async () => {
    const { job } = await newPollJob();
    const dead = await claimById(job.id, 'dead-worker');
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [job.id]);
    const again = await claimById(job.id, 'new-worker');
    expect(again.attempt).toBe(2);
    expect(await completeJob(db, job.id, 'dead-worker', dead.attempt, { state: 'complete' })).toBe(false);
    // Final attempt also abandoned -> reaper fails it.
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [job.id]);
    await reapJobs(db);
    expect((await getJobById(db, job.id))?.state).toBe('failed');
  });

  it('cancels queued jobs immediately and flags running ones', async () => {
    const queued = await newPollJob();
    expect(await cancelJob(db, queued.job.id)).toBe('cancelled');
    const running = await newPollJob();
    const claimed = await claimById(running.job.id, 'w2');
    expect(await cancelJob(db, running.job.id)).toBe('running');
    expect(await heartbeatJob(db, running.job.id, 'w2', claimed.attempt, 30_000)).toBe(false);
  });

  it('backoff grows exponentially with jitter', () => {
    for (let i = 0; i < 20; i++) {
      const b1 = backoffMs(1, 1000);
      const b3 = backoffMs(3, 1000);
      expect(b1).toBeGreaterThanOrEqual(500);
      expect(b1).toBeLessThanOrEqual(1000);
      expect(b3).toBeGreaterThanOrEqual(2000);
      expect(b3).toBeLessThanOrEqual(4000);
    }
  });
});

/**
 * The same-worker lease reclaim fence (feature `shared-worker-attempt-terminal-fence`).
 *
 * A worker that reclaims its own lapsed job at a newer attempt is a NEW
 * execution: the lease_owner guard alone cannot tell the old execution from
 * the successor, because both write under the same worker id. Every lease
 * observation and terminal write is therefore pinned to the CLAIMED ATTEMPT:
 * a stale attempt cannot complete, fail, requeue, cancel, heartbeat or
 * progress the successor, cannot observe itself as owner, and a reclaim
 * committing between failJob's SELECT and UPDATE cannot be mutated by the old
 * UPDATE. Current-attempt writers keep working, and an independent
 * different-worker transfer stays fenced exactly as before.
 */
describe('same-worker lease reclaim: stale attempts cannot mutate the successor', () => {
  /** A poll job with room for a third claim (attempt < max_attempts). */
  async function newAttemptJob() {
    const s = await insertAnonymousSession(db);
    const { job } = await enqueueJob(db, {
      type: 'sensor_poll',
      owner: { kind: 'session', sessionId: s.sessionId },
      payload: { sensor_connection_id: randomUUID() },
      maxAttempts: 4,
    });
    return job;
  }

  /** Lapse the current lease and let the REAL claim writer reclaim (same or other worker). */
  async function reclaim(jobId: string, workerId: string) {
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const [job] = await claimJobs(db, { workerId, limit: 1, leaseMs: 30_000, ids: [jobId] });
    if (!job) throw new Error('could not reclaim');
    return job;
  }

  async function rowOf(jobId: string) {
    const { rows } = await db.query<{
      state: string;
      lease_owner: string | null;
      attempt: number;
      stage: string | null;
      lease_expiry: Date | null;
      error_code: string | null;
    }>(
      'SELECT state, lease_owner, attempt, stage, lease_expiry, error_code FROM jobs WHERE id = $1',
      [jobId],
    );
    return rows[0]!;
  }

  /**
   * A Queryable view that holds ONE matching statement client-side until
   * `release()` — the test controls exactly one scheduling boundary between
   * failJob's SELECT and its UPDATE while the reclaim commits on the pool.
   */
  function parkedQueryDb(base: Queryable, pattern: RegExp): { db: Queryable; arrived: Promise<void>; release: () => void } {
    let parked = false;
    let markArrived!: () => void;
    const arrived = new Promise<void>((resolve) => {
      markArrived = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const self: Queryable = {
      query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
        if (!parked && pattern.test(text)) {
          parked = true;
          markArrived();
          return gate.then(() => base.query<R>(text, params));
        }
        return base.query<R>(text, params);
      },
    };
    return { db: self, arrived, release: () => openGate() };
  }

  it('a stale attempt cannot complete, heartbeat, progress or observe ownership of the successor; the current attempt still can', async () => {
    const job = await newAttemptJob();
    await claimById(job.id, 'w1'); // attempt 1
    await reclaim(job.id, 'w1'); // the SAME worker reclaims at attempt 2
    const successorLease = (await rowOf(job.id)).lease_expiry!;

    expect(await completeJob(db, job.id, 'w1', 1, { state: 'complete' })).toBe(false);
    expect(await heartbeatJob(db, job.id, 'w1', 1, 5_000)).toBe(false);
    expect(await setJobStage(db, job.id, 'w1', 1, 'stale')).toBe(false);
    expect(await stillOwnsJob(db, job.id, 'w1', 1)).toBe(false);

    const after = await rowOf(job.id);
    expect(after).toMatchObject({ state: 'running', lease_owner: 'w1', attempt: 2, stage: null, error_code: null });
    // The stale heartbeat did not renew (or shorten) the successor's lease.
    expect(after.lease_expiry!.getTime()).toBe(successorLease.getTime());

    // The current attempt keeps full authority through the same writers.
    expect(await stillOwnsJob(db, job.id, 'w1', 2)).toBe(true);
    expect(await heartbeatJob(db, job.id, 'w1', 2, 60_000)).toBe(true);
    expect(await setJobStage(db, job.id, 'w1', 2, 'fresh')).toBe(true);
    expect(await completeJob(db, job.id, 'w1', 2, { state: 'complete' })).toBe(true);
    expect((await getJobById(db, job.id))?.state).toBe('complete');
  });

  it('a stale attempt cannot cancel the successor through the cancellation cleanup; the current attempt still finalizes a requested cancellation', async () => {
    const job = await newAttemptJob();
    await claimById(job.id, 'w1');
    await reclaim(job.id, 'w1'); // attempt 2, same worker

    // The old execution observed "stop" (e.g. its guard rejected a lost
    // lease): its cancelled-cleanup must not finalize the successor row.
    expect(await markJobCancelled(db, job.id, 'w1', 1)).toBe(false);
    expect(await rowOf(job.id)).toMatchObject({ state: 'running', lease_owner: 'w1', attempt: 2 });

    // Control: the CURRENT attempt's cleanup still works for its own row.
    expect(await cancelJob(db, job.id)).toBe('running');
    expect(await markJobCancelled(db, job.id, 'w1', 2)).toBe(true);
    expect((await getJobById(db, job.id))?.state).toBe('cancelled');
  });

  it('a stale attempt cannot requeue or fail the successor (retryable and nonretryable); the current attempt still fails honestly', async () => {
    const retryable = await newAttemptJob();
    await claimById(retryable.id, 'w1');
    await reclaim(retryable.id, 'w1');
    expect(
      await failJob(db, retryable.id, 'w1', 1, { code: 'provider_unavailable', message: 'down', retryable: true }),
    ).toBeNull();
    expect(await rowOf(retryable.id)).toMatchObject({ state: 'running', lease_owner: 'w1', attempt: 2, error_code: null });
    // The current attempt's retryable failure still requeues with backoff.
    const now = await failJob(db, retryable.id, 'w1', 2, { code: 'provider_unavailable', message: 'down', retryable: true }, { retryAfterMs: 0 });
    expect(now?.state).toBe('queued');

    const terminal = await newAttemptJob();
    await claimById(terminal.id, 'w1');
    await reclaim(terminal.id, 'w1');
    expect(
      await failJob(db, terminal.id, 'w1', 1, { code: 'invalid_input', message: 'nope', retryable: false }),
    ).toBeNull();
    expect(await rowOf(terminal.id)).toMatchObject({ state: 'running', lease_owner: 'w1', attempt: 2, error_code: null });
    const end = await failJob(db, terminal.id, 'w1', 2, { code: 'invalid_input', message: 'nope', retryable: false });
    expect(end?.state).toBe('failed');
    expect((await getJobById(db, terminal.id))?.error_code).toBe('invalid_input');
  });

  it('a different-worker transfer keeps rejecting the old worker across both attempts (control)', async () => {
    const job = await newAttemptJob();
    await claimById(job.id, 'w1'); // attempt 1
    await reclaim(job.id, 'w2'); // an independent worker reclaims at attempt 2

    expect(await completeJob(db, job.id, 'w1', 1, { state: 'complete' })).toBe(false);
    expect(await heartbeatJob(db, job.id, 'w1', 1, 60_000)).toBe(false);
    expect(await setJobStage(db, job.id, 'w1', 1, 'stale')).toBe(false);
    expect(await markJobCancelled(db, job.id, 'w1', 1)).toBe(false);
    expect(await stillOwnsJob(db, job.id, 'w1', 1)).toBe(false);
    expect(await failJob(db, job.id, 'w1', 1, { code: 'invalid_input', message: 'nope', retryable: false })).toBeNull();

    // The successor worker keeps full authority.
    expect(await stillOwnsJob(db, job.id, 'w2', 2)).toBe(true);
    expect(await heartbeatJob(db, job.id, 'w2', 2, 60_000)).toBe(true);
    expect(await completeJob(db, job.id, 'w2', 2, { state: 'complete' })).toBe(true);
  });

  it('the failJob SELECT-to-UPDATE window: a same-worker reclaim committing between the statements is not mutated by the old UPDATE', async () => {
    const job = await newAttemptJob();
    await claimById(job.id, 'w1'); // attempt 1

    // Park the old execution's failure between its SELECT (which ran against
    // its own live row) and its UPDATE.
    const park = parkedQueryDb(db, /UPDATE jobs SET state = \$\d+, error_code = \$\d+/);
    const failing = failJob(park.db, job.id, 'w1', 1, { code: 'provider_unavailable', message: 'down', retryable: true }, { retryAfterMs: 0 });
    await park.arrived;

    // The SAME worker reclaims the lapsed lease between the two statements.
    const successor = await reclaim(job.id, 'w1');
    expect(successor.attempt).toBe(2);

    park.release();
    // The old UPDATE re-evaluates the pinned attempt against the successor
    // row and matches nothing: the successor is left exactly as the real
    // reclaim writer left it.
    expect(await failing).toBeNull();
    expect(await rowOf(job.id)).toMatchObject({ state: 'running', lease_owner: 'w1', attempt: 2, error_code: null });

    // And the successor attempt still completes.
    expect(await completeJob(db, job.id, 'w1', 2, { state: 'complete' })).toBe(true);
  });
});

describe('job stages', () => {
  it('first completion wins and runStageOnce does not repeat work', async () => {
    const { job } = await newPollJob();
    let calls = 0;
    const run = () => runStageOnce(db, { jobId: job.id, stage: 'observe', attempt: 1 }, async () => ({ n: ++calls }));
    expect(await run()).toEqual({ n: 1 });
    expect(await run()).toEqual({ n: 1 });
    expect(calls).toBe(1);
    const overwritten = await recordStage(db, { jobId: job.id, stage: 'observe', status: 'complete', attempt: 2, output: { n: 99 } });
    expect(overwritten.output).toEqual({ n: 1 });
    expect((await getStage(db, job.id, 'observe'))?.attempt).toBe(1);
  });
});
