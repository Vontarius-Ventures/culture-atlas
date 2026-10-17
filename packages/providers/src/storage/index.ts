import type { ProviderConfig } from '../config';
import { MemoryObjectStorage } from '../testing/memory-storage';
import { resolveFromWorkspace } from '../paths';
import { UnavailableStorage } from '../unavailable';
import { LocalFsStorage } from './local';
import { S3Storage } from './s3';
import { ephemeralSigningSecret } from './signing';
import type { ObjectStorage } from './types';

export { LocalFsStorage } from './local';
export { S3Storage } from './s3';
export * from './multipart-types';
export { buildSignedMediaUrl, isSafeObjectKey, signMedia, verifySignedMedia, type MediaVerification } from './signing';

/**
 * Storage factory: local filesystem (HMAC-signed /v1/media links), S3
 * (presigned GET links) or memory (tests). Misconfigured S3 reports
 * unavailable rather than silently falling back.
 */
export function createObjectStorage(config: ProviderConfig): ObjectStorage {
  switch (config.STORAGE_DRIVER) {
    case 'memory':
      return new MemoryObjectStorage(config.APP_BASE_URL, config.STORAGE_SIGNING_SECRET);
    case 'local':
      return new LocalFsStorage(resolveFromWorkspace(config.STORAGE_LOCAL_DIR), {
        baseUrl: config.APP_BASE_URL,
        secret: config.STORAGE_SIGNING_SECRET ?? ephemeralSigningSecret(),
        ephemeralSecret: !config.STORAGE_SIGNING_SECRET,
        ttlSeconds: config.SIGNED_URL_TTL_SECONDS,
      });
    case 's3':
      if (!config.S3_BUCKET) return new UnavailableStorage('not_configured');
      return new S3Storage({
        bucket: config.S3_BUCKET,
        region: config.S3_REGION,
        endpoint: config.S3_ENDPOINT,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        credentials:
          config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
            : undefined,
        ttlSeconds: config.SIGNED_URL_TTL_SECONDS,
      });
  }
}
