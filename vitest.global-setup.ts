import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from './packages/domain/src/db/migrate';
import { assertSafeDatabaseName, dropOwnedDatabase } from './packages/domain/src/testing/isolated-db';

/**
 * Creates an isolated database for this test run (so parallel agents/worktrees
 * never collide), applies all migrations, and provides its URL to tests via
 * inject('databaseUrl'). Dropped on teardown.
 *
 * Base connection: TEST_DATABASE_URL (default: local culture_atlas_test). The
 * role needs CREATEDB (scripts/dev-db.sh grants it).
 */
declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://culture_atlas:culture_atlas@localhost:5432/culture_atlas_test';

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export default async function setup(project: TestProject) {
  const name = `ca_test_${process.pid}_${randomBytes(3).toString('hex')}`;
  assertSafeDatabaseName(name);
  const admin = new pg.Client({ connectionString: BASE_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot connect to the test database (${(err as Error).message}). ` +
        'Run `pnpm db:setup` (starts PostgreSQL and creates the culture_atlas role) or set TEST_DATABASE_URL.',
      { cause: err },
    );
  }
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = withDatabase(BASE_URL, name);
  await runMigrations(url);
  project.provide('databaseUrl', url);

  return async () => {
    const c = new pg.Client({ connectionString: BASE_URL });
    await c.connect();
    try {
      // No WITH (FORCE): the test role lacks pg_signal_backend, and a
      // role-less autovacuum worker attached to the churned per-run database
      // would make the teardown fail with "permission denied to terminate
      // process". dropOwnedDatabase waits, bounded, for sessions to exit.
      await dropOwnedDatabase(c, name);
    } finally {
      await c.end();
    }
  };
}
