/**
 * Restore drill (docs/runbooks/restore-drill.md). ISOLATED STAGING ONLY.
 *
 *   RESTORE_DRILL_CONFIRM=isolated \
 *   RESTORE_TARGET_DATABASE_URL=<new empty database> \
 *   pnpm ops:restore-drill -- --backup <dir from capture-backup.ts> \
 *     --objects local:<restored object root> | --objects s3:<restore bucket> \
 *     [--journal <deletion journal json>]
 *
 * Prints a JSON report of counts. Exit code 1 when objects are missing or
 * corrupt, or migrations differ, so the drill cannot "pass" silently.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LocalFsStorage, S3Storage } from '../packages/providers/src/storage/index';
import { runRestoreDrill, type ObjectReader, type Tombstone } from './restore-drill-lib';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

if (process.env.RESTORE_DRILL_CONFIRM !== 'isolated')
  fail('Set RESTORE_DRILL_CONFIRM=isolated to confirm the target is a new, isolated database.');
const targetUrl =
  process.env.RESTORE_TARGET_DATABASE_URL ?? fail('RESTORE_TARGET_DATABASE_URL is required.');
if (process.env.DATABASE_URL && process.env.DATABASE_URL === targetUrl)
  fail('The restore target must not be the application database.');
const backupDir = arg('backup') ?? fail('--backup <dir> is required.');
const objects = arg('objects') ?? fail('--objects local:<dir> or s3:<bucket> is required.');

let readObject: ObjectReader;
if (objects.startsWith('local:')) {
  const storage = new LocalFsStorage(resolve(objects.slice(6)), {
    baseUrl: 'http://localhost',
    secret: 'restore-drill-read-only',
    ttlSeconds: 60,
  });
  readObject = async (key) => (await storage.get(key))?.body ?? null;
} else if (objects.startsWith('s3:')) {
  // Credentials come from the default chain (instance role); the bucket is the RESTORE copy.
  const storage = new S3Storage({
    bucket: objects.slice(3),
    region:
      process.env.S3_REGION ??
      process.env.AWS_REGION ??
      fail('Set AWS_REGION for the S3 restore copy.'),
    ttlSeconds: 60,
  });
  readObject = async (key) => (await storage.get(key))?.body ?? null;
} else readObject = fail('--objects must start with local: or s3:');

const journalPath = arg('journal');
const journal = journalPath
  ? (JSON.parse(await readFile(journalPath, 'utf8')) as Tombstone[])
  : undefined;
try {
  const report = await runRestoreDrill({
    backupDir: resolve(backupDir),
    targetUrl,
    readObject,
    journal,
  });
  console.log(JSON.stringify(report, null, 2));
  if (
    !report.migrations_match ||
    report.objects_missing ||
    report.objects_size_mismatch ||
    report.objects_checksum_mismatch
  )
    process.exitCode = 1;
} catch (error) {
  // Messages from restore-drill-lib are written to be safe to print.
  console.error((error as Error).message);
  process.exitCode = 1;
}
