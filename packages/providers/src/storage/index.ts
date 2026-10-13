import type { ProviderConfig } from '../config';
import { MemoryObjectStorage } from '../testing/memory-storage';
import { UnavailableStorage } from '../unavailable';
import type { ObjectStorage } from './types';

/**
 * Storage factory.
 * TODO(storage owner): implement LocalFsStorage (STORAGE_LOCAL_DIR, HMAC-signed
 * /v1/media URLs with STORAGE_SIGNING_SECRET) and S3Storage (@aws-sdk/client-s3
 * + s3-request-presigner; private bucket; S3_* env).
 */
export function createObjectStorage(config: ProviderConfig): ObjectStorage {
  switch (config.STORAGE_DRIVER) {
    case 'memory':
      return new MemoryObjectStorage(config.APP_BASE_URL);
    case 'local':
    case 's3':
      return new UnavailableStorage('not_implemented');
  }
}
