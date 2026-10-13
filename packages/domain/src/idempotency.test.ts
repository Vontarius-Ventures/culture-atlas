import { afterAll, describe, expect, it } from 'vitest';
import { withIdempotency } from './idempotency';
import { closeTestDb, getTestDb, insertAccount } from './testing';

const db = getTestDb();
afterAll(closeTestDb);

describe('withIdempotency', () => {
  it('replays the stored response for the same key and payload', async () => {
    const principal = await insertAccount(db);
    let runs = 0;
    const call = (body: unknown) =>
      withIdempotency(db, { principal, route: 'POST /v1/collections', key: 'k-1', request: body }, async () => ({
        status: 201,
        body: { id: `c-${++runs}` },
      }));
    const first = await call({ name: 'Rooms' });
    const second = await call({ name: 'Rooms' });
    expect(first).toEqual({ status: 201, body: { id: 'c-1' }, replayed: false });
    expect(second).toEqual({ status: 201, body: { id: 'c-1' }, replayed: true });
    expect(runs).toBe(1);
    await expect(call({ name: 'Different' })).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
  });

  it('scopes keys per principal and releases the key when the handler throws', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const req = { route: 'POST /v1/plans', key: 'shared', request: { x: 1 } };
    await withIdempotency(db, { principal: a, ...req }, async () => ({ status: 202, body: 'a' }));
    const forB = await withIdempotency(db, { principal: b, ...req }, async () => ({ status: 202, body: 'b' }));
    expect(forB.body).toBe('b');

    await expect(
      withIdempotency(db, { principal: a, ...req, key: 'boom' }, async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    const retry = await withIdempotency(db, { principal: a, ...req, key: 'boom' }, async () => ({ status: 202, body: 'ok' }));
    expect(retry.replayed).toBe(false);
  });
});
