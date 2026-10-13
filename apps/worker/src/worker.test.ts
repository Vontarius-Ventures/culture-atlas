import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError, JOB_HANDLERS, enqueueJob, getJobById, type JobHandlerMap } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAnonymousSession, testConfig, testProviders } from '@culture-atlas/domain/testing';
import { ProviderError } from '@culture-atlas/providers';
import { Worker } from './worker';

const db = getTestDb();
afterAll(closeTestDb);

function handlers(sensorPoll: JobHandlerMap['sensor_poll']): JobHandlerMap {
  return { ...JOB_HANDLERS, sensor_poll: sensorPoll };
}

async function enqueue(maxAttempts = 2) {
  const s = await insertAnonymousSession(db);
  const { job } = await enqueueJob(db, {
    type: 'sensor_poll',
    owner: { kind: 'session', sessionId: s.sessionId },
    payload: { sensor_connection_id: randomUUID() },
    maxAttempts,
  });
  return job;
}

function worker(h: JobHandlerMap, jobIds: string[]) {
  return new Worker({ db, providers: testProviders(), config: testConfig(), handlers: h, jobIds, log: () => undefined });
}

describe('Worker', () => {
  it('runs a handler with idempotent stages and completes the job', async () => {
    const job = await enqueue();
    let observed = 0;
    const w = worker(
      handlers(async (ctx) => {
        await ctx.setStage('observing');
        await ctx.runStage('observe', async () => ++observed);
        await ctx.ensureActive();
        return { state: 'partial', resultType: 'sensor_connection', resultId: ctx.payload.sensor_connection_id };
      }),
      [job.id],
    );
    await w.drain();
    const done = await getJobById(db, job.id);
    expect(done?.state).toBe('partial');
    expect(done?.stage).toBe('observing');
    expect(observed).toBe(1);
  });

  it('re-queues provider outages with backoff and fails non-retryable errors', async () => {
    const outage = await enqueue();
    const bad = await enqueue();
    const w = worker(
      handlers(async (ctx) => {
        if (ctx.job.id === outage.id) throw new ProviderError('qloo', 'server', 'boom', { retryAfterMs: 60_000 });
        if (ctx.job.id === bad.id) throw new AppError('invalid_input');
        return { state: 'complete' };
      }),
      [outage.id, bad.id],
    );
    await w.drain();
    const o = await getJobById(db, outage.id);
    expect(o?.state).toBe('queued');
    expect(o?.error_code).toBe('provider_unavailable');
    expect(o!.available_at.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect((await getJobById(db, bad.id))?.state).toBe('failed');
  });

  it('marks the job cancelled when cancellation is requested mid-run', async () => {
    const job = await enqueue();
    const w = worker(
      handlers(async (ctx) => {
        if (ctx.job.id === job.id) {
          await db.query('UPDATE jobs SET cancel_requested_at = now() WHERE id = $1', [job.id]);
          await ctx.ensureActive();
        }
        return { state: 'complete' };
      }),
      [job.id],
    );
    await w.drain();
    expect((await getJobById(db, job.id))?.state).toBe('cancelled');
  });
});
