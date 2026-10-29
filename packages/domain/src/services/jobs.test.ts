import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { cancelJob, claimJobs, completeJob, enqueueJob, failJob, recordStage } from '../jobs';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, insertAnonymousSession, testContext } from '../testing';
import { getJob, pollAfterMs } from './jobs';

const db = getTestDb();
afterAll(closeTestDb);

async function sensorJob(owner: { kind: 'session'; sessionId: string } | { kind: 'account'; accountId: string }, agentConnectionId?: string) {
  const { job } = await enqueueJob(db, {
    type: 'sensor_poll',
    owner,
    payload: { sensor_connection_id: randomUUID() },
    agentConnectionId: agentConnectionId ?? null,
    maxAttempts: 2,
  });
  return job;
}

describe('job polling', () => {
  it('reports state transitions, sections, errors and polling cadence', async () => {
    const anon = await insertAnonymousSession(db);
    const ctx = testContext(anon);
    const job = await sensorJob({ kind: 'session', sessionId: anon.sessionId });
    expect(await getJob(ctx, { id: job.id })).toMatchObject({ state: 'queued', poll_after_ms: 1500, error: null, result: null });

    const [claimed] = await claimJobs(db, { workerId: 'w1', limit: 1, leaseMs: 30_000, ids: [job.id] });
    await recordStage(db, { jobId: job.id, stage: 'observe', status: 'complete', attempt: claimed!.attempt, output: {} });
    const running = await getJob(ctx, { id: job.id });
    expect(running.state).toBe('running');
    expect(running.sections).toEqual([{ name: 'observe', status: 'complete' }]);

    // A transient failure re-queues (still active); a second failure is terminal with a structured error.
    await failJob(db, job.id, 'w1', claimed!.attempt, { code: 'provider_unavailable', message: 'Related discoveries are taking longer.', retryable: true }, { retryAfterMs: 0 });
    expect((await getJob(ctx, { id: job.id })).state).toBe('queued');
    const [reclaimed] = await claimJobs(db, { workerId: 'w2', limit: 1, leaseMs: 30_000, ids: [job.id] });
    await failJob(db, job.id, 'w2', reclaimed!.attempt, { code: 'provider_unavailable', message: 'Related discoveries are taking longer.', retryable: true });
    const failed = await getJob(ctx, { id: job.id });
    expect(failed).toMatchObject({
      state: 'failed',
      poll_after_ms: null,
      error: { code: 'provider_unavailable', message: 'Related discoveries are taking longer.', retryable: true },
    });

    const ok = await sensorJob({ kind: 'session', sessionId: anon.sessionId });
    await claimJobs(db, { workerId: 'w3', limit: 1, leaseMs: 30_000, ids: [ok.id] });
    await completeJob(db, ok.id, 'w3', 1, { state: 'partial', resultType: 'sensor_connection', resultId: randomUUID() });
    expect(await getJob(ctx, { id: ok.id })).toMatchObject({ state: 'partial', poll_after_ms: null, result: { type: 'sensor_connection' } });

    const c = await sensorJob({ kind: 'session', sessionId: anon.sessionId });
    await cancelJob(db, c.id);
    expect((await getJob(ctx, { id: c.id })).state).toBe('cancelled');
  });

  it('backs off after 15 seconds and stops when terminal', () => {
    const created = new Date('2026-10-13T00:00:00Z');
    expect(pollAfterMs('queued', created, new Date('2026-10-13T00:00:05Z'))).toBe(1500);
    expect(pollAfterMs('running', created, new Date('2026-10-13T00:00:20Z'))).toBe(4000);
    expect(pollAfterMs('complete', created, new Date('2026-10-13T00:00:01Z'))).toBeNull();
  });

  it('hides jobs from other owners and limits agents to their own or granted work', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const job = await sensorJob({ kind: 'account', accountId: a.accountId });
    await expect(getJob(testContext(b), { id: job.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(getJob(testContext(await insertAnonymousSession(db)), { id: job.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(getJob(testContext(a), { id: randomUUID() })).rejects.toMatchObject({ code: 'not_found' });

    const { principal: whole } = await insertAgentConnection(a, { libraryAccess: 'all' });
    expect((await getJob(testContext(whole), { id: job.id })).id).toBe(job.id);
    const { principal: limited } = await insertAgentConnection(a, { libraryAccess: 'selected_collections' });
    await expect(getJob(testContext(limited), { id: job.id })).rejects.toMatchObject({ code: 'not_found' });
    const own = await sensorJob({ kind: 'account', accountId: a.accountId }, limited.connectionId);
    expect((await getJob(testContext(limited), { id: own.id })).id).toBe(own.id);
  });
});
