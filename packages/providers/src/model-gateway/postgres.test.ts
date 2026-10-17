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
