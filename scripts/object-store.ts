/**
 * On-prem object store operator commands (docs/production-readiness.md).
 *
 *   pnpm ops:storage init [--create]   bucket exists (or create it), CORS for
 *                                      APP_BASE_URL, write/read/delete probe
 *   pnpm ops:storage mirror <dir>      copy every object to <dir>/objects
 *                                      (pair with pnpm ops:backup; restore with
 *                                      ops:restore-drill --objects local:<dir>/objects)
 *
 * Reads S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE and APP_BASE_URL. Prints counts and
 * names only, never credentials.
 */
import { join, resolve } from 'node:path';
import { createS3Client, initBucket, mirrorBucket, objectStoreSettings } from './object-store-lib';

const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
const fail = (message: string): never => {
  console.error(`[storage] ${message}`);
  process.exit(1);
};

try {
  const settings = objectStoreSettings(process.env);
  const client = createS3Client(settings);
  if (command === 'init') {
    const appOrigin = process.env.APP_BASE_URL?.trim() || fail('APP_BASE_URL is required for the CORS rule.');
    const result = await initBucket(client, {
      bucket: settings.bucket,
      appOrigin,
      create: rest.includes('--create'),
    });
    console.log(`[storage] ok bucket=${settings.bucket} created=${result.created} cors=${result.cors} round_trip=${result.roundTrip}`);
  } else if (command === 'mirror') {
    const dir = rest[0] ?? fail('Usage: pnpm ops:storage mirror <backup dir>');
    const result = await mirrorBucket(client, { bucket: settings.bucket, destination: join(resolve(dir), 'objects') });
    console.log(
      `[storage] mirrored ${result.objects} object(s), ${result.bytes} bytes, ${result.skipped} skipped; checksums in ${result.manifest}`,
    );
    if (result.skipped > 0) process.exitCode = 1;
  } else fail('Usage: pnpm ops:storage init [--create] | mirror <backup dir>');
} catch (error) {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  // Messages from object-store-lib name settings and buckets only; SDK errors
  // are reduced to their name and status.
  fail(status === undefined && (error as Error).name === 'Error'
    ? (error as Error).message
    : `${(error as Error).name ?? 'Error'} from the object store${status ? ` (HTTP ${status})` : ''}.`);
}
