import type { Db, Queryable } from '../db/pool';

/**
 * Discovery refresh state (VAL-DISC-003, VAL-DISC-007): the durable pause and
 * the expansion due marker, one `graph_refresh_state` row per account.
 *
 * The pause is the primitive behind Settings → Taste's background toggle
 * (VAL-FEED-001): it stops expansion and relation-research DISPATCH and
 * PUBLICATION only — never the authoritative projection, retraction, support
 * removal or deletion cleanup, which continue for a paused account exactly as
 * before. Resume never replays stale paused work: the next dispatch reads
 * CURRENT authority, because every check (gate, due marker, fences) is made
 * against current committed state at dispatch/publication time.
 *
 * The due marker is stamped by the projector's successful pass: committed
 * fresh support is durably due for one bounded expansion refresh, and the
 * closed-app sweeper (not a feed read) hands it to the queue. The marker
 * survives dispatcher outages and restarts; a completed expansion consumes
 * it; a paused, killed or flag-off account keeps it untouched until eligible.
 */

/**
 * The consistent per-account publication-authority lock (DISC-SCR-008).
 *
 * Pause, resume and BOTH publishers — the expansion publication fence and
 * relation research's storage fence — acquire this row lock before their
 * authority read/write and hold it through their transaction's commit. That
 * makes ordering deterministic where plain READ COMMITTED checks could not:
 * a pause either commits before a publisher's fence read (and is seen, so the
 * publication is rejected) or waits for the publisher's commit (the
 * publication wins the ordering) — it can no longer commit between the
 * publisher's pause check and its publication commit.
 *
 * FOR NO KEY UPDATE is deliberate: it conflicts with pause/resume and with
 * account UPDATE/DELETE (so deletion also orders against publication), while
 * staying compatible with the FOR KEY SHARE locks foreign-key inserts take
 * on this row — projection passes, support removal and deletion cleanup are
 * never blocked by the ordering.
 *
 * Returns false when the account row is gone (the caller reports deletion).
 */
export async function lockAccountPublicationAuthority(db: Queryable, accountId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [accountId]);
  return rows.length > 0;
}

/** Pauses discovery refresh for the account (idempotent; keeps the first pause timestamp). */
export async function pauseGraphDiscovery(db: Db, accountId: string): Promise<{ paused: boolean }> {
  // The lock and the write are ONE transaction, so the ordering lock is held
  // through the commit that makes the pause visible (DISC-SCR-008): a
  // publisher contending on the same row cannot commit between them.
  return db.transaction(async (tx) => {
    await lockAccountPublicationAuthority(tx, accountId);
    await tx.query(
      `INSERT INTO graph_refresh_state (owner_account_id, discovery_paused_at)
       VALUES ($1, now())
       ON CONFLICT (owner_account_id)
         DO UPDATE SET discovery_paused_at = COALESCE(graph_refresh_state.discovery_paused_at, now()), updated_at = now()
          WHERE graph_refresh_state.discovery_paused_at IS NULL`,
      [accountId],
    );
    const pausedAt = await graphDiscoveryPausedAt(tx, accountId);
    return { paused: pausedAt != null };
  });
}

/** Resumes discovery refresh for the account (idempotent). */
export async function resumeGraphDiscovery(db: Db, accountId: string): Promise<void> {
  // Same ordered protocol as pause: the lock is held through the commit.
  await db.transaction(async (tx) => {
    await lockAccountPublicationAuthority(tx, accountId);
    await tx.query(
      `INSERT INTO graph_refresh_state (owner_account_id)
       VALUES ($1)
       ON CONFLICT (owner_account_id)
         DO UPDATE SET discovery_paused_at = NULL, updated_at = now()`,
      [accountId],
    );
  });
}

/** The account's pause timestamp, or null while refreshing is allowed. */
export async function graphDiscoveryPausedAt(db: Queryable, accountId: string): Promise<Date | null> {
  const { rows } = await db.query<{ discovery_paused_at: Date | null }>(
    'SELECT discovery_paused_at FROM graph_refresh_state WHERE owner_account_id = $1',
    [accountId],
  );
  return rows[0]?.discovery_paused_at ?? null;
}

/**
 * The projector's successful pass calls this inside its own transaction:
 * committed fresh support is durably due for one bounded refresh. Plain
 * `now()` keeps the marker in the pass's clock domain.
 */
export async function noteExpansionDue(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    `INSERT INTO graph_refresh_state (owner_account_id, expansion_due_since)
     VALUES ($1, now())
     ON CONFLICT (owner_account_id)
       DO UPDATE SET expansion_due_since = now(), updated_at = now()`,
    [accountId],
  );
}

/**
 * A completed expansion consumes the due marker — but only the portion the
 * run actually covered: a marker stamped AFTER the run's own read (a
 * projection that committed while the expansion was in flight — the very
 * state the publication fence rejects) stays due for the next refresh.
 */
export async function consumeExpansionDue(db: Queryable, input: { accountId: string; dueUntil: Date }): Promise<void> {
  await db.query(
    `UPDATE graph_refresh_state
        SET expansion_due_since = NULL, updated_at = now()
      WHERE owner_account_id = $1
        AND (expansion_due_since IS NULL OR expansion_due_since <= $2)`,
    [input.accountId, input.dueUntil],
  );
}

/** The account's refresh row as the sweeper and handlers see it. */
export interface GraphRefreshRow {
  owner_account_id: string;
  discovery_paused_at: Date | null;
  expansion_due_since: Date | null;
  last_expansion_at: Date | null;
}

export async function loadGraphRefreshRow(db: Queryable, accountId: string): Promise<GraphRefreshRow | null> {
  const { rows } = await db.query<GraphRefreshRow>(
    `SELECT owner_account_id, discovery_paused_at, expansion_due_since, last_expansion_at
       FROM graph_refresh_state WHERE owner_account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}
