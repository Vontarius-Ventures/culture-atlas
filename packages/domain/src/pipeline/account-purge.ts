import { isAppError } from '../errors';
import type { Db, Queryable } from '../db/pool';
import type { JobHandler } from '../jobs/handler';
import { enqueueJob } from '../jobs/queue';
import type { JobOutcome } from '../jobs/types';
import { createMultipartStorage, loadProviderConfig, type MultipartStorage, type ProviderError } from '@culture-atlas/providers';
import { ACCOUNT_PURGE_STEPS, type AccountPurgeStep } from '../services/account-deletion';

export { ACCOUNT_PURGE_STEPS } from '../services/account-deletion';

/**
 * Durable private-store cleanup for an accepted account deletion
 * (VAL-DELETE-004). Runs as the system-owned `purge_account` job so it
 * survives the account rows it deletes; acceptance enqueues it and the
 * worker sweep re-arms it after crashes, restarts or terminal failures —
 * the deletion is never lost, and no failure ever restores access.
 *
 * The two required stores, in order:
 *
 *  - `media_objects`: the account's private objects in BOTH storage
 *    namespaces — the v1 object store (`owners/a-<account>/...`: captures,
 *    uploads, analysis display images) and the v2 multipart store
 *    (`accounts/<account>/...`: media originals, derivatives, frames).
 *    Objects go before rows (the house rule: a crash then leaves rows
 *    without media, never orphaned media without rows; the account has no
 *    authority left to serve either).
 *
 *  - `private_rows`: every private record. The tables that reference
 *    `accounts` (and each other) WITHOUT a cascade go first, in foreign-key
 *    dependency order; the final `DELETE FROM accounts` cascades everything
 *    else (81 account-scoped tables). One transaction: the account either
 *    disappears whole or not at all. Shared public facts and other accounts
 *    are never touched.
 *
 * A step is recorded in `account_deletions.completed_steps` only once it is
 * done, and `cleanup_state='complete'` only after ALL of them — the honest
 * status contract. Any failure marks the last attempt's error code and
 * leaves the deletion owed (`failed` + retried by the sweep); the durable
 * record intentionally survives the account row it describes.
 */

let registeredMediaStorage: MultipartStorage | undefined;
/**
 * The worker registers the same multipart storage the web API and media
 * worker use (one namespace); tests register theirs. The lazy default keeps
 * a bare worker honest.
 */
export function setAccountMediaStorage(storage: MultipartStorage | undefined): void {
  registeredMediaStorage = storage;
}
function accountMediaStorage(config: { SESSION_SECRET: string }): MultipartStorage {
  registeredMediaStorage ??= createMultipartStorage(loadProviderConfig(), {
    production: process.env.NODE_ENV === 'production',
    fallbackSigningSecret: config.SESSION_SECRET,
  });
  return registeredMediaStorage;
}

/** One durable cleanup job per account; acceptance and the sweep agree on it. */
export function accountPurgeDedupeKey(accountId: string): string {
  return `purge_account:${accountId}`;
}

/**
 * Re-arm the durable cleanup for every deletion whose work is still owed
 * (pending or last-attempt-failed) and that has no live purge job. Called by
 * the worker sweep; safe to run on any cadence and from any process — a
 * crashed or terminally failed job is re-enqueued, a live one is never
 * duplicated, and a completed deletion is never re-run.
 */
export async function ensureAccountDeletionPurgeJobs(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ account_id: string }>(
    `SELECT d.account_id FROM account_deletions d
      WHERE d.cleanup_state IN ('pending', 'failed')
        AND NOT EXISTS (
              SELECT 1 FROM jobs j
               WHERE j.dedupe_key = 'purge_account:' || d.account_id::text
                 AND j.state IN ('queued', 'running'))
      ORDER BY d.accepted_at
      LIMIT 50`,
  );
  let enqueued = 0;
  for (const row of rows) {
    const { reused } = await enqueueJob(db, {
      type: 'purge_account',
      owner: null,
      payload: { account_id: row.account_id },
      dedupeKey: accountPurgeDedupeKey(row.account_id),
      maxAttempts: 3,
    });
    if (!reused) enqueued += 1;
  }
  return enqueued;
}

async function markStep(db: Queryable, accountId: string, step: AccountPurgeStep): Promise<void> {
  await db.query(
    `UPDATE account_deletions
        SET completed_steps = CASE WHEN $2 = ANY(completed_steps) THEN completed_steps ELSE completed_steps || $2 END,
            updated_at = now()
      WHERE account_id = $1`,
    [accountId, step],
  );
}

async function failAttempt(db: Queryable, accountId: string, err: unknown): Promise<void> {
  const code = (isAppError(err) ? err.code : isProviderError(err) ? 'provider_unavailable' : 'internal').slice(0, 100);
  await db.query(
    `UPDATE account_deletions SET cleanup_state = 'failed', last_error_code = $2, updated_at = now()
      WHERE account_id = $1 AND cleanup_state <> 'complete'`,
    [accountId, code],
  );
}

function isProviderError(err: unknown): err is ProviderError {
  return typeof err === 'object' && err !== null && 'kind' in err && 'provider' in err;
}

/**
 * The account's row deletes that no cascade performs, in foreign-key
 * dependency order, ending with the account row whose cascades remove
 * everything else. Anything NOT in this list cascades from `accounts` (or
 * from a table below) and needs no explicit step.
 */
const ACCOUNT_ROW_PURGES: readonly string[] = [
  // device_commands children, then the commands themselves.
  `DELETE FROM device_command_ack_keys WHERE account_id = $1`,
  `DELETE FROM device_commands WHERE account_id = $1`,
  // v2 media pipeline: work rows reference requests, assets and uploads.
  `DELETE FROM capture_work WHERE account_id = $1`,
  `DELETE FROM media_analysis_requests WHERE account_id = $1`, // frames cascade
  // media_assets' direct children.
  `DELETE FROM audio_analysis_components WHERE account_id = $1`,
  `DELETE FROM audio_analysis_requests WHERE account_id = $1`,
  `DELETE FROM audio_entity_resolutions WHERE account_id = $1`,
  `DELETE FROM media_derivatives WHERE account_id = $1`,
  `DELETE FROM media_evidence WHERE account_id = $1`,
  `DELETE FROM media_segments WHERE account_id = $1`,
  `DELETE FROM media_tracks WHERE account_id = $1`,
  `DELETE FROM recognized_recordings WHERE account_id = $1`,
  `DELETE FROM saved_moments WHERE account_id = $1`,
  // captures reference media_assets (media_asset_id) without a cascade.
  `DELETE FROM captures WHERE owner_account_id = $1`,
  // upload_sessions' children, then the sessions (media_assets' child).
  `DELETE FROM agent_media_uploads WHERE account_id = $1`,
  `DELETE FROM usage_reservations WHERE account_id = $1`, // references upload_sessions
  `DELETE FROM upload_sessions WHERE account_id = $1`,
  `DELETE FROM media_assets WHERE account_id = $1`,
  // mobile_installations' children, then the installations.
  `DELETE FROM capture_sessions WHERE account_id = $1`,
  `DELETE FROM device_events WHERE account_id = $1`,
  `DELETE FROM wearable_connections WHERE account_id = $1`,
  `DELETE FROM mobile_installations WHERE account_id = $1`,
  // The remaining accounts-referencing tables without a cascade.
  `DELETE FROM inference_attempts WHERE account_id = $1`,
  `DELETE FROM model_gateway_attempts WHERE account_id = $1`,
  `DELETE FROM capture_v2_idempotency WHERE account_id = $1`,
  `DELETE FROM capture_enrollment_challenges WHERE account_id = $1`,
  // The hard delete: every other private table cascades from here.
  `DELETE FROM accounts WHERE id = $1`,
];

/**
 * Delete the account's rows, whole, in one transaction. Idempotent: every
 * statement matches what is left, so re-running a crashed attempt converges.
 * No statement names another account's rows.
 */
async function purgeAccountRows(tx: Db, accountId: string): Promise<void> {
  for (const sql of ACCOUNT_ROW_PURGES) await tx.query(sql, [accountId]);
}

/** Queue handler for `purge_account`. */
export const purgeAccount: JobHandler<'purge_account'> = async (ctx): Promise<JobOutcome> => {
  const accountId = ctx.payload.account_id;
  await ctx.setStage('purge_account');
  await ctx.ensureActive();

  // Claim the attempt honestly: 'purging' with attempts+1 before any work,
  // never over a completed record.
  const claim = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<{ cleanup_state: string }>(
      `SELECT cleanup_state FROM account_deletions WHERE account_id = $1 FOR UPDATE`,
      [accountId],
    );
    if (!rows[0] || rows[0]!.cleanup_state === 'complete') return 'done';
    await tx.query(
      `UPDATE account_deletions SET cleanup_state = 'purging', attempts = attempts + 1,
              last_attempt_at = now(), last_error_code = NULL, updated_at = now()
        WHERE account_id = $1`,
      [accountId],
    );
    return 'work';
  });
  if (claim === 'done') return { state: 'complete' };

  try {
    // Step 1: private media objects, both namespaces, objects before rows.
    await ctx.ensureActive();
    await ctx.providers.storage.deletePrefix(`owners/a-${accountId}`);
    await accountMediaStorage(ctx.config).deletePrefix(`accounts/${accountId}`);
    await markStep(ctx.db, accountId, 'media_objects');

    // Step 2: the private rows, whole, in one transaction.
    await ctx.ensureActive();
    await ctx.db.transaction((tx) => purgeAccountRows(tx, accountId));
    await markStep(ctx.db, accountId, 'private_rows');
  } catch (err) {
    // The attempt failed: the work is still owed and honestly labeled. No
    // authority ever comes back with it (acceptance revoked everything
    // durably); the sweep re-arms this job after the queue's own retries.
    await failAttempt(ctx.db, accountId, err).catch(() => undefined);
    throw err;
  }

  // Completion is claimed only now, after every required store is gone.
  await ctx.db.query(
    `UPDATE account_deletions SET cleanup_state = 'complete', completed_at = now(), updated_at = now()
      WHERE account_id = $1`,
    [accountId],
  );
  ctx.log('account purge complete', { accountId, steps: [...ACCOUNT_PURGE_STEPS] });
  await ctx.trace({ kind: 'stage', name: 'purge_account', data: { accountId, steps: [...ACCOUNT_PURGE_STEPS] } });
  return { state: 'complete', resultType: 'account_deletion', resultId: accountId };
};
