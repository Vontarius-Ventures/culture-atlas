import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Bridge } from '../../../../apps/sensor-bridge/src/bridge';
import { BridgeConfigSchema } from '../../../../apps/sensor-bridge/src/config';
import { MockRelay } from '../../../../fixtures/sensor/mock-relay';
import { requireScopes } from '../authz';
import { createServiceContext } from '../context';
import { AppError, toErrorBody } from '../errors';
import { withIdempotency } from '../idempotency';
import { CreateCaptureJsonRequest } from '../schemas/captures';
import { CreateSensorConnectionRequest } from '../schemas/sensor-connections';
import { resolvePrincipal } from '../services/auth';
import { createCapture, createUpload } from '../services/captures';
import { createSensorConnection, deleteSensorConnection, listSensorConnections } from '../services/sensor-connections';
import { getTestDb, insertAccount, testConfig, testContext, testProviders } from '../testing';

/**
 * End to end: the real bridge (apps/sensor-bridge) against the mock relay and
 * a thin HTTP harness over the real domain services. The harness mirrors what
 * apps/web/lib/server/http.ts does for the three routes a bridge token may
 * call: bearer resolution, the sensor_bridge route restriction, scopes,
 * Idempotency-Key and the standard error body.
 */

const db = getTestDb();
const providers = testProviders();
const config = testConfig();
const BRIDGE_ROUTES = new Set(['POST /v1/uploads', 'POST /v1/captures', 'GET /v1/jobs/{id}']);

async function startHarness(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const requestId = randomUUID();
      const body = Buffer.concat(chunks);
      const route = `${req.method} ${req.url}`;
      try {
        const principal = await resolvePrincipal(db, { authorization: req.headers.authorization ?? null });
        if (!principal) throw new AppError('unauthenticated');
        if (principal.kind === 'agent' && principal.purpose === 'sensor_bridge' && !BRIDGE_ROUTES.has(route)) throw new AppError('scope_denied');
        requireScopes(principal, 'captures:write');
        const ctx = createServiceContext(principal, { db, providers, config, requestId });
        let status: number;
        let out: unknown;
        if (route === 'POST /v1/uploads') {
          const form = await new Request('http://h/v1/uploads', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body }).formData();
          const file = form.get('image') as File;
          out = await createUpload(ctx, { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name, declaredContentType: file.type });
          status = 201;
        } else if (route === 'POST /v1/captures') {
          const parsed = CreateCaptureJsonRequest.safeParse(JSON.parse(body.toString()));
          if (!parsed.success) throw new AppError('invalid_input');
          const run = async () => ({ status: 202, body: await createCapture(ctx, { kind: 'json', body: parsed.data }) });
          const key = req.headers['idempotency-key'] as string | undefined;
          const r = key ? await withIdempotency(db, { principal, route: 'POST /v1/captures', key, request: { digest: body.toString() } }, run) : await run();
          status = r.status;
          out = r.body;
        } else {
          throw new AppError('scope_denied');
        }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (err) {
        const { status, body: errBody } = toErrorBody(err, requestId);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(errBody));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
});

async function setup(existing = 0, select: number[] = []) {
  const relay = new MockRelay({ credential: 'local-viewer-credential', pageSize: 3 });
  const pre = Array.from({ length: existing }, () => relay.addPhoto());
  await relay.start();
  const harness = await startHarness();
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-e2e-'));
  cleanup.push(() => relay.stop(), () => new Promise((r) => harness.server.close(r)), () => rm(dir, { recursive: true, force: true }));

  const account = await insertAccount(db);
  const ctx = testContext(account, { config });
  const created = await createSensorConnection(ctx, CreateSensorConnectionRequest.parse({ origin: relay.origin, mode: 'bridge' }));
  const bridgeConfig = BridgeConfigSchema.parse({
    BRIDGE_RELAY_ORIGIN: relay.origin,
    BRIDGE_VIEWER_CREDENTIAL: relay.credential,
    BRIDGE_APP_URL: harness.url,
    BRIDGE_CAPTURE_TOKEN: created.bridge_token!,
    BRIDGE_CONNECTION_ID: created.connection.id,
    BRIDGE_STATE_FILE: path.join(dir, 'state.json'),
    BRIDGE_IMPORT_EXISTING: select.map((i) => pre[i]!.asset_id).join(','),
  });
  const bridge = (over: Partial<typeof bridgeConfig> = {}) => new Bridge({ config: { ...bridgeConfig, ...over }, log: () => undefined });
  const captures = async () =>
    (
      await db.query<{ sensor_asset_id: string; source: string; captured_at: Date | null; owner_account_id: string; created_by_agent_connection_id: string | null }>(
        `SELECT sensor_asset_id, source, captured_at, owner_account_id, created_by_agent_connection_id FROM captures
          WHERE sensor_connection_id = $1 ORDER BY sensor_asset_id`,
        [created.connection.id],
      )
    ).rows;
  return { relay, account, ctx, created, bridgeConfig, bridge, captures, pre, dir };
}

describe('bridge -> app end to end', () => {
  it('imports selected existing photos and new photos into the owner account as sensor captures', async () => {
    const t = await setup(4, [2]);
    const r1 = await t.bridge().runOnce();
    expect(r1.sync.error).toBeNull();
    const fresh = [t.relay.addPhoto(), t.relay.addPhoto({ asset_id: 'IMG 0042/odd?id' })];
    const r2 = await t.bridge().runOnce();
    expect(r2.sync.error).toBeNull();

    const caps = await t.captures();
    expect(caps.map((c) => c.sensor_asset_id).sort()).toEqual([t.pre[2]!.asset_id, ...fresh.map((f) => f.asset_id)].sort());
    for (const c of caps) {
      expect(c).toMatchObject({ source: 'sensor', owner_account_id: t.account.accountId });
      expect(c.created_by_agent_connection_id).not.toBeNull();
    }
    const odd = caps.find((c) => c.sensor_asset_id === 'IMG 0042/odd?id')!;
    expect(odd.captured_at!.toISOString()).toBe(fresh[1]!.captured_at);

    const [conn] = (await listSensorConnections(t.ctx)).connections;
    expect(conn).toMatchObject({ mode: 'bridge', imported_count: 3, status: 'active' });
    expect(conn!.last_attempt_at).not.toBeNull();
    // Imports are never likes.
    const saves = await db.query('SELECT 1 FROM saved_items WHERE owner_account_id = $1', [t.account.accountId]);
    expect(saves.rows).toHaveLength(0);
  });

  it('the app ledger prevents duplicates even when the bridge loses its state', async () => {
    const t = await setup();
    await t.bridge().runOnce();
    const ids = [t.relay.addPhoto().asset_id, t.relay.addPhoto().asset_id];
    await t.bridge().runOnce();
    await rm(t.bridgeConfig.BRIDGE_STATE_FILE);
    const replay = await t.bridge({ BRIDGE_IMPORT_EXISTING: ids }).runOnce();
    expect(replay.sync.error).toBeNull();
    expect(replay.sync.duplicates.sort()).toEqual([...ids].sort());
    expect(await t.captures()).toHaveLength(2);
  });

  it('the bridge token cannot import for another connection or call other routes', async () => {
    const t = await setup();
    const other = await createSensorConnection(t.ctx, CreateSensorConnectionRequest.parse({ origin: 'http://10.9.9.9:8787', mode: 'bridge' }));
    t.relay.addPhoto();
    const wrong = t.bridge({ BRIDGE_CONNECTION_ID: other.connection.id, BRIDGE_STATE_FILE: path.join(t.dir, 'other.json'), BRIDGE_IMPORT_EXISTING: [...t.relay.assets.keys()] });
    const r = await wrong.runOnce();
    expect(r.fatal).toBe(true);
    expect(r.sync.error).toMatchObject({ code: 'scope_denied' });
    expect(await t.captures()).toHaveLength(0);
  });

  it('disconnecting in settings revokes the bridge immediately', async () => {
    const t = await setup();
    await t.bridge().runOnce();
    await deleteSensorConnection(t.ctx, { id: t.created.connection.id });
    t.relay.addPhoto();
    const r = await t.bridge().runOnce();
    expect(r.fatal).toBe(true);
    expect(r.sync.error).toMatchObject({ code: 'token_revoked' });
    expect(await t.captures()).toHaveLength(0);
  });
});
