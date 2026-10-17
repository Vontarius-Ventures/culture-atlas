import {
  createMultipartStorage,
  type MultipartStorage,
  type ProviderConfig,
} from '@culture-atlas/providers';

/**
 * Private v2 media storage for the analysis worker. Uses the same composition
 * as the web API and the media worker (providers `createMultipartStorage`), so
 * all three address one namespace: S3 in production, and in development a local
 * directory resolved from the workspace root (not from this package's cwd).
 */
export function createCaptureStorage(
  config: ProviderConfig,
  signingSecret: string,
): MultipartStorage {
  return createMultipartStorage(config, {
    production: process.env.NODE_ENV === 'production',
    fallbackSigningSecret: signingSecret,
  });
}
