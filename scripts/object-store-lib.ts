/**
 * On-prem object store operations (Garage, or any S3-compatible store) used by
 * scripts/object-store.ts. Kept free of process.env so it can be tested with a
 * fake client. Messages name buckets and counts only, never keys' contents or
 * credentials.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export interface ObjectStoreSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Reads S3_* settings by name; throws listing the missing NAMES only. */
export function objectStoreSettings(env: Record<string, string | undefined>): ObjectStoreSettings {
  const get = (name: string) => env[name]?.trim() || undefined;
  const missing = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((n) => !get(n));
  if (missing.length) throw new Error(`Object store settings missing: ${missing.join(', ')}.`);
  return {
    endpoint: get('S3_ENDPOINT')!,
    region: get('S3_REGION') ?? 'us-east-1',
    bucket: get('S3_BUCKET')!,
    accessKeyId: get('S3_ACCESS_KEY_ID')!,
    secretAccessKey: get('S3_SECRET_ACCESS_KEY')!,
    forcePathStyle: get('S3_FORCE_PATH_STYLE') === 'true',
  };
}

export function createS3Client(settings: ObjectStoreSettings): S3Client {
  return new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    maxAttempts: 2,
  });
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/**
 * CORS rule for browser uploads: the web client PUTs signed parts straight to
 * the media host and reads the ETag header, and reads media with GET.
 */
export function corsRule(appOrigin: string) {
  const origin = new URL(appOrigin).origin;
  return {
    AllowedOrigins: [origin],
    AllowedMethods: ['GET', 'HEAD', 'PUT'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3600,
  };
}

/**
 * Ensures the private bucket exists (optionally creating it), applies the CORS
 * rule for APP_BASE_URL, and proves write/read/delete with a throwaway object.
 */
export async function initBucket(
  client: S3Like,
  options: { bucket: string; appOrigin: string; create: boolean },
): Promise<{ created: boolean; cors: boolean; roundTrip: boolean }> {
  let created = false;
  try {
    await client.send(new HeadBucketCommand({ Bucket: options.bucket }));
  } catch (error) {
    const status = statusOf(error);
    // `cause` keeps the SDK error for debuggers; the CLI prints only `message`.
    if (status === 403)
      throw new Error(`Access to bucket ${options.bucket} denied: grant the app key read/write/owner.`, { cause: error });
    if (status !== 404 && status !== undefined)
      throw new Error(`Bucket ${options.bucket} check failed (HTTP ${status}).`, { cause: error });
    if (!options.create)
      throw new Error(`Bucket ${options.bucket} does not exist (run with --create or create it in Garage).`, {
        cause: error,
      });
    await client.send(new CreateBucketCommand({ Bucket: options.bucket }));
    created = true;
  }
  await client.send(
    new PutBucketCorsCommand({
      Bucket: options.bucket,
      CORSConfiguration: { CORSRules: [corsRule(options.appOrigin)] },
    }),
  );
  const key = `preflight/${randomUUID()}`;
  const body = `culture atlas object store check ${key}`;
  await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: body, ContentType: 'text/plain' }));
  const got = (await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }))) as {
    Body?: { transformToString(): Promise<string> };
  };
  const text = await got.Body?.transformToString();
  await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
  if (text !== body) throw new Error(`Bucket ${options.bucket} returned different bytes than were written.`);
  return { created, cors: true, roundTrip: true };
}

/** Same rule as the providers' isSafeObjectKey: relative, no dot segments, no control characters. */
export function isSafeKey(key: string): boolean {
  if (!key || key.length > 1024 || key.startsWith('/') || key.includes('\\') || key.includes('\0')) return false;
  for (let i = 0; i < key.length; i++) if (key.charCodeAt(i) < 0x20) return false;
  return key.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * Copies every object in the bucket to `<destination>/<key>` (0600 files),
 * the layout `pnpm ops:restore-drill --objects local:<destination>` reads.
 * Unsafe keys are counted and skipped, never written outside the destination.
 */
export async function mirrorBucket(
  client: S3Like,
  options: { bucket: string; destination: string },
): Promise<{ objects: number; bytes: number; skipped: number; manifest: string }> {
  const root = resolve(options.destination);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let token: string | undefined;
  let objects = 0,
    bytes = 0,
    skipped = 0;
  const lines: string[] = [];
  do {
    const page = (await client.send(
      new ListObjectsV2Command({ Bucket: options.bucket, ContinuationToken: token }),
    )) as { Contents?: { Key?: string }[]; IsTruncated?: boolean; NextContinuationToken?: string };
    for (const item of page.Contents ?? []) {
      const key = item.Key;
      if (!key || !isSafeKey(key)) {
        skipped++;
        continue;
      }
      const target = resolve(root, key);
      if (!target.startsWith(root + sep)) {
        skipped++;
        continue;
      }
      const got = (await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }))) as {
        Body?: { transformToByteArray(): Promise<Uint8Array> };
      };
      const data = await got.Body?.transformToByteArray();
      if (!data) throw new Error(`Object store returned no body for an object in ${options.bucket}.`);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { mode: 0o600 });
      lines.push(`${createHash('sha256').update(data).digest('hex')}  ${key}`);
      objects++;
      bytes += data.byteLength;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const manifest = join(root, '..', 'objects.sha256');
  await writeFile(manifest, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  return { objects, bytes, skipped, manifest };
}
