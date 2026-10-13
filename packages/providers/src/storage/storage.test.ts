import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';
import { loadProviderConfig } from '../config';
import { createObjectStorage } from './index';
import { serveSignedMedia } from './media';
import { LocalFsStorage } from './local';
import { S3Storage } from './s3';
import { isSafeObjectKey, verifySignedMedia } from './signing';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function localStorage(secret = 'test-secret') {
  const dir = await mkdtemp(path.join(tmpdir(), 'ca-storage-'));
  dirs.push(dir);
  return new LocalFsStorage(dir, { baseUrl: 'http://app.test', secret, ttlSeconds: 300 });
}

describe('object keys', () => {
  it('rejects traversal and absolute keys', () => {
    expect(isSafeObjectKey('captures/a/b/derivative.jpg')).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a\\b', 'a/./b', 'a\0b']) expect(isSafeObjectKey(bad)).toBe(false);
  });
});

describe('LocalFsStorage', () => {
  it('stores privately, reads back with content type, deletes idempotently and by prefix', async () => {
    const s = await localStorage();
    await s.put('captures/o1/c1/derivative.jpg', new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' });
    await s.put('captures/o1/c1/original', new Uint8Array([4]), { contentType: 'image/png' });
    await s.put('captures/o1/c2/derivative.jpg', new Uint8Array([5]), { contentType: 'image/jpeg' });
    expect(await s.get('captures/o1/c1/derivative.jpg')).toEqual({ body: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' });
    expect(await s.deletePrefix('captures/o1/c1')).toBe(2);
    expect(await s.get('captures/o1/c1/derivative.jpg')).toBeNull();
    expect(await s.get('captures/o1/c2/derivative.jpg')).not.toBeNull();
    await s.delete('captures/o1/c2/derivative.jpg');
    await s.delete('captures/o1/c2/derivative.jpg');
    expect(await s.deletePrefix('captures/none')).toBe(0);
    await expect(s.put('../escape', new Uint8Array([1]), { contentType: 'x' })).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('issues short-lived HMAC links that verify until expiry and reject tampering', async () => {
    const s = await localStorage();
    const url = new URL(await s.signedUrl('captures/o/c/derivative.jpg', { expiresInSeconds: 60 }));
    expect(url.origin + url.pathname).toBe('http://app.test/v1/media');
    const params = url.searchParams;
    expect(s.verifySignedRequest(params)).toEqual({ ok: true, key: 'captures/o/c/derivative.jpg' });
    expect(s.verifySignedRequest(params, Date.now() + 61_000)).toEqual({ ok: false, reason: 'expired' });
    const tampered = new URLSearchParams(params);
    tampered.set('key', 'captures/other/c/derivative.jpg');
    expect(s.verifySignedRequest(tampered)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySignedMedia('different-secret', params)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(s.verifySignedRequest(new URLSearchParams())).toEqual({ ok: false, reason: 'missing' });
  });

  it('serves signed media privately and returns a uniform 404 otherwise', async () => {
    const s = await localStorage();
    await s.put('captures/o/c/derivative.jpg', new Uint8Array([7, 7]), { contentType: 'image/jpeg' });
    const url = new URL(await s.signedUrl('captures/o/c/derivative.jpg'));
    const ok = await serveSignedMedia(s, url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect(ok.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([7, 7]));
    expect((await serveSignedMedia(s, url, Date.now() + 3_600_000)).status).toBe(404); // expired
    const tampered = new URL(url);
    tampered.searchParams.set('sig', 'x');
    expect((await serveSignedMedia(s, tampered)).status).toBe(404);
    await s.delete('captures/o/c/derivative.jpg');
    expect((await serveSignedMedia(s, url)).status).toBe(404); // deletion revokes access immediately
  });

  it('factory: local without a signing secret is degraded (process-local links)', () => {
    const s = createObjectStorage(loadProviderConfig({ STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: path.join(tmpdir(), 'ca-unused') }));
    expect(s.driver).toBe('local');
    expect(s.capability().signedUrls).toMatchObject({ status: 'degraded', reason: 'not_configured' });
    expect(createObjectStorage(loadProviderConfig({ STORAGE_DRIVER: 's3' })).capability().objects).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
  });
});

describe('S3Storage', () => {
  function fakeS3() {
    const store = new Map<string, { body: Uint8Array; type?: string }>();
    const sent: string[] = [];
    const client = {
      async send(cmd: unknown): Promise<unknown> {
        sent.push((cmd as object).constructor.name);
        if (cmd instanceof PutObjectCommand) {
          store.set(cmd.input.Key!, { body: cmd.input.Body as Uint8Array, type: cmd.input.ContentType });
          return {};
        }
        if (cmd instanceof GetObjectCommand) {
          const o = store.get(cmd.input.Key!);
          if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
          return { Body: { transformToByteArray: async () => o.body }, ContentType: o.type };
        }
        if (cmd instanceof ListObjectsV2Command) {
          const keys = [...store.keys()].filter((k) => k.startsWith(cmd.input.Prefix!));
          return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
        }
        if (cmd instanceof DeleteObjectsCommand) {
          for (const o of cmd.input.Delete!.Objects!) store.delete(o.Key!);
          return {};
        }
        store.delete((cmd as { input: { Key: string } }).input.Key);
        return {};
      },
    };
    return { client, store, sent };
  }

  it('puts/gets/deletes through the client and lists+batch-deletes prefixes', async () => {
    const { client, store } = fakeS3();
    const s = new S3Storage({ bucket: 'b', region: 'us-east-1', ttlSeconds: 300, client, presign: async (k, e) => `https://s3.test/${k}?X-Amz-Expires=${e}` });
    await s.put('captures/o/c/derivative.jpg', new Uint8Array([9]), { contentType: 'image/jpeg' });
    expect(await s.get('captures/o/c/derivative.jpg')).toEqual({ body: new Uint8Array([9]), contentType: 'image/jpeg' });
    expect(await s.get('captures/o/missing')).toBeNull();
    expect(await s.deletePrefix('captures/o/c')).toBe(1);
    expect(store.size).toBe(0);
    expect(await s.signedUrl('captures/o/c/derivative.jpg', { expiresInSeconds: 99_999 })).toContain('X-Amz-Expires=3600');
  });

  it('presigns real SigV4 GET URLs offline with the configured TTL', async () => {
    const s = new S3Storage({ bucket: 'private-bucket', region: 'us-east-1', endpoint: 'https://s3.example.test', forcePathStyle: true, credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' }, ttlSeconds: 300 });
    const url = new URL(await s.signedUrl('captures/o/c/derivative.jpg'));
    expect(url.pathname).toBe('/private-bucket/captures/o/c/derivative.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });
});
