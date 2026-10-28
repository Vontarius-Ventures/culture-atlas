import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { PoolDb, Queryable } from '../db/pool';
import { closeTestDb, getTestDb, insertAccount } from '../testing';
import { createGraphRun, upsertFrontierCandidate, type FrontierUpsertResult } from './store';

/**
 * Concurrent frontier dedupe return value (frontier support-root contract,
 * migration 280 owner binding): an ON CONFLICT dedupe call resolves the
 * conflict through the committed tuple, but every other scan in the same
 * statement keeps the statement's PRE-WAIT snapshot — so when the candidate
 * and its owner-bound roots were committed by the transaction the dedupe
 * waited on, those roots are invisible to the statement and the caller is
 * told support_root_ids is empty while stored roots exist. These barrier
 * regressions hold the first candidate/root insert uncommitted until the
 * dedupe call is observed waiting (pg_locks, never a plain sleep), then
 * commit or roll back and require the response to carry exactly the retained
 * stored roots — never a merged or replaced candidate identity. Repeatable
 * read callers must fail the conflict honestly rather than observe any
 * stale set, foreign roots must keep failing the creating statement
 * atomically, and cross-owner/empty-root cases keep their current shape.
 */

const db = getTestDb();
afterAll(closeTestDb);

/** Queryable view of one dedicated pool client; the store writers need nothing more. */
function clientDb(client: PoolClient): Queryable {
  return {
    query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
      return client.query<R>(text, params as unknown[] | undefined);
    },
  };
}

/**
 * Resolves once the backend holds an ungranted lock request — the
 * speculative-insertion wait an ON CONFLICT dedupe call takes on the
 * conflicting transaction. Fails honestly if the dedupe never blocks, so a
 * barrier cannot silently pass by racing past the wait.
 */
async function waitForBlockedOn(pool: PoolDb, pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*) AS n FROM pg_locks WHERE pid = $1 AND NOT granted',
      [pid],
    );
    if (Number(rows[0]!.n) > 0) return;
    if (Date.now() >= deadline)
      throw new Error(`backend ${pid} never blocked on the conflicting candidate within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function graphNode(dbh: Queryable, key = randomUUID()): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO graph_nodes (canonical_key, canonical_name, name_key, node_kind, domain, sense_key)
     VALUES ($1, $2, $3, 'creator', 'art', 'person') RETURNING id`,
    [`atlas:${key}`, `Name ${key}`, `name-${key}`],
  );
  return rows[0]!.id;
}

/** One private explicit edge owned by the account (the valid frontier root form). */
async function explicitEdge(dbh: Queryable, accountId: string): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO personal_interest_edges (owner_account_id, node_id, origin, state, policy_version)
     VALUES ($1, $2, 'explicit', 'confirmed', 'graph-policy-1') RETURNING id`,
    [accountId, await graphNode(dbh)],
  );
  return rows[0]!.id;
}

/** The retained roots actually stored for one frontier candidate. */
async function storedRoots(dbh: Queryable, frontierId: string): Promise<string[]> {
  const { rows } = await dbh.query<{ roots: string[] }>(
    `SELECT COALESCE(array_agg(sr.root_id ORDER BY sr.root_id), ARRAY[]::uuid[]) AS roots
       FROM graph_frontier_support_roots sr WHERE sr.frontier_id = $1`,
    [frontierId],
  );
  return rows[0]!.roots;
}

describe('a dedupe that waited on the conflicting candidate returns the stored roots, not its stale snapshot', () => {
  it('an autocommit dedupe that waited for the committing candidate reports exactly the retained stored roots', async () => {
    const a = await insertAccount(db);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const n = await graphNode(db);
    const stored1 = await explicitEdge(db, a.accountId);
    const stored2 = await explicitEdge(db, a.accountId);
    const offered = await explicitEdge(db, a.accountId); // must never merge
    const key = `node:${n}`;

    // Connection 1: the candidate and its roots sit in an open transaction.
    const holder = await db.pool.connect();
    let first: FrontierUpsertResult | undefined;
    try {
      const holderDb = clientDb(holder);
      await holder.query('BEGIN');
      first = await upsertFrontierCandidate(holderDb, {
        ownerAccountId: a.accountId,
        runId: runA.id,
        nodeId: n,
        dedupeKey: key,
        expiresInDays: 7,
        supportRootIds: [stored2, stored1], // unsorted on purpose
        score: 1,
      });
      expect(first.created).toBe(true);

      // Connection 2: the same account's dedupe call, offering a different
      // root and score. Its statement snapshot predates the holder's commit,
      // and the ON CONFLICT parks it on the holder's transaction.
      const dedupeConn = await db.pool.connect();
      try {
        const pid = (await dedupeConn.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const dedupe = upsertFrontierCandidate(clientDb(dedupeConn), {
          ownerAccountId: a.accountId,
          runId: runA.id,
          nodeId: n,
          dedupeKey: key,
          expiresInDays: 7,
          supportRootIds: [offered],
          score: 9,
        });
        await waitForBlockedOn(db, pid);

        // The barrier: the held candidate is released only once the dedupe
        // call is observed waiting.
        await holder.query('COMMIT');

        const result = await dedupe;
        expect(result.created).toBe(false);
        expect(result.row.id).toBe(first.row.id);
        // Candidate identity is never replaced by the caller's offer.
        expect(result.row.score).toBe(1);
        expect(result.row.run_id).toBe(runA.id);
        expect(result.row.node_id).toBe(n);
        expect(result.row.dedupe_key).toBe(key);
        // Exactly the retained stored roots, sorted: the stale statement
        // snapshot reported [] here while the stored roots existed.
        expect(result.row.support_root_ids).toEqual([stored1, stored2].sort());
        expect(await storedRoots(db, first.row.id)).toEqual([stored1, stored2].sort());
      } finally {
        await dedupeConn.query('ROLLBACK').catch(() => undefined);
        dedupeConn.release();
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('a dedupe inside an open read-committed transaction reports the stored roots its own snapshot could not see', async () => {
    const a = await insertAccount(db);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const n = await graphNode(db);
    const stored1 = await explicitEdge(db, a.accountId);
    const stored2 = await explicitEdge(db, a.accountId);
    const key = `node:${n}`;

    const holder = await db.pool.connect();
    let first: FrontierUpsertResult | undefined;
    try {
      await holder.query('BEGIN');
      first = await upsertFrontierCandidate(clientDb(holder), {
        ownerAccountId: a.accountId,
        runId: runA.id,
        nodeId: n,
        dedupeKey: key,
        expiresInDays: 7,
        supportRootIds: [stored1, stored2],
      });
      expect(first.created).toBe(true);

      // The dedupe caller composes like a real writer transaction: an open
      // read-committed transaction that already ran statements before the
      // upsert, so its earlier statements predate the holder's commit too.
      const dedupeConn = await db.pool.connect();
      try {
        await dedupeConn.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await dedupeConn.query('SELECT 1');
        const pid = (await dedupeConn.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const dedupe = upsertFrontierCandidate(clientDb(dedupeConn), {
          ownerAccountId: a.accountId,
          runId: runA.id,
          nodeId: n,
          dedupeKey: key,
          expiresInDays: 7,
        });
        await waitForBlockedOn(db, pid);
        await holder.query('COMMIT');

        const result = await dedupe;
        expect(result.created).toBe(false);
        expect(result.row.id).toBe(first.row.id);
        // A fresh per-statement snapshot within the caller's transaction sees
        // the commit that ended the conflict wait.
        expect(result.row.support_root_ids).toEqual([stored1, stored2].sort());
        await dedupeConn.query('COMMIT');
      } finally {
        await dedupeConn.query('ROLLBACK').catch(() => undefined);
        dedupeConn.release();
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('a repeatable-read dedupe fails the conflict honestly instead of observing a stale root set', async () => {
    const a = await insertAccount(db);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const n = await graphNode(db);
    const stored1 = await explicitEdge(db, a.accountId);
    const key = `node:${n}`;

    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      const first = await upsertFrontierCandidate(clientDb(holder), {
        ownerAccountId: a.accountId,
        runId: runA.id,
        nodeId: n,
        dedupeKey: key,
        expiresInDays: 7,
        supportRootIds: [stored1],
      });
      expect(first.created).toBe(true);

      const dedupeConn = await db.pool.connect();
      try {
        await dedupeConn.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await dedupeConn.query('SELECT 1');
        const pid = (await dedupeConn.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const dedupe = upsertFrontierCandidate(clientDb(dedupeConn), {
          ownerAccountId: a.accountId,
          runId: runA.id,
          nodeId: n,
          dedupeKey: key,
          expiresInDays: 7,
        });
        await waitForBlockedOn(db, pid);
        await holder.query('COMMIT');

        // Snapshot-isolated callers cannot silently learn the concurrent
        // commit: the conflict is a serialization failure they must retry,
        // never a response that misreports the retained roots.
        await expect(dedupe).rejects.toMatchObject({ code: '40001' });
        await dedupeConn.query('ROLLBACK');
      } finally {
        dedupeConn.release();
      }
      // Nothing was published by the failed dedupe: the holder's candidate
      // keeps exactly its own roots.
      expect(await storedRoots(db, first.row.id)).toEqual([stored1]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('a dedupe whose conflicting transaction rolls back creates the candidate with its own roots', async () => {
    const a = await insertAccount(db);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const n = await graphNode(db);
    const lostRoot = await explicitEdge(db, a.accountId);
    const ownRoot = await explicitEdge(db, a.accountId);
    const key = `node:${n}`;

    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      const first = await upsertFrontierCandidate(clientDb(holder), {
        ownerAccountId: a.accountId,
        runId: runA.id,
        nodeId: n,
        dedupeKey: key,
        expiresInDays: 7,
        supportRootIds: [lostRoot],
      });
      expect(first.created).toBe(true);

      const dedupeConn = await db.pool.connect();
      try {
        const pid = (await dedupeConn.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const dedupe = upsertFrontierCandidate(clientDb(dedupeConn), {
          ownerAccountId: a.accountId,
          runId: runA.id,
          nodeId: n,
          dedupeKey: key,
          expiresInDays: 7,
          supportRootIds: [ownRoot],
        });
        await waitForBlockedOn(db, pid);
        await holder.query('ROLLBACK');

        // The conflicting candidate vanished, so this call is the creator and
        // only its own offered roots are stored.
        const result = await dedupe;
        expect(result.created).toBe(true);
        expect(result.row.support_root_ids).toEqual([ownRoot]);
        expect(await storedRoots(db, result.row.id)).toEqual([ownRoot]);
      } finally {
        dedupeConn.release();
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('another account dedupes independently while the first candidate is still uncommitted', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const runB = await createGraphRun(db, {
      ownerAccountId: b.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const n = await graphNode(db);
    const rootA = await explicitEdge(db, a.accountId);
    const rootB = await explicitEdge(db, b.accountId);
    const key = `node:${n}`; // same key string, different owner: no conflict

    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      const first = await upsertFrontierCandidate(clientDb(holder), {
        ownerAccountId: a.accountId,
        runId: runA.id,
        nodeId: n,
        dedupeKey: key,
        expiresInDays: 7,
        supportRootIds: [rootA],
      });
      expect(first.created).toBe(true);

      // B's candidate neither waits on A's transaction nor sees A's row: the
      // dedupe conflict scope is the (owner, dedupe key) pair and the root
      // relation is owner-bound.
      const other = await upsertFrontierCandidate(db, {
        ownerAccountId: b.accountId,
        runId: runB.id,
        nodeId: n,
        dedupeKey: key,
        expiresInDays: 7,
        supportRootIds: [rootB],
      });
      expect(other.created).toBe(true);
      expect(other.row.support_root_ids).toEqual([rootB]);
      expect(other.row.id).not.toBe(first.row.id);

      await holder.query('COMMIT');
      // After A's commit each account retains exactly its own stored roots.
      expect(await storedRoots(db, first.row.id)).toEqual([rootA]);
      expect(await storedRoots(db, other.row.id)).toEqual([rootB]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('a dedupe hit on a candidate stored without roots keeps reporting the empty root set', async () => {
    const a = await insertAccount(db);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const n = await graphNode(db);
    const offered = await explicitEdge(db, a.accountId);
    const key = `node:${n}`;

    const holder = await db.pool.connect();
    let first: FrontierUpsertResult | undefined;
    try {
      await holder.query('BEGIN');
      first = await upsertFrontierCandidate(clientDb(holder), {
        ownerAccountId: a.accountId,
        runId: runA.id,
        nodeId: n,
        dedupeKey: key,
        expiresInDays: 7,
      });
      expect(first.created).toBe(true);
      expect(first.row.support_root_ids).toEqual([]);

      const dedupeConn = await db.pool.connect();
      try {
        const pid = (await dedupeConn.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const dedupe = upsertFrontierCandidate(clientDb(dedupeConn), {
          ownerAccountId: a.accountId,
          runId: runA.id,
          nodeId: n,
          dedupeKey: key,
          expiresInDays: 7,
          supportRootIds: [offered],
        });
        await waitForBlockedOn(db, pid);
        await holder.query('COMMIT');

        // The stored candidate genuinely has no roots: the honest answer
        // stays empty even though the offered root is a valid same-owner id.
        const result = await dedupe;
        expect(result.created).toBe(false);
        expect(result.row.support_root_ids).toEqual([]);
        expect(await storedRoots(db, first.row.id)).toEqual([]);
      } finally {
        await dedupeConn.query('ROLLBACK').catch(() => undefined);
        dedupeConn.release();
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('a foreign root still fails the creating call atomically while a neighbor candidate is held open', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const n1 = await graphNode(db);
    const n2 = await graphNode(db);
    const rootA = await explicitEdge(db, a.accountId);
    const rootB = await explicitEdge(db, b.accountId);

    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      const held = await upsertFrontierCandidate(clientDb(holder), {
        ownerAccountId: a.accountId,
        runId: runA.id,
        nodeId: n1,
        dedupeKey: `node:${n1}`,
        expiresInDays: 7,
        supportRootIds: [rootA],
      });
      expect(held.created).toBe(true);

      // A different key in the same account: the single statement still
      // rejects the foreign root and leaves no candidate behind.
      await expect(
        upsertFrontierCandidate(db, {
          ownerAccountId: a.accountId,
          runId: runA.id,
          nodeId: n2,
          dedupeKey: `node:${n2}`,
          expiresInDays: 7,
          supportRootIds: [rootB],
        }),
      ).rejects.toThrow(/foreign key/i);
      const { rows } = await db.query<{ n: number }>(
        'SELECT count(*) AS n FROM graph_frontier WHERE owner_account_id = $1 AND dedupe_key = $2',
        [a.accountId, `node:${n2}`],
      );
      expect(Number(rows[0]!.n)).toBe(0);
      await holder.query('COMMIT');
      expect(await storedRoots(db, held.row.id)).toEqual([rootA]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});
