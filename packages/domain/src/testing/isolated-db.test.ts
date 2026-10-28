import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { Queryable } from '../db/pool';
import {
  assertSafeDatabaseName,
  createIsolatedDatabase,
  dropOwnedDatabase,
} from './isolated-db';

/**
 * Teardown regression tests for the isolated-database harness.
 *
 * `DROP DATABASE ... WITH (FORCE)` lets the server terminate every backend
 * attached to the target database, but only if the dropping role has the
 * privileges of each backend's role (or pg_signal_backend). The app test role
 * has no pg_signal_backend, and PostgreSQL background workers attached to a
 * freshly churned test database (autovacuum/autoanalyze after migrations and
 * test writes) have no role at all — so the FORCE drop intermittently failed
 * with "permission denied to terminate process" in file-level afterAll hooks,
 * leaving the serial suite nonzero while every assertion had passed and
 * stranding the dropped-failed databases.
 *
 * Teardown therefore must drop WITHOUT FORCE: the server stops its own
 * background workers and only reports object-in-use (SQLSTATE 55006) while a
 * session is still attached, so a bounded retry waits for invocation-owned
 * connections to exit and never needs privileges it does not have.
 */

const BASE_URL = () =>
  process.env.TEST_DATABASE_URL ??
  'postgres://culture_atlas:culture_atlas@localhost:5432/culture_atlas_test';

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: BASE_URL() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function databaseExists(name: string): Promise<boolean> {
  return withAdmin(async (c) => {
    const { rows } = await c.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [name],
    );
    return rows[0]!.exists;
  });
}

/** Opens an extra connection to the isolated database, as a leaked pool client would. */
async function openHolder(url: string): Promise<{ client: pg.Client; errors: string[] }> {
  const client = new pg.Client({ connectionString: url });
  const errors: string[] = [];
  client.on('error', (e) => errors.push((e as { code?: string }).code ?? e.message));
  await client.connect();
  await client.query('SELECT 1');
  return { client, errors };
}

describe('isolated database teardown', () => {
  it('drops a transiently busy owned database without terminating the attached connection', async () => {
    const iso = await createIsolatedDatabase({ migrate: false, prefix: 'ca_isodrop' });
    const { client: holder, errors } = await openHolder(iso.url);
    try {
      // The connection exits on its own shortly after the drop starts.
      setTimeout(() => void holder.end().catch(() => undefined), 600);
      const started = Date.now();
      await iso.drop();
      const waitedMs = Date.now() - started;

      expect(errors).toEqual([]); // no FATAL "terminating connection" was issued
      expect(waitedMs).toBeGreaterThanOrEqual(400); // waited for the exit instead of killing it
      await expect(databaseExists(iso.name)).resolves.toBe(false);
    } finally {
      await holder.end().catch(() => undefined);
      await iso.drop().catch(() => undefined);
    }
  });

  it('fails honestly after the bounded deadline while the database stays busy, and a later drop succeeds', async () => {
    process.env.CA_TEST_DROP_DEADLINE_MS = '1200';
    const iso = await createIsolatedDatabase({ migrate: false, prefix: 'ca_isodrop' });
    const { client: busy, errors } = await openHolder(iso.url);
    try {
      await expect(iso.drop()).rejects.toThrow(/still in use/i);
      // Nobody was terminated and nothing was dropped behind the busy database's back.
      await expect(databaseExists(iso.name)).resolves.toBe(true);
      expect(errors).toEqual([]);
    } finally {
      delete process.env.CA_TEST_DROP_DEADLINE_MS;
      await busy.end().catch(() => undefined);
      // The failed drop released its admin connection and pool, so the next
      // drop succeeds immediately.
      await iso.drop().catch(() => undefined);
    }
    await expect(databaseExists(iso.name)).resolves.toBe(false);
  });

  it('treats dropping an already-dropped database as success', async () => {
    const iso = await createIsolatedDatabase({ migrate: false, prefix: 'ca_isodrop' });
    await iso.drop();
    await expect(iso.drop()).resolves.toBeUndefined();
  });

  it('refuses unsafe database names before issuing any SQL', async () => {
    const { admin, queries } = fakeAdmin(async () => resultOf([]));
    await expect(dropOwnedDatabase(admin, 'ca_isodrop_1; DROP TABLE accounts')).rejects.toThrow(/Unsafe test database name/);
    await expect(dropOwnedDatabase(admin, `ca_${'x'.repeat(70)}`)).rejects.toThrow(/Unsafe test database name/);
    expect(queries).toEqual([]);
    expect(() => assertSafeDatabaseName('')).toThrow(/Unsafe test database name/);
  });

  it('drops without FORCE and retries transient object-in-use within the deadline', async () => {
    let dropAttempts = 0;
    const { admin, queries } = fakeAdmin(async (text) => {
      if (text.startsWith('DROP DATABASE')) {
        dropAttempts += 1;
        if (dropAttempts === 1)
          throw Object.assign(new Error('database "ca_isodrop_1_ab" is being accessed by other users'), {
            code: '55006',
          });
        return resultOf([]);
      }
      if (text.includes('datdba')) return resultOf([{ datname: 'ca_isodrop_1_ab' }]);
      return resultOf([]);
    });
    await dropOwnedDatabase(admin, 'ca_isodrop_1_ab', { deadlineMs: 5_000, pollMs: 10 });
    expect(dropAttempts).toBe(2);
    expect(queries.map((q) => q.text)).toEqual([
      expect.stringContaining('datdba'),
      'DROP DATABASE IF EXISTS ca_isodrop_1_ab',
      'DROP DATABASE IF EXISTS ca_isodrop_1_ab',
    ]);
    expect(queries.some((q) => q.text.includes('FORCE'))).toBe(false);
  });

  it('fails honestly when the database stays busy past the deadline', async () => {
    const { admin, queries } = fakeAdmin(async (text) => {
      if (text.startsWith('DROP DATABASE'))
        throw Object.assign(new Error('database "ca_isodrop_1_ab" is being accessed by other users'), {
          code: '55006',
        });
      if (text.includes('datdba')) return resultOf([{ datname: 'ca_isodrop_1_ab' }]);
      return resultOf([]);
    });
    await expect(dropOwnedDatabase(admin, 'ca_isodrop_1_ab', { deadlineMs: 60, pollMs: 10 })).rejects.toThrow(
      /still in use/i,
    );
    expect(queries.filter((q) => q.text.startsWith('DROP DATABASE')).length).toBeGreaterThanOrEqual(2);
  });

  it('propagates unexpected errors immediately without retrying', async () => {
    let dropAttempts = 0;
    const { admin } = fakeAdmin(async (text) => {
      if (text.startsWith('DROP DATABASE')) {
        dropAttempts += 1;
        throw Object.assign(new Error('permission denied to drop database'), { code: '42501' });
      }
      if (text.includes('datdba')) return resultOf([{ datname: 'ca_isodrop_1_ab' }]);
      return resultOf([]);
    });
    await expect(dropOwnedDatabase(admin, 'ca_isodrop_1_ab', { deadlineMs: 5_000, pollMs: 10 })).rejects.toThrow(
      /permission denied to drop database/,
    );
    expect(dropAttempts).toBe(1);
  });

  it('refuses a database that exists but is not owned by the current role, and never issues the drop', async () => {
    const { admin, queries } = fakeAdmin(async (text) =>
      text.includes('datdba') ? resultOf([]) : resultOf([{ datname: 'ca_foreign_1_ab' }]),
    );
    await expect(dropOwnedDatabase(admin, 'ca_foreign_1_ab')).rejects.toThrow(/not owned by the current role/);
    expect(queries.filter((q) => q.text.startsWith('DROP DATABASE'))).toEqual([]);
  });

  it('treats a missing database as already dropped', async () => {
    const { admin, queries } = fakeAdmin(async () => resultOf([]));
    await expect(dropOwnedDatabase(admin, 'ca_isodrop_missing_1')).resolves.toBeUndefined();
    expect(queries.filter((q) => q.text.startsWith('DROP DATABASE'))).toEqual([]);
  });

  it('never drops a live database the test role does not own', async () => {
    await withAdmin(async (admin) => {
      await expect(dropOwnedDatabase(admin, 'postgres')).rejects.toThrow(/not owned by the current role/);
    });
    await expect(databaseExists('postgres')).resolves.toBe(true);
  });

  it('refuses to create an isolated database with an unsafe name', async () => {
    await expect(
      createIsolatedDatabase({ migrate: false, prefix: 'ca_isodrop_BAD-NAME' }),
    ).rejects.toThrow(/Unsafe test database name/);
    await expect(createIsolatedDatabase({ migrate: false, prefix: `ca_${'y'.repeat(60)}` })).rejects.toThrow(
      /Unsafe test database name/,
    );
  });
});

/** A recording stand-in for the admin connection, so the exact SQL is observable. */
function fakeAdmin(
  handler: (text: string, params?: readonly unknown[]) => Promise<pg.QueryResult>,
): { admin: Queryable; queries: { text: string; params?: readonly unknown[] }[] } {
  const queries: { text: string; params?: readonly unknown[] }[] = [];
  return {
    queries,
    admin: {
      query<R extends pg.QueryResultRow>(text: string, params?: readonly unknown[]): Promise<pg.QueryResult<R>> {
        queries.push({ text, params });
        return handler(text, params) as Promise<pg.QueryResult<R>>;
      },
    },
  };
}

function resultOf<T extends pg.QueryResultRow>(rows: T[]): pg.QueryResult<T> {
  return { rows } as unknown as pg.QueryResult<T>;
}
