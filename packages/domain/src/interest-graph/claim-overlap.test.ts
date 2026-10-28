import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/pool';
import { claimSession } from '../services/accounts';
import { fillInterestsBoard } from '../services/collections';
import { recordPreference } from '../services/preferences';
import { accountCtx, anonCtx, insertItem } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { loadExplicitSupport } from './explicit-support';
import { projectAccountInterestGraph } from './projector';
import { readReconciledInterestGraph } from './read';

/**
 * Claim/removal operation order (VAL-PROJ-002/003, VAL-CROSS-001): a claim
 * transaction's start `now()` (stamped into every moved event as
 * `claimed_at`) and a remove transaction's start `created_at` are NOT the
 * order in which the save was actually transferred or withdrawn. These
 * barrier-controlled two-connection regressions hold both inversions open
 * across real PostgreSQL connections:
 *
 *  - the claim transaction starts FIRST, but the account withdrawal starts
 *    later and commits before the claim's merge runs;
 *  - the withdrawal transaction starts FIRST, but only executes after the
 *    claim committed and the anonymous save transferred.
 *
 * Either way the outcome must follow the row that was actually transferred
 * or withdrawn, never the transaction timestamps.
 */

const db = getTestDb();
afterAll(closeTestDb);

const projectionOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

/** Separates the two transactions' start clocks deterministically. */
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A Db bound to one already-BEGIN-ning pool client: claimSession only needs
 * a Queryable, while recordPreference composes through savepoints like the
 * production ClientDb.
 */
class ManualClientDb implements Db {
  readonly inTransaction = true;
  private savepoint = 0;

  constructor(private readonly client: PoolClient) {}

  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
    return this.client.query<R>(text, params as unknown[] | undefined);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const name = `manual_sp_${++this.savepoint}`;
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

/** A session save with its save event: the claimed-history shape. */
async function sessionSave(sessionId: string, itemId: string): Promise<void> {
  const { rows: item } = await db.query<{ canonical_key: string }>('SELECT canonical_key FROM discovery_items WHERE id = $1', [itemId]);
  const { rows: saved } = await db.query<{ id: string }>(
    'INSERT INTO saved_items (owner_session_id, discovery_item_id) VALUES ($1, $2) RETURNING id',
    [sessionId, itemId],
  );
  await db.query(
    `INSERT INTO preference_events (owner_session_id, action, target_type, target_id, payload)
     VALUES ($1, 'save', 'discovery_item', $2, $3::jsonb)`,
    [sessionId, itemId, JSON.stringify({ canonical_key: item[0]!.canonical_key, saved_item_id: saved[0]!.id })],
  );
}

/** The account's saved_item support rows keyed by canonical key. */
async function savedItemSupport(accountId: string): Promise<{ canonicalKey: string }[]> {
  const { rows } = await db.query<{ canonical_key: string }>(
    `SELECT di.canonical_key
       FROM personal_interest_support s
       JOIN saved_items si ON si.id = s.saved_item_id
       JOIN discovery_items di ON di.id = si.discovery_item_id
      WHERE s.owner_account_id = $1 AND s.origin_kind = 'saved_item'
      ORDER BY di.canonical_key`,
    [accountId],
  );
  return rows.map((r) => ({ canonicalKey: r.canonical_key }));
}

describe('overlapping claim and withdrawal transactions follow the row actually transferred or withdrawn', () => {
  it('a withdrawal starting after the claim but committing first never suppresses the transferred save', async () => {
    const { principal: account, ctx: actx } = await accountCtx({ config: projectionOn });
    const key = `test:${randomUUID()}`;
    // Both scopes saved the same ownerless shared row.
    const shared = await insertItem(null, { key, kind: 'film', title: 'Shared sample' });
    await recordPreference(actx, { action: 'save', target_type: 'discovery_item', target_id: shared });
    const { principal: anon } = await anonCtx();
    await sessionSave(anon.sessionId, shared);

    // Connection 1 opens the claim's transaction first (its now() is fixed at
    // BEGIN), but the merge inside claimSession has not run yet.
    const claimConn = await db.pool.connect();
    const claimTx = new ManualClientDb(claimConn);
    try {
      await claimTx.query('BEGIN');
      await tick();

      // Connection 2: the account withdraws ITS OWN save in a transaction that
      // starts later and commits before the claim's merge runs.
      const removeConn = await db.pool.connect();
      try {
        const removeTx = new ManualClientDb(removeConn);
        await removeTx.query('BEGIN');
        await tick();
        const removed = await recordPreference({ ...actx, db: removeTx }, {
          action: 'remove',
          target_type: 'discovery_item',
          target_id: shared,
        });
        expect(removed.saved_item).toBeNull();
        await removeTx.query('COMMIT');
      } finally {
        removeConn.release();
      }

      // The claim now proceeds inside the earlier-started transaction: the
      // merge sees the account's row already withdrawn, so the still-active
      // anonymous save transfers. The moved event's claimed_at is the claim
      // transaction's own earlier start — the exact inversion transaction
      // timestamps cannot order.
      const claimed = await claimSession(claimTx, anon.sessionId, account.accountId, new Date(), projectionOn);
      expect(claimed).toEqual({ captures: 0, saved_items: 1 });
      await claimTx.query('COMMIT');
    } finally {
      await claimTx.query('ROLLBACK').catch(() => undefined);
      claimConn.release();
    }

    // The transferred save stays one explicit endorsement — not relabeled
    // exposure-only by the account's withdrawal of its own row.
    const snapshot = await loadExplicitSupport(db, account.accountId);
    expect(snapshot.saves.map((s) => s.canonicalKey)).toEqual([key]);
    expect(snapshot.exposureOnlyItemIds).toEqual([]);

    // The reconciled read honors it before any projection catch-up.
    const read = await readReconciledInterestGraph(db, account.accountId);
    expect(read.interests).toHaveLength(1);
    expect(read.interests[0]).toMatchObject({ canonicalKey: key, origin: 'explicit', state: 'confirmed' });

    // The ready projection agrees on exactly one support whose originating
    // event is the transferred anonymous save, and the claim queued exactly
    // one claim intent (no unintended extra intents).
    await projectAccountInterestGraph(db, { accountId: account.accountId, config: projectionOn, source: 'mutation_intent' });
    expect(await savedItemSupport(account.accountId)).toEqual([{ canonicalKey: key }]);
    const { rows: movedEvent } = await db.query<{ id: string }>(
      `SELECT id FROM preference_events
        WHERE owner_account_id = $1 AND action = 'save' AND payload->>'canonical_key' = $2
          AND payload->>'claimed_session_id' = $3`,
      [account.accountId, key, anon.sessionId],
    );
    const { rows: support } = await db.query<{ originating_event_id: string | null }>(
      `SELECT s.originating_event_id
         FROM personal_interest_support s
        WHERE s.owner_account_id = $1 AND s.origin_kind = 'saved_item'`,
      [account.accountId],
    );
    expect(support).toHaveLength(1);
    expect(support[0]!.originating_event_id).toBe(movedEvent[0]!.id);
    const { rows: claimIntents } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM graph_outbox WHERE owner_account_id = $1 AND event_type = 'claim'`,
      [account.accountId],
    );
    expect(Number(claimIntents[0]!.n)).toBe(1);
  });

  it('a withdrawal starting before the claim but executing after it withdraws the transferred save', async () => {
    const { principal: account, ctx: actx } = await accountCtx({ config: projectionOn });
    const key = `test:${randomUUID()}`;
    // The anonymous history holds the only save, on its own item row.
    const { principal: anon } = await anonCtx();
    const sessItem = await insertItem({ sessionId: anon.sessionId }, { key, kind: 'film', title: 'Transferred twin' });
    await sessionSave(anon.sessionId, sessItem);

    // Connection 1: the account's withdrawal opens first, but only BEGINs —
    // its statements have not run yet.
    const removeConn = await db.pool.connect();
    const removeTx = new ManualClientDb(removeConn);
    try {
      await removeTx.query('BEGIN');
      await tick();

      // Connection 2: the claim starts later and completes first — the
      // anonymous save AND its item transfer to the account.
      const claimed = await db.transaction((tx) => claimSession(tx, anon.sessionId, account.accountId, new Date(), projectionOn));
      expect(claimed).toEqual({ captures: 0, saved_items: 1 });

      // The withdrawal now executes inside the earlier-started transaction:
      // its created_at precedes the claim's claimed_at, yet it finds and
      // deletes the TRANSFERRED save row. The withdrawal must be honored.
      const removed = await recordPreference({ ...actx, db: removeTx }, {
        action: 'remove',
        target_type: 'discovery_item',
        target_id: sessItem,
      });
      expect(removed.saved_item).toBeNull();
      expect(removed.undo).toMatchObject({ action: 'save', target_type: 'discovery_item', target_id: sessItem });
      await removeTx.query('COMMIT');
    } finally {
      await removeTx.query('ROLLBACK').catch(() => undefined);
      removeConn.release();
    }

    // Nothing remains explicit, and auto-fill cannot revive the withdrawn
    // transferred save through an exposure-only re-file.
    expect((await loadExplicitSupport(db, account.accountId)).saves).toEqual([]);
    await fillInterestsBoard(db, account.accountId, [sessItem]);
    const after = await loadExplicitSupport(db, account.accountId);
    expect(after.saves).toEqual([]);
    expect(after.exposureOnlyItemIds).toEqual([sessItem]);

    // Reconciled reads and the ready projection agree on zero support.
    expect((await readReconciledInterestGraph(db, account.accountId)).interests).toEqual([]);
    await projectAccountInterestGraph(db, { accountId: account.accountId, config: projectionOn, source: 'mutation_intent' });
    expect(await savedItemSupport(account.accountId)).toEqual([]);
  });
});
