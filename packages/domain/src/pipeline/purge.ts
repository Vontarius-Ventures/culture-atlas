import type { JobHandler } from '../jobs/handler';
import { captureObjectPrefix } from '../services/captures';

/**
 * Physically purge deleted captures (purge_after < now), expired anonymous
 * sessions (24h) with all their records and media, expired uploads, expired
 * idempotency keys and feed snapshots. Idempotent and batched; objects are
 * deleted before rows so a crash never leaves orphaned media without a row
 * pointing at it.
 */
const BATCH = 200;

export const purgeDeleted: JobHandler<'purge_deleted'> = async (ctx) => {
  const { db, providers } = ctx;
  const before = ctx.payload.before ? new Date(ctx.payload.before) : new Date();
  const counts = { captures: 0, sessions: 0, uploads: 0, idempotency_keys: 0, feed_snapshots: 0 };
  await ctx.setStage('purging');

  // 1. Deleted captures past their purge time.
  for (;;) {
    await ctx.ensureActive();
    const { rows } = await db.query<{ id: string; owner_account_id: string | null; owner_session_id: string | null }>(
      `SELECT id, owner_account_id, owner_session_id FROM captures
        WHERE deleted_at IS NOT NULL AND purge_after < $1 ORDER BY purge_after LIMIT $2`,
      [before, BATCH],
    );
    if (rows.length === 0) break;
    for (const c of rows) {
      const owner = c.owner_account_id ? { kind: 'account' as const, accountId: c.owner_account_id } : { kind: 'session' as const, sessionId: c.owner_session_id! };
      await providers.storage.deletePrefix(captureObjectPrefix(owner, c.id));
    }
    const r = await db.query('DELETE FROM captures WHERE id = ANY($1::uuid[])', [rows.map((c) => c.id)]);
    counts.captures += r.rowCount ?? 0;
  }

  // 2. Expired, unclaimed anonymous sessions (cascades to every record they own).
  for (;;) {
    await ctx.ensureActive();
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM sessions WHERE account_id IS NULL AND claimed_at IS NULL AND expires_at < $1 ORDER BY expires_at LIMIT $2`,
      [before, BATCH],
    );
    if (rows.length === 0) break;
    for (const s of rows) await providers.storage.deletePrefix(`owners/s-${s.id}`);
    const r = await db.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [rows.map((s) => s.id)]);
    counts.sessions += r.rowCount ?? 0;
  }

  // 3. Expired uploads (captures keep their own copy of the derivative).
  for (;;) {
    await ctx.ensureActive();
    const { rows } = await db.query<{ id: string; object_key: string }>(
      'SELECT id, object_key FROM uploads WHERE expires_at < $1 ORDER BY expires_at LIMIT $2',
      [before, BATCH],
    );
    if (rows.length === 0) break;
    for (const u of rows) {
      const dir = u.object_key.replace(/\/[^/]+$/, '');
      await providers.storage.deletePrefix(dir);
    }
    const r = await db.query('DELETE FROM uploads WHERE id = ANY($1::uuid[])', [rows.map((u) => u.id)]);
    counts.uploads += r.rowCount ?? 0;
  }

  // 4. Expired idempotency keys and feed snapshots.
  counts.idempotency_keys = (await db.query('DELETE FROM idempotency_keys WHERE expires_at < $1', [before])).rowCount ?? 0;
  counts.feed_snapshots = (await db.query('DELETE FROM feed_snapshots WHERE expires_at < $1', [before])).rowCount ?? 0;

  ctx.log('purge complete', counts);
  await ctx.trace({ kind: 'stage', name: 'purge', data: counts });
  return { state: 'complete' };
};
