import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../db/migrate';
import { createDb, type PoolDb } from '../db/pool';

/**
 * A private database for tests whose assertions need absolute counts (ops
 * metrics) or a second database (restore drills). The shared per-run test
 * database is used by many files in parallel, so global aggregates there are
 * not deterministic. Names use the `ca_idops_` prefix so leftovers are easy to
 * find; each is dropped by `drop()`.
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
  options: { migrate?: boolean; prefix?: string } = {},
): Promise<IsolatedDatabase> {
  const name = `${options.prefix ?? 'ca_idops'}_${process.pid}_${randomBytes(4).toString('hex')}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Invalid isolated database name.');
  const admin = new pg.Client({ connectionString: BASE_URL() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = databaseUrl(name);
  if (options.migrate !== false) await runMigrations(url);
  const db = createDb(url, 4);
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
