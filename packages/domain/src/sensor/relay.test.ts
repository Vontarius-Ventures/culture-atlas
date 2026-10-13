import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MockRelay, sha256 } from '../../../../fixtures/sensor/mock-relay';
import {
  RelayClient,
  RelayError,
  SinkError,
  canonicalOrigin,
  isAllowedOrigin,
  normalizeRelayAsset,
  normalizeRelayPage,
  syncOnce,
  type ImportOutcome,
  type RelayAsset,
  type RelayContent,
  type SyncState,
  type SyncSink,
} from './relay';

/** In-memory ledger sink that records what the sync asked it to do. */
class MemorySink implements SyncSink {
  ledger = new Map<string, string>();
  imports: { asset: RelayAsset; content: RelayContent }[] = [];
  saved: SyncState[] = [];
  /** Throw this for the next importAsset calls. */
  failWith: (SinkError | null)[] = [];

  async isKnown(id: string) {
    return this.ledger.has(id);
  }
  async importAsset(asset: RelayAsset, content: RelayContent): Promise<ImportOutcome> {
    const f = this.failWith.shift();
    if (f) throw f;
    if (this.ledger.has(asset.asset_id)) return 'duplicate';
    this.ledger.set(asset.asset_id, 'imported');
    this.imports.push({ asset, content });
    return 'imported';
  }
  async recordSkipped(asset: RelayAsset, status: string, code: string) {
    if (!this.ledger.has(asset.asset_id)) this.ledger.set(asset.asset_id, `${status}:${code}`);
  }
  async saveState(s: SyncState) {
    this.saved.push(structuredClone(s));
  }
  get state(): SyncState {
    return this.saved.at(-1) ?? { cursor: null, baselineDone: true, selection: [] };
  }
  importedIds() {
    return this.imports.map((i) => i.asset.asset_id);
  }
}

const relays: MockRelay[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((r) => r.stop()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function startRelay(opts: ConstructorParameters<typeof MockRelay>[0] = {}) {
  const relay = new MockRelay({ pageSize: 7, ...opts });
  relays.push(relay);
  await relay.start();
  const client = new RelayClient({ origin: relay.origin, allowedOrigins: [relay.origin], credential: relay.credential, maxAssetBytes: 1024 * 1024, timeoutMs: 2000 });
  return { relay, client };
}

const NEW: SyncState = { cursor: null, baselineDone: true, selection: [] };

describe('origins', () => {
  it('canonicalizes http(s) origins and rejects everything else', () => {
    expect(canonicalOrigin('https://Relay.Example.com:8443/')).toBe('https://relay.example.com:8443');
    expect(canonicalOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    for (const bad of ['ftp://relay', 'https://user:pw@relay', 'https://relay/path', 'https://relay?x=1', 'file:///etc/passwd', 'not a url']) {
      expect(canonicalOrigin(bad)).toBeNull();
    }
  });

  it('matches the allowlist by exact origin (scheme, host and port)', () => {
    const allowed = ['https://relay.example.com', 'http://127.0.0.1:8787/'];
    expect(isAllowedOrigin('https://relay.example.com/', allowed)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8787', allowed)).toBe(true);
    expect(isAllowedOrigin('http://relay.example.com', allowed)).toBe(false);
    expect(isAllowedOrigin('https://relay.example.com:444', allowed)).toBe(false);
    expect(isAllowedOrigin('https://evil.relay.example.com', allowed)).toBe(false);
  });

  it('refuses to construct a client for an origin outside the allowlist', () => {
    expect(() => new RelayClient({ origin: 'http://169.254.169.254', allowedOrigins: ['https://relay.example.com'], credential: 'x', maxAssetBytes: 10 })).toThrow(RelayError);
  });
});

describe('normalization', () => {
  it('accepts snake_case and camelCase assets and parses declared hashes', () => {
    const h = 'A'.repeat(64);
    expect(normalizeRelayAsset({ asset_id: 'a1', kind: 'photo', committed: true, sha256: h, captured_at: '2026-10-01T10:00:00+02:00' })).toMatchObject({
      asset_id: 'a1',
      committed: true,
      sha256: 'a'.repeat(64),
      captured_at: '2026-10-01T08:00:00.000Z',
    });
    expect(normalizeRelayAsset({ assetID: 'a2', kind: 'PHOTO', state: 'committed', contentType: 'image/jpeg', capturedAt: 1_790_000_000 })).toMatchObject({
      asset_id: 'a2',
      kind: 'photo',
      committed: true,
      content_type: 'image/jpeg',
      captured_at: new Date(1_790_000_000_000).toISOString(),
    });
    expect(normalizeRelayAsset({ asset_id: 'a3', kind: 'photo', sha256: 'sha256:' + 'b'.repeat(64) })!.sha256).toBe('b'.repeat(64));
    expect(normalizeRelayAsset({ asset_id: 'a4', kind: 'photo', sha256: 'xyz' })).toMatchObject({ sha256: null, sha256_invalid: true });
    expect(normalizeRelayAsset({ kind: 'photo' })).toBeNull();
    expect(normalizeRelayAsset({ asset_id: 'x'.repeat(201) })).toBeNull();
  });

  it('rejects a body that is not a page', () => {
    expect(() => normalizeRelayPage({ nope: true })).toThrow(RelayError);
    expect(normalizeRelayPage({ assets: [{ asset_id: 'a' }, { bad: 1 }], next_cursor: 'c' })).toMatchObject({ invalid_entries: 1, has_more: true, next_cursor: 'c' });
  });
});

describe('RelayClient', () => {
  it('authenticates with the viewer credential and filters to committed photos', async () => {
    const { relay, client } = await startRelay();
    relay.addPhoto();
    relay.addPhoto({ commit: false });
    relay.addAsset('audio');
    const page = await client.listPage(null, 50);
    expect(page.assets.map((a) => a.kind)).toEqual(['photo']);
    expect(relay.requests.every((r) => r.authorized)).toBe(true);
    expect(relay.requests[0]!.query).toMatchObject({ kind: 'photo', committed: 'true' });
  });

  it('reports a rejected credential as unauthorized', async () => {
    const { relay } = await startRelay();
    const bad = new RelayClient({ origin: relay.origin, allowedOrigins: [relay.origin], credential: 'wrong', maxAssetBytes: 1000 });
    await expect(bad.listPage(null, 10)).rejects.toMatchObject({ code: 'unauthorized', scope: 'connection' });
  });

  it('verifies bytes against the declared hash', async () => {
    const { relay, client } = await startRelay();
    const good = relay.addPhoto();
    const wrong = relay.addPhoto({ declare_hash: 'wrong' });
    const garbled = relay.addPhoto({ declare_hash: 'garbled' });
    const none = relay.addPhoto({ declare_hash: 'none' });
    const page = await client.listPage(null, 50);
    const byId = new Map(page.assets.map((a) => [a.asset_id, a]));
    const content = await client.fetchContent(byId.get(good.asset_id)!);
    expect(content.sha256).toBe(sha256(good.bytes));
    expect(content.content_type).toBe('image/jpeg');
    await expect(client.fetchContent(byId.get(wrong.asset_id)!)).rejects.toMatchObject({ code: 'hash_mismatch', scope: 'asset' });
    await expect(client.fetchContent(byId.get(garbled.asset_id)!)).rejects.toMatchObject({ code: 'hash_unverifiable', scope: 'asset' });
    // No declared hash: accepted, and the computed hash is returned.
    expect((await client.fetchContent(byId.get(none.asset_id)!)).sha256).toBe(sha256(none.bytes));
  });

  it('rejects oversized bodies, unexpected content types and redirects to other hosts', async () => {
    const { relay } = await startRelay();
    const client = new RelayClient({ origin: relay.origin, allowedOrigins: [relay.origin], credential: relay.credential, maxAssetBytes: 20_000 });
    const big = relay.addPhoto({ declare_hash: 'none' });
    big.bytes = new Uint8Array(50_000).fill(1);
    const html = relay.addPhoto();
    html.served_content_type = 'text/html';
    const away = relay.addPhoto();
    away.redirect_to = 'http://169.254.169.254/latest/meta-data/';
    const page = await client.listPage(null, 50);
    const [a, b, c] = page.assets;
    await expect(client.fetchContent(a!)).rejects.toMatchObject({ code: 'too_large', scope: 'asset' });
    await expect(client.fetchContent(b!)).rejects.toMatchObject({ code: 'bad_content_type', scope: 'asset' });
    await expect(client.fetchContent(c!)).rejects.toMatchObject({ code: 'redirect_blocked', scope: 'connection' });
    expect(relay.requests.some((r) => r.path.includes('meta-data'))).toBe(false);
  });

  it('stops reading a body that exceeds the limit without a content-length', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      const chunk = Buffer.alloc(1024, 7);
      let sent = 0;
      const pump = () => {
        while (sent < 64 && res.write(chunk)) sent++;
        if (sent < 64) res.once('drain', pump);
        else res.end();
      };
      pump();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new RelayClient({ origin, allowedOrigins: [origin], credential: 'c', maxAssetBytes: 4096 });
    const asset = normalizeRelayAsset({ asset_id: 'stream', kind: 'photo', committed: true })!;
    await expect(client.fetchContent(asset)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('follows a redirect only within the same origin', async () => {
    const { relay, client } = await startRelay();
    const target = relay.addPhoto();
    const alias = relay.addPhoto({ declare_hash: 'none' });
    alias.redirect_to = `/wc/v2/assets/${target.asset_id}/content`;
    const page = await client.listPage(null, 50);
    const content = await client.fetchContent(page.assets.find((a) => a.asset_id === alias.asset_id)!);
    expect(content.sha256).toBe(sha256(target.bytes));
  });

  it('classifies outages, rate limits and timeouts as connection errors', async () => {
    const { relay, client } = await startRelay();
    relay.failNext(1, 503, 'list');
    await expect(client.listPage(null, 10)).rejects.toMatchObject({ code: 'server_error', scope: 'connection' });
    relay.failNext(1, 429, 'list', 30);
    await expect(client.listPage(null, 10)).rejects.toMatchObject({ code: 'rate_limited', options: { retryAfterMs: 30_000 } });
    relay.setOffline(true);
    await expect(client.listPage(null, 10)).rejects.toMatchObject({ code: 'unreachable' });

    const hang = createServer(() => undefined);
    servers.push(hang);
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
    const slow = new RelayClient({ origin, allowedOrigins: [origin], credential: 'c', maxAssetBytes: 10, timeoutMs: 200 });
    await expect(slow.listPage(null, 10)).rejects.toMatchObject({ code: 'timeout' });
    hang.closeAllConnections();
  });
});

describe('syncOnce', () => {
  it('pages through every new photo exactly once and persists the cursor', async () => {
    const { relay, client } = await startRelay({ pageSize: 4 });
    const ids = Array.from({ length: 17 }, () => relay.addPhoto().asset_id);
    relay.addAsset('audio');
    const sink = new MemorySink();
    const r = await syncOnce(client, NEW, sink, { pageSize: 50 });
    expect(r.error).toBeNull();
    expect(sink.importedIds()).toEqual(ids);
    expect(r.pagesRead).toBe(5);
    // Second pass from the saved cursor: nothing new, nothing re-downloaded.
    const before = relay.contentFetches();
    const again = await syncOnce(client, sink.state, sink);
    expect(again.imported).toEqual([]);
    expect(relay.contentFetches()).toBe(before);
    // New photos after the cursor are picked up.
    const later = relay.addPhoto().asset_id;
    const third = await syncOnce(client, sink.state, sink);
    expect(third.imported).toEqual([later]);
  });

  it('first connection imports only the selected existing photos', async () => {
    const { relay, client } = await startRelay({ pageSize: 3 });
    const existing = Array.from({ length: 7 }, () => relay.addPhoto().asset_id);
    const sink = new MemorySink();
    const r = await syncOnce(client, { cursor: null, baselineDone: false, selection: [existing[1]!, existing[5]!, 'missing-id'] }, sink);
    expect(sink.importedIds()).toEqual([existing[1], existing[5]]);
    expect(r.baselineSkipped).toBe(5);
    expect(r.selectionNotFound).toEqual(['missing-id']);
    expect(sink.state).toMatchObject({ baselineDone: true, selection: [] });
    expect(sink.ledger.get(existing[0]!)).toBe('skipped:existing_not_selected');
    // Photos committed after connecting are new and imported.
    const fresh = relay.addPhoto().asset_id;
    await syncOnce(client, sink.state, sink);
    expect(sink.importedIds()).toEqual([existing[1], existing[5], fresh]);
  });

  it('recovers from a relay outage without skipping or duplicating photos', async () => {
    const { relay, client } = await startRelay({ pageSize: 3 });
    const first = Array.from({ length: 4 }, () => relay.addPhoto().asset_id);
    const sink = new MemorySink();
    // Relay drops after the first page's content downloads begin.
    let calls = 0;
    const flaky = {
      listPage: client.listPage.bind(client),
      fetchContent: async (a: RelayAsset, s?: AbortSignal) => {
        if (++calls === 3) relay.setOffline(true);
        return client.fetchContent(a, s);
      },
    };
    const r1 = await syncOnce(flaky, NEW, sink);
    expect(r1.error).toMatchObject({ code: 'unreachable' });
    expect(sink.importedIds()).toEqual(first.slice(0, 2));
    // Cursor was never advanced past the unfinished page.
    expect(sink.saved).toEqual([]);

    // More photos are committed while the bridge/poller is offline.
    relay.setOffline(false);
    const during = Array.from({ length: 5 }, () => relay.addPhoto().asset_id);
    relay.setOffline(true);
    const r2 = await syncOnce(client, NEW, sink);
    expect(r2.error).toMatchObject({ code: 'unreachable' });

    relay.setOffline(false);
    const r3 = await syncOnce(client, NEW, sink);
    expect(r3.error).toBeNull();
    expect(sink.importedIds()).toEqual([...first, ...during]);
    expect(new Set(sink.importedIds()).size).toBe(sink.importedIds().length);
  });

  it('records per-photo failures once and keeps going', async () => {
    const { relay, client } = await startRelay();
    const a = relay.addPhoto().asset_id;
    const bad = relay.addPhoto({ declare_hash: 'wrong' }).asset_id;
    const c = relay.addPhoto().asset_id;
    const rejected = relay.addPhoto().asset_id;
    const sink = new MemorySink();
    sink.failWith = [null, null, new SinkError('asset', 'unsupported_image', 'nope')];
    const r = await syncOnce(client, NEW, sink);
    expect(r.error).toBeNull();
    expect(sink.importedIds()).toEqual([a, c]);
    expect(r.failed).toEqual([
      { asset_id: bad, code: 'hash_mismatch' },
      { asset_id: rejected, code: 'unsupported_image' },
    ]);
    const fetches = relay.contentFetches(bad);
    await syncOnce(client, NEW, sink);
    expect(relay.contentFetches(bad)).toBe(fetches);
  });

  it('holds the cursor while a listed photo is not committed yet (unfiltered relay)', async () => {
    const { relay, client } = await startRelay({ listMode: 'creation', pageSize: 2 });
    const a = relay.addPhoto().asset_id;
    const pending = relay.addPhoto({ commit: false }).asset_id;
    relay.addAsset('sensor_log');
    const c = relay.addPhoto().asset_id;
    const sink = new MemorySink();
    const r1 = await syncOnce(client, NEW, sink);
    expect(r1.pendingUncommitted).toBe(1);
    expect(sink.importedIds()).toEqual([a, c]);
    expect(sink.saved).toEqual([]);
    relay.commit(pending);
    await syncOnce(client, NEW, sink);
    expect(sink.importedIds()).toEqual([a, c, pending]);
    // Now every page is resolved and the cursor moves to the end.
    expect(sink.state.cursor).not.toBeNull();
  });

  it('works with camelCase fields and a relay that ends the list with a null cursor', async () => {
    const { relay, client } = await startRelay({ fieldStyle: 'camel', endCursor: 'null', pageSize: 2 });
    const ids = Array.from({ length: 5 }, () => relay.addPhoto().asset_id);
    const sink = new MemorySink();
    await syncOnce(client, NEW, sink);
    expect(sink.importedIds()).toEqual(ids);
    const next = relay.addPhoto().asset_id;
    await syncOnce(client, sink.state, sink);
    expect(sink.importedIds()).toEqual([...ids, next]);
  });

  it('stops at the import limit and reports more work', async () => {
    const { relay, client } = await startRelay({ pageSize: 5 });
    const ids = Array.from({ length: 8 }, () => relay.addPhoto().asset_id);
    const sink = new MemorySink();
    const r = await syncOnce(client, NEW, sink, { maxImports: 3 });
    expect(r.more).toBe(true);
    expect(sink.importedIds()).toEqual(ids.slice(0, 3));
    let state = sink.saved.at(-1) ?? NEW;
    for (let i = 0; i < 5 && sink.imports.length < ids.length; i++) {
      await syncOnce(client, state, sink, { maxImports: 3 });
      state = sink.saved.at(-1) ?? NEW;
    }
    expect(sink.importedIds()).toEqual(ids);
  });

  it('stops on a connection-level sink failure and resumes later', async () => {
    const { relay, client } = await startRelay();
    const ids = Array.from({ length: 3 }, () => relay.addPhoto().asset_id);
    const sink = new MemorySink();
    sink.failWith = [null, new SinkError('connection', 'quota_exceeded', 'limit', { retryAfterMs: 1000 })];
    const r = await syncOnce(client, NEW, sink);
    expect(r.error).toMatchObject({ code: 'quota_exceeded' });
    expect(sink.importedIds()).toEqual(ids.slice(0, 1));
    await syncOnce(client, NEW, sink);
    expect(sink.importedIds()).toEqual(ids);
  });
});
