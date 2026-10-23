import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../db/migrate';
import { createDb, type PoolDb } from '../db/pool';

/**
 * A private, separately created database for tests that either mutate GLOBAL
 * state (the model-gateway spend control row, credit pauses, role circuits),
 * need absolute counts (ops metrics) or need a second database (restore
 * drills). The shared per-run test database is used by many files in parallel,
 * so those assertions would not be deterministic there.
 *
 * Two call shapes are supported:
 * - `createIsolatedDatabase('conc', { migrationsDir })`: named
 *   `ca_conc_<pid>_<hex>`, migrated from `migrationsDir` (default: db/migrations).
 * - `createIsolatedDatabase({ migrate, prefix })`: named
 *   `<prefix ?? 'ca_idops'>_<pid>_<hex>`; `migrate: false` leaves it empty.
 *
 * Each is dropped by `drop()`; leftovers are easy to find by their prefix.
 */
export interface IsolatedDatabase {
  name: string;
  url: string;
  db: PoolDb;
  drop(): Promise<void>;
}

const BASE_URL = () =>
  process.env.TEST_DATABASE_URL ??
  'postgres://culture_atlas:culture_atlas@localhost:5432/culture_atlas_test';

export function databaseUrl(name: string): string {
  const url = new URL(BASE_URL());
  url.pathname = `/${name}`;
  return url.toString();
}

export async function createIsolatedDatabase(
  prefixOrOptions?: string | { migrate?: boolean; prefix?: string },
  maybeOptions: { migrationsDir?: string } = {},
): Promise<IsolatedDatabase> {
  let prefix: string;
  let migrate = true;
  let migrationsDir: string | undefined;
  if (typeof prefixOrOptions === 'string') {
    if (!/^[a-z][a-z0-9]{0,15}$/.test(prefixOrOptions))
      throw new Error('Invalid test database prefix');
    prefix = `ca_${prefixOrOptions}`;
    migrationsDir = maybeOptions.migrationsDir;
  } else {
    prefix = prefixOrOptions?.prefix ?? 'ca_idops';
    migrate = prefixOrOptions?.migrate !== false;
  }
  const name = `${prefix}_${process.pid}_${randomBytes(4).toString('hex')}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Invalid isolated database name.');
  const admin = new pg.Client({ connectionString: BASE_URL() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = databaseUrl(name);
  if (migrate) await runMigrations(url, migrationsDir ? { dir: migrationsDir } : undefined);
  const db = createDb(url, 5);
  return {
    name,
    url,
    db,
    async drop() {
      await db.end().catch(() => undefined);
      const c = new pg.Client({ connectionString: BASE_URL() });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
