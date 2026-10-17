import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { runMigrations } from '../db/migrate';
import { createDb, type PoolDb } from '../db/pool';

/**
 * A separate, fully migrated database for tests that mutate GLOBAL state (the
 * model-gateway spend control row, credit pauses, role circuits). Named
 * `<run db>_<prefix><hex>` so it is recognizable and never collides with the
 * shared per-run database other files use concurrently.
 */
export async function createIsolatedDatabase(
  prefix: string,
  options: { migrationsDir?: string } = {},
): Promise<{ url: string; db: PoolDb; drop: () => Promise<void> }> {
  if (!/^[a-z][a-z0-9]{0,15}$/.test(prefix)) throw new Error('Invalid test database prefix');
  const base = new URL(inject('databaseUrl'));
  const name = `${base.pathname.slice(1)}_${prefix}${randomBytes(3).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  await runMigrations(url.toString(), { dir: options.migrationsDir });
  const db = createDb(url.toString(), 5);
  return {
    url: url.toString(),
    db,
    drop: async () => {
      await db.end();
      const c = new pg.Client({ connectionString: base.toString() });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
