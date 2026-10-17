import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterAll, describe, it, expect, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { LocalMultipartStorage } from './multipart-local';
import { S3MultipartStorage } from './multipart-s3';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function local() {
  const root = await mkdtemp(join(tmpdir(), 'ca-multipart-'));
  roots.push(root);
  return {
    root,
    storage: new LocalMultipartStorage(root, 'http://localhost:3301', 'test-signing-key'),
  };
}
async function contents(storage: LocalMultipartStorage, key: string): Promise<Buffer> {
  const object = await storage.read(key),
    chunks = [];
  for await (const chunk of object.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}
describe('durable filesystem multipart test double', () => {
  it('resumes after restart, scopes signed parts, seals immutable bytes and cleans namespaced objects', async () => {
    const { root, storage } = await local(),
      key = `accounts/${randomUUID()}/staging/${randomUUID()}`;
    const id = await storage.begin(key, 'video/mp4'),
      signed = await storage.signPart(key, id, 1, 900, 8),
      url = new URL(signed.url);
    expect(url.searchParams.get('size')).toBe('8');
    const etag = await storage.acceptSignedPart(
      id,
      1,
      Number(url.searchParams.get('expires')),
      url.searchParams.get('signature')!,
      Readable.from([Buffer.from('original')]),
      Number(url.searchParams.get('size')),
    );
    const restarted = new LocalMultipartStorage(root, 'http://localhost:3301', 'test-signing-key');
    expect(await restarted.listParts(key, id)).toEqual([{ part_number: 1, etag, size: 8 }]);
    await expect(
      restarted.acceptSignedPart(
        id,
        2,
        Number(url.searchParams.get('expires')),
        url.searchParams.get('signature')!,
        Readable.from([Buffer.from('wrong-par')]),
        8,
      ),
    ).rejects.toThrow('authorization');
    await restarted.finish(key, id, [{ etag, part_number: 1 }]);
    const immutable = `accounts/${randomUUID()}/media/${randomUUID()}/1/original`;
    await restarted.seal(key, immutable);
    await expect(
      restarted.writePart(id, 1, Readable.from([Buffer.from('overwritten')])),
    ).rejects.toThrow('closed');
    expect((await contents(restarted, immutable)).toString()).toBe('original');
    const range = await restarted.getRange(immutable, { start: 1, end: 3 }),
      chunks = [];
    for await (const chunk of range.body) {
      expect(chunk.byteLength).toBeLessThanOrEqual(65536);
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString()).toBe('rig');
    expect(range).toMatchObject({ start: 1, end: 3, byteSize: 3, totalSize: 8 });
    await expect(restarted.getRange(immutable, { start: 0, end: 8388608 })).rejects.toThrow(
      'excessive',
    );
    await restarted.deletePrefix(immutable.slice(0, immutable.lastIndexOf('/')));
    await expect(restarted.read(immutable)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects expired/tampered signatures, path escapes and excessive part size', async () => {
    const { storage } = await local(),
      key = `accounts/${randomUUID()}/staging/${randomUUID()}`;
    await expect(storage.begin('../escape', 'image/png')).rejects.toThrow('Invalid object key');
    const id = await storage.begin(key, 'image/png'),
      signed = await storage.signPart(key, id, 1, 900, 1),
      url = new URL(signed.url);
    await expect(
      storage.acceptSignedPart(
        id,
        1,
        0,
        url.searchParams.get('signature')!,
        Readable.from([Buffer.from('x')]),
        1,
      ),
    ).rejects.toThrow('authorization');
    const expires = Number(url.searchParams.get('expires')),
      signature = url.searchParams.get('signature')!;
    // The signed length binds the body: a 1-byte part URL cannot store more, or less.
    await expect(
      storage.acceptSignedPart(id, 1, expires, signature, Readable.from([Buffer.from('xx')]), 1),
    ).rejects.toThrow('too large');
    await expect(
      storage.acceptSignedPart(id, 1, expires, signature, Readable.from([Buffer.from('xx')]), 2),
    ).rejects.toThrow('authorization');
    await expect(
      storage.acceptSignedPart(id, 1, expires, signature, Readable.from([Buffer.alloc(0)]), 1),
    ).rejects.toThrow('size mismatch');
    await expect(storage.writePart(id, 1, Readable.from([Buffer.alloc(8388609)]))).rejects.toThrow(
      'too large',
    );
    expect(await storage.listParts(key, id)).toEqual([]);
  });
});
describe('private S3 multipart adapter (mock transport, no live service)', () => {
  it('uses scoped multipart commands, streams reads, and recovers a lost completion response', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' },
    });
    const send = vi.spyOn(client, 'send');
    const storage = new S3MultipartStorage({ bucket: 'private-test', region: 'us-east-1', client });
    send.mockResolvedValueOnce({ UploadId: 'multipart-fixture' } as never);
    expect(await storage.begin('accounts/a/staging/upload', 'image/png')).toBe('multipart-fixture');
    const create = send.mock.calls[0]![0];
    expect(create.input).toMatchObject({
      Bucket: 'private-test',
      Key: 'accounts/a/staging/upload',
      Metadata: { 'capture-v2': 'staging' },
    });
    send.mockResolvedValueOnce({
      Parts: [{ PartNumber: 1, ETag: 'etag' }],
      IsTruncated: false,
    } as never);
    expect(await storage.listParts('accounts/a/staging/upload', 'multipart-fixture')).toEqual([
      { part_number: 1, etag: 'etag' },
    ]);
    send.mockRejectedValueOnce(
      Object.assign(new Error('lost completion'), { name: 'NoSuchUpload' }),
    );
    send.mockResolvedValueOnce({ Metadata: { 'capture-v2': 'staging' } } as never);
    await expect(
      storage.finish('accounts/a/staging/upload', 'multipart-fixture', [
        { part_number: 1, etag: 'etag' },
      ]),
    ).resolves.toBeUndefined();
    const stream = Readable.from([Buffer.from('media')]);
    send.mockResolvedValueOnce({
      Body: stream,
      ContentLength: 5,
      ContentType: 'image/png',
    } as never);
    expect((await storage.read('accounts/a/staging/upload')).body).toBe(stream);
    await expect(storage.read('../escape')).rejects.toThrow('Invalid private object key');
    client.destroy();
  });
  it('presigns UploadPart with the exact part length as a signed header and no body checksum', async () => {
    const storage = new S3MultipartStorage({
      bucket: 'private-test',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' },
    });
    const signed = await storage.signPart('accounts/a/staging/upload', 'multipart-fixture', 1, 3600, 1234);
    const url = new URL(signed.url);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('partNumber')).toBe('1');
    expect([...url.searchParams.keys()].some((k) => k.toLowerCase().startsWith('x-amz-checksum'))).toBe(false);
    await expect(storage.signPart('accounts/a/staging/upload', 'm', 1, 60, 0)).rejects.toThrow('Invalid part size');
  });
  it('reports stored part sizes from ListParts', async () => {
    const client = new S3Client({ region: 'us-east-1' }),
      send = vi.spyOn(client, 'send');
    const storage = new S3MultipartStorage({ bucket: 'private-test', region: 'us-east-1', client });
    send.mockResolvedValueOnce({ Parts: [{ PartNumber: 1, ETag: 'e', Size: 5_368_709_120 }], IsTruncated: false } as never);
    expect(await storage.listParts('accounts/a/staging/upload', 'm')).toEqual([
      { part_number: 1, etag: 'e', size: 5_368_709_120 },
    ]);
    client.destroy();
  });
  it('fails cleanup when S3 reports per-object deletion errors', async () => {
    const client = new S3Client({ region: 'us-east-1' }),
      send = vi.spyOn(client, 'send');
    const storage = new S3MultipartStorage({ bucket: 'private-test', region: 'us-east-1', client });
    send.mockResolvedValueOnce({ Contents: [{ Key: 'accounts/a/media/id/original' }] } as never);
    send.mockResolvedValueOnce({
      Errors: [{ Key: 'accounts/a/media/id/original', Code: 'AccessDenied' }],
    } as never);
    await expect(storage.deletePrefix('accounts/a/media/id')).rejects.toThrow('cleanup failed');
    client.destroy();
  });
  it('paginates reconciliation inventories with scoped prefixes', async () => {
    const client = new S3Client({ region: 'us-east-1' }),
      send = vi.spyOn(client, 'send');
    const storage = new S3MultipartStorage({ bucket: 'private-test', region: 'us-east-1', client });
    const at = new Date('2026-10-01T00:00:00Z');
    send.mockResolvedValueOnce({
      Contents: [{ Key: 'accounts/a/media/m/1/original', Size: 5, LastModified: at }],
      IsTruncated: true,
      NextContinuationToken: 'page-2',
    } as never);
    send.mockResolvedValueOnce({
      Contents: [
        { Key: 'accounts/a/staging/m/u', Size: 7, LastModified: at },
        { Key: '../escape' },
      ],
      IsTruncated: false,
    } as never);
    const objects = [];
    for await (const o of storage.list('accounts/a')) objects.push(o);
    expect(objects).toEqual([
      { key: 'accounts/a/media/m/1/original', byteSize: 5, lastModified: at },
      { key: 'accounts/a/staging/m/u', byteSize: 7, lastModified: at },
    ]);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      Bucket: 'private-test',
      Prefix: 'accounts/a/',
    });
    expect(send.mock.calls[1]![0].input).toMatchObject({ ContinuationToken: 'page-2' });
    send.mockResolvedValueOnce({
      Uploads: [{ Key: 'accounts/a/staging/m/u', UploadId: 'mp-1', Initiated: at }],
      IsTruncated: true,
      NextKeyMarker: 'accounts/a/staging/m/u',
      NextUploadIdMarker: 'mp-1',
    } as never);
    send.mockResolvedValueOnce({ Uploads: [], IsTruncated: false } as never);
    const uploads = [];
    for await (const u of storage.listIncompleteUploads('accounts/a')) uploads.push(u);
    expect(uploads).toEqual([{ key: 'accounts/a/staging/m/u', uploadId: 'mp-1', initiatedAt: at }]);
    expect(send.mock.calls[3]![0].input).toMatchObject({
      Prefix: 'accounts/a/',
      KeyMarker: 'accounts/a/staging/m/u',
      UploadIdMarker: 'mp-1',
    });
    client.destroy();
  });
});
