import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { CapabilityEntry } from '../capabilities';
import { ProviderError } from '../errors';
import { isSafeObjectKey } from './signing';
import type { ObjectStorage, StoredObject } from './types';

/**
 * Private S3-compatible storage (STORAGE_DRIVER=s3). The bucket must block
 * public access; reads go through presigned GET URLs that expire after
 * SIGNED_URL_TTL_SECONDS (max 7 days per S3, capped at 1 hour here).
 */
export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  ttlSeconds: number;
  /** Injected client (tests). */
  client?: Pick<S3Client, 'send'> & { config?: unknown };
  /** Injected presigner (tests). */
  presign?: (key: string, expiresIn: number) => Promise<string>;
}

const MAX_TTL_SECONDS = 3600;

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

function toProviderError(err: unknown, op: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const kind = status === 403 || status === 401 ? 'auth' : status === 429 || status === 503 ? 'rate_limited' : status && status < 500 ? 'bad_request' : 'server';
  return new ProviderError('storage', kind, `s3 ${op} failed${status ? ` (HTTP ${status})` : ''}`, { status, cause: err });
}

export class S3Storage implements ObjectStorage {
  readonly driver = 's3' as const;
  private readonly client: Pick<S3Client, 'send'>;
  private readonly presign: (key: string, expiresIn: number) => Promise<string>;

  constructor(private readonly options: S3StorageOptions) {
    const cfg: S3ClientConfig = {
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      credentials: options.credentials,
    };
    const real = options.client ? null : new S3Client(cfg);
    this.client = options.client ?? real!;
    this.presign =
      options.presign ??
      ((key, expiresIn) => getSignedUrl(real!, new GetObjectCommand({ Bucket: options.bucket, Key: key }), { expiresIn }));
  }

  capability(): { objects: CapabilityEntry; signedUrls: CapabilityEntry } {
    const ok: CapabilityEntry = { status: 'available', provider: 's3', detail: this.options.endpoint ? 'S3-compatible endpoint' : 'AWS S3' };
    return { objects: ok, signedUrls: ok };
  }

  private check(key: string): void {
    if (!isSafeObjectKey(key)) throw new ProviderError('storage', 'bad_request', 'invalid object key');
  }

  async put(key: string, body: Uint8Array, options: { contentType: string }): Promise<void> {
    this.check(key);
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: body, ContentType: options.contentType }));
    } catch (err) {
      throw toProviderError(err, 'put');
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    this.check(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
      const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) return null;
      return { body: await body.transformToByteArray(), contentType: out.ContentType ?? 'application/octet-stream' };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw toProviderError(err, 'get');
    }
  }

  async delete(key: string): Promise<void> {
    this.check(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw toProviderError(err, 'delete');
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const clean = prefix.replace(/\/+$/, '');
    this.check(clean);
    let count = 0;
    let token: string | undefined;
    try {
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: `${clean}/`, ContinuationToken: token }),
        );
        const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
        if (keys.length) {
          await this.client.send(
            new DeleteObjectsCommand({ Bucket: this.options.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
          );
          count += keys.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    } catch (err) {
      throw toProviderError(err, 'deletePrefix');
    }
    return count;
  }

  async signedUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string> {
    this.check(key);
    const ttl = Math.min(options?.expiresInSeconds ?? this.options.ttlSeconds, MAX_TTL_SECONDS);
    return this.presign(key, ttl);
  }
}
