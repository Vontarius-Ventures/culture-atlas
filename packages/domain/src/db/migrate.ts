import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../db/migrations',
);

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies db/migrations/*.sql in lexical order. Each file runs in its own
 * transaction and is recorded in schema_migrations with a checksum; editing an
 * applied migration is an error (add a new file instead). A session advisory
 * lock serializes concurrent runners.
 */
export async function runMigrations(
  connectionString: string,
  options: { dir?: string; log?: (msg: string) => void } = {},
): Promise<MigrationResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => undefined);
  const client = new pg.Client({ connectionString, options: '-c timezone=UTC' });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) {
          throw new Error(`Migration ${file} changed after it was applied; add a new migration instead`);
        }
        result.skipped.push(file);
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
  return result;
}
