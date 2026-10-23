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
  /** Applied files whose recorded checksum was a known pre-reconciliation version. */
  reconciled: string[];
}

/**
 * Checksums of migration files as they shipped on parallel lines before those
 * lines were merged and the files were rewritten to be order-independent
 * (idempotent guards only, no change to the resulting schema). A database that
 * applied one of these versions is valid; its record is updated to the current
 * checksum. Any other mismatch is still an error.
 */
export const RECONCILED_CHECKSUMS: Readonly<Record<string, readonly string[]>> = {
  // capture-v2/p1-domain-infra: unguarded media_assets/upload/work agent fences.
  '055_agent_media_fences.sql': ['0758d7a9c56853fb14da56347e11431606ae2ecc5d94d72c1de71deceeec200b'],
  // capture-v2/p5-agents: unguarded media_assets.created_by_agent_connection_id.
  '071_agent_resources_commands.sql': ['1bdc43ac9b9e7e6a769e4a252308f3ee5261eff4bac71d3e4b6db984c5156b2a'],
};

/**
 * Applies db/migrations/*.sql in lexical order. Each file runs in its own
 * transaction and is recorded in schema_migrations with a checksum; editing an
 * applied migration is an error (add a new file instead). A session advisory
 * lock serializes concurrent runners.
 */
export async function runMigrations(
  connectionString: string,
  options: {
    dir?: string;
    log?: (msg: string) => void;
    reconciledChecksums?: Readonly<Record<string, readonly string[]>>;
  } = {},
): Promise<MigrationResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => undefined);
  const reconciledChecksums = options.reconciledChecksums ?? RECONCILED_CHECKSUMS;
  const client = new pg.Client({ connectionString, options: '-c timezone=UTC' });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [], reconciled: [] };
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
        if (prior !== checksum && reconciledChecksums[file]?.includes(prior)) {
          log(`reconciling ${file} (applied from a pre-merge line)`);
          await client.query('UPDATE schema_migrations SET checksum=$2 WHERE version=$1', [file, checksum]);
          result.reconciled.push(file);
        } else if (prior !== checksum) {
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
