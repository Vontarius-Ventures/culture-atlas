import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createDb } from '../../../domain/src/db/pool';
import { ModelSpendLedger } from './budget';
import { PostgresSpendStore } from './postgres';
import { limits, profile, response } from '../concentrate/test-fixtures';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
const db = createDb(inject('databaseUrl'), 5);
const createdAccounts: string[] = [];
afterAll(() => db.end());
beforeEach(async () => {
  // Reconcile ONLY artifacts made by this file. Never truncate shared test tables.
  const ledger = new ModelSpendLedger(new PostgresSpendStore(db), limits);
  for (const attempt of (await ledger.store.read()).attempts.filter((a) =>
    createdAccounts.includes(a.identity.accountId),
  )) {
    if (attempt.state === 'reserved') await ledger.finish(attempt.id, 'test-cleanup');
    if (attempt.state !== 'settled') await ledger.reconcile(attempt.id, 0);
  }
  await ledger.resume();
});
async function account() {
  const rows = await db.query<{ id: string }>(
    'INSERT INTO accounts (auth_subject) VALUES ($1) RETURNING id',
    [`p4:${randomUUID()}`],
  );
  const accountId = rows.rows[0]!.id;
  createdAccounts.push(accountId);
  return { accountId, jobId: randomUUID(), attemptKey: 'fixture' };
}

describe('AI-02 durable PostgreSQL spend ledger, port 55504', () => {
  it('serializes concurrent global reservations across independent store instances', async () => {
    const a = await account();
    const b = await account();
    const cap = { ...limits, dailyMicros: 100 };
    const ledgers = [
      new ModelSpendLedger(new PostgresSpendStore(db), cap),
      new ModelSpendLedger(new PostgresSpendStore(db), cap),
    ];
    const outcomes = await Promise.allSettled([
      ledgers[0]!.reserve(a, profile),
      ledgers[1]!.reserve(b, profile),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('serializes account daily cap while another account can dispatch', async () => {
    const identity = await account();
    const ledger = new ModelSpendLedger(new PostgresSpendStore(db), {
      ...limits,
      accountDailyMicros: 100,
    });
    const results = await Promise.allSettled([
      ledger.reserve(identity, profile),
      ledger.reserve({ ...identity, attemptKey: 'other' }, profile),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await ledger.reserve(await account(), profile);
  });
  it('persists crash-era reservation and idempotency across store reconstruction', async () => {
    const identity = await account();
    const a = new ModelSpendLedger(new PostgresSpendStore(db), {
      ...limits,
      maxUnknownMicros: 100,
    });
    const id = await a.reserve(identity, profile);
    const b = new ModelSpendLedger(new PostgresSpendStore(db), {
      ...limits,
      maxUnknownMicros: 100,
    });
    await expect(b.reserve(identity, profile)).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(b.reserve({ ...identity, attemptKey: 'other' }, profile)).rejects.toMatchObject({
      kind: 'budget_exhausted',
    });
    expect((await b.store.read()).attempts.find((x) => x.id === id)).toMatchObject({
      state: 'reserved',
      costMicros: null,
    });
  });
  it('atomically marks unknown and then settles idempotently from actual billing', async () => {
    const identity = await account();
    const ledger = new ModelSpendLedger(new PostgresSpendStore(db), limits);
    const id = await ledger.reserve(identity, profile);
    await ledger.finish(id, 'complete', response);
    expect((await ledger.store.read()).attempts.find((a) => a.id === id)).toMatchObject({
      state: 'unknown',
      responseId: 'r1',
      costMicros: null,
    });
    await Promise.all([ledger.reconcile(id, 0), ledger.reconcile(id, 0)]);
    expect((await ledger.store.read()).attempts.find((a) => a.id === id)).toMatchObject({
      state: 'settled',
      costMicros: 0,
    });
    await expect(ledger.reconcile(id, 1)).rejects.toThrow('Conflicting');
  });
  it('rolls back failed updates without losing reservations', async () => {
    const store = new PostgresSpendStore(db);
    const ledger = new ModelSpendLedger(store, limits);
    const id = await ledger.reserve(await account(), profile);
    await expect(
      store.transaction((s) => {
        s.attempts.find((a) => a.id === id)!.state = 'settled';
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    expect((await store.read()).attempts.find((a) => a.id === id)!.state).toBe('reserved');
  });
  it('persists credit pause across restart and read-only readiness does not dispatch', async () => {
    const a = new ModelSpendLedger(new PostgresSpendStore(db), limits);
    const id = await a.reserve(await account(), profile);
    await a.finish(id, 'credits', undefined, { reason: 'credits', until: null });
    const b = new ModelSpendLedger(new PostgresSpendStore(db), limits);
    await expect(b.status()).resolves.toMatchObject({ reason: 'credits' });
    await expect(b.reserve(await account(), profile)).rejects.toMatchObject({
      kind: 'budget_exhausted',
    });
    await b.resume();
    await b.reserve(await account(), profile);
  });
  it('serializes concurrent admission at the all-time total ceiling, counting every settled day (VAL-OPS-002)', async () => {
    // All-time ceiling 250 micros; daily caps are roomy so ONLY the total binds.
    const cap = {
      ...limits,
      dailyMicros: 1_000_000,
      accountDailyMicros: 1_000_000,
      maxUnknownMicros: 1_000_000,
      totalMicros: 250,
    };
    // Day 1: one attempt settles at its reservation (billed history), so 150
    // micros of all-time allowance remain.
    const first = new ModelSpendLedger(new PostgresSpendStore(db), cap);
    const dayOne = await first.reserve(await account(), profile);
    await first.finish(dayOne, 'complete', response);
    await first.reconcile(dayOne, 100);
    // Day 2 (a fresh store/ledger pair, a day later): the settled row is
    // outside the scoped day, so the decision must come from the all-time
    // charge, and two PARALLEL admissions through independent store instances
    // must let exactly one of the two 100-micro reservations in (the second
    // would push charged spend past 250).
    const later = Date.now() + 24 * 3600 * 1000;
    const ledgers = [
      new ModelSpendLedger(new PostgresSpendStore(db), cap, () => later),
      new ModelSpendLedger(new PostgresSpendStore(db), cap, () => later),
    ];
    const outcomes = await Promise.allSettled([
      ledgers[0]!.reserve(await account(), profile),
      ledgers[1]!.reserve(await account(), profile),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // Restart does not reset the allowance: a fresh instance still sees the
    // ceiling fully consumed (100 settled + 100 reserved) and refuses the
    // next 100-micro reservation.
    const after = new ModelSpendLedger(new PostgresSpendStore(db), cap, () => later + 1000);
    await expect(after.reserve(await account(), profile)).rejects.toMatchObject({
      kind: 'budget_exhausted',
    });
  });
  it('rejects transaction-bound handles that could roll back after dispatch', async () => {
    await db.transaction(async (tx) => {
      expect(() => new PostgresSpendStore(tx)).toThrow('pool-level');
    });
  });
  it('enforces owner existence at the database boundary', async () => {
    const ledger = new ModelSpendLedger(new PostgresSpendStore(db), limits);
    await expect(
      ledger.reserve(
        { accountId: randomUUID(), jobId: randomUUID(), attemptKey: 'invalid-owner' },
        profile,
      ),
    ).rejects.toThrow('foreign key');
  });
});
