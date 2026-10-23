import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAnonymousSession } from '../testing';
import { backoffMs, cancelJob, claimJobs, completeJob, enqueueJob, failJob, getJobById, heartbeatJob, reapJobs } from './queue';
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
    expect(await completeJob(db, job.id, other, { state: 'complete' })).toBe(false);
    expect(await heartbeatJob(db, job.id, owner.lease_owner!, 30_000)).toBe(true);
    expect(await completeJob(db, job.id, owner.lease_owner!, { state: 'complete' })).toBe(true);
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
    await claimById(job.id, 'w1');
    const r1 = await failJob(db, job.id, 'w1', { code: 'provider_unavailable', message: 'down', retryable: true }, { retryAfterMs: 0 });
    expect(r1?.state).toBe('queued');
    await claimById(job.id, 'w1');
    const r2 = await failJob(db, job.id, 'w1', { code: 'provider_unavailable', message: 'down', retryable: true });
    expect(r2?.state).toBe('failed');
    const stored = await getJobById(db, job.id);
    expect(stored?.error_code).toBe('provider_unavailable');
    expect(stored?.finished_at).not.toBeNull();
  });

  it('recovers a job whose lease expired', async () => {
    const { job } = await newPollJob();
    await claimById(job.id, 'dead-worker');
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [job.id]);
    const again = await claimById(job.id, 'new-worker');
    expect(again.attempt).toBe(2);
    expect(await completeJob(db, job.id, 'dead-worker', { state: 'complete' })).toBe(false);
    // Final attempt also abandoned -> reaper fails it.
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [job.id]);
    await reapJobs(db);
    expect((await getJobById(db, job.id))?.state).toBe('failed');
  });

  it('cancels queued jobs immediately and flags running ones', async () => {
    const queued = await newPollJob();
    expect(await cancelJob(db, queued.job.id)).toBe('cancelled');
    const running = await newPollJob();
    await claimById(running.job.id, 'w2');
    expect(await cancelJob(db, running.job.id)).toBe('running');
    expect(await heartbeatJob(db, running.job.id, 'w2', 30_000)).toBe(false);
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
