import { describe, expect, it } from 'vitest';
import { identity, limits, profile, response } from '../concentrate/test-fixtures';
import { MemorySpendStore, ModelSpendLedger } from './budget';

describe('AI-02 budget accounting, no inference', () => {
  it('counts reserved attempts against global, account and potential-unknown caps', async () => {
    const store = new MemorySpendStore();
    const ledger = new ModelSpendLedger(store, {
      ...limits,
      dailyMicros: 100,
      accountDailyMicros: 100,
    });
    await ledger.reserve(identity, profile);
    await expect(
      ledger.reserve({ ...identity, attemptKey: 'other' }, profile),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
    await expect(
      ledger.reserve({ ...identity, accountId: 'other' }, profile),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
  });
  it('keeps null usage and successful token-only usage charged as unknown until billing', async () => {
    const store = new MemorySpendStore();
    const ledger = new ModelSpendLedger(store, { ...limits, maxUnknownMicros: 200 });
    const a = await ledger.reserve(identity, profile);
    await ledger.finish(a, 'complete', { ...response, usage: null });
    const b = await ledger.reserve({ ...identity, attemptKey: 'other' }, profile);
    await ledger.finish(b, 'complete', response);
    expect((await store.read()).attempts.map((a) => a.costMicros)).toEqual([null, null]);
    await expect(
      ledger.reserve({ ...identity, accountId: 'other' }, profile),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
    await ledger.reconcile(a, 20);
    await ledger.reserve({ ...identity, accountId: 'other' }, profile);
    await expect(ledger.reconcile(a, 20)).resolves.toBeUndefined();
    await expect(ledger.reconcile(a, 0)).rejects.toThrow('Conflicting');
  });
  it('keeps old-day unresolved charges counted across midnight and restart', async () => {
    let now = Date.parse('2026-10-15T23:59:59Z');
    const store = new MemorySpendStore();
    let ledger = new ModelSpendLedger(store, { ...limits, dailyMicros: 100 }, () => now);
    await ledger.reserve(identity, profile);
    now += 2000;
    ledger = new ModelSpendLedger(store, { ...limits, dailyMicros: 100 }, () => now);
    await expect(ledger.reserve({ ...identity, jobId: 'new-day' }, profile)).rejects.toMatchObject({
      kind: 'budget_exhausted',
    });
  });
  it('limits unique account/day analyses, retry reuses the job identity without resetting spend', async () => {
    const ledger = new ModelSpendLedger(new MemorySpendStore(), {
      ...limits,
      accountDailyAnalyses: 1,
    });
    await ledger.reserve(identity, profile);
    await ledger.reserve({ ...identity, attemptKey: 'retry' }, profile);
    await expect(
      ledger.reserve({ ...identity, jobId: 'different-job' }, profile),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
    await ledger.reserve({ ...identity, accountId: 'different-account' }, profile);
  });
  it('keeps account spend separate while enforcing global spend', async () => {
    const ledger = new ModelSpendLedger(new MemorySpendStore(), {
      ...limits,
      accountDailyMicros: 100,
      dailyMicros: 200,
    });
    await ledger.reserve(identity, profile);
    await expect(
      ledger.reserve({ ...identity, attemptKey: 'again' }, profile),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
    await ledger.reserve({ ...identity, accountId: 'other' }, profile);
    await expect(
      ledger.reserve({ ...identity, accountId: 'third' }, profile),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
  });
  it('late rate-limit completion cannot reopen a credit pause; only operator resume does', async () => {
    let now = Date.now();
    const ledger = new ModelSpendLedger(new MemorySpendStore(), limits, () => now);
    const a = await ledger.reserve(identity, profile);
    const b = await ledger.reserve({ ...identity, attemptKey: 'other' }, profile);
    await ledger.finish(a, 'credits', undefined, { reason: 'credits', until: null });
    await ledger.finish(b, 'rate_limited', undefined, {
      reason: 'rate_limited',
      until: now + 1000,
    });
    now += 2000;
    await expect(ledger.status()).resolves.toEqual({ reason: 'credits', until: null });
    await expect(
      ledger.reserve({ ...identity, attemptKey: 'third' }, profile),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
    await ledger.resume();
    await ledger.reserve({ ...identity, attemptKey: 'third' }, profile);
  });
  it('settles actual reconciled costs and pauses dispatch on reservation overrun', async () => {
    const ledger = new ModelSpendLedger(new MemorySpendStore(), limits);
    const id = await ledger.reserve(identity, profile);
    await expect(ledger.reconcile(id, 1)).rejects.toThrow('in-flight');
    await ledger.finish(id, 'complete', response);
    await ledger.reconcile(id, 101);
    await expect(ledger.status()).resolves.toMatchObject({ reason: 'cost_overrun' });
    await expect(ledger.reconcile(id, Number.NaN)).rejects.toThrow('Invalid actual cost');
  });
});
