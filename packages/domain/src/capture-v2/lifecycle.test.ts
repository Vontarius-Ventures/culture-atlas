import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalMultipartStorage } from '@culture-atlas/providers';
import { getTestDb, insertAccount, closeTestDb } from '../testing';
import { insertAgentConnection } from '../testing';
import { AppError } from '../errors';
import { createCaptureV2Context } from './context';
import { MediaIntake } from './intake';
import { MediaPreparation } from './preparation';
import { CaptureQueue } from './queue';
import { CaptureDevice, endCaptureAuthority, enrollmentSignaturePayload } from './devices';
import { MediaAnalysis } from './analysis';
import {
  evaluateCaptureCapabilities,
  heartbeatMediaWorker,
  hasQualifiedVideoWorker,
} from './capabilities';
import type { CaptureIdentityAdapter, CaptureV2Context, MediaVerifier } from './types';

const db = getTestDb();
let root: string, photo: Buffer;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identity: CaptureIdentityAdapter = {
  requireRecoverableAccount: async () => {},
  peekNativeEnrollmentGrant: async () => {
    throw new Error('No grant fixture');
  },
  consumeNativeEnrollmentGrant: async () => {
    throw new Error('No grant fixture');
  },
  issueNativeSession: async (_tx, input) => ({
    session_id: randomUUID(),
    account_id: input.accountId,
    installation_id: input.installationId,
    access_token: 'test-access',
    refresh_token: 'test-refresh',
    access_expires_at: new Date(Date.now() + 600000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 86400000).toISOString(),
  }),
  revokeInstallationSessions: async () => {},
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-v2-p1-'));
  photo = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#224466' } })
    .png()
    .toBuffer();
});
afterAll(async () => {
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});
async function fixture(overrides: Partial<CaptureV2Context> = {}) {
  const account = await insertAccount();
  const storage = new LocalMultipartStorage(
    join(root, randomUUID()),
    'http://127.0.0.1:3301',
    'local-test-signing-key',
  );
  const ctx = createCaptureV2Context({ db, authority: account, storage, identity, ...overrides });
  return {
    ctx,
    account,
    storage,
    intake: new MediaIntake(ctx),
    worker: new MediaPreparation(ctx),
    queue: new CaptureQueue(db, ctx.now),
  };
}
const request = (bytes = photo) => ({
  client_capture_id: randomUUID(),
  kind: 'photo',
  source: 'upload',
  filename: 'photo.png',
  byte_size: bytes.length,
  sha256: digest(bytes),
  content_type: 'image/png',
});
async function transferred(
  f: Awaited<ReturnType<typeof fixture>>,
  input = request(),
  bytes = photo,
) {
  const u = await f.intake.createUpload(input, randomUUID());
  const { rows } = await db.query(`SELECT provider_multipart_id FROM upload_sessions WHERE id=$1`, [
    u.upload_id,
  ]);
  const etag = await f.storage.writePart(rows[0]!.provider_multipart_id, 1, Readable.from([bytes]));
  return { u, parts: [{ part_number: 1, etag }] };
}
async function committed(f: Awaited<ReturnType<typeof fixture>>) {
  const { u, parts } = await transferred(f);
  await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
  const lease = await f.queue.claim(['verify_upload'], 60, f.account.accountId);
  await f.worker.verifyUpload(lease!);
  return { u, parts };
}

describe('TEN-01/TEN-02 private media and upload authority', () => {
  it('denies guessed upload/media IDs to another real database account across every operation', async () => {
    const a = await fixture(),
      b = await fixture();
    const { u, parts } = await transferred(a);
    for (const operation of [
      () => b.intake.getUpload(u.upload_id),
      () => b.intake.parts(u.upload_id, { part_numbers: [1] }, randomUUID()),
      () => b.intake.completeUpload(u.upload_id, { parts }, randomUUID()),
      () => b.intake.abortUpload(u.upload_id, randomUUID()),
      () => b.intake.detail(u.asset_id),
      () => b.intake.content(u.asset_id, 'original'),
      () => b.intake.deleteMedia(u.asset_id, { expected_generation: 1 }, randomUUID()),
      () =>
        b.intake.updateMedia(u.asset_id, { title: 'stolen', expected_revision: 1 }, randomUUID()),
      () =>
        new MediaAnalysis(b.ctx).request(
          u.asset_id,
          { mode: 'photo', expected_generation: 1 },
          randomUUID(),
        ),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'not_found' });
    expect((await b.intake.library({})).items).toEqual([]);
    expect((await a.intake.library({})).items).toHaveLength(1);
  });
  it('account switch cannot reassign upload/storage and cross-owner FKs reject forged children', async () => {
    const a = await fixture(),
      b = await fixture(),
      input = request();
    const u = await a.intake.createUpload(input, randomUUID());
    await expect(
      b.intake.completeUpload(
        u.upload_id,
        { parts: [{ part_number: 1, etag: 'guessed' }] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      db.query(
        `INSERT INTO upload_sessions(account_id,asset_id,staging_key,expected_bytes,expected_sha256,reserved_bytes,request_hash,expires_at)
      VALUES($1,$2,$3,1,$4,1,'test',now()+interval '1 hour')`,
        [b.account.accountId, u.asset_id, randomUUID(), input.sha256],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    const { rows } = await db.query(
      `SELECT account_id,staging_key FROM upload_sessions WHERE id=$1`,
      [u.upload_id],
    );
    expect(rows[0]).toMatchObject({
      account_id: a.account.accountId,
      staging_key: expect.stringContaining(`accounts/${a.account.accountId}/staging/`),
    });
  });
  it('enforces installation owner scope and revocation on replay', async () => {
    const a = await fixture(),
      b = await fixture();
    const install = await db.query(
      `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version)
      VALUES($1,$2,'ios','1') RETURNING id`,
      [a.account.accountId, randomUUID()],
    );
    const id = install.rows[0]!.id;
    const ctx = {
      ...a.ctx,
      authority: {
        kind: 'installation' as const,
        accountId: a.account.accountId,
        installationId: id,
        sessionId: randomUUID(),
        expiresAt: new Date(Date.now() + 600000),
      },
    };
    const intake = new MediaIntake(ctx),
      input = request(),
      key = randomUUID();
    const u = await intake.createUpload(input, key);
    await expect(
      new MediaIntake({
        ...ctx,
        authority: { ...ctx.authority, accountId: b.account.accountId },
      }).getUpload(u.upload_id),
    ).rejects.toMatchObject({ code: 'token_revoked' });
    await db.query(`UPDATE mobile_installations SET revoked_at=now() WHERE id=$1`, [id]);
    await expect(intake.createUpload(input, key)).rejects.toMatchObject({ code: 'token_revoked' });
  });
});

describe('MED-01 idempotent multipart commit', () => {
  it('duplicate completion and worker restart publish one asset and one preparation job', async () => {
    const f = await fixture(),
      { u, parts } = await transferred(f);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        f.intake.completeUpload(u.upload_id, { parts }, randomUUID()),
      ),
    );
    const lease = await f.queue.claim(['verify_upload'], 60, f.account.accountId);
    await new MediaPreparation(f.ctx).verifyUpload(lease!);
    expect((await f.intake.completeUpload(u.upload_id, { parts }, randomUUID())).state).toBe(
      'committed',
    );
    const assets = await db.query(`SELECT count(*) AS n FROM media_assets WHERE account_id=$1`, [
      f.account.accountId,
    ]);
    const jobs = await db.query(
      `SELECT count(*) AS n FROM capture_work WHERE account_id=$1 AND kind='prepare_media'`,
      [f.account.accountId],
    );
    expect([assets.rows[0]!.n, jobs.rows[0]!.n]).toEqual([1, 1]);
  });
  it('capture-id retries dedupe only the same capture, never two intentional captures with identical bytes', async () => {
    const f = await fixture(),
      input = request();
    const first = await f.intake.createUpload(input, randomUUID());
    expect((await f.intake.createUpload(input, randomUUID())).asset_id).toBe(first.asset_id);
    await expect(
      f.intake.createUpload({ ...input, filename: 'different.png' }, randomUUID()),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect((await f.intake.createUpload(request(), randomUUID())).asset_id).not.toBe(
      first.asset_id,
    );
    const reusedKey = randomUUID();
    await f.intake.createUpload(request(), reusedKey);
    await expect(f.intake.createUpload(request(), reusedKey)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });
  it('lost provider completion response is recoverable without trusting multipart ETags as hashes', async () => {
    const f = await fixture(),
      { u, parts } = await transferred(f);
    const { rows } = await db.query(`SELECT * FROM upload_sessions WHERE id=$1`, [u.upload_id]);
    await f.storage.finish(rows[0]!.staging_key, rows[0]!.provider_multipart_id, parts);
    await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
    const lease = await f.queue.claim(['verify_upload'], 60, f.account.accountId);
    await f.worker.verifyUpload(lease!);
    expect((await f.intake.getUpload(u.upload_id)).state).toBe('committed');
  });
});

describe('MED-02 deletion and authority fencing', () => {
  it('delete while verifier is running never resurrects bytes or metadata', async () => {
    let started!: () => void, resume!: () => void;
    const ready = new Promise<void>((r) => {
        started = r;
      }),
      release = new Promise<void>((r) => {
        resume = r;
      });
    const f = await fixture(),
      normal = f.ctx.verifier;
    f.ctx.verifier = {
      async verify(input) {
        const m = await normal.verify(input);
        started();
        await release;
        return m;
      },
    };
    const { u, parts } = await transferred(f);
    await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
    const lease = await f.queue.claim(['verify_upload'], 60, f.account.accountId);
    const verifying = f.worker.verifyUpload(lease!);
    await ready;
    await f.intake.deleteMedia(u.asset_id, { expected_generation: 1 }, randomUUID());
    resume();
    await verifying;
    await expect(f.intake.detail(u.asset_id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      f.intake.completeUpload(u.upload_id, { parts }, randomUUID()),
    ).rejects.toMatchObject({ code: 'conflict' });
    const purge = await f.queue.claim(['purge_media'], 60, f.account.accountId);
    await f.worker.cleanup(purge!);
    const { rows } = await db.query(
      `SELECT status,original_key,generation FROM media_assets WHERE id=$1`,
      [u.asset_id],
    );
    expect(rows[0]).toMatchObject({ status: 'deleted', original_key: null, generation: 2 });
  });
  it('abort racing complete is terminal and cannot delete already committed media implicitly', async () => {
    const f = await fixture(),
      { u, parts } = await transferred(f);
    await Promise.allSettled([
      f.intake.completeUpload(u.upload_id, { parts }, randomUUID()),
      f.intake.abortUpload(u.upload_id, randomUUID()),
    ]);
    expect((await f.intake.getUpload(u.upload_id)).state).toBe('aborted');
    const another = await fixture(),
      c = await committed(another);
    await expect(another.intake.abortUpload(c.u.upload_id, randomUUID())).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('revoked authority fences pending uploads and ends local/remote sessions without rebinding', async () => {
    const f = await fixture();
    const install = await db.query(
      `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version)
      VALUES($1,$2,'ios','1') RETURNING id`,
      [f.account.accountId, randomUUID()],
    );
    const installationId = install.rows[0]!.id,
      sessionId = randomUUID();
    const ctx = {
      ...f.ctx,
      authority: {
        kind: 'installation' as const,
        accountId: f.account.accountId,
        installationId,
        sessionId,
        expiresAt: new Date(Date.now() + 600000),
      },
    };
    const d = new CaptureDevice(ctx),
      session = await d.createSession({ source: 'phone_camera', mode: 'photo' }, randomUUID());
    const u = await new MediaIntake(ctx).createUpload(request(), randomUUID());
    await db.transaction((tx) =>
      endCaptureAuthority(tx, {
        accountId: f.account.accountId,
        installationId,
        sessionId,
        reason: 'account_switch',
        now: new Date(),
      }),
    );
    const capture = await db.query(
      `SELECT state,remote_arm_expires_at FROM capture_sessions WHERE id=$1`,
      [session.session_id],
    );
    const upload = await db.query(`SELECT account_id,state FROM upload_sessions WHERE id=$1`, [
      u.upload_id,
    ]);
    expect(capture.rows[0]).toMatchObject({ state: 'ended', remote_arm_expires_at: null });
    expect(upload.rows[0]).toMatchObject({ account_id: f.account.accountId, state: 'paused' });
  });
});

describe('MED-03 bounded input and quota rejection', () => {
  it('rejects unsupported MIME and excessive declared size before storage begin', async () => {
    const f = await fixture(),
      begin = vi.spyOn(f.storage, 'begin');
    await expect(
      f.intake.createUpload({ ...request(), content_type: 'image/heic' }, randomUUID()),
    ).rejects.toThrow();
    await expect(
      f.intake.createUpload({ ...request(), byte_size: 15728641 }, randomUUID()),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(begin).not.toHaveBeenCalled();
  });
  it('reserves quota before transfer and releases aborted quota exactly once', async () => {
    const f = await fixture();
    f.ctx.limits = { ...f.ctx.limits, accountQuotaBytes: 33554432 + photo.length };
    const u = await f.intake.createUpload(request(), randomUUID());
    await expect(f.intake.createUpload(request(), randomUUID())).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    await f.intake.abortUpload(u.upload_id, randomUUID());
    await f.intake.abortUpload(u.upload_id, randomUUID());
    await expect(f.intake.createUpload(request(), randomUUID())).resolves.toMatchObject({
      state: 'created',
    });
  });
  it('rejects corrupt bytes and digest mismatch without blocking a valid sibling', async () => {
    const f = await fixture();
    for (const [input, bytes] of [
      [request(Buffer.from('not an image')), Buffer.from('not an image')],
      [{ ...request(), sha256: '0'.repeat(64) }, photo],
    ] as const) {
      const { u, parts } = await transferred(f, input, bytes);
      await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
      const lease = await f.queue.claim(['verify_upload'], 60, f.account.accountId);
      await f.worker.verifyUpload(lease!);
      expect((await f.intake.getUpload(u.upload_id)).state).toBe('rejected');
    }
    const good = await committed(f);
    expect((await f.intake.getUpload(good.u.upload_id)).state).toBe('committed');
  });
  it('signs each part URL for its exact length and aborts a multipart whose stored part is oversized', async () => {
    const f = await fixture();
    const u = await f.intake.createUpload(request(), randomUUID());
    expect(new URL(u.parts[0]!.url).searchParams.get('size')).toBe(String(photo.length));
    // A storage that accepted more than the signed length (or a part beyond the declared count).
    const { rows } = await db.query(`SELECT provider_multipart_id, staging_key FROM upload_sessions WHERE id=$1`, [
      u.upload_id,
    ]);
    const extra = Buffer.alloc(4096, 1);
    const etag = await f.storage.writePart(rows[0]!.provider_multipart_id, 1, Readable.from([photo, extra]));
    await f.intake.completeUpload(u.upload_id, { parts: [{ part_number: 1, etag }] }, randomUUID());
    const lease = await f.queue.claim(['verify_upload'], 60, f.account.accountId);
    await f.worker.verifyUpload(lease!);
    expect((await f.intake.getUpload(u.upload_id)).state).toBe('rejected');
    // The multipart was aborted: its stored bytes are gone, and nothing was sealed.
    expect(await f.storage.listParts(rows[0]!.staging_key, rows[0]!.provider_multipart_id)).toEqual([]);
    await expect(
      f.storage.writePart(rows[0]!.provider_multipart_id, 1, Readable.from([photo])),
    ).rejects.toThrow('closed');
  });
  it('rejects actual dimensions and overlong video at the verifier boundary', async () => {
    const metadata = (
      kind: 'photo' | 'video',
      width: number,
      durationMs?: number,
    ): MediaVerifier => ({
      async verify(input) {
        for await (const _ of input.body) {
          /* Fully consume for independent digest verification. */
        }
        return {
          contentType: kind === 'photo' ? 'image/png' : 'video/mp4',
          width,
          height: 10,
          durationMs,
          audioPresent: false,
        };
      },
    });
    for (const kind of ['photo', 'video'] as const) {
      const f = await fixture({
        videoEnabled: true,
        verifier: metadata(kind, kind === 'photo' ? 4000001 : 10, 120001),
      });
      const input =
        kind === 'photo' ? request() : { ...request(), kind: 'video', content_type: 'video/mp4' };
      const { u, parts } = await transferred(f, input);
      await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
      const lease = await f.queue.claim(['verify_upload'], 60, f.account.accountId);
      await f.worker.verifyUpload(lease!);
      expect((await f.intake.getUpload(u.upload_id)).state).toBe('rejected');
    }
  });
  it('refreshes part authorization but refuses expired upload sessions', async () => {
    let now = new Date();
    const f = await fixture({ now: () => now });
    const u = await f.intake.createUpload(request(), randomUUID());
    const refreshed = await f.intake.parts(u.upload_id, { part_numbers: [1] }, randomUUID());
    expect(Date.parse(refreshed.parts[0]!.expires_at) - Date.now()).toBeLessThanOrEqual(900000);
    now = new Date(now.getTime() + 86400001);
    await expect(
      f.intake.parts(u.upload_id, { part_numbers: [1] }, randomUUID()),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.worker.expireUploads(f.account.accountId)).toBe(1);
    expect((await f.intake.getUpload(u.upload_id)).state).toBe('expired');
  });
});

describe('worker leases, explicit analysis and device proof', () => {
  it('reclaims expired leases with a new attempt id and fences the old worker', async () => {
    let now = new Date();
    const f = await fixture({ now: () => now }),
      { u, parts } = await transferred(f);
    await f.intake.completeUpload(u.upload_id, { parts }, randomUUID());
    const old = await f.queue.claim(['verify_upload'], 1, f.account.accountId);
    now = new Date(now.getTime() + 1001);
    const next = await f.queue.claim(['verify_upload'], 60, f.account.accountId);
    expect(next!.attempt_id).not.toBe(old!.attempt_id);
    expect(await f.queue.heartbeat(old!)).toBe(false);
    await expect(f.queue.complete(old!)).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.queue.heartbeat(next!)).toBe(true);
  });
  it('publishes prepared derivatives with generation/lease fencing and leaves automatic analysis off', async () => {
    const f = await fixture(),
      { u } = await committed(f);
    const lease = await f.queue.claim(['prepare_media'], 60, f.account.accountId);
    await f.worker.prepareMedia(lease!, {
      async prepare(input) {
        await input.assertLive();
        const objectKey = input.derivativeKey('normalized');
        await input.storage.put(objectKey, Readable.from([photo]), 'image/png', photo.length);
        return {
          derivatives: [
            {
              kind: 'normalized',
              objectKey,
              checksum: digest(photo),
              byteSize: photo.length,
              width: 8,
              height: 8,
              processingVersion: 'test-v1',
            },
          ],
        };
      },
    });
    expect((await f.intake.detail(u.asset_id)).media).toMatchObject({
      status: 'ready',
      analysis_status: 'not_requested',
    });
    const analysis = new MediaAnalysis(f.ctx),
      first = await analysis.request(
        u.asset_id,
        { mode: 'photo', expected_generation: 1 },
        randomUUID(),
      );
    expect(
      (await analysis.request(u.asset_id, { mode: 'photo', expected_generation: 1 }, randomUUID()))
        .job_id,
    ).toBe(first.job_id);
    const count = await db.query(
      `SELECT count FROM usage_counters WHERE bucket=$1 AND metric='media_analyses'`,
      [`account:${f.account.accountId}`],
    );
    expect(count.rows[0]!.count).toBe(1);
    const job = await f.queue.claim(['analyze_media'], 60, f.account.accountId);
    expect(await analysis.loadWork(job!)).toMatchObject({
      accountId: f.account.accountId,
      jobId: first.job_id,
      assetId: u.asset_id,
      kind: 'photo',
    });
    await analysis.publish(job!, { state: 'failed', errorCode: 'provider_unavailable' });
    expect((await f.intake.detail(u.asset_id)).media).toMatchObject({
      status: 'ready',
      analysis_status: 'failed',
    });
  });
  it('the owner cancels waiting or running exploration; a cancelled run cannot publish', async () => {
    const f = await fixture(),
      { u } = await committed(f);
    const prep = await f.queue.claim(['prepare_media'], 60, f.account.accountId);
    await f.worker.prepareMedia(prep!, {
      async prepare(input) {
        const objectKey = input.derivativeKey('normalized');
        await input.storage.put(objectKey, Readable.from([photo]), 'image/png', photo.length);
        return {
          derivatives: [
            { kind: 'normalized', objectKey, checksum: digest(photo), byteSize: photo.length, width: 8, height: 8, processingVersion: 'test-v1' },
          ],
        };
      },
    });
    const analysis = new MediaAnalysis(f.ctx);
    // Waiting (queued): cancel ends it and the media is no longer "queued".
    const first = await analysis.request(u.asset_id, { mode: 'photo', expected_generation: 1 }, randomUUID());
    const cancelled = await analysis.cancel(u.asset_id, first.analysis_id as string, randomUUID());
    expect(cancelled).toMatchObject({ analysis_id: first.analysis_id, state: 'cancelled', waiting_reason: null });
    expect((await f.intake.detail(u.asset_id)).media.analysis_status).toBe('not_requested');
    expect(await f.queue.claim(['analyze_media'], 60, f.account.accountId)).toBeNull();
    // Exploring again starts a new request instead of reusing the cancelled one.
    const second = await analysis.request(u.asset_id, { mode: 'photo', expected_generation: 1 }, randomUUID());
    expect(second.analysis_id).not.toBe(first.analysis_id);
    // Running: the worker holds a lease; after cancel its publication is fenced.
    const lease = await f.queue.claim(['analyze_media'], 60, f.account.accountId);
    expect(lease).not.toBeNull();
    await analysis.cancel(u.asset_id, second.analysis_id as string, randomUUID());
    await expect(analysis.publish(lease!, { state: 'failed', errorCode: 'provider_unavailable' })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await analysis.get(u.asset_id, second.analysis_id as string)).state).toBe('cancelled');
    // A finished request is returned unchanged; another account cannot reach it.
    expect((await analysis.cancel(u.asset_id, second.analysis_id as string, randomUUID())).state).toBe('cancelled');
    const other = await fixture();
    await expect(
      new MediaAnalysis(other.ctx).cancel(u.asset_id, second.analysis_id as string, randomUUID()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('verifies enrolled P-256 proof, rejects replay/wrong key, and exposes safe setup only', async () => {
    const f = await fixture(),
      device = new CaptureDevice(f.ctx),
      pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = pair.publicKey.export({ format: 'jwk' }),
      publicId = randomUUID();
    const challenge = await device.challenge({
      installation_public_id: publicId,
      platform: 'ios',
      public_key: publicKey,
    });
    const signature = sign(
      'sha256',
      Buffer.from(enrollmentSignaturePayload(challenge.nonce, publicId, 'ios')),
      { key: pair.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');
    const input = {
      installation_public_id: publicId,
      platform: 'ios',
      app_version: '1',
      proof: { nonce: challenge.nonce, signature, public_key: publicKey },
    };
    const enrolled = await device.enroll(input);
    expect(enrolled.native_session).toHaveProperty('access_token');
    await expect(device.enroll(input)).rejects.toMatchObject({ code: 'unauthenticated' });
    const safe = await device.safeSetup();
    expect(Object.keys(safe[0]!).sort()).toEqual([
      'alias',
      'app_version',
      'capabilities',
      'last_seen_at',
      'stale',
      'unavailable_reasons',
    ]);
    const other = await fixture();
    expect((await new CaptureDevice(other.ctx).list()).items).toEqual([]);
    await expect(
      new CaptureDevice(other.ctx).revoke(
        enrolled.installation.id as string,
        { expected_revision: 1 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('server glass gates are an intersection and never enable audio or automatic analysis', () => {
    const policy = {
      mediaCreationEnabled: true,
      cameraVideoEnabled: true,
      videoDecoderQualified: true,
      glasses: {
        buildSupported: true,
        channelEligible: true,
        rolloutEligible: true,
        deviceCompatible: true,
        permissionGranted: true,
        locallyReady: true,
        killed: false,
      },
      analysisReady: true,
      agentApiEnabled: true,
      sharingEnabled: true,
    };
    const limits = createCaptureV2Context({
      authority: { kind: 'account', accountId: randomUUID(), sessionId: null },
      db,
      storage: new LocalMultipartStorage(root, 'http://localhost', 'test'),
    }).limits;
    expect(evaluateCaptureCapabilities(policy, limits).flags.meta_glasses_capture_enabled).toBe(
      true,
    );
    expect(
      evaluateCaptureCapabilities(
        { ...policy, glasses: { ...policy.glasses, channelEligible: false } },
        limits,
      ).flags,
    ).toMatchObject({
      meta_glasses_capture_enabled: false,
      automatic_analysis: false,
      meta_glasses_audio_enabled: false,
    });
  });
  it('video qualification depends on a fresh server worker heartbeat, not a web decoder object', async () => {
    const at = new Date('2030-01-01T00:00:00Z');
    await heartbeatMediaWorker(
      db,
      {
        workerId: randomUUID(),
        qualifiedMatrixVersion: 'fixture-matrix-v1',
        codecs: { mp4_h264: true },
      },
      at,
    );
    expect(await hasQualifiedVideoWorker(db, at)).toBe(true);
    expect(await hasQualifiedVideoWorker(db, new Date(at.getTime() + 120001))).toBe(false);
    expect(await hasQualifiedVideoWorker(db, at, false)).toBe(false);
  });
  it('same-account same-key reauthentication resumes preserved parts without redeclaration', async () => {
    const f = await fixture(),
      pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
      publicId = randomUUID();
    const enroll = async (key = pair) => {
      const publicKey = key.publicKey.export({ format: 'jwk' }),
        devices = new CaptureDevice(f.ctx);
      const challenge = await devices.challenge({
        installation_public_id: publicId,
        platform: 'ios',
        public_key: publicKey,
      });
      const signature = sign(
        'sha256',
        Buffer.from(enrollmentSignaturePayload(challenge.nonce, publicId, 'ios')),
        { key: key.privateKey, dsaEncoding: 'ieee-p1363' },
      ).toString('base64url');
      return devices.enroll({
        installation_public_id: publicId,
        platform: 'ios',
        app_version: '1',
        proof: { nonce: challenge.nonce, signature, public_key: publicKey },
      });
    };
    const initial = await enroll(),
      installationId = initial.installation.id as string;
    const ctx = {
      ...f.ctx,
      authority: {
        kind: 'installation' as const,
        accountId: f.account.accountId,
        installationId,
        sessionId: initial.native_session.session_id as string,
        expiresAt: new Date(Date.now() + 600000),
      },
    };
    const native = { ...f, ctx, intake: new MediaIntake(ctx) },
      uploaded = await transferred(native);
    await native.intake.completeUpload(
      uploaded.u.upload_id,
      { parts: uploaded.parts },
      randomUUID(),
    );
    await db.transaction((tx) =>
      endCaptureAuthority(tx, {
        accountId: f.account.accountId,
        installationId,
        sessionId: ctx.authority.sessionId,
        reason: 'account_switch',
        now: new Date(),
      }),
    );
    const paused = await f.intake.getUpload(uploaded.u.upload_id);
    expect(paused).toMatchObject({
      state: 'paused',
      pause_reason: 'authority_ended',
      parts: [],
      verified_parts: uploaded.parts,
    });
    await expect(
      native.intake.parts(uploaded.u.upload_id, { part_numbers: [1] }, randomUUID()),
    ).rejects.toMatchObject({ code: 'token_revoked' });
    await expect(
      enroll(generateKeyPairSync('ec', { namedCurve: 'prime256v1' })),
    ).rejects.toMatchObject({ code: 'conflict' });
    const next = await enroll();
    expect(next.installation.id).toBe(installationId);
    const renewed = {
      ...ctx,
      authority: { ...ctx.authority, sessionId: next.native_session.session_id as string },
    };
    const intake = new MediaIntake(renewed);
    expect((await intake.getUpload(uploaded.u.upload_id)).state).toBe('uploading');
    await intake.completeUpload(uploaded.u.upload_id, { parts: uploaded.parts }, randomUUID());
    const lease = await f.queue.claim(['verify_upload'], 60, f.account.accountId);
    expect(lease!.generation).toBe(2);
    await new MediaPreparation(renewed).verifyUpload(lease!);
    expect((await intake.getUpload(uploaded.u.upload_id)).state).toBe('committed');
    await new CaptureDevice(f.ctx).revoke(
      installationId,
      { expected_revision: next.installation.revision },
      randomUUID(),
    );
    await expect(enroll()).rejects.toMatchObject({ code: 'token_revoked' });
  });
  it('agent work rechecks persisted authorization before byte verification; the default live check denies unregistered drafts', async () => {
    const f = await fixture(),
      agent = await insertAgentConnection(f.account),
      authorizationVersion = 1;
    const authorizer = {
      async authorize() {
        return { authorizationVersion };
      },
    };
    const ctx = {
      ...f.ctx,
      agent: { connectionId: agent.principal.connectionId, authorizationVersion },
      agentAuthorization: authorizer,
    };
    const draft = { ...f, ctx, intake: new MediaIntake(ctx) },
      uploaded = await transferred(draft);
    await draft.intake.completeUpload(
      uploaded.u.upload_id,
      { parts: uploaded.parts },
      randomUUID(),
    );
    const lease = await f.queue.claim(['verify_upload'], 60, f.account.accountId),
      read = vi.spyOn(f.storage, 'read');
    // No injected adapter: the production live grant check runs (G5). This draft
    // was never registered as an upload of that connection, so it is denied.
    await expect(f.worker.verifyUpload(lease!)).rejects.toMatchObject({ code: 'not_found' });
    expect(read).not.toHaveBeenCalled();
    const persisted = await db.query(
      `SELECT created_by_agent_connection_id,authorization_version FROM capture_work WHERE id=$1`,
      [lease!.job_id],
    );
    expect(persisted.rows[0]).toMatchObject({
      created_by_agent_connection_id: agent.principal.connectionId,
      authorization_version: 1,
    });
    const revoked = {
      ...ctx,
      agentAuthorization: {
        async authorize(): Promise<{ authorizationVersion: number }> {
          throw new AppError('scope_denied');
        },
      },
    };
    await expect(new MediaPreparation(revoked).verifyUpload(lease!)).rejects.toMatchObject({
      code: 'scope_denied',
    });
  });
});
