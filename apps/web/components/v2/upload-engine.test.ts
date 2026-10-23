import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/client/api';
import type { MediaDetail, PartInstruction, UploadResponse } from './media-api';
import { DEFAULT_LIMITS } from './media-format';
import { UploadEngine, type EngineDeps, type UploadApi } from './upload-engine';
import { MemoryUploadStore, type UploadEntry } from './upload-store';

const PART = 8_388_608;
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function file(name: string, size: number, type: string) {
  return Object.assign(new Blob([new Uint8Array(size)], { type }), {
    name,
    lastModified: 1_760_000_000_000,
  });
}

/** In-memory server honouring the /v2 upload contract semantics the engine relies on. */
class FakeServer implements UploadApi {
  calls: Array<{ op: string; arg?: unknown }> = [];
  uploads = new Map<
    string,
    {
      req: Parameters<UploadApi['createUpload']>[0];
      key: string;
      state: UploadResponse['state'];
      receipts: Array<{ part_number: number; etag: string }>;
      asset: string;
      error: string | null;
    }
  >();
  status = new Map<string, MediaDetail['media']['status']>();
  failCreateOnce = false;
  verifyOutcome: 'ready' | 'rejected' | 'expired' = 'ready';
  n = 0;
  private id() {
    this.n += 1;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`;
  }
  private res(u: string, sign: boolean): UploadResponse {
    const r = this.uploads.get(u)!;
    const count = Math.ceil(r.req.byte_size / PART);
    return {
      asset_id: r.asset,
      upload_id: u,
      state: r.state,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      part_size: PART,
      part_count: count,
      parts: sign ? Array.from({ length: count }, (_, i) => this.instr(i + 1)) : [],
      verified_parts: r.receipts,
      error_code: r.error,
      pause_reason: null,
    };
  }
  private instr(n: number): PartInstruction {
    return {
      part_number: n,
      method: 'PUT',
      url: `https://storage.test/p/${n}`,
      headers: {},
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    };
  }
  async createUpload(req: Parameters<UploadApi['createUpload']>[0], key: string) {
    this.calls.push({ op: 'create', arg: { id: req.client_capture_id, key } });
    if (this.failCreateOnce) {
      this.failCreateOnce = false;
      throw new ApiError(0, {
        code: 'offline',
        message: 'offline',
        retryable: true,
        request_id: 'x',
      });
    }
    const existing = [...this.uploads.entries()].find(
      ([, u]) => u.req.client_capture_id === req.client_capture_id,
    );
    if (existing) return this.res(existing[0], true);
    const u = this.id();
    const asset = this.id();
    this.uploads.set(u, { req, key, state: 'created', receipts: [], asset, error: null });
    this.status.set(asset, 'pending_upload');
    return this.res(u, true);
  }
  async getUpload(id: string) {
    this.calls.push({ op: 'get', arg: id });
    return this.res(id, false);
  }
  async resumeUpload(id: string) {
    return this.res(id, false);
  }
  async parts(id: string, nums: number[]) {
    this.calls.push({ op: 'parts', arg: nums });
    return { parts: nums.map((n) => this.instr(n)) };
  }
  async completeUpload(
    id: string,
    parts: Array<{ part_number: number; etag: string }>,
    key: string,
  ) {
    this.calls.push({ op: 'complete', arg: { parts, key } });
    const u = this.uploads.get(id)!;
    u.receipts = parts;
    if (this.verifyOutcome === 'expired') {
      u.state = 'expired';
      return this.res(id, false);
    }
    u.state = 'verifying';
    this.status.set(u.asset, this.verifyOutcome === 'rejected' ? 'failed' : 'ready');
    if (this.verifyOutcome === 'rejected') {
      u.state = 'rejected';
      u.error = 'unsupported_image';
      return { ...this.res(id, false), state: 'verifying' as const };
    }
    return this.res(id, false);
  }
  async abortUpload(id: string) {
    this.calls.push({ op: 'abort', arg: id });
    this.uploads.get(id)!.state = 'aborted';
    return { upload_id: id, state: 'aborted' };
  }
  async media(id: string): Promise<MediaDetail> {
    const status = this.status.get(id);
    if (!status)
      throw new ApiError(404, {
        code: 'not_found',
        message: 'Not found.',
        retryable: false,
        request_id: 'x',
      });
    return {
      media: {
        schema_version: 1,
        id,
        kind: 'photo',
        source: 'upload',
        status,
        analysis_status: 'not_requested',
        created_at: new Date().toISOString(),
      },
      generation: 1,
      revision: 1,
      links: { original: null, playback: null, poster: null, analysis: null },
      error_code: null,
      frames: [],
    };
  }
}

function setup(server = new FakeServer(), store = new MemoryUploadStore()) {
  let uuid = 0;
  const puts: number[] = [];
  const deps: EngineDeps = {
    store,
    api: server,
    putPart: async (instruction, body, onProgress) => {
      puts.push(instruction.part_number);
      onProgress(body.size);
      return `"etag-${instruction.part_number}"`;
    },
    sha256: async () => 'f'.repeat(64),
    describe: async () => ({ duration_ms: null, width: 100, height: 100, thumb: null }),
    uuid: () => `99999999-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    now: () => new Date(),
    online: () => true,
    sleep: async () => undefined,
  };
  const engine = new UploadEngine(deps);
  return { engine, server, store, puts };
}

async function settle(engine: UploadEngine, done: (items: UploadEntry[]) => boolean) {
  for (let i = 0; i < 200; i++) {
    if (done(engine.getSnapshot().items)) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(
    `did not settle: ${JSON.stringify(engine.getSnapshot().items.map((i) => [i.filename, i.phase, i.error]))}`,
  );
}

describe('UploadEngine', () => {
  it('persists the client capture id before any request, then uploads once and drops the bytes after commit', async () => {
    const { engine, server, store, puts } = setup();
    await engine.start(ACCOUNT, DEFAULT_LIMITS);
    let persistedBeforeCreate = false;
    const create = server.createUpload.bind(server);
    server.createUpload = async (req, key) => {
      persistedBeforeCreate = (await store.all()).some(
        (r) => r.client_capture_id === req.client_capture_id,
      );
      return create(req, key);
    };
    const [id] = await engine.add([file('a.jpg', PART + 10, 'image/jpeg')], 'upload');
    await settle(engine, (items) => items[0]?.phase === 'ready');
    expect(persistedBeforeCreate).toBe(true);
    expect(server.calls.filter((c) => c.op === 'create')).toHaveLength(1);
    expect(puts).toEqual([1, 2]);
    const done = (await store.all()).find((r) => r.client_capture_id === id)!;
    expect(done.blob).toBeNull();
    expect(done.receipts.map((r) => r.part_number)).toEqual([1, 2]);
  });

  it('rejects unsupported files per item while siblings continue', async () => {
    const { engine } = setup();
    await engine.start(ACCOUNT, DEFAULT_LIMITS);
    await engine.add([file('x.heic', 10, 'image/heic'), file('b.png', 10, 'image/png')], 'upload');
    await settle(engine, (items) =>
      items.some((i) => i.filename === 'b.png' && i.phase === 'ready'),
    );
    const heic = engine.getSnapshot().items.find((i) => i.filename === 'x.heic')!;
    expect(heic.phase).toBe('rejected');
    expect(heic.error).toMatch(/HEIC/);
  });

  it('a lost create response retries with the same client id and idempotency key (no duplicate asset)', async () => {
    const { engine, server } = setup();
    server.failCreateOnce = true;
    await engine.start(ACCOUNT, DEFAULT_LIMITS);
    const [id] = await engine.add([file('c.jpg', 50, 'image/jpeg')], 'upload');
    await settle(engine, (items) => items[0]?.phase === 'paused');
    expect(engine.getSnapshot().items[0]!.pause_reason).toBe('offline');
    engine.retry(id!);
    await settle(engine, (items) => items[0]?.phase === 'ready');
    const creates = server.calls
      .filter((c) => c.op === 'create')
      .map((c) => c.arg as { id: string; key: string });
    expect(creates).toHaveLength(2);
    expect(creates[0]).toEqual(creates[1]);
    expect(server.uploads.size).toBe(1);
  });

  it('resumes from the server receipts after a reload and only sends missing parts', async () => {
    const server = new FakeServer();
    const store = new MemoryUploadStore();
    const first = setup(server, store);
    await first.engine.start(ACCOUNT, DEFAULT_LIMITS);
    const big = file('v.mp4', PART * 2 + 5, 'video/mp4');
    const [id] = await first.engine.add([big], 'upload');
    await settle(first.engine, (items) => items[0]?.phase === 'ready');
    // Simulate a reload mid-way: the server holds part 1, the device lost its receipts.
    const u = [...server.uploads.values()][0]!;
    u.state = 'uploading';
    u.receipts = [{ part_number: 1, etag: '"etag-1"' }];
    const row = (await store.all()).find((r) => r.client_capture_id === id)!;
    await store.put({ ...row, phase: 'uploading', receipts: [], blob: big });
    server.calls.length = 0;
    const second = setup(server, store);
    await second.engine.start(ACCOUNT, DEFAULT_LIMITS);
    await settle(second.engine, (items) => items[0]?.phase === 'ready');
    expect(server.calls[0]).toEqual({ op: 'get', arg: [...server.uploads.keys()][0] });
    expect(server.calls.some((c) => c.op === 'create')).toBe(false);
    expect(server.calls.find((c) => c.op === 'parts')?.arg).toEqual([2, 3]);
    expect(second.puts).toEqual([2, 3]);
  });

  it("never shows or uploads another account's local drafts, and can discard them", async () => {
    const store = new MemoryUploadStore();
    const offline = setup(new FakeServer(), store);
    offline.engine['deps'].online = () => false;
    await offline.engine.start(OTHER, DEFAULT_LIMITS);
    await offline.engine.add([file('theirs.jpg', 10, 'image/jpeg')], 'upload');
    expect((await store.all())[0]).toMatchObject({ account_id: OTHER, phase: 'paused' });
    const server = new FakeServer();
    const mine = setup(server, store);
    await mine.engine.start(ACCOUNT, DEFAULT_LIMITS);
    expect(mine.engine.getSnapshot().items).toHaveLength(0);
    expect(mine.engine.getSnapshot().lockedCount).toBe(1);
    mine.engine.onOnline();
    expect(server.calls).toHaveLength(0);
    await mine.engine.discardLocked();
    expect(await store.all()).toHaveLength(0);
  });

  it('server-side verification rejection is reported per file', async () => {
    const { engine, server } = setup();
    server.verifyOutcome = 'rejected';
    await engine.start(ACCOUNT, DEFAULT_LIMITS);
    await engine.add([file('bad.jpg', 10, 'image/jpeg')], 'upload');
    await settle(engine, (items) => items[0]?.phase === 'rejected');
    expect(engine.getSnapshot().items[0]!.error).toMatch(/could not be read/);
  });

  it('an expired upload is re-keyed so a retry starts a fresh upload', async () => {
    const { engine, server } = setup();
    server.verifyOutcome = 'expired';
    await engine.start(ACCOUNT, DEFAULT_LIMITS);
    const [id] = await engine.add([file('late.jpg', 10, 'image/jpeg')], 'upload');
    await settle(engine, (items) => items[0]?.phase === 'failed');
    const row = engine.getSnapshot().items[0]!;
    expect(row.client_capture_id).not.toBe(id);
    expect(row.upload_id).toBeNull();
    server.verifyOutcome = 'ready';
    engine.retry(row.client_capture_id);
    await settle(engine, (items) => items[0]?.phase === 'ready');
    expect(server.uploads.size).toBe(2);
  });

  it('cancel stops the transfer, aborts the server upload and removes the row', async () => {
    const { engine, server } = setup();
    engine['deps'].putPart = (_i, _b, _p, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))),
      );
    await engine.start(ACCOUNT, DEFAULT_LIMITS);
    const [id] = await engine.add([file('d.jpg', 10, 'image/jpeg')], 'upload');
    await settle(engine, (items) => items[0]?.phase === 'uploading');
    const uploadId = engine.getSnapshot().items[0]!.upload_id!;
    await engine.cancel(id!);
    expect(engine.getSnapshot().items).toHaveLength(0);
    expect(server.calls).toContainEqual({ op: 'abort', arg: uploadId });
  });
});
