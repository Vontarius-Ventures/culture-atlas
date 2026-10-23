import type { ProviderConfig } from '../config';
import { resolveFromWorkspace } from '../paths';
import { LocalMultipartStorage } from './multipart-local';
import { S3MultipartStorage } from './multipart-s3';
import type { MultipartStorage } from './multipart-types';

export class MultipartStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultipartStorageUnavailableError';
  }
}

/**
 * Shared composition for the web API and the media worker, so both address the
 * same private namespace. The filesystem driver is a test double and is refused
 * in production; S3 must be configured explicitly (never a silent fallback).
 */
export function createMultipartStorage(
  config: ProviderConfig,
  options: { production: boolean; fallbackSigningSecret: string },
): MultipartStorage {
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET)
      throw new MultipartStorageUnavailableError('Private media storage is not configured.');
    return new S3MultipartStorage({
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  if (options.production)
    throw new MultipartStorageUnavailableError('Production media requires private S3 storage.');
  return new LocalMultipartStorage(
    resolveFromWorkspace(`${config.STORAGE_LOCAL_DIR.replace(/\/+$/, '')}/capture-v2`),
    config.APP_BASE_URL,
    config.STORAGE_SIGNING_SECRET ?? options.fallbackSigningSecret,
  );
}
