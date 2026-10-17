import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  AppError,
  agentEvents,
  auth,
  setDbForTesting,
  setDomainConfigForTesting,
  createCaptureV2Context,
  createServiceContext,
  MediaPreparation,
  CaptureQueue,
  type CaptureIdentityAdapter,
} from '@culture-atlas/domain';
import { getTestDb, closeTestDb, insertAccount, testConfig } from '@culture-atlas/domain/testing';
import { LocalMultipartStorage } from '@culture-atlas/providers';

vi.mock('server-only', () => ({}));
const { captureV2Route, setCaptureV2Runtime, configureCaptureV2Runtime } =
  await import('./capture-v2');
const { eventStream } = await import('./events');
const db = getTestDb(),
  config = testConfig();
let root: string, storage: LocalMultipartStorage, photo: Buffer;
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
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-v2-media-routes-'));
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
/** Uploads the fixture photo through the HTTP routes and runs verification only. */
async function verifiedPhoto(owner: Browser) {
  const created = await captureV2Route(
    request('/v2/uploads', owner, 'POST', {
      client_capture_id: randomUUID(),
      kind: 'photo',
      source: 'upload',
      filename: 'image.jpg',
      content_type: 'image/jpeg',
      byte_size: photo.length,
      sha256: createHash('sha256').update(photo).digest('hex'),
    }),
  );
  const upload = await created.json();
  const part = await captureV2Route(
    new NextRequest(upload.parts[0].url, { method: 'PUT', body: new Uint8Array(photo) }),
  );
  await captureV2Route(
    request(`/v2/uploads/${upload.upload_id}/complete`, owner, 'POST', {
      parts: [{ part_number: 1, etag: part.headers.get('etag') }],
    }),
  );
  const ctx = createCaptureV2Context({ db, authority: owner.principal, storage, identity });
  const lease = await new CaptureQueue(db).claim(['verify_upload'], 60, owner.principal.accountId);
  await new MediaPreparation(ctx).verifyUpload(lease!);
  return { upload, ctx };
}
async function readStream(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}

describe('authorized byte-range media gateway', () => {
  it('serves bounded ranges with correct Content-Range and rejects unsatisfiable ranges', async () => {
    const owner = await browser();
    const { upload } = await verifiedPhoto(owner);
    const link = `/v2/media/${upload.asset_id}/content/original`;
    const total = photo.length;
    const head = await captureV2Route(
      request(link, owner, 'GET', undefined, { range: 'bytes=0-99' }),
    );
    expect(head.status).toBe(206);
    expect(head.headers.get('content-range')).toBe(`bytes 0-99/${total}`);
    expect(head.headers.get('content-length')).toBe('100');
    expect(head.headers.get('content-disposition')).toBe('attachment');
    expect(Buffer.from(await head.arrayBuffer())).toEqual(photo.subarray(0, 100));
    const suffix = await captureV2Route(
      request(link, owner, 'GET', undefined, { range: 'bytes=-10' }),
    );
    expect(suffix.headers.get('content-range')).toBe(`bytes ${total - 10}-${total - 1}/${total}`);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(photo.subarray(total - 10));
    const open = await captureV2Route(
      request(link, owner, 'GET', undefined, { range: 'bytes=100-' }),
    );
    expect(Buffer.from(await open.arrayBuffer())).toEqual(photo.subarray(100));
    const full = await captureV2Route(request(link, owner));
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer())).toEqual(photo);
    const beyond = await captureV2Route(
      request(link, owner, 'GET', undefined, { range: `bytes=${total}-` }),
    );
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe(`bytes */${total}`);
    expect(
      (await captureV2Route(request(link, owner, 'GET', undefined, { range: 'items=0-1' }))).status,
    ).toBe(416);
    // Every range request reauthorizes: another account and a deleted asset get 404.
    const other = await browser();
    expect(
      (await captureV2Route(request(link, other, 'GET', undefined, { range: 'bytes=0-1' }))).status,
    ).toBe(404);
    await captureV2Route(
      request(`/v2/media/${upload.asset_id}`, owner, 'DELETE', { expected_generation: 1 }),
    );
    expect(
      (await captureV2Route(request(link, owner, 'GET', undefined, { range: 'bytes=0-1' }))).status,
    ).toBe(404);
  });
});

describe('POST /v2/media/{id}/preparation', () => {
  it('retries only failed preparation of a stored original, with generation checks', async () => {
    const owner = await browser();
    const { upload } = await verifiedPhoto(owner);
    const path = `/v2/media/${upload.asset_id}/preparation`;
    // Still processing: nothing to retry.
    expect(
      (await captureV2Route(request(path, owner, 'POST', { expected_generation: 1 }))).status,
    ).toBe(409);
    const prepare = await new CaptureQueue(db).claim(
      ['prepare_media'],
      60,
      owner.principal.accountId,
    );
    const ctx = createCaptureV2Context({ db, authority: owner.principal, storage, identity });
    await new MediaPreparation(ctx).prepareMedia(prepare!, {
      async prepare() {
        throw new AppError('unsupported_image');
      },
    });
    const failed = await (
      await captureV2Route(request(`/v2/media/${upload.asset_id}`, owner))
    ).json();
    expect(failed).toMatchObject({ media: { status: 'failed' }, error_code: 'unsupported_image' });
    const retried = await captureV2Route(request(path, owner, 'POST', { expected_generation: 1 }));
    expect(retried.status).toBe(202);
    expect((await retried.json()).media.status).toBe('processing');
    const work = await db.query(
      `SELECT state,attempts FROM capture_work WHERE account_id=$1 AND kind='prepare_media'`,
      [owner.principal.accountId],
    );
    expect(work.rows).toEqual([{ state: 'queued', attempts: 0 }]);
    const other = await browser();
    expect(
      (await captureV2Route(request(path, other, 'POST', { expected_generation: 1 }))).status,
    ).toBe(404);
  });
});

describe('GET /v2/events', () => {
  it('streams own media transitions including deletions, and nothing from other accounts', async () => {
    const owner = await browser(),
      other = await browser();
    const { upload } = await verifiedPhoto(owner);
    await verifiedPhoto(other);
    const batchItems = (text: string) =>
      [...text.matchAll(/^data: (.+)$/gm)].flatMap((m) => JSON.parse(m[1]!).items);
    const response = await eventStream(request('/v2/events', owner), {
      pollMs: 20,
      maxStreamMs: 100,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await readStream(response);
    expect(text).toMatch(/^retry: 2000/);
    const items = batchItems(text);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.kind === 'media' && i.id === upload.asset_id)).toBe(true);
    expect(items).toContainEqual({ id: upload.asset_id, kind: 'media', status: 'processing' });
    const cursor = [...text.matchAll(/^id: (.+)$/gm)].at(-1)![1]!;
    await captureV2Route(
      request(`/v2/media/${upload.asset_id}`, owner, 'DELETE', { expected_generation: 1 }),
    );
    // Resuming from the cursor yields only the newer deletion (IDs and status, no content).
    const resumed = await readStream(
      await eventStream(
        request('/v2/events', owner, 'GET', undefined, { 'last-event-id': cursor }),
        {
          pollMs: 20,
          maxStreamMs: 60,
        },
      ),
    );
    expect(batchItems(resumed)).toEqual([
      { id: upload.asset_id, kind: 'media', status: 'deleted' },
    ]);
  });
  it('asks the client to resync when its cursor expired', async () => {
    const owner = await browser();
    const past = createServiceContext(owner.principal, {
      db,
      config,
      now: () => new Date(Date.now() - 2 * 86400000),
    });
    const old = await agentEvents.readEvents(past);
    const text = await readStream(
      await eventStream(request(`/v2/events?after_cursor=${old.next_cursor}`, owner), {
        pollMs: 20,
        maxStreamMs: 60,
      }),
    );
    expect(text).toContain('event: resync');
    expect(text).toContain('cursor_expired');
  });
  it('accepts enrolled installations and stops serving revoked ones', async () => {
    const owner = await browser();
    const installation = await db.query(
      `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version)
       VALUES($1,$2,'ios','1') RETURNING id`,
      [owner.principal.accountId, randomUUID()],
    );
    const installationId = installation.rows[0]!.id;
    configureCaptureV2Runtime({
      resolveNativePrincipal: async (token) => {
        if (token !== 'cna_fixture') throw new Error('unexpected');
        return {
          kind: 'installation',
          accountId: owner.principal.accountId,
          installationId,
          sessionId: randomUUID(),
          expiresAt: new Date(Date.now() + 600000),
        };
      },
    });
    const native = () =>
      new NextRequest('http://localhost:3301/v2/events', {
        headers: { authorization: 'Bearer cna_fixture' },
      });
    const ok = await eventStream(native(), { pollMs: 20, maxStreamMs: 60 });
    expect(ok.status).toBe(200);
    expect(await readStream(ok)).toContain('event: batch');
    await db.query(`UPDATE mobile_installations SET revoked_at=now() WHERE id=$1`, [
      installationId,
    ]);
    const revoked = await eventStream(native(), { pollMs: 20, maxStreamMs: 60 });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ error: { code: 'token_revoked' } });
    // Share viewers and anonymous callers never get an event stream.
    expect(
      (
        await eventStream(
          new NextRequest('http://localhost:3301/v2/events', {
            headers: { cookie: 'ca_share_session=viewer' },
          }),
        )
      ).status,
    ).toBe(403);
    expect((await eventStream(new NextRequest('http://localhost:3301/v2/events'))).status).toBe(
      401,
    );
  });
});
