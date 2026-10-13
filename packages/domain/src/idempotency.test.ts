import { afterAll, describe, expect, it } from 'vitest';
import { withIdempotency } from './idempotency';
import { ROUTES } from './schemas/routes';
import { createAgentConnection } from './services/agent-connections';
import { accountCtx } from './test-support/library';
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

  it('never stores a shown-once agent credential and refuses to replay it', async () => {
    const { principal, ctx } = await accountCtx();
    const route = ROUTES.createAgentConnection;
    expect(route.oneTimeSecrets).toContain('credential');
    const body = { client_name: 'Demo agent', scopes: ['collections:read' as const], library_access: 'all' as const, collection_ids: [], expires_in_days: 30 };
    let runs = 0;
    const call = () =>
      withIdempotency(
        db,
        { principal, route: `${route.method} ${route.path}`, key: 'conn-1', request: body, secretFields: route.oneTimeSecrets },
        async () => {
          runs++;
          return { status: 201, body: await createAgentConnection(ctx, body) };
        },
      );
    const first = await call();
    const credential = (first.body as { credential: string }).credential;
    expect(credential).toMatch(/^cat_/);

    const { rows } = await db.query<{ b: string }>(
      `SELECT response_body::text AS b FROM idempotency_keys WHERE key = 'conn-1' AND route = $1`,
      [`${route.method} ${route.path}`],
    );
    expect(rows[0]!.b).not.toContain(credential);
    expect(rows[0]!.b).not.toContain('"credential"');

    await expect(call()).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
    expect(runs).toBe(1);
  });

  it('every route whose response carries a shown-once secret declares it', () => {
    expect(ROUTES.createAgentConnection.oneTimeSecrets).toEqual(['credential']);
    expect(ROUTES.createAccount.oneTimeSecrets).toEqual(['csrf_token']);
    // Bridge tokens are not replayable at all.
    expect(ROUTES.createSensorConnection.idempotent).toBe(false);
  });
});
