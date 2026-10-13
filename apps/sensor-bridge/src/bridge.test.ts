import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockRelay } from '../../../fixtures/sensor/mock-relay';
import { captureIdempotencyKey } from './app-client';
import { Bridge } from './bridge';
import { BridgeConfigSchema, loadBridgeConfig } from './config';
import type { BridgeState } from './state';

/**
 * Minimal stand-in for the public app's three bridge routes, with the same
 * dedupe semantics as the real capture service: one capture per
 * (connection, asset_id); a repeat returns the existing capture (reused).
 */
class FakeApp {
  server: Server | null = null;
  url = '';
  token = `cat_${randomUUID().slice(0, 8)}_secret`;
  offline = false;
  revoked = false;
  failNext = 0;
  rejectSha = new Set<string>();
  uploads = new Map<string, { sha: string }>();
  captures = new Map<string, { capture_id: string; upload_id: string }>();
  requests: { method: string; path: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (this.offline) {
          req.socket.destroy();
          return;
        }
        const body = Buffer.concat(chunks);
        this.requests.push({ method: req.method!, path: req.url!, headers: req.headers, body });
        const send = (status: number, json: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(json));
        };
        if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { code: 'unauthenticated', message: 'no', retryable: false });
        if (this.revoked) return send(401, { code: 'token_revoked', message: 'This connection was revoked.', retryable: false });
        if (this.failNext > 0) {
          this.failNext--;
          return send(503, { code: 'service_unavailable', message: 'down', retryable: true });
        }
        if (req.url === '/v1/uploads') {
          // Pull the JPEG out of the multipart body (between the part headers and the boundary).
          const start = body.indexOf(Buffer.from([0xff, 0xd8]));
          const boundary = Buffer.from(`\r\n--${/boundary=(.+)$/.exec(req.headers['content-type']!)![1]}`);
          const bytes = body.subarray(start, body.indexOf(boundary, start));
          const sha = createHash('sha256').update(bytes).digest('hex');
          if (this.rejectSha.has(sha)) return send(400, { code: 'unsupported_image', message: 'Use a JPEG, PNG or WebP photo.', retryable: false });
          const id = randomUUID();
          this.uploads.set(id, { sha });
          return send(201, { upload_id: id, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
        }
        if (req.url === '/v1/captures') {
          const json = JSON.parse(body.toString()) as { upload_id: string; sensor: { connection_id: string; asset_id: string; declared_sha256?: string } };
          const up = this.uploads.get(json.upload_id);
          if (!up) return send(404, { code: 'not_found', message: 'That upload was not found or has expired.', retryable: false });
          if (json.sensor.declared_sha256 && json.sensor.declared_sha256 !== up.sha) return send(400, { code: 'invalid_input', message: 'hash', retryable: false });
          const key = `${json.sensor.connection_id}:${json.sensor.asset_id}`;
          const existing = this.captures.get(key);
          if (existing) return send(202, { capture_id: existing.capture_id, job_id: randomUUID(), reused: true });
          const capture = { capture_id: randomUUID(), upload_id: json.upload_id };
          this.captures.set(key, capture);
          return send(202, { capture_id: capture.capture_id, job_id: randomUUID(), reused: false });
        }
        return send(403, { code: 'scope_denied', message: 'no', retryable: false });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((r) => this.server?.close(r));
  }

  importedAssets(): string[] {
    return [...this.captures.keys()].map((k) => k.split(':')[1]!);
  }
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
});

async function setup(opts: { existing?: number; select?: number[]; pageSize?: number } = {}) {
  const relay = new MockRelay({ credential: 'relay-viewer-secret', pageSize: opts.pageSize ?? 4 });
  const existing = Array.from({ length: opts.existing ?? 0 }, () => relay.addPhoto());
  await relay.start();
  const app = new FakeApp();
  await app.start();
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  cleanup.push(() => relay.stop(), () => app.stop(), () => rm(dir, { recursive: true, force: true }));
  const connectionId = randomUUID();
  const config = BridgeConfigSchema.parse({
    BRIDGE_RELAY_ORIGIN: relay.origin,
    BRIDGE_VIEWER_CREDENTIAL: relay.credential,
    BRIDGE_APP_URL: app.url,
    BRIDGE_CAPTURE_TOKEN: app.token,
    BRIDGE_CONNECTION_ID: connectionId,
    BRIDGE_POLL_INTERVAL_MS: '10000',
    BRIDGE_STATE_FILE: path.join(dir, 'state.json'),
    BRIDGE_IMPORT_EXISTING: (opts.select ?? []).map((i) => existing[i]!.asset_id).join(','),
  });
  const logs: string[] = [];
  const bridge = () => new Bridge({ config, log: (m) => logs.push(m) });
  const state = async () => JSON.parse(await readFile(config.BRIDGE_STATE_FILE, 'utf8')) as BridgeState;
  return { relay, app, config, existing, bridge, state, logs, connectionId };
}

describe('sensor bridge', () => {
  it('imports only selected existing photos first, then every new photo exactly once', async () => {
    const t = await setup({ existing: 5, select: [0, 3] });
    const b = t.bridge();
    const r1 = await b.runOnce();
    expect(r1.sync.error).toBeNull();
    expect(t.app.importedAssets().sort()).toEqual([t.existing[0]!.asset_id, t.existing[3]!.asset_id].sort());
    expect((await t.state()).baseline_done).toBe(true);

    const fresh = Array.from({ length: 9 }, () => t.relay.addPhoto().asset_id);
    await b.runOnce();
    expect(t.app.importedAssets()).toHaveLength(11);
    for (const id of fresh) expect(t.app.importedAssets()).toContain(id);

    // Restart with the same state file: nothing re-downloaded or re-uploaded.
    const uploads = t.app.uploads.size;
    const fetches = t.relay.contentFetches();
    const r2 = await t.bridge().runOnce();
    expect(r2.sync.imported).toEqual([]);
    expect(t.app.uploads.size).toBe(uploads);
    expect(t.relay.contentFetches()).toBe(fetches);
  });

  it('sends captures with the shared dedupe key and never sends the viewer credential to the app', async () => {
    const t = await setup();
    await t.bridge().runOnce();
    const a = t.relay.addPhoto();
    await t.bridge().runOnce();
    const capture = t.app.requests.find((r) => r.path === '/v1/captures')!;
    const json = JSON.parse(capture.body.toString());
    expect(json.sensor).toEqual({ connection_id: t.connectionId, asset_id: a.asset_id, captured_at: a.captured_at, declared_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(capture.headers['idempotency-key']).toBe(captureIdempotencyKey({ connection_id: t.connectionId, asset_id: a.asset_id }, json.upload_id));
    expect(capture.headers['idempotency-key']).toMatch(/^[A-Za-z0-9_\-:.]{1,255}$/);
    for (const r of t.app.requests) {
      expect(r.body.includes(Buffer.from('relay-viewer-secret'))).toBe(false);
      expect(JSON.stringify(r.headers)).not.toContain('relay-viewer-secret');
    }
    expect(t.relay.requests.every((r) => r.authorized)).toBe(true);
  });

  it('survives relay and app outages without skips or duplicates', async () => {
    const t = await setup({ pageSize: 3 });
    const b = t.bridge();
    await b.runOnce();
    const ids = Array.from({ length: 4 }, () => t.relay.addPhoto().asset_id);

    t.relay.setOffline(true);
    const off = await b.runOnce();
    expect(off).toMatchObject({ fatal: false });
    expect(off.sync.error).toMatchObject({ code: 'unreachable' });
    expect(off.nextDelayMs).toBeGreaterThanOrEqual(20_000);
    t.relay.setOffline(false);

    // App goes down after accepting two photos.
    let calls = 0;
    const origCreate = b.app.createCapture.bind(b.app);
    b.app.createCapture = async (...args) => {
      if (++calls === 3) t.app.offline = true;
      return origCreate(...args);
    };
    const appDown = await b.runOnce();
    expect(appDown.sync.error).toMatchObject({ code: 'app_unreachable' });
    expect(t.app.importedAssets()).toEqual(ids.slice(0, 2));

    t.app.offline = false;
    ids.push(...Array.from({ length: 3 }, () => t.relay.addPhoto().asset_id));
    t.app.failNext = 1;
    const flaky = await b.runOnce();
    expect(flaky.sync.error).toMatchObject({ code: 'service_unavailable' });
    const ok = await b.runOnce();
    expect(ok.sync.error).toBeNull();
    expect(ok.nextDelayMs).toBe(10_000);
    expect(t.app.importedAssets()).toEqual(ids);
    // The photo whose capture failed reused its upload instead of uploading again.
    expect(t.app.uploads.size).toBe(ids.length);
  });

  it('a lost state file costs re-uploads but never duplicate captures', async () => {
    const t = await setup();
    await t.bridge().runOnce();
    const ids = Array.from({ length: 3 }, () => t.relay.addPhoto().asset_id);
    await t.bridge().runOnce();
    await rm(t.config.BRIDGE_STATE_FILE);
    // A fresh state would treat everything as "existing"; force a re-import pass instead.
    const replay = new Bridge({ config: { ...t.config, BRIDGE_IMPORT_EXISTING: ids }, log: () => undefined });
    const r = await replay.runOnce();
    expect(r.sync.duplicates.sort()).toEqual([...ids].sort());
    expect(t.app.captures.size).toBe(3);
  });

  it('records photos the app rejects and moves on', async () => {
    const t = await setup();
    await t.bridge().runOnce();
    const bad = t.relay.addPhoto();
    const good = t.relay.addPhoto().asset_id;
    const mismatch = t.relay.addPhoto({ declare_hash: 'wrong' }).asset_id;
    t.app.rejectSha.add(createHash('sha256').update(bad.bytes).digest('hex'));
    const r = await t.bridge().runOnce();
    expect(r.sync.failed).toEqual([
      { asset_id: bad.asset_id, code: 'unsupported_image' },
      { asset_id: mismatch, code: 'hash_mismatch' },
    ]);
    expect(t.app.importedAssets()).toEqual([good]);
    expect((await t.state()).known).toMatchObject({ [bad.asset_id]: 'failed:unsupported_image', [mismatch]: 'failed:hash_mismatch', [good]: 'imported' });
  });

  it('stops on a revoked token', async () => {
    const t = await setup();
    await t.bridge().runOnce();
    t.relay.addPhoto();
    t.app.revoked = true;
    const r = await t.bridge().runOnce();
    expect(r.fatal).toBe(true);
    expect(r.sync.error).toMatchObject({ code: 'token_revoked' });
    expect(await t.bridge().run()).toBe('fatal');
  });

  it('refuses a state file that belongs to another connection', async () => {
    const t = await setup();
    await t.bridge().runOnce();
    const other = new Bridge({ config: { ...t.config, BRIDGE_CONNECTION_ID: randomUUID() }, log: () => undefined });
    await expect(other.runOnce()).rejects.toThrow(/belongs to sensor connection/);
  });

  it('run() polls until stopped', async () => {
    const t = await setup();
    const b = new Bridge({ config: { ...t.config, BRIDGE_POLL_INTERVAL_MS: 20 }, log: () => undefined });
    const done = b.run();
    t.relay.addPhoto();
    await new Promise((r) => setTimeout(r, 300));
    const a = t.relay.addPhoto().asset_id;
    for (let i = 0; i < 50 && !t.app.importedAssets().includes(a); i++) await new Promise((r) => setTimeout(r, 20));
    b.stop();
    expect(await done).toBe('stopped');
    expect(t.app.importedAssets()).toContain(a);
  });

  it('validates configuration', () => {
    expect(() => loadBridgeConfig({ BRIDGE_RELAY_ORIGIN: 'http://127.0.0.1:8787' })).toThrow();
    const c = loadBridgeConfig({
      BRIDGE_RELAY_ORIGIN: 'http://127.0.0.1:8787',
      BRIDGE_VIEWER_CREDENTIAL: 'v',
      BRIDGE_APP_URL: 'https://app.example',
      BRIDGE_CAPTURE_TOKEN: 't',
      BRIDGE_CONNECTION_ID: randomUUID(),
      BRIDGE_IMPORT_EXISTING: ' a1, a2 ,',
      BRIDGE_POLL_INTERVAL_MS: '',
    });
    expect(c.BRIDGE_IMPORT_EXISTING).toEqual(['a1', 'a2']);
    expect(c.BRIDGE_POLL_INTERVAL_MS).toBe(10_000);
  });
});
