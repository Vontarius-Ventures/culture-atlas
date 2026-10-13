import pg from 'pg';
import { getDomainConfig } from '../config';

/** Minimal query surface shared by pools, clients and transaction handles. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * Database handle passed through service contexts. `transaction` opens a
 * transaction on a pool handle, or a SAVEPOINT when already inside one, so
 * services can compose without caring whether a caller already holds a tx.
 */
export interface Db extends Queryable {
  transaction<T>(fn: (tx: Db) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** True when this handle is bound to an open transaction. */
  readonly inTransaction: boolean;
}

export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
}

// Return int8 (COUNT(*), bigint) as JS numbers; values here stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
// Return DATE columns as plain 'YYYY-MM-DD' strings (no local-time Date shift).
pg.types.setTypeParser(1082, (v) => v);

class ClientDb implements Db {
  readonly inTransaction = true;
  private savepoint = 0;
  constructor(private readonly client: pg.PoolClient) {}

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<R>> {
    return this.client.query<R>(text, params as unknown[] | undefined);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const name = `sp_${++this.savepoint}`;
    await this.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw err;
    }
  }
}

export class PoolDb implements Db {
  readonly inTransaction = false;
  constructor(readonly pool: pg.Pool) {}

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, params as unknown[] | undefined);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        options?.isolation ? `BEGIN ISOLATION LEVEL ${options.isolation.toUpperCase()}` : 'BEGIN',
      );
      const result = await fn(new ClientDb(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    // All timestamps are UTC.
    options: '-c timezone=UTC',
  });
  pool.on('error', (err) => {
    // Idle client errors must not crash the process.
    console.error('[db] idle client error', err.message);
  });
  return pool;
}

export function createDb(connectionString: string, max = 10): PoolDb {
  return new PoolDb(createPool(connectionString, max));
}

let shared: PoolDb | undefined;

/** Process-wide database handle built from DATABASE_URL (see config.ts for the default). */
export function getDb(): PoolDb {
  if (!shared) {
    const config = getDomainConfig();
    shared = createDb(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  }
  return shared;
}

/** Test hook: replace the process-wide handle. */
export function setDbForTesting(db: PoolDb | undefined): void {
  shared = db;
}

/** Run fn in a transaction (or savepoint if db is already a transaction). */
export function withTransaction<T>(
  db: Db,
  fn: (tx: Db) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  return db.transaction(fn, options);
}
