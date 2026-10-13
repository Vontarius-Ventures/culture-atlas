import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { CreateSensorConnectionRequest, SensorConnectionsListResponse, CreateSensorConnectionResponse } from '../schemas/sensor-connections';
import { getTestDb, insertAccount, insertAgentConnection, insertAnonymousSession, testConfig, testContext } from '../testing';
import { resolvePrincipal } from './auth';
import { createSensorConnection, deleteSensorConnection, listSensorConnections } from './sensor-connections';

const RELAY = 'https://relay.example.test:8443';
const KEY = randomBytes(32).toString('base64');
const config = testConfig({ SENSOR_ALLOWED_ORIGINS: `${RELAY},http://127.0.0.1:8787`, CREDENTIAL_ENCRYPTION_KEY: KEY });
const db = getTestDb();

const body = (over: Partial<Record<string, unknown>> = {}) => CreateSensorConnectionRequest.parse({ origin: RELAY, viewer_credential: 'viewer-secret-123', ...over });

async function account() {
  const a = await insertAccount(db);
  return { principal: a, ctx: testContext(a, { config }) };
}

describe('sensor connections', () => {
  it('creates a poll connection with the credential encrypted at rest and never returned', async () => {
    const { ctx } = await account();
    const res = await createSensorConnection(ctx, body({ origin: `${RELAY}/`, import_existing_asset_ids: ['a1', 'a1', 'a2'] }));
    CreateSensorConnectionResponse.parse(res);
    expect(res.bridge_token).toBeNull();
    expect(res.connection).toMatchObject({ origin: RELAY, mode: 'poll', enabled: true, status: 'connecting', imported_count: 0 });
    expect(JSON.stringify(res)).not.toContain('viewer-secret-123');

    const { rows } = await db.query<{ encrypted_viewer_credential: Buffer; credential_key_id: string; pending_selection: string[] }>(
      'SELECT encrypted_viewer_credential, credential_key_id, pending_selection FROM sensor_connections WHERE id = $1',
      [res.connection.id],
    );
    expect(rows[0]!.encrypted_viewer_credential.includes(Buffer.from('viewer-secret-123'))).toBe(false);
    expect(rows[0]!.credential_key_id).toMatch(/^[a-f0-9]{16}$/);
    expect(rows[0]!.pending_selection).toEqual(['a1', 'a2']);

    // The first poll is queued immediately.
    const jobs = await db.query(`SELECT state FROM jobs WHERE type = 'sensor_poll' AND payload->>'sensor_connection_id' = $1`, [res.connection.id]);
    expect(jobs.rows).toEqual([{ state: 'queued' }]);

    const list = SensorConnectionsListResponse.parse(await listSensorConnections(ctx));
    expect(list.connections.map((c) => c.id)).toEqual([res.connection.id]);
    expect(JSON.stringify(list)).not.toContain('viewer-secret');
  });

  it('only allows configured origins for polling (and https in production)', async () => {
    const { ctx } = await account();
    for (const origin of ['https://other.example.test', 'http://169.254.169.254', 'http://relay.example.test:8443']) {
      await expect(createSensorConnection(ctx, body({ origin }))).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(createSensorConnection(ctx, body({ origin: 'https://relay.example.test:8443/wc/v2' }))).rejects.toMatchObject({ code: 'invalid_input' });
    const prod = testContext((await insertAccount(db)), { config: { ...config, NODE_ENV: 'production' } });
    await expect(createSensorConnection(prod, body({ origin: 'http://127.0.0.1:8787' }))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('requires a viewer credential in poll mode and an encryption key to store one', async () => {
    expect(CreateSensorConnectionRequest.safeParse({ origin: RELAY }).success).toBe(false);
    expect(CreateSensorConnectionRequest.safeParse({ origin: RELAY, mode: 'bridge' }).success).toBe(true);
    const a = await insertAccount(db);
    const noKey = testContext(a, { config: { ...config, CREDENTIAL_ENCRYPTION_KEY: undefined } });
    await expect(createSensorConnection(noKey, body())).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('rejects a second active connection to the same relay', async () => {
    const { ctx } = await account();
    await createSensorConnection(ctx, body());
    await expect(createSensorConnection(ctx, body())).rejects.toMatchObject({ code: 'conflict' });
  });

  it('bridge mode issues a restricted capture-write token bound to the connection', async () => {
    const { principal, ctx } = await account();
    // The server never contacts the relay in bridge mode, so it need not be allowlisted.
    const res = await createSensorConnection(ctx, CreateSensorConnectionRequest.parse({ origin: 'http://192.168.1.20:8787', mode: 'bridge' }));
    expect(res.bridge_token).toMatch(/^cat_[a-f0-9]{8}_/);
    expect(res.connection).toMatchObject({ mode: 'bridge', status: 'active' });
    const p = await resolvePrincipal(db, { authorization: `Bearer ${res.bridge_token}` });
    expect(p).toMatchObject({
      kind: 'agent',
      accountId: principal.accountId,
      purpose: 'sensor_bridge',
      scopes: ['captures:write'],
      libraryAccess: 'none',
      sensorConnectionId: res.connection.id,
    });
    // No poll job in bridge mode.
    const jobs = await db.query(`SELECT 1 FROM jobs WHERE type = 'sensor_poll' AND payload->>'sensor_connection_id' = $1`, [res.connection.id]);
    expect(jobs.rows).toHaveLength(0);
    // Selection happens on the bridge in this mode.
    await expect(
      createSensorConnection(ctx, CreateSensorConnectionRequest.parse({ origin: 'http://192.168.1.21:8787', mode: 'bridge', import_existing_asset_ids: ['x'] })),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('is only available to the account owner in the browser', async () => {
    const { principal } = await account();
    const agent = await insertAgentConnection(principal, {}, db);
    await expect(createSensorConnection(testContext(agent.principal, { config }), body())).rejects.toMatchObject({ code: 'scope_denied' });
    await expect(listSensorConnections(testContext(agent.principal, { config }))).rejects.toMatchObject({ code: 'scope_denied' });
    const anon = await insertAnonymousSession(db);
    await expect(createSensorConnection(testContext(anon, { config }), body())).rejects.toMatchObject({ code: 'account_required' });
  });

  it('delete disables import, removes the credential, revokes the bridge token and cancels polls', async () => {
    const { ctx } = await account();
    const poll = await createSensorConnection(ctx, body());
    const bridge = await createSensorConnection(ctx, CreateSensorConnectionRequest.parse({ origin: 'http://10.0.0.5:8787', mode: 'bridge' }));

    await deleteSensorConnection(ctx, { id: poll.connection.id });
    const row = await db.query<{ enabled: boolean; encrypted_viewer_credential: Buffer | null; disabled_at: Date | null }>(
      'SELECT enabled, encrypted_viewer_credential, disabled_at FROM sensor_connections WHERE id = $1',
      [poll.connection.id],
    );
    expect(row.rows[0]).toMatchObject({ enabled: false, encrypted_viewer_credential: null });
    expect(row.rows[0]!.disabled_at).toBeInstanceOf(Date);
    const jobs = await db.query(`SELECT state FROM jobs WHERE type = 'sensor_poll' AND payload->>'sensor_connection_id' = $1`, [poll.connection.id]);
    expect(jobs.rows).toEqual([{ state: 'cancelled' }]);

    await deleteSensorConnection(ctx, { id: bridge.connection.id });
    await expect(resolvePrincipal(db, { authorization: `Bearer ${bridge.bridge_token}` })).rejects.toMatchObject({ code: 'token_revoked' });

    expect((await listSensorConnections(ctx)).connections).toEqual([]);
    // Idempotent for the owner; other accounts get 404.
    await deleteSensorConnection(ctx, { id: poll.connection.id });
    const other = await account();
    const theirs = await createSensorConnection(other.ctx, body());
    await expect(deleteSensorConnection(ctx, { id: theirs.connection.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteSensorConnection(ctx, { id: randomUUID() })).rejects.toBeInstanceOf(AppError);
    // A deleted connection can be set up again.
    await expect(createSensorConnection(ctx, body())).resolves.toMatchObject({ connection: { mode: 'poll' } });
  });
});
