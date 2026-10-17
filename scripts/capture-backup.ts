import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pg from 'pg';

/**
 * Consistent metadata snapshot + immutable-object inventory. Object backup is
 * separately required; this command alone is not a restorable media backup.
 */
const databaseUrl = process.env.DATABASE_URL,
  base = process.env.CAPTURE_BACKUP_DIR;
if (!databaseUrl || !base) throw new Error('DATABASE_URL and CAPTURE_BACKUP_DIR are required.');
await mkdir(resolve(base), { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(resolve(base), 'capture-'));
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows } = await db.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot');
  await promisify(execFile)(
    process.env.PG_DUMP_BIN ?? 'pg_dump',
    [
      '--format=custom',
      '--no-owner',
      '--no-acl',
      `--snapshot=${rows[0]!.snapshot}`,
      `--file=${join(directory, 'database.dump')}`,
    ],
    { env: { ...process.env, PGDATABASE: databaseUrl }, timeout: 900000, maxBuffer: 1048576 },
  );
  const inventory = await db.query(
    `SELECT account_id,id AS asset_id,generation,original_key AS object_key,sha256 AS checksum,byte_size
       FROM media_assets WHERE deleted_at IS NULL AND original_key IS NOT NULL
     UNION ALL
     SELECT d.account_id,d.asset_id,d.generation,d.object_key,d.checksum,d.byte_size
       FROM media_derivatives d JOIN media_assets m ON m.account_id=d.account_id AND m.id=d.asset_id
       WHERE m.deleted_at IS NULL AND d.generation=m.generation
     UNION ALL
     SELECT m.account_id,m.id,m.generation,c.private_object_key,NULL::text,NULL::bigint
       FROM media_assets m JOIN captures c ON c.id=m.legacy_capture_id AND c.owner_account_id=m.account_id
       WHERE m.legacy_imported AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND c.private_object_key IS NOT NULL`,
  );
  const tombstones = await db.query(
    `SELECT account_id,id,generation,deleted_at FROM media_assets WHERE deleted_at IS NOT NULL`,
  );
  const migrations = await db.query(
    `SELECT version,checksum FROM schema_migrations ORDER BY version`,
  );
  await writeFile(join(directory, 'objects.json'), JSON.stringify(inventory.rows), { mode: 0o600 });
  await writeFile(join(directory, 'tombstones.json'), JSON.stringify(tombstones.rows), {
    mode: 0o600,
  });
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(
      {
        schema_version: 1,
        created_at: new Date().toISOString(),
        objects_backed_up: false,
        object_count: inventory.rowCount,
        migrations: migrations.rows,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await db.query('COMMIT');
  console.log(
    `Metadata snapshot written to ${directory}. Object backup and restore validation remain required.`,
  );
} catch {
  await db.query('ROLLBACK').catch(() => undefined);
  // Do not print command arguments, environment, DB credentials or record contents.
  throw new Error('Capture metadata backup failed; inspect private operator diagnostics.');
} finally {
  await db.end();
}
