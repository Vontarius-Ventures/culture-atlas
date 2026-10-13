/**
 * Mock World Sensor relay for tests and local demos without the user's
 * machine. Models the asset viewer API assumed in relay.ts (from the
 * WorldCompilerSensor@8639b3b source review):
 *
 *   GET /wc/v2/assets?kind=photo&committed=true&cursor=&limit=
 *       -> { assets: [...], next_cursor, has_more }
 *   GET /wc/v2/assets/{id}/content -> original bytes (image/jpeg)
 *
 * Both routes require `Authorization: Bearer <viewer credential>`. Assets are
 * declared first and become visible once committed (as LibraryUploader
 * declares, uploads, then commits). By default the cursor follows commit
 * order, so a photo committed late is still "after" the cursor. With
 * `listMode: 'creation'` the relay ignores the filters and lists everything in
 * creation order, including uncommitted photos and non-photo assets, which
 * exercises the client's own filtering and hold-back logic.
 *
 * Test controls: offline toggle, injected failures, wrong/garbled hashes,
 * oversize bodies, content-type overrides, redirects and a request log.
 * Uses Node built-ins only.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';

const PHOTO_DIR = path.join(import.meta.dirname, 'photos');

/** Base fixture photos (synthetic, generated for this repo). */
export function fixturePhotos(): Uint8Array[] {
  return readdirSync(PHOTO_DIR)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => new Uint8Array(readFileSync(path.join(PHOTO_DIR, f))));
}

/**
 * A distinct but still valid JPEG: inserts a COM (comment) segment right
 * after SOI, so every asset has its own bytes and sha256.
 */
export function uniqueJpeg(base: Uint8Array, tag: string): Uint8Array {
  if (base[0] !== 0xff || base[1] !== 0xd8) throw new Error('not a JPEG');
  const text = new TextEncoder().encode(tag);
  const len = text.byteLength + 2;
  const seg = new Uint8Array(4 + text.byteLength);
  seg.set([0xff, 0xfe, (len >> 8) & 0xff, len & 0xff]);
  seg.set(text, 4);
  const out = new Uint8Array(base.byteLength + seg.byteLength);
  out.set(base.subarray(0, 2));
  out.set(seg, 2);
  out.set(base.subarray(2), 2 + seg.byteLength);
  return out;
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export interface MockAsset {
  asset_id: string;
  kind: string;
  bytes: Uint8Array;
  content_type: string;
  captured_at: string;
  session_id: string | null;
  /** 'correct' (default), 'none', 'wrong' (valid hex, wrong value) or 'garbled' (not a hash). */
  declare_hash: 'correct' | 'none' | 'wrong' | 'garbled';
  committed: boolean;
  created_seq: number;
  commit_seq: number | null;
  /** Serve these bytes instead (e.g. corrupted or oversize) while declaring the original hash. */
  served_bytes?: Uint8Array;
  served_content_type?: string;
  redirect_to?: string;
}

export interface MockRelayOptions {
  credential?: string;
  /** Max page size the relay will return (client limit is capped to this). */
  pageSize?: number;
  /** 'commit' (default): committed photos in commit order. 'creation': everything, unfiltered. */
  listMode?: 'commit' | 'creation';
  /** 'snake' (default) or 'camel' field names. */
  fieldStyle?: 'snake' | 'camel';
  /** End-of-list cursor: 'position' (default, cursor after the last item) or 'null'. */
  endCursor?: 'position' | 'null';
}

export interface RequestLogEntry {
  method: string;
  path: string;
  query: Record<string, string>;
  authorized: boolean;
  status: number;
}

type Failure = { route: 'list' | 'content' | 'any'; status: number; remaining: number; retryAfter?: number };

export class MockRelay {
  readonly credential: string;
  readonly assets = new Map<string, MockAsset>();
  readonly requests: RequestLogEntry[] = [];
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private seq = 0;
  private commitSeq = 0;
  private offline = false;
  private failures: Failure[] = [];
  private photos = fixturePhotos();
  origin = '';

  constructor(private readonly opts: MockRelayOptions = {}) {
    this.credential = opts.credential ?? 'mock-viewer-credential';
  }

  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const addr = this.server.address() as AddressInfo;
    this.origin = `http://${host}:${addr.port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** Offline: every connection is dropped without a response (like a sleeping phone or closed tunnel). */
  setOffline(offline: boolean): void {
    this.offline = offline;
    if (offline) for (const s of this.sockets) s.destroy();
  }

  /** The next `count` requests to `route` answer `status`. */
  failNext(count: number, status: number, route: Failure['route'] = 'any', retryAfter?: number): void {
    this.failures.push({ route, status, remaining: count, retryAfter });
  }

  /** Declare a photo (and by default commit it). Returns the asset. */
  addPhoto(init: Partial<Pick<MockAsset, 'asset_id' | 'bytes' | 'content_type' | 'captured_at' | 'session_id' | 'declare_hash'>> & { commit?: boolean } = {}): MockAsset {
    const n = ++this.seq;
    const base = this.photos[n % this.photos.length]!;
    const asset: MockAsset = {
      asset_id: init.asset_id ?? `asset-${String(n).padStart(4, '0')}`,
      kind: 'photo',
      bytes: init.bytes ?? uniqueJpeg(base, `mock relay asset ${n}`),
      content_type: init.content_type ?? 'image/jpeg',
      captured_at: init.captured_at ?? new Date(Date.UTC(2026, 9, 1, 12, 0, n)).toISOString(),
      session_id: init.session_id ?? null,
      declare_hash: init.declare_hash ?? 'correct',
      committed: false,
      created_seq: n,
      commit_seq: null,
    };
    this.assets.set(asset.asset_id, asset);
    if (init.commit ?? true) this.commit(asset.asset_id);
    return asset;
  }

  /** A committed non-photo asset (e.g. audio, sensor log). */
  addAsset(kind: string): MockAsset {
    const a = this.addPhoto({ commit: false });
    a.kind = kind;
    a.content_type = 'application/octet-stream';
    this.commit(a.asset_id);
    return a;
  }

  commit(assetId: string): void {
    const a = this.assets.get(assetId);
    if (!a) throw new Error(`no asset ${assetId}`);
    if (a.committed) return;
    a.committed = true;
    a.commit_seq = ++this.commitSeq;
  }

  /** Count of content downloads per asset id (for duplicate checks). */
  contentFetches(assetId?: string): number {
    return this.requests.filter((r) => r.status === 200 && r.path.endsWith('/content') && (!assetId || r.path.includes(`/${encodeURIComponent(assetId)}/`))).length;
  }

  private describe(a: MockAsset): Record<string, unknown> {
    const hash =
      a.declare_hash === 'correct' ? sha256(a.bytes) : a.declare_hash === 'wrong' ? sha256(new TextEncoder().encode(`wrong:${a.asset_id}`)) : a.declare_hash === 'garbled' ? 'not-a-hash' : undefined;
    const snake = {
      asset_id: a.asset_id,
      kind: a.kind,
      committed: a.committed,
      content_type: a.content_type,
      byte_size: a.bytes.byteLength,
      sha256: hash,
      captured_at: a.captured_at,
      session_id: a.session_id ?? undefined,
    };
    if (this.opts.fieldStyle !== 'camel') return snake;
    return {
      assetID: snake.asset_id,
      kind: snake.kind,
      state: a.committed ? 'committed' : 'declared',
      contentType: snake.content_type,
      byteSize: snake.byte_size,
      sha256: hash,
      capturedAt: snake.captured_at,
      sessionID: snake.session_id,
    };
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (body instanceof Uint8Array) {
      res.writeHead(status, { 'content-length': String(body.byteLength), ...headers });
      res.end(body);
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers });
    res.end(text);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (this.offline) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://relay.local');
    const query = Object.fromEntries(url.searchParams.entries());
    const authorized = req.headers.authorization === `Bearer ${this.credential}`;
    const entry: RequestLogEntry = { method: req.method ?? 'GET', path: url.pathname, query, authorized, status: 0 };
    this.requests.push(entry);
    const reply = (status: number, body: unknown, headers?: Record<string, string>) => {
      entry.status = status;
      this.send(res, status, body, headers);
    };

    if (req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
    if (!authorized) return reply(401, { error: 'unauthorized' });

    const isList = url.pathname === '/wc/v2/assets';
    const contentMatch = /^\/wc\/v2\/assets\/([^/]+)\/content$/.exec(url.pathname);
    const route = isList ? 'list' : contentMatch ? 'content' : null;
    if (!route) return reply(404, { error: 'not_found' });

    const failure = this.failures.find((f) => f.remaining > 0 && (f.route === 'any' || f.route === route));
    if (failure) {
      failure.remaining--;
      return reply(failure.status, { error: 'injected' }, failure.retryAfter !== undefined ? { 'retry-after': String(failure.retryAfter) } : {});
    }

    if (route === 'list') {
      const limit = Math.max(1, Math.min(Number(query.limit ?? '50') || 50, this.opts.pageSize ?? 20));
      const after = query.cursor ? decodeCursor(query.cursor) : 0;
      if (after === null) return reply(400, { error: 'bad_cursor' });
      const byCommit = (this.opts.listMode ?? 'commit') === 'commit';
      const all = [...this.assets.values()]
        .filter((a) => (byCommit ? a.committed && (query.kind ? a.kind === query.kind : true) : true))
        .map((a) => ({ a, key: byCommit ? a.commit_seq! : a.created_seq }))
        .filter((x) => x.key > after)
        .sort((x, y) => x.key - y.key);
      const page = all.slice(0, limit);
      const last = page.at(-1)?.key ?? after;
      const hasMore = all.length > page.length;
      const next = !hasMore && this.opts.endCursor === 'null' ? null : encodeCursor(last);
      const body = this.opts.fieldStyle === 'camel'
        ? { items: page.map((x) => this.describe(x.a)), nextCursor: next, hasMore }
        : { assets: page.map((x) => this.describe(x.a)), next_cursor: next, has_more: hasMore };
      return reply(200, body);
    }

    const id = decodeURIComponent(contentMatch![1]!);
    const asset = this.assets.get(id);
    if (!asset || !asset.committed) return reply(404, { error: 'not_found' });
    if (asset.redirect_to) return reply(302, Buffer.alloc(0), { location: asset.redirect_to });
    return reply(200, asset.served_bytes ?? asset.bytes, { 'content-type': asset.served_content_type ?? asset.content_type });
  }
}

function encodeCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ seq })).toString('base64url');
}

function decodeCursor(c: string): number | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { seq?: unknown };
    return typeof v.seq === 'number' && Number.isInteger(v.seq) && v.seq >= 0 ? v.seq : null;
  } catch {
    return null;
  }
}
