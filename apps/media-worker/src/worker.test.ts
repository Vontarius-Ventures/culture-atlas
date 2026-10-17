import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CaptureQueue,
  DEFAULT_CAPTURE_LIMITS,
  MediaAnalysis,
  MediaIntake,
  MediaPreparation,
  backfillLegacyCaptures,
  createCaptureV2Context,
  endCaptureAuthority,
  hasQualifiedVideoWorker,
  reconcileCaptureStorage,
  schemas,
  type CaptureIdentityAdapter,
  type CaptureLimits,
} from '@culture-atlas/domain';
import type { MediaUploadResponse } from '@culture-atlas/domain/schemas';
import { closeTestDb, getTestDb, insertAccount } from '@culture-atlas/domain/testing';
import { LocalMultipartStorage } from '@culture-atlas/providers';
import { DEFAULT_TOOL_CONFIG } from './probe';
import { qualifyWorker, type Qualification } from './qualify';
import { corrupt, makeFixture, type FixtureName } from './test-fixtures';
import { MediaWorker } from './worker';

const db = getTestDb();
let root: string, scratch: string, qualification: Qualification;
const media = new Map<FixtureName | 'photo', Buffer>();
const identity: CaptureIdentityAdapter = {
  requireRecoverableAccount: async () => {},
  peekNativeEnrollmentGrant: async () => {
    throw new Error('unused');
  },
  consumeNativeEnrollmentGrant: async () => {
    throw new Error('unused');
  },
  issueNativeSession: async () => {
    throw new Error('unused');
  },
  revokeInstallationSessions: async () => {},
};

// Real ffmpeg work competes with the rest of the suite for CPU.
vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-media-worker-'));
  scratch = join(root, 'scratch');
  qualification = await qualifyWorker(DEFAULT_TOOL_CONFIG, scratch);
  for (const name of ['h264-aac', 'vp9-opus', 'long', 'big'] as const)
    media.set(name, await makeFixture(root, name));
  media.set(
    'photo',
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#446688' } })
      .jpeg()
      .toBuffer(),
  );
}, 300_000);
afterAll(async () => {
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});

type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup(limits: Partial<CaptureLimits> = {}, clock?: () => Date) {
  const account = await insertAccount();
  const storage = new LocalMultipartStorage(join(root, randomUUID()), 'http://127.0.0.1:3301', 'k');
  const merged = { ...DEFAULT_CAPTURE_LIMITS, ...limits };
  const ctx = createCaptureV2Context({
    db,
    authority: account,
    storage,
    identity,
    videoEnabled: true,
    limits: merged,
    now: clock,
  });
  const worker = new MediaWorker({
    db,
    storage,
    scratchRoot: scratch,
    qualification,
    limits: merged,
    accountId: account.accountId,
    now: clock,
    housekeeping: {
      reapEveryMs: 0,
      expireEveryMs: 0,
      legacyEveryMs: 0,
      reconcileEveryMs: 0,
      capabilityEveryMs: 0,
    },
    log: () => {},
  });
  return { account, storage, ctx, intake: new MediaIntake(ctx), worker };
}
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function declare(name: FixtureName | 'photo', overrides: Record<string, unknown> = {}) {
  const bytes = media.get(name)!;
  const photo = name === 'photo';
  return {
    client_capture_id: randomUUID(),
    kind: photo ? 'photo' : 'video',
    source: 'upload',
    filename: photo ? 'p.jpg' : 'v.bin',
    content_type: photo ? 'image/jpeg' : name === 'vp9-opus' ? 'video/webm' : 'video/mp4',
    byte_size: bytes.length,
    sha256: digest(bytes),
    ...overrides,
  };
}
/** PUT through the signed instruction exactly like a client (HMAC-checked by the local driver). */
async function put(f: Fixture, u: MediaUploadResponse, part: number, bytes: Buffer) {
  const instruction =
    u.parts.find((p) => p.part_number === part) ??
    (await f.intake.parts(u.upload_id, { part_numbers: [part] }, randomUUID())).parts[0]!;
  const url = new URL(instruction.url);
  const size = u.part_size;
  return f.storage.acceptSignedPart(
    url.pathname.split('/')[4]!,
    part,
    Number(url.searchParams.get('expires')),
    url.searchParams.get('signature')!,
    Readable.from([bytes.subarray((part - 1) * size, part * size)]),
  );
}
async function uploadAll(f: Fixture, request: ReturnType<typeof declare>, bytes: Buffer) {
  const u = await f.intake.createUpload(request, randomUUID());
  const parts = [];
  for (let p = 1; p <= u.part_count; p++)
    parts.push({ part_number: p, etag: await put(f, u, p, bytes) });
  return { u, parts };
}
async function stored(storage: LocalMultipartStorage, prefix: string) {
  const keys: string[] = [];
  for await (const o of storage.list(prefix)) keys.push(o.key);
  return keys;
}
function assertMediaContract(detail: Awaited<ReturnType<MediaIntake['detail']>>) {
  schemas.MediaDetailResponse.parse(detail);
  if (detail.media.kind === 'video' && detail.media.status === 'ready') {
    expect(detail.media.duration_ms).toBeGreaterThan(0);
    expect(typeof detail.media.audio_present).toBe('boolean');
  }
}

describe('MED-01 one committed asset per capture across duplicate completion and worker restart', () => {
  it('commits, prepares and exposes a video once; a crashed attempt is fenced', async () => {
    const f = await setup();
    const bytes = media.get('h264-aac')!;
    const request = declare('h264-aac');
    const { u, parts } = await uploadAll(f, request, bytes);
    // Lost responses: the client retries create and complete with fresh keys.
    expect((await f.intake.createUpload(request, randomUUID())).upload_id).toBe(u.upload_id);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        f.intake.completeUpload(u.upload_id, { parts }, randomUUID()),
      ),
    );
    // A worker claims verification, then dies holding a 1s lease.
    const crashed = await new CaptureQueue(db).claim(['verify_upload'], 1, f.account.accountId);
    expect(crashed).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1100));
    await f.worker.drain();
    // The crashed attempt resumes late: it must not publish anything.
    await new MediaPreparation(f.ctx).verifyUpload(crashed!);
    await f.worker.drain();

    const assets = await db.query(`SELECT id,status FROM media_assets WHERE account_id=$1`, [
      f.account.accountId,
    ]);
    expect(assets.rows).toEqual([{ id: u.asset_id, status: 'ready' }]);
    const work = await db.query(
      `SELECT kind,state,count(*)::int AS n FROM capture_work WHERE account_id=$1 GROUP BY kind,state ORDER BY kind`,
      [f.account.accountId],
    );
    expect(work.rows).toEqual([
      { kind: 'prepare_media', state: 'complete', n: 1 },
      { kind: 'verify_upload', state: 'complete', n: 1 },
    ]);
    const detail = await f.intake.detail(u.asset_id);
    assertMediaContract(detail);
    expect(detail.media).toMatchObject({
      kind: 'video',
      status: 'ready',
      audio_present: true,
      width: 320,
      height: 240,
    });
    expect(detail.links.playback).toMatch(/^\/v2\/media\/.+\/content\//);
    expect(detail.links.poster).not.toBeNull();
    expect(detail.frames.length).toBeGreaterThanOrEqual(1);
    expect(detail.frames.length).toBeLessThanOrEqual(8);
    expect(detail.frames.every((fr) => fr.extraction_version === 'frames-v1')).toBe(true);
    expect(detail.frames.every((fr) => fr.timestamp_ms < detail.media.duration_ms!)).toBe(true);
    // Staging bytes are gone; only the immutable namespace remains.
    expect(await stored(f.storage, `accounts/${f.account.accountId}/staging`)).toEqual([]);
    const keys = await stored(f.storage, `accounts/${f.account.accountId}/media/${u.asset_id}`);
    expect(keys).toContain(`accounts/${f.account.accountId}/media/${u.asset_id}/1/original`);
    // Usage settles once at actual prepared size.
    const usage = await db.query(
      `SELECT state,amount FROM usage_reservations WHERE account_id=$1`,
      [f.account.accountId],
    );
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]!.state).toBe('settled');
    expect(Number(usage.rows[0]!.amount)).toBeLessThan(
      bytes.length + DEFAULT_CAPTURE_LIMITS.derivativeAllowanceBytes,
    );
    // Two explicit sampled-video requests are one logical analysis and one allowance unit.
    const analysis = new MediaAnalysis(f.ctx);
    const first = await analysis.request(
      u.asset_id,
      { mode: 'sampled_video', expected_generation: 1 },
      randomUUID(),
    );
    const second = await analysis.request(
      u.asset_id,
      { mode: 'sampled_video', expected_generation: 1 },
      randomUUID(),
    );
    expect(second).toMatchObject({ analysis_id: first.analysis_id, reused: true });
    const counter = await db.query(
      `SELECT count FROM usage_counters WHERE bucket=$1 AND metric='media_analyses'`,
      [`account:${f.account.accountId}`],
    );
    expect(counter.rows[0]!.count).toBe(1);
  });
});

describe('MED-02 cancel/delete races cannot resurrect media', () => {
  it('delete during real ffmpeg preparation leaves no derivative rows or bytes', async () => {
    const f = await setup();
    const { u, parts } = await uploadAll(f, declare('vp9-opus'), media.get('vp9-opus')!);
    await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
    const original = f.storage.put.bind(f.storage);
    let deleted = false;
    vi.spyOn(f.storage, 'put').mockImplementation(async (key, body, type, size) => {
      if (key.includes('/derived/') && !deleted) {
        deleted = true;
        await f.intake.deleteMedia(u.asset_id, { expected_generation: 1 }, randomUUID());
      }
      return original(key, body, type, size);
    });
    await f.worker.drain();
    expect(deleted).toBe(true);
    await expect(f.intake.detail(u.asset_id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await f.intake.library({})).items).toEqual([]);
    const derivatives = await db.query(
      `SELECT count(*)::int AS n FROM media_derivatives WHERE account_id=$1`,
      [f.account.accountId],
    );
    expect(derivatives.rows[0]!.n).toBe(0);
    // First purge pass already removed original and attempt output.
    expect(await stored(f.storage, `accounts/${f.account.accountId}/media`)).toEqual([]);
    const work = await db.query(
      `SELECT kind,state FROM capture_work WHERE account_id=$1 AND kind IN ('prepare_media','purge_media')`,
      [f.account.accountId],
    );
    expect(work.rows).toEqual(
      expect.arrayContaining([
        { kind: 'prepare_media', state: 'cancelled' },
        // The delayed second purge pass stays durable for late writes.
        { kind: 'purge_media', state: 'queued' },
      ]),
    );
    // Replaying the delete is safe and does not revive anything.
    expect(
      await f.intake.deleteMedia(u.asset_id, { expected_generation: 1 }, randomUUID()),
    ).toMatchObject({
      status: 'deleted',
    });
  });
  it('abort racing queued verification cancels the work and removes staging bytes', async () => {
    const f = await setup();
    const { u, parts } = await uploadAll(f, declare('h264-aac'), media.get('h264-aac')!);
    await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
    await f.intake.abortUpload(u.upload_id, randomUUID());
    await expect(
      f.intake.completeUpload(u.upload_id, { parts }, randomUUID()),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    await f.worker.drain();
    expect((await f.intake.getUpload(u.upload_id)).state).toBe('aborted');
    const verify = await db.query(
      `SELECT state FROM capture_work WHERE account_id=$1 AND kind='verify_upload'`,
      [f.account.accountId],
    );
    expect(verify.rows).toEqual([{ state: 'cancelled' }]);
    expect(await stored(f.storage, `accounts/${f.account.accountId}`)).toEqual([]);
    const usage = await db.query(`SELECT state FROM usage_reservations WHERE account_id=$1`, [
      f.account.accountId,
    ]);
    expect(usage.rows).toEqual([{ state: 'released' }]);
  });
});

describe('MED-03 invalid media rejects safely without blocking valid batch siblings', () => {
  it('processes a mixed batch with independent per-file results', async () => {
    const f = await setup({ videoMaxDurationMs: 2500, accountQuotaBytes: 7 * 33554432 });
    const h264 = media.get('h264-aac')!;
    const files: Array<[string, ReturnType<typeof declare>, Buffer]> = [
      ['valid video', declare('h264-aac'), h264],
      ['valid photo', declare('photo'), media.get('photo')!],
      ['corrupt video', declare('h264-aac', { sha256: digest(corrupt(h264)) }), corrupt(h264)],
      ['overlong video', declare('long'), media.get('long')!],
      [
        'mislabeled webm',
        declare('vp9-opus', { content_type: 'video/mp4' }),
        media.get('vp9-opus')!,
      ],
      ['digest mismatch', declare('h264-aac', { sha256: 'a'.repeat(64) }), h264],
    ];
    const uploads = new Map<string, MediaUploadResponse>();
    for (const [label, request, bytes] of files) {
      const { u, parts } = await uploadAll(f, request, bytes);
      await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
      uploads.set(label, u);
    }
    // Excessive declared bytes and exhausted quota are rejected before any storage work.
    const begin = vi.spyOn(f.storage, 'begin');
    await expect(
      f.intake.createUpload(
        declare('photo', { byte_size: DEFAULT_CAPTURE_LIMITS.photoMaxBytes + 1 }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    await expect(
      f.intake.createUpload(
        declare('h264-aac', { byte_size: DEFAULT_CAPTURE_LIMITS.videoMaxBytes }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(begin).not.toHaveBeenCalled();
    await f.worker.drain();

    const state = async (label: string) => {
      const u = uploads.get(label)!;
      const upload = await f.intake.getUpload(u.upload_id);
      const row = await db.query(`SELECT status,error_code FROM media_assets WHERE id=$1`, [
        u.asset_id,
      ]);
      return { upload: upload.state, error: upload.error_code, media: row.rows[0] };
    };
    expect(await state('valid video')).toMatchObject({
      upload: 'committed',
      media: { status: 'ready' },
    });
    expect(await state('valid photo')).toMatchObject({
      upload: 'committed',
      media: { status: 'ready' },
    });
    expect(await state('corrupt video')).toMatchObject({
      upload: 'rejected',
      error: 'unsupported_media',
    });
    expect(await state('overlong video')).toMatchObject({
      upload: 'rejected',
      error: 'duration_exceeded',
    });
    expect(await state('mislabeled webm')).toMatchObject({
      upload: 'rejected',
      error: 'unsupported_media',
    });
    expect(await state('digest mismatch')).toMatchObject({
      upload: 'rejected',
      error: 'invalid_input',
    });
    // Rejected files release their reservations once physical cleanup ran; nothing sealed.
    const released = await db.query(
      `SELECT r.state,count(*)::int AS n FROM usage_reservations r WHERE r.account_id=$1 GROUP BY r.state ORDER BY r.state`,
      [f.account.accountId],
    );
    expect(released.rows).toEqual([
      { state: 'released', n: 4 },
      { state: 'settled', n: 2 },
    ]);
    const originals = (await stored(f.storage, `accounts/${f.account.accountId}/media`)).filter(
      (k) => k.endsWith('/original'),
    );
    expect(originals).toHaveLength(2);
    expect(await stored(f.storage, `accounts/${f.account.accountId}/staging`)).toEqual([]);
  });
  it('a failed preparation keeps the original and can be retried explicitly', async () => {
    const f = await setup({ derivativeAllowanceBytes: 4 * 1024 * 1024 + 70_000 });
    const { u, parts } = await uploadAll(f, declare('h264-aac'), media.get('h264-aac')!);
    await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
    await f.worker.drain();
    const failed = await f.intake.detail(u.asset_id);
    expect(failed).toMatchObject({ media: { status: 'failed' }, error_code: 'quota_exceeded' });
    expect(failed.links).toMatchObject({ playback: null, poster: null });
    expect(failed.links.original).not.toBeNull();
    // Retry under a corrected operator budget.
    const fixed = await setup();
    const retryCtx = { ...f.ctx };
    const intake = new MediaIntake(retryCtx);
    await expect(
      intake.retryPreparation(u.asset_id, { expected_generation: 2 }, randomUUID()),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      (await intake.retryPreparation(u.asset_id, { expected_generation: 1 }, randomUUID())).media
        .status,
    ).toBe('processing');
    await new MediaWorker({
      db,
      storage: f.storage,
      scratchRoot: scratch,
      qualification,
      accountId: f.account.accountId,
      housekeeping: {
        reapEveryMs: 0,
        expireEveryMs: 0,
        legacyEveryMs: 0,
        reconcileEveryMs: 0,
        capabilityEveryMs: 0,
      },
      log: () => {},
    }).drain();
    expect((await intake.detail(u.asset_id)).media.status).toBe('ready');
    await expect(
      new MediaIntake(fixed.ctx).retryPreparation(
        u.asset_id,
        { expected_generation: 1 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('MED-04 interrupted transfers, expiry and orphan cleanup bound storage', () => {
  it('resumes a two-part upload after app termination using server-verified parts', async () => {
    const f = await setup();
    const bytes = media.get('big')!;
    expect(bytes.length).toBeGreaterThan(8388608);
    const request = declare('big');
    const u = await f.intake.createUpload(request, randomUUID());
    expect(u.part_count).toBe(2);
    const first = await put(f, u, 1, bytes);
    // App terminated: a new process only knows the persisted upload id and asks the server.
    const resumedIntake = new MediaIntake(createCaptureV2Context({ ...f.ctx }));
    const status = await resumedIntake.getUpload(u.upload_id);
    expect(status.verified_parts).toEqual([{ part_number: 1, etag: first }]);
    const second = await put({ ...f, intake: resumedIntake }, status, 2, bytes);
    await resumedIntake.completeUpload(
      u.upload_id,
      {
        parts: [
          { part_number: 1, etag: first },
          { part_number: 2, etag: second },
        ],
      },
      randomUUID(),
    );
    await f.worker.drain();
    expect((await resumedIntake.detail(u.asset_id)).media.status).toBe('ready');
    // Range reads through the gateway are bounded to one 8 MiB storage window per request.
    const window = await resumedIntake.content(u.asset_id, 'original', { start: 0 });
    expect(window).toMatchObject({
      partial: true,
      start: 0,
      end: 8388607,
      byteSize: 8388608,
      totalSize: bytes.length,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of window.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).equals(bytes.subarray(0, 8388608))).toBe(true);
    const count = await db.query(
      `SELECT count(*)::int AS n FROM media_assets WHERE account_id=$1`,
      [f.account.accountId],
    );
    expect(count.rows[0]!.n).toBe(1);
  });
  it('expired part URLs are refused and abandoned multipart uploads are aborted and released', async () => {
    let now = new Date();
    const f = await setup({}, () => now);
    const bytes = media.get('h264-aac')!;
    const u = await f.intake.createUpload(declare('h264-aac'), randomUUID());
    const url = new URL(u.parts[0]!.url);
    await expect(
      f.storage.acceptSignedPart(
        url.pathname.split('/')[4]!,
        1,
        Math.floor(Date.now() / 1000) - 1,
        url.searchParams.get('signature')!,
        Readable.from([bytes]),
      ),
    ).rejects.toThrow('authorization');
    await put(f, u, 1, bytes); // partially transferred, never completed
    now = new Date(now.getTime() + 86400000 + 1000);
    const expiring = new MediaWorker({
      db,
      storage: f.storage,
      scratchRoot: scratch,
      qualification,
      accountId: f.account.accountId,
      now: () => now,
      housekeeping: {
        reapEveryMs: 0,
        legacyEveryMs: 0,
        reconcileEveryMs: 0,
        capabilityEveryMs: 0,
        expireEveryMs: 1,
      },
      log: () => {},
    });
    await expiring.drain();
    expect((await f.intake.getUpload(u.upload_id)).state).toBe('expired');
    const incomplete = [];
    for await (const m of f.storage.listIncompleteUploads(`accounts/${f.account.accountId}`))
      incomplete.push(m);
    expect(incomplete).toEqual([]);
    const usage = await db.query(`SELECT state FROM usage_reservations WHERE account_id=$1`, [
      f.account.accountId,
    ]);
    expect(usage.rows).toEqual([{ state: 'released' }]);
  });
  it('reconciliation removes only unreferenced objects after the safety window and reports missing ones', async () => {
    const f = await setup();
    const { u, parts } = await uploadAll(f, declare('photo'), media.get('photo')!);
    await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
    await f.worker.drain();
    const a = f.account.accountId;
    const old = new Date(Date.now() - 2 * 86400000);
    const orphanAttempt = `accounts/${a}/media/${u.asset_id}/1/derived/${randomUUID()}/normalized`;
    const unknownAsset = `accounts/${a}/media/${randomUUID()}/1/original`;
    const freshOrphan = `accounts/${a}/media/${u.asset_id}/1/derived/${randomUUID()}/poster`;
    const foreign = `accounts/${a}/notes/readme`;
    for (const key of [orphanAttempt, unknownAsset, freshOrphan, foreign])
      await f.storage.put(key, Readable.from([Buffer.from('x')]), 'application/octet-stream', 1);
    const objects = join((f.storage as unknown as { root: string }).root, 'objects');
    for (const key of [orphanAttempt, unknownAsset]) await utimes(join(objects, key), old, old);
    // An abandoned multipart without any DB record (crash between begin and commit).
    const strayKey = `accounts/${a}/staging/${randomUUID()}/${randomUUID()}`;
    const strayId = await f.storage.begin(strayKey, 'video/mp4');
    await utimes(
      join((f.storage as unknown as { root: string }).root, 'multipart', strayId, 'metadata.json'),
      old,
      old,
    );

    const result = await reconcileCaptureStorage(db, f.storage, { accountId: a });
    expect(result).toMatchObject({
      deletedOrphans: 2,
      abortedMultipart: 1,
      unrecognized: 1,
      missingReferenced: 0,
      complete: true,
    });
    const keys = await stored(f.storage, `accounts/${a}`);
    expect(keys).not.toContain(orphanAttempt);
    expect(keys).not.toContain(unknownAsset);
    expect(keys).toEqual(
      expect.arrayContaining([
        freshOrphan,
        foreign,
        `accounts/${a}/media/${u.asset_id}/1/original`,
      ]),
    );
    expect((await f.intake.detail(u.asset_id)).media.status).toBe('ready');
    // A referenced object that disappeared is reported, never recreated.
    await f.storage.delete(`accounts/${a}/media/${u.asset_id}/1/original`);
    expect((await reconcileCaptureStorage(db, f.storage, { accountId: a })).missingReferenced).toBe(
      1,
    );
  });
});

describe('TEN-01/TEN-02 worker ownership and account switching', () => {
  it('derivatives stay in each owner namespace and guessed IDs never cross accounts', async () => {
    const a = await setup(),
      b = await setup();
    const ua = await uploadAll(a, declare('vp9-opus'), media.get('vp9-opus')!);
    const ub = await uploadAll(b, declare('h264-aac'), media.get('h264-aac')!);
    await a.intake.completeUpload(ua.u.upload_id, { parts: ua.parts }, randomUUID());
    await b.intake.completeUpload(ub.u.upload_id, { parts: ub.parts }, randomUUID());
    await a.worker.drain();
    await b.worker.drain();
    const keys = await db.query(
      `SELECT account_id,object_key FROM media_derivatives WHERE account_id=ANY($1::uuid[])`,
      [[a.account.accountId, b.account.accountId]],
    );
    for (const row of keys.rows)
      expect(row.object_key.startsWith(`accounts/${row.account_id}/media/`)).toBe(true);
    const detailA = await a.intake.detail(ua.u.asset_id);
    const variantA = detailA.links.playback!.split('/').at(-1)!;
    // Guessed asset IDs, and A's derivative ID under B's own asset, are both not found.
    await expect(b.intake.detail(ua.u.asset_id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.intake.content(ua.u.asset_id, variantA)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(b.intake.content(ub.u.asset_id, variantA)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      b.intake.retryPreparation(ua.u.asset_id, { expected_generation: 1 }, randomUUID()),
    ).rejects.toMatchObject({ code: 'not_found' });
    // A forged work row pointing B's account at A's asset violates the owner-composite key.
    await expect(
      db.query(
        `INSERT INTO capture_work(account_id,asset_id,generation,kind) VALUES($1,$2,1,'prepare_media')`,
        [b.account.accountId, ua.u.asset_id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    expect((await b.intake.library({})).items.map((i) => i.media.id)).toEqual([ub.u.asset_id]);
  });
  it('sign-out during verification fences the worker; the original account resumes the same asset', async () => {
    const f = await setup();
    const { u, parts } = await uploadAll(f, declare('h264-aac'), media.get('h264-aac')!);
    await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
    const stale = await new CaptureQueue(db).claim(['verify_upload'], 60, f.account.accountId);
    await db.transaction((tx) =>
      endCaptureAuthority(tx, {
        accountId: f.account.accountId,
        installationId: null,
        sessionId: f.account.sessionId,
        reason: 'sign_out',
        now: new Date(),
      }),
    );
    await new MediaPreparation(f.ctx).verifyUpload(stale!);
    expect((await f.intake.getUpload(u.upload_id)).state).toBe('paused');
    expect(await stored(f.storage, `accounts/${f.account.accountId}/media`)).toEqual([]);
    // Another account cannot resume it.
    const other = await setup();
    await expect(other.intake.resumeUpload(u.upload_id, randomUUID())).rejects.toMatchObject({
      code: 'not_found',
    });
    await f.intake.resumeUpload(u.upload_id, randomUUID());
    await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
    await f.worker.drain();
    const row = await db.query(
      `SELECT account_id,status,generation FROM media_assets WHERE id=$1`,
      [u.asset_id],
    );
    expect(row.rows[0]).toMatchObject({
      account_id: f.account.accountId,
      status: 'ready',
      generation: 2,
    });
  });
});

describe('legacy capture adapter', () => {
  async function capture(accountId: string, source: string, extra: Record<string, unknown> = {}) {
    let connection: string | null = null;
    if (source === 'sensor') {
      const c = await db.query(
        `INSERT INTO sensor_connections(owner_account_id,configured_origin,mode) VALUES($1,'https://relay.invalid','bridge') RETURNING id`,
        [accountId],
      );
      connection = c.rows[0]!.id;
    }
    const { rows } = await db.query(
      `INSERT INTO captures(owner_account_id,source,sample_id,private_object_key,image_sha256,width,height,status,
         sensor_connection_id,sensor_asset_id,deleted_at)
       VALUES($1,$2,$3,$4,$5,640,480,'ready',$6,$7,$8) RETURNING id`,
      [
        accountId,
        source,
        source === 'sample' ? 'sample-1' : null,
        `captures/${randomUUID()}.jpg`,
        'b'.repeat(64),
        connection,
        connection ? randomUUID() : null,
        extra.deleted_at ?? null,
      ],
    );
    return { id: rows[0]!.id as string };
  }
  it('imports later v1 captures, keeps Sensor optional and mirrors v1 deletion', async () => {
    const f = await setup();
    const a = f.account.accountId;
    const camera = await capture(a, 'camera');
    const upload = await capture(a, 'upload');
    const sample = await capture(a, 'sample');
    const sensor = await capture(a, 'sensor');
    await backfillLegacyCaptures(db, { includeSensor: false, accountId: a });
    const sources = async () =>
      (
        await db.query(
          `SELECT source,legacy_capture_id FROM media_assets WHERE account_id=$1 AND deleted_at IS NULL ORDER BY source`,
          [a],
        )
      ).rows;
    expect(await sources()).toEqual([
      { source: 'browser_camera', legacy_capture_id: camera.id },
      { source: 'upload', legacy_capture_id: upload.id },
    ]);
    expect((await f.intake.library({})).items).toHaveLength(2);
    const detail = (await f.intake.library({})).items[0]!;
    assertMediaContract(detail);
    expect(detail.links.analysis).toMatch(/^\/captures\//);
    await backfillLegacyCaptures(db, { includeSensor: true, accountId: a });
    expect(await sources()).toContainEqual({
      source: 'legacy_sensor',
      legacy_capture_id: sensor.id,
    });
    // Re-running is idempotent; samples are never library media.
    await backfillLegacyCaptures(db, { includeSensor: true, accountId: a });
    const sampleRow = await db.query(`SELECT media_asset_id FROM captures WHERE id=$1`, [
      sample.id,
    ]);
    expect(sampleRow.rows[0]!.media_asset_id).toBeNull();
    await db.query(`UPDATE captures SET deleted_at=now(),status='deleted' WHERE id=$1`, [
      camera.id,
    ]);
    expect(
      (await backfillLegacyCaptures(db, { includeSensor: false, accountId: a })).tombstoned,
    ).toBe(1);
    expect((await sources()).map((r) => r.legacy_capture_id)).not.toContain(camera.id);
  });
});

describe('worker capability heartbeat', () => {
  it('advertises video only after self-test qualification and withdraws it on shutdown', async () => {
    const at = new Date('2031-03-01T00:00:00Z');
    const storage = new LocalMultipartStorage(
      join(root, randomUUID()),
      'http://127.0.0.1:3301',
      'k',
    );
    const options = {
      db,
      storage,
      scratchRoot: scratch,
      accountId: randomUUID(),
      now: () => at,
      housekeeping: {
        reapEveryMs: 0,
        expireEveryMs: 0,
        legacyEveryMs: 0,
        reconcileEveryMs: 0,
        capabilityEveryMs: 1,
      },
      log: () => {},
    };
    const unqualified = new MediaWorker({
      ...options,
      qualification: {
        qualified: { video: new Set(), audio: new Set() },
        codecs: {},
        preparation: false,
      },
    });
    await unqualified.housekeeping();
    expect(await hasQualifiedVideoWorker(db, at)).toBe(false);
    const worker = new MediaWorker({ ...options, qualification });
    await worker.housekeeping();
    expect(await hasQualifiedVideoWorker(db, at)).toBe(true);
    const row = await db.query(`SELECT codecs FROM media_worker_capabilities WHERE worker_id=$1`, [
      worker.workerId,
    ]);
    expect(row.rows[0]!.codecs).toMatchObject({
      'prepare/mp4/h264/aac': true,
      'mp4/h264/aac': true,
    });
    await worker.stop();
    expect(await hasQualifiedVideoWorker(db, at)).toBe(false);
  });
});
