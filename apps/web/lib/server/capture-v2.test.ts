import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  auth,
  setDbForTesting,
  setDomainConfigForTesting,
  createCaptureV2Context,
  MediaPreparation,
  CaptureQueue,
} from '@culture-atlas/domain';
import {
  getTestDb,
  closeTestDb,
  insertAccount,
  insertAgentConnection,
  testConfig,
} from '@culture-atlas/domain/testing';
import { LocalMultipartStorage } from '@culture-atlas/providers';
import type { CaptureIdentityAdapter } from '@culture-atlas/domain';

vi.mock('server-only', () => ({}));
const { captureV2Route, setCaptureV2Runtime } = await import('./capture-v2');
const db = getTestDb(),
  config = testConfig();
let root: string, storage: LocalMultipartStorage, photo: Buffer;
const identity: CaptureIdentityAdapter = {
  requireRecoverableAccount: async () => {},
  peekNativeEnrollmentGrant: async () => {
    throw new Error('Not used');
  },
  consumeNativeEnrollmentGrant: async () => {
    throw new Error('Not used');
  },
  issueNativeSession: async () => {
    throw new Error('Not used');
  },
  revokeInstallationSessions: async () => {},
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-v2-http-'));
  storage = new LocalMultipartStorage(root, 'http://localhost:3301', 'private-test-key');
  photo = await readFile(
    new URL('../../../../fixtures/sensor/photos/glasses-photo-1.jpg', import.meta.url),
  );
  setDbForTesting(db);
  setDomainConfigForTesting(config);
  setCaptureV2Runtime({ storage, identity });
});
afterAll(async () => {
  setCaptureV2Runtime({});
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});
async function browser() {
  const principal = await insertAccount(),
    token = randomUUID();
  await db.query(`UPDATE sessions SET token_hash=$2 WHERE id=$1`, [
    principal.sessionId,
    auth.hashToken(token),
  ]);
  return { principal, token, csrf: auth.csrfTokenFor(principal.sessionId!, config.SESSION_SECRET) };
}
type Browser = Awaited<ReturnType<typeof browser>>;
function request(
  path: string,
  owner: Browser,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new NextRequest(`http://localhost:3301${path}`, {
    method,
    headers: {
      cookie: `ca_session=${owner.token}`,
      'x-csrf-token': owner.csrf,
      'x-atlas-expected-account': owner.principal.accountId,
      'idempotency-key': randomUUID(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const uploadInput = () => ({
  client_capture_id: randomUUID(),
  kind: 'photo',
  source: 'upload',
  filename: 'image.jpg',
  content_type: 'image/jpeg',
  byte_size: photo.length,
  sha256: createHash('sha256').update(photo).digest('hex'),
});

describe('v2 REST boundary', () => {
  it('TEN-02 rejects switched cookie and missing account assertion before CSRF, idempotency, quota or storage effects', async () => {
    const a = await browser(),
      b = await browser(),
      begin = vi.spyOn(storage, 'begin');
    const result = await captureV2Route(
      request('/v2/uploads', b, 'POST', uploadInput(), {
        'x-atlas-expected-account': a.principal.accountId,
        'x-csrf-token': 'stale-csrf',
      }),
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: { code: 'account_mismatch' } });
    const missing = request('/v2/uploads', a, 'POST', uploadInput());
    missing.headers.delete('x-atlas-expected-account');
    expect((await captureV2Route(missing)).status).toBe(409);
    expect(begin).not.toHaveBeenCalled();
    begin.mockRestore();
    const counts = await db.query(
      `SELECT count(*) AS n FROM usage_reservations WHERE account_id=ANY($1::uuid[])`,
      [[a.principal.accountId, b.principal.accountId]],
    );
    expect(counts.rows[0]!.n).toBe(0);
  });
  it('retains CSRF and denies anonymous/legacy-agent v2 authority without broadening old tokens', async () => {
    const owner = await browser();
    expect(
      (
        await captureV2Route(
          request('/v2/uploads', owner, 'POST', uploadInput(), { 'x-csrf-token': 'wrong' }),
        )
      ).status,
    ).toBe(403);
    expect((await captureV2Route(new NextRequest('http://localhost:3301/v2/library'))).status).toBe(
      401,
    );
    // A legacy (v1-scoped) token: agent REST media now exists (G7), but old
    // credentials never gain the new v2 media scopes.
    const agent = await insertAgentConnection(owner.principal, {
      scopes: ['captures:read', 'collections:read', 'taste:read', 'plans:read'],
    });
    const result = await captureV2Route(
      new NextRequest('http://localhost:3301/v2/library', {
        headers: { authorization: `Bearer ${agent.credential}` },
      }),
    );
    expect(result.status).toBe(403);
    expect((await result.json()).error.code).toBe('scope_denied');
  });
  it('share tokens and viewer cookies never become account authority, including when an owner cookie exists', async () => {
    const owner = await browser(),
      viewer = request('/v2/library', owner, 'GET', undefined, {
        cookie: `ca_session=${owner.token}; ca_share_session=viewer-fixture`,
      });
    expect((await captureV2Route(viewer)).status).toBe(403);
    const bearer = await captureV2Route(
      new NextRequest('http://localhost:3301/v2/library', {
        headers: { authorization: 'Bearer share-fixture-token' },
      }),
    );
    expect(bearer.status).toBe(401);
  });
  it('multipart upload → durable verification → authorized range playback, and immediate deletion fencing', async () => {
    const owner = await browser(),
      other = await browser();
    const created = await captureV2Route(request('/v2/uploads', owner, 'POST', uploadInput()));
    expect(created.status).toBe(201);
    const upload = await created.json();
    const part = await captureV2Route(
      new NextRequest(upload.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(photo),
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    expect(part.status).toBe(200);
    const completion = await captureV2Route(
      request(`/v2/uploads/${upload.upload_id}/complete`, owner, 'POST', {
        parts: [{ part_number: 1, etag: part.headers.get('etag') }],
      }),
    );
    expect(completion.status).toBe(202);
    const ctx = createCaptureV2Context({ db, authority: owner.principal, storage, identity });
    const queue = new CaptureQueue(db),
      worker = new MediaPreparation(ctx);
    const verify = await queue.claim(['verify_upload'], 60, owner.principal.accountId);
    await worker.verifyUpload(verify!);
    const prepare = await queue.claim(['prepare_media'], 60, owner.principal.accountId);
    await worker.prepareMedia(prepare!, {
      async prepare(input) {
        const key = input.derivativeKey('normalized');
        await input.storage.put(key, Readable.from([photo]), 'image/jpeg', photo.length);
        return {
          derivatives: [
            {
              kind: 'normalized',
              objectKey: key,
              checksum: createHash('sha256').update(photo).digest('hex'),
              byteSize: photo.length,
              width: 2,
              height: 2,
              processingVersion: 'test-v1',
            },
          ],
        };
      },
    });
    const detail = await captureV2Route(request(`/v2/media/${upload.asset_id}`, owner)),
      media = await detail.json();
    expect(media.media.status).toBe('ready');
    const range = await captureV2Route(
      request(media.links.playback, owner, 'GET', undefined, { range: 'bytes=0-7' }),
    );
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 0-7/${photo.length}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(photo.subarray(0, 8));
    expect((await captureV2Route(request(media.links.playback, other))).status).toBe(404);
    expect(
      (
        await captureV2Route(
          request(`/v2/media/${upload.asset_id}`, owner, 'DELETE', { expected_generation: 1 }),
        )
      ).status,
    ).toBe(202);
    expect((await captureV2Route(request(media.links.playback, owner))).status).toBe(404);
    expect((await captureV2Route(request(`/v2/media/${upload.asset_id}`, owner))).status).toBe(404);
  });
  it('returns safe capabilities without provider probes or client-controlled experimental activation', async () => {
    const owner = await browser(),
      response = await captureV2Route(
        request('/v2/capabilities?meta_glasses_capture_enabled=true', owner),
      );
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.flags).toMatchObject({
      media_library: true,
      automatic_analysis: false,
      meta_glasses_capture_enabled: false,
      file_video_upload: false,
    });
  });
});
