import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { corsRule, initBucket, isSafeKey, mirrorBucket, objectStoreSettings, type S3Like } from './object-store-lib';

/** In-memory S3 stand-in that answers the commands object-store-lib sends. */
function fakeS3(initial: Record<string, string> = {}, bucketExists = true) {
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const sent: string[] = [];
  let exists = bucketExists;
  let cors: unknown;
  const client: S3Like = {
    async send(command: unknown) {
      const name = (command as object).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      sent.push(name);
      switch (name) {
        case 'HeadBucketCommand':
          if (!exists) throw Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } });
          return {};
        case 'CreateBucketCommand':
          exists = true;
          return {};
        case 'PutBucketCorsCommand':
          cors = input.CORSConfiguration;
          return {};
        case 'PutObjectCommand':
          objects.set(input.Key as string, Buffer.from(input.Body as string));
          return {};
        case 'GetObjectCommand': {
          const data = objects.get(input.Key as string)!;
          return {
            Body: {
              transformToString: async () => data.toString(),
              transformToByteArray: async () => new Uint8Array(data),
            },
          };
        }
        case 'DeleteObjectCommand':
          objects.delete(input.Key as string);
          return {};
        case 'ListObjectsV2Command': {
          // Two pages to exercise continuation.
          const keys = [...objects.keys()].sort();
          const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
          const page = keys.slice(start, start + 2);
          const next = start + 2 < keys.length ? String(start + 2) : undefined;
          return { Contents: page.map((Key) => ({ Key })), IsTruncated: !!next, NextContinuationToken: next };
        }
        default:
          throw new Error(`unexpected ${name}`);
      }
    },
  };
  return { client, objects, sent, cors: () => cors };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ca-object-store-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('on-prem object store (Garage / S3 API)', () => {
  it('reads settings by name and reports missing names only', () => {
    expect(() => objectStoreSettings({ S3_BUCKET: 'b' })).toThrow(/S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
    const s = objectStoreSettings({
      S3_ENDPOINT: 'https://media.example.org',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      S3_FORCE_PATH_STYLE: 'true',
    });
    expect(s).toMatchObject({ region: 'us-east-1', forcePathStyle: true });
  });

  it('allows browser part uploads from the app origin only and exposes ETag', () => {
    expect(corsRule('https://app.example.org/')).toEqual({
      AllowedOrigins: ['https://app.example.org'],
      AllowedMethods: ['GET', 'HEAD', 'PUT'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600,
    });
  });

  it('init applies CORS and proves write/read/delete, leaving nothing behind', async () => {
    const s3 = fakeS3();
    const result = await initBucket(s3.client, { bucket: 'b', appOrigin: 'https://app.example.org', create: false });
    expect(result).toEqual({ created: false, cors: true, roundTrip: true });
    expect(s3.objects.size).toBe(0);
    expect(JSON.stringify(s3.cors())).toContain('https://app.example.org');
  });

  it('init refuses a missing bucket unless --create', async () => {
    await expect(
      initBucket(fakeS3({}, false).client, { bucket: 'b', appOrigin: 'https://app.example.org', create: false }),
    ).rejects.toThrow(/does not exist/);
    const s3 = fakeS3({}, false);
    const result = await initBucket(s3.client, { bucket: 'b', appOrigin: 'https://app.example.org', create: true });
    expect(result.created).toBe(true);
    expect(s3.sent).toContain('CreateBucketCommand');
  });

  it('mirrors every object into the restore-drill layout and skips unsafe keys', async () => {
    const s3 = fakeS3({
      'media/a/original': 'one',
      'media/a/derived/thumb.jpg': 'two',
      'captures/x.jpg': 'three',
      '../escape': 'never',
    });
    const destination = join(dir, 'backup-1', 'objects');
    const result = await mirrorBucket(s3.client, { bucket: 'b', destination });
    expect(result).toMatchObject({ objects: 3, bytes: 11, skipped: 1 });
    expect(await readFile(join(destination, 'media/a/derived/thumb.jpg'), 'utf8')).toBe('two');
    expect((await stat(join(destination, 'captures/x.jpg'))).mode & 0o777).toBe(0o600);
    const sums = await readFile(result.manifest, 'utf8');
    expect(sums.trim().split('\n')).toHaveLength(3);
    await expect(stat(join(dir, 'backup-1', 'escape'))).rejects.toThrow();
  });

  it('accepts only relative keys without dot segments', () => {
    expect(isSafeKey('a/b.jpg')).toBe(true);
    for (const bad of ['', '/a', 'a/../b', 'a//b', './a', 'a\\b', 'a\nb']) expect(isSafeKey(bad)).toBe(false);
  });
});
