import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../db/migrate';
import { createDb, type PoolDb, type Queryable } from '../db/pool';

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

/**
 * PostgreSQL truncates identifiers longer than 63 bytes (NAMEDATALEN - 1), so
 * a longer name would silently address a different database than the caller
 * believes it created. Names are also interpolated into SQL, so they are
 * restricted to plain [a-z0-9_].
 */
export function assertSafeDatabaseName(name: string): void {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (!/^[a-z0-9_]+$/.test(name) || bytes < 1 || bytes > 63) {
    throw new Error(`Unsafe test database name "${name}" (${bytes} bytes): must be 1-63 bytes of [a-z0-9_].`);
  }
}

export interface DropOwnedDatabaseOptions {
  /** Bounded wait (ms) for the database to leave transient object-in-use (SQLSTATE 55006). Default 10s; `CA_TEST_DROP_DEADLINE_MS` overrides. */
  deadlineMs?: number;
  /** Delay (ms) between drop attempts while busy. Default 250ms; `CA_TEST_DROP_POLL_MS` overrides. */
  pollMs?: number;
}

const DEFAULT_DROP_DEADLINE_MS = 10_000;
const DEFAULT_DROP_POLL_MS = 250;

function envNonNegativeInt(name: string): number | undefined {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function dropRetryOptions(options: DropOwnedDatabaseOptions): Required<DropOwnedDatabaseOptions> {
  return {
    deadlineMs: options.deadlineMs ?? envNonNegativeInt('CA_TEST_DROP_DEADLINE_MS') ?? DEFAULT_DROP_DEADLINE_MS,
    pollMs: options.pollMs ?? envNonNegativeInt('CA_TEST_DROP_POLL_MS') ?? DEFAULT_DROP_POLL_MS,
  };
}

/** Best-effort diagnostics for an honest failure: which sessions keep the database busy. */
async function describeAttachedSessions(admin: Queryable, name: string): Promise<string> {
  try {
    const { rows } = await admin.query<{ pid: number; usename: string | null; backend_type: string; state: string | null }>(
      'SELECT pid, usename, backend_type, state FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    return rows.length
      ? ` Attached: ${rows.map((r) => `${r.pid} ${r.usename ?? 'unknown role'} (${r.backend_type}, ${r.state ?? 'active'})`).join('; ')}.`
      : ' No sessions are attached anymore.';
  } catch {
    return '';
  }
}

/**
 * Drops a database this invocation created, permission-safely and with a
 * bounded wait. Callers only ever pass names they created themselves; the
 * ownership check and identifier check make that a hard guarantee.
 *
 * Never `WITH (FORCE)`: terminating an attached backend requires the
 * privileges of its role (or pg_signal_backend), which the app test role does
 * not have, and a role-less autovacuum worker attached to a freshly churned
 * test database made every FORCE drop fail with "permission denied to
 * terminate process" in file-level afterAll hooks. A plain DROP DATABASE lets
 * the server stop its own background workers and reports object-in-use
 * (SQLSTATE 55006) only while a session is still attached: transient busy is
 * retried within `deadlineMs`; persistent busy or an unexpected error fails
 * honestly (nothing dropped, nothing terminated) after it. The deadline is
 * enforced between attempts — one in-flight DROP DATABASE can block for a few
 * seconds server-side while it waits for sessions to drain.
 */
export async function dropOwnedDatabase(
  admin: Queryable,
  name: string,
  options: DropOwnedDatabaseOptions = {},
): Promise<void> {
  assertSafeDatabaseName(name);
  // Only ever drop a database the current role owns: CREATE DATABASE makes
  // the invoker the owner, so a row that exists without ownership is another
  // session's database and must be left alone.
  const owned = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database
      WHERE datname = $1 AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
    [name],
  );
  if (owned.rows.length === 0) {
    const exists = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = $1',
      [name],
    );
    if (exists.rows.length > 0)
      throw new Error(`Refusing to drop database "${name}": it exists but is not owned by the current role.`);
    return; // Already dropped — the semantics of DROP DATABASE IF EXISTS.
  }
  const { deadlineMs, pollMs } = dropRetryOptions(options);
  const deadline = Date.now() + deadlineMs;
  for (let attempts = 1; ; attempts++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      return;
    } catch (err) {
      const busy = (err as { code?: string }).code === '55006';
      if (!busy || Date.now() >= deadline) {
        const detail = busy ? await describeAttachedSessions(admin, name) : '';
        throw new Error(
          busy
            ? `Owned test database "${name}" is still in use after ${attempts} drop attempt(s) over ${deadlineMs}ms; it was NOT dropped and no connection was terminated.${detail}`
            : `Dropping owned test database "${name}" failed: ${(err as Error).message}`,
          { cause: err },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

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
  assertSafeDatabaseName(name);
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
      // Close this handle's pool first so the drop only waits for stragglers.
      await db.end().catch(() => undefined);
      const c = new pg.Client({ connectionString: BASE_URL() });
      await c.connect();
      try {
        await dropOwnedDatabase(c, name);
      } finally {
        await c.end();
      }
    },
  };
}
