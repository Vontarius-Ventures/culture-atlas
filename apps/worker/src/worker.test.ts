import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AppError,
  JOB_HANDLERS,
  enqueueJob,
  getJobById,
  type Db,
  type JobHandlerMap,
} from '@culture-atlas/domain';
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

function worker(
  h: JobHandlerMap,
  jobIds: string[],
  opts: { concurrency?: number; leaseMs?: number; heartbeatMs?: number; logs?: string[] } = {},
) {
  return new Worker({
    db,
    providers: testProviders(),
    config: testConfig(),
    handlers: h,
    jobIds,
    log: (m) => opts.logs?.push(m),
    concurrency: opts.concurrency ?? 5,
    leaseMs: opts.leaseMs ?? 30_000,
    heartbeatMs: opts.heartbeatMs ?? 10_000,
    pollMs: 5,
  });
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

/**
 * A worker's lease names (job, worker, ATTEMPT). When an execution outlives
 * its lease, the SAME worker reclaims its own job at a newer attempt while
 * the old execution is still running — the old execution's terminal writes
 * (completion, failure, cancellation cleanup), its heartbeats/progress and
 * its running-map slot then all target a row (and a slot) that belongs to
 * the successor attempt. Every case parks the old execution past a REAL
 * lease lapse, lets the worker itself reclaim at attempt 2, then releases
 * the old execution and asserts the successor attempt stays untouched and
 * still converges, with drain/stop accounting correct.
 */
describe('same-worker expired-lease reclaim (shared attempt fence)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function gate(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  /**
   * A Db view that holds every real heartbeat UPDATE (`UPDATE jobs SET
   * lease_expiry …`) client-side until `open()`: a parked execution's beats
   * never renew while held, so its lease really lapses, and the beats that
   * later flow through are exactly the stale ones the test wants to observe.
   * All other statements (claims, stages, terminal writes) pass through.
   */
  function holdHeartbeatDb(base: Db): { db: Db; open: () => void } {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const wrap = (inner: Db): Db => {
      const self: Db = {
        inTransaction: inner.inTransaction,
        query: (async (text: string, params?: readonly unknown[]) =>
          /^UPDATE jobs SET lease_expiry/m.test(text)
            ? gate.then(() => inner.query(text, params))
            : inner.query(text, params)) as Db['query'],
        transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
      };
      return self;
    };
    return { db: wrap(base), open: () => openGate() };
  }

  async function jobRow(jobId: string) {
    const { rows } = await db.query<{
      state: string;
      lease_owner: string | null;
      attempt: number;
      stage: string | null;
      error_code: string | null;
    }>('SELECT state, lease_owner, attempt, stage, error_code FROM jobs WHERE id = $1', [jobId]);
    return rows[0]!;
  }

  it('an old attempt completing after the same worker reclaimed the job cannot complete the successor; stop accounting keeps the successor tracked', async () => {
    const job = await enqueue(5);
    const oldParked = gate();
    const oldHold = gate();
    const newParked = gate();
    const newHold = gate();
    const attempts: number[] = [];
    const logs: string[] = [];
    const w = worker(
      handlers(async (ctx) => {
        attempts.push(ctx.attempt);
        if (ctx.attempt === 1) {
          await ctx.ensureActive(); // passes on the live attempt-1 lease
          oldParked.release();
          await oldHold.promise; // the old execution sits here past its lease
        } else {
          newParked.release();
          await newHold.promise; // the successor attempt parks in the same worker
        }
        return { state: 'complete' };
      }),
      [job.id],
      { leaseMs: 250, heartbeatMs: 60_000, logs },
    );

    // Attempt 1 starts and parks inside the handler.
    await w.tick();
    await oldParked.promise;
    // The lease really lapses; the worker reclaims its own job at attempt 2.
    await sleep(400);
    expect(await w.tick()).toBe(1);
    await newParked.promise;

    // The old execution finishes: its completion must NOT mutate attempt 2…
    oldHold.release();
    await sleep(150);
    // …and its settle must not erase the successor's running slot: stop()
    // still has work to wait for.
    let stopped = false;
    const stoppedPromise = w.stop().then(() => {
      stopped = true;
    });
    await sleep(150);
    expect(stopped).toBe(false);
    expect(await jobRow(job.id)).toMatchObject({ state: 'running', lease_owner: w.workerId, attempt: 2 });

    newHold.release();
    await stoppedPromise;
    expect(await jobRow(job.id)).toMatchObject({ state: 'complete', attempt: 2, lease_owner: null });
    expect(attempts).toEqual([1, 2]);
    // The old attempt's completion was rejected, not the successor's.
    expect(logs.some((l) => l.includes('completion rejected'))).toBe(true);
  }, 10_000);

  it('stale heartbeats, stale progress and the old attempt\'s cancellation cleanup cannot stop or renew the successor', async () => {
    const job = await enqueue(5);
    const oldParked = gate();
    const oldHold = gate();
    const newParked = gate();
    const newHold = gate();
    // Hold the real heartbeat interval's statements client-side: the old
    // execution stops renewing (its lease really lapses with no successful
    // beat), and its beats only reach the server after the same-worker
    // reclaim — genuinely stale writes against the successor's row.
    const held = holdHeartbeatDb(db);
    const w = new Worker({
      db: held.db,
      providers: testProviders(),
      config: testConfig(),
      handlers: handlers(async (ctx) => {
        if (ctx.attempt === 1) {
          await ctx.setStage('observing'); // current while attempt 1 owns the row
          oldParked.release();
          await oldHold.promise; // lease lapses; the same worker reclaims here
          await ctx.setStage('stale-progress'); // must be refused for attempt 2
          await ctx.ensureActive(); // must refuse the superseded attempt
          return { state: 'complete' };
        }
        await ctx.setStage('fresh');
        newParked.release();
        await newHold.promise;
        return { state: 'complete' };
      }),
      jobIds: [job.id],
      log: () => undefined,
      concurrency: 5,
      leaseMs: 250,
      heartbeatMs: 10,
      pollMs: 5,
    });

    await w.tick();
    await oldParked.promise;
    await sleep(400);
    expect(await w.tick()).toBe(1);
    await newParked.promise;
    // The real interval beats now fire: the old attempt's are stale.
    held.open();
    await sleep(150);

    oldHold.release();
    await sleep(150);
    // The stale heartbeat/progress never renewed, restaged or completed the
    // successor, and the old attempt's cancellation cleanup (its
    // JobCancelledError path) did not cancel it either.
    expect(await jobRow(job.id)).toMatchObject({ state: 'running', lease_owner: w.workerId, attempt: 2, stage: 'fresh' });

    newHold.release();
    await w.stop();
    expect(await jobRow(job.id)).toMatchObject({ state: 'complete', attempt: 2, lease_owner: null });
  }, 10_000);

  it('an old attempt\'s nonretryable failure after the same worker reclaimed the job cannot fail the successor', async () => {
    const job = await enqueue(5);
    const oldParked = gate();
    const oldHold = gate();
    const newParked = gate();
    const newHold = gate();
    const w = worker(
      handlers(async (ctx) => {
        if (ctx.attempt === 1) {
          await ctx.ensureActive();
          oldParked.release();
          await oldHold.promise;
          throw new AppError('invalid_input');
        }
        newParked.release();
        await newHold.promise;
        return { state: 'complete' };
      }),
      [job.id],
      { leaseMs: 250, heartbeatMs: 60_000 },
    );

    await w.tick();
    await oldParked.promise;
    await sleep(400);
    expect(await w.tick()).toBe(1);
    await newParked.promise;

    oldHold.release();
    await sleep(150);
    expect(await jobRow(job.id)).toMatchObject({
      state: 'running',
      lease_owner: w.workerId,
      attempt: 2,
      error_code: null,
    });

    newHold.release();
    await w.stop();
    expect(await jobRow(job.id)).toMatchObject({ state: 'complete', attempt: 2, lease_owner: null });
  }, 10_000);

  it('an old attempt\'s retryable failure after the same worker reclaimed the job cannot requeue the successor', async () => {
    const job = await enqueue(5);
    const oldParked = gate();
    const oldHold = gate();
    const newParked = gate();
    const newHold = gate();
    const w = worker(
      handlers(async (ctx) => {
        if (ctx.attempt === 1) {
          await ctx.ensureActive();
          oldParked.release();
          await oldHold.promise;
          throw new ProviderError('qloo', 'server', 'boom', { retryAfterMs: 60_000 });
        }
        newParked.release();
        await newHold.promise;
        return { state: 'complete' };
      }),
      [job.id],
      { leaseMs: 250, heartbeatMs: 60_000 },
    );

    await w.tick();
    await oldParked.promise;
    await sleep(400);
    expect(await w.tick()).toBe(1);
    await newParked.promise;

    oldHold.release();
    await sleep(150);
    expect(await jobRow(job.id)).toMatchObject({
      state: 'running',
      lease_owner: w.workerId,
      attempt: 2,
      error_code: null,
    });

    newHold.release();
    await w.stop();
    expect(await jobRow(job.id)).toMatchObject({ state: 'complete', attempt: 2, lease_owner: null });
  }, 10_000);
});
