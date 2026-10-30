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

describe('the all-time total ceiling (VAL-OPS-002: durable budgets enforce the total)', () => {
  it('counts settled, unknown and reserved spend from EVERY day against the total ceiling, across restarts', async () => {
    let now = Date.parse('2026-10-15T10:00:00Z');
    const store = new MemorySpendStore();
    // Ceiling 250 micros all-time; daily limits stay roomy so ONLY the total binds.
    const capped = { ...limits, dailyMicros: 1_000_000, accountDailyMicros: 1_000_000, maxUnknownMicros: 1_000_000, totalMicros: 250 };
    let ledger = new ModelSpendLedger(store, capped, () => now);

    // Day 1: one attempt settles at 100 (billed).
    const a = await ledger.reserve(identity, profile);
    await ledger.finish(a, 'complete', response);
    await ledger.reconcile(a, 100);

    // Day 2 (a restart reconstructs the ledger over the same store): one
    // attempt stays unknown — it counts at its reserved amount.
    now += 24 * 3600 * 1000;
    ledger = new ModelSpendLedger(store, capped, () => now);
    const b = await ledger.reserve({ ...identity, attemptKey: 'day2' }, profile);
    await ledger.finish(b, 'timeout');

    // Day 3: the ceiling has 50 micros left, so a 100-micro reservation is
    // refused honestly — the all-time spend never exceeds the ceiling.
    now += 24 * 3600 * 1000;
    ledger = new ModelSpendLedger(store, capped, () => now);
    await expect(
      ledger.reserve({ ...identity, attemptKey: 'over-ceiling' }, profile),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
    // A smaller reservation still fits inside what is left.
    const small = { ...profile, reservationMicros: 50 };
    const c = await ledger.reserve({ ...identity, attemptKey: 'fits' }, small);
    expect(c).toBeDefined();
  });

  it('without a configured total ceiling the ledger keeps its daily-only semantics', async () => {
    let now = Date.parse('2026-10-16T10:00:00Z');
    const store = new MemorySpendStore();
    let ledger = new ModelSpendLedger(store, { ...limits, dailyMicros: 150, accountDailyMicros: 600, maxUnknownMicros: 500 }, () => now);
    const first = await ledger.reserve(identity, profile);
    await ledger.finish(first, 'complete', response);
    await ledger.reconcile(first, 100);
    now += 24 * 3600 * 1000;
    ledger = new ModelSpendLedger(store, { ...limits, dailyMicros: 150, accountDailyMicros: 600, maxUnknownMicros: 500 }, () => now);
    // All-time spend (100 settled) equals two-thirds of one day's allowance
    // but nothing binds cumulative spend when no total is configured: the
    // next day starts fresh and the reservation fits.
    await ledger.reserve({ ...identity, attemptKey: 'next-day' }, profile);
  });
});

describe('two-stage reservation pre-check (amendment 2.2)', () => {
  const quick = { ...profile, role: 'vision_photo' as const, reservationMicros: 100 };
  const enrich = { ...profile, role: 'vision_photo_enrich' as const, reservationMicros: 200 };
  it('is true only when both stages fit together, and reserves nothing', async () => {
    const store = new MemorySpendStore();
    const ledger = new ModelSpendLedger(store, {
      ...limits,
      accountDailyMicros: 300,
      dailyMicros: 1000,
      maxUnknownMicros: 1000,
    });
    await expect(ledger.canReserveAll(identity, [quick, enrich])).resolves.toBe(true);
    expect((await store.read()).attempts).toHaveLength(0);
    await ledger.reserve(identity, quick);
    // 100 already reserved by this account: the pair (300 more) no longer fits under 300.
    await expect(ledger.canReserveAll(identity, [quick, enrich])).resolves.toBe(false);
    await expect(ledger.canReserveAll(identity, [enrich])).resolves.toBe(true);
    await expect(ledger.canReserveAll(identity, [])).resolves.toBe(false);
  });
  it('counts both stages of one job as one analysis; false while paused or a role circuit is open', async () => {
    const store = new MemorySpendStore();
    const ledger = new ModelSpendLedger(store, {
      ...limits,
      accountDailyAnalyses: 1,
      dailyMicros: 10_000,
      accountDailyMicros: 10_000,
      maxUnknownMicros: 10_000,
    });
    await ledger.reserve(identity, quick);
    await expect(ledger.canReserveAll(identity, [enrich])).resolves.toBe(true);
    await expect(
      ledger.canReserveAll({ ...identity, jobId: 'job-2' }, [quick, enrich]),
    ).resolves.toBe(false);
    const id = await ledger.reserve({ ...identity, attemptKey: 'enrich' }, enrich);
    await ledger.finish(id, 'auth', undefined, {
      circuit: { role: 'vision_photo_enrich', reason: 'auth' },
    });
    await expect(ledger.canReserveAll(identity, [quick, enrich])).resolves.toBe(false);
    await expect(ledger.canReserveAll(identity, [quick])).resolves.toBe(true);
    await store.transaction((s) => {
      s.pause = { reason: 'credits', until: null };
    });
    await expect(ledger.canReserveAll(identity, [quick])).resolves.toBe(false);
  });
});
