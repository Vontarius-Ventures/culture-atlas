import { resolve } from 'node:path';
import {
  LocalMultipartStorage,
  S3MultipartStorage,
  type MultipartStorage,
  type ProviderConfig,
} from '@culture-atlas/providers';

/**
 * Private v2 media storage for the analysis worker, configured exactly like the
 * web runtime (apps/web/lib/server/capture-v2.ts getCaptureV2Storage): S3 in
 * production, a local directory in development.
 */
export function createCaptureStorage(
  config: ProviderConfig,
  signingSecret: string,
): MultipartStorage {
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET) throw new Error('Private media storage is not configured (S3_BUCKET).');
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
  if (process.env.NODE_ENV === 'production')
    throw new Error('Production media requires private S3 storage.');
  return new LocalMultipartStorage(
    resolve(config.STORAGE_LOCAL_DIR, 'capture-v2'),
    config.APP_BASE_URL,
    config.STORAGE_SIGNING_SECRET ?? signingSecret,
  );
}
