import type { Queryable } from '../db/pool';
import { AppError } from '../errors';
import { requireAccountOwner } from '../authz';
import type { AccountPrincipal } from '../principal';
import type { ServiceContext } from '../context';
import { enqueueJob } from '../jobs/queue';
import { endCaptureAuthority } from '../capture-v2/devices';
import { endAuthority, getAuthorityLifecycle } from './native-sessions';
import { hashToken, randomToken } from './auth';
import {
  type AccountDeletionDisclosure,
  RequestAccountDeletionRequest,
  type AccountDeletionOverviewResponse,
  type AccountDeletionStatus,
  type AccountDeletionStatusResponse,
  type RequestAccountDeletionResponse,
} from '../schemas/account-deletion';

/**
 * Account deletion lifecycle (VAL-DELETE-002/003/004): the owner asks, one
 * transaction accepts, a durable job cleans up, and an honest status record
 * answers without restoring any authority.
 *
 * ACCEPTANCE is a single transaction that takes the account's publication-
 * authority row lock (the same one graph pause/publication fences use, so
 * this orders against every producer) and commits, together:
 *
 *  - the `accounts.deleted_at` tombstone every publication fence checks;
 *  - the durable `account_deletions` record (cleanup status + token hash);
 *  - cancellation of every queued/running job and v2 media work row, so
 *    workers stop at their next liveness check and can never be re-claimed;
 *  - kill rows for the four interest-graph flags, so outbox replay and the
 *    expansion/research sweeps never re-arm the account's work;
 *  - a `deletion_generation` bump, so in-flight graph passes are stale even
 *    if they somehow passed the row fence;
 *  - revocation of every credential: sessions, agent tokens, native session
 *    families, share links/invites/sessions, sensor connections, and the
 *    capture-v2 device authority (installations, capture sessions, uploads);
 *  - the `purge_account` job (system-owned: it must survive its own work).
 *
 * The tombstone is the fence during the pending window (the accounts row
 * still exists); the hard row delete at the end of the durable cleanup is
 * the airtight fence afterwards (no FK insert can name a deleted account).
 *
 * The status token is a capability, not a credential: it reads one deletion
 * record's progress and restores no authority. Only its SHA-256 is stored.
 */

/** The required private stores, in the order the purge job runs them. */
export const ACCOUNT_PURGE_STEPS = ['media_objects', 'private_rows'] as const;
export type AccountPurgeStep = (typeof ACCOUNT_PURGE_STEPS)[number];

export const ACCOUNT_PURGE_STEP_LABELS: Record<AccountPurgeStep, string> = {
  media_objects: 'Your media objects (photos, uploads, derivatives) are deleted from private storage.',
  private_rows: 'Every private record — captures, analyses, saves, collections, plans, preferences, graph, traces — is deleted.',
};

/** The four interest-graph flags whose account kills fence replay and sweeps. */
export const ACCOUNT_DELETION_GRAPH_KILLS = [
  'interest_graph_projection_enabled',
  'interest_graph_discovery_enabled',
  'interest_graph_research_enabled',
  'interest_graph_framework_shadow_enabled',
] as const;

/** The truthful disclosure served with every status answer (VAL-DELETE-004). */
export const ACCOUNT_DELETION_DISCLOSURE: AccountDeletionDisclosure = {
  summary:
    'Deleting your account revokes every credential immediately and purges every private store through a durable cleanup. Completion is claimed only after that cleanup finished; failures stay visible and retry. Shared cultural facts and other accounts are untouched.',
  immediate: [
    'Every browser session, agent token, native phone installation, share link and sensor connection is revoked.',
    'Every queued or running analysis, discovery, research and graph job for the account is cancelled and can never publish.',
  ],
  cleanup_steps: ACCOUNT_PURGE_STEPS.map((step) => ACCOUNT_PURGE_STEP_LABELS[step]),
  retained: [
    'Independently sourced cultural facts stay: they are shared public data and never contained your private context.',
    'Security and abuse-prevention logs are kept for a bounded operational window with your account reference removed; they never contain photos or library data.',
    "Provider-side processing records (for example the vision model's) follow the provider's documented retention terms; this server cannot delete them.",
    'Encrypted backups roll off on the platform schedule; a deleted account is never restored from them.',
  ],
};

interface DeletionRow {
  account_id: string;
  cleanup_state: 'pending' | 'purging' | 'failed' | 'complete';
  requested_at: Date;
  accepted_at: Date;
  completed_at: Date | null;
  completed_steps: string[];
  attempts: number;
  last_error_code: string | null;
}

function statusOf(row: DeletionRow): AccountDeletionStatus {
  const completed = row.completed_steps;
  return {
    state: row.cleanup_state,
    requested_at: row.requested_at.toISOString(),
    accepted_at: row.accepted_at.toISOString(),
    completed_at: row.completed_at ? row.completed_at.toISOString() : null,
    completed_steps: completed,
    pending_steps: ACCOUNT_PURGE_STEPS.filter((step) => !completed.includes(step)),
    attempts: row.attempts,
    last_error_code: row.last_error_code,
    retrying: row.cleanup_state !== 'complete',
  };
}

const DELETION_COLUMNS = `account_id, cleanup_state, requested_at, accepted_at, completed_at, completed_steps, attempts, last_error_code`;

async function loadDeletion(db: Queryable, accountId: string): Promise<DeletionRow | null> {
  const { rows } = await db.query<DeletionRow>(
    `SELECT ${DELETION_COLUMNS} FROM account_deletions WHERE account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

/** GET /v2/me/account-deletion — the owner's honest state, disclosure included. */
export async function getAccountDeletionOverview(ctx: ServiceContext): Promise<AccountDeletionOverviewResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const row = await loadDeletion(ctx.db, owner.accountId);
  if (!row) {
    return { requested: false, state: 'none', status: null, disclosure: ACCOUNT_DELETION_DISCLOSURE };
  }
  return { requested: true, state: row.cleanup_state, status: statusOf(row), disclosure: ACCOUNT_DELETION_DISCLOSURE };
}

/**
 * GET /v2/account-deletion/status — the one-time capability token answers the
 * lifecycle snapshot after every authority is gone. A wrong or missing token
 * discloses nothing (the caller sees not_found). Never restores authority.
 */
export async function getAccountDeletionStatusByToken(
  db: Queryable,
  token: string,
): Promise<AccountDeletionStatusResponse | null> {
  if (!token || token.length > 256) return null;
  const { rows } = await db.query<DeletionRow>(
    `SELECT ${DELETION_COLUMNS} FROM account_deletions WHERE status_token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return { status: statusOf(row), disclosure: ACCOUNT_DELETION_DISCLOSURE };
}

/**
 * POST /v2/me/account-deletion — accept the deletion. Idempotent: a retry
 * returns the same durable status and never re-runs a revocation, never
 * re-mints the token, and never enqueues a second purge job.
 */
export async function requestAccountDeletion(
  ctx: ServiceContext,
  input: unknown,
): Promise<RequestAccountDeletionResponse> {
  const owner: AccountPrincipal = requireAccountOwner(ctx.principal);
  const parsed = RequestAccountDeletionRequest.safeParse(input);
  if (!parsed.success) {
    throw new AppError('invalid_input', { message: 'The request is not valid.', details: parsed.error.issues });
  }
  const body = parsed.data;
  const token = body.status_token ?? randomToken(32);
  const now = ctx.now();
  const accountId = owner.accountId;

  return ctx.db.transaction(async (tx) => {
    // The publication-authority lock: the same row lock pause/resume, the
    // projector, expansion, research and the compiler publication fence take.
    // A producer either publishes before this commits (its rows are purged by
    // the cleanup) or waits and then sees the tombstone and refuses.
    const { rows: account } = await tx.query<{ id: string }>(
      'SELECT id FROM accounts WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE',
      [accountId],
    );

    if (account.length === 0 || (await loadDeletion(tx, accountId))) {
      // Already accepted (or gone): idempotent. The deletion stands; the
      // caller's token is echoed only when it hashes to the stored one, and
      // nothing re-runs, re-mints or re-enqueues.
      const existing = await loadDeletion(tx, accountId);
      if (!existing) throw new AppError('not_found', { message: 'Account not found.' });
      const stored = await storedTokenHash(tx, accountId);
      return {
        status: statusOf(existing),
        status_token: hashToken(token) === stored ? token : null,
        disclosure: ACCOUNT_DELETION_DISCLOSURE,
      };
    }

    // 1. The tombstone every publication fence checks.
    await tx.query('UPDATE accounts SET deleted_at = $2 WHERE id = $1', [accountId, now]);
    // 2. The durable cleanup record (outlives the account row on purpose).
    await tx.query(
      `INSERT INTO account_deletions (account_id, status_token_hash, requested_at, accepted_at, requested_by_session_id)
       VALUES ($1, $2, $3, $3, $4)`,
      [accountId, hashToken(token), now, owner.sessionId],
    );

    // 3. Cancel every producer on the shared queue: queued jobs die now,
    // running ones at their next heartbeat (and never claim a retry).
    await tx.query(
      `UPDATE jobs SET cancel_requested_at = COALESCE(cancel_requested_at, $2),
              state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
              finished_at = CASE WHEN state = 'queued' THEN now() ELSE finished_at END,
              updated_at = now()
        WHERE owner_account_id = $1 AND state IN ('queued', 'running')`,
      [accountId, now],
    );
    // 4. Cancel the v2 media pipeline the same way: a held lease can no
    // longer pass its publication-time lease assertion.
    await tx.query(
      `UPDATE capture_work SET state = 'cancelled' WHERE account_id = $1 AND state IN ('queued', 'running')`,
      [accountId],
    );
    await tx.query(
      `UPDATE media_analysis_requests SET state = 'cancelled' WHERE account_id = $1 AND state IN ('queued', 'running')`,
      [accountId],
    );

    // 5. Fence graph replay: kill the four interest-graph flags for this
    // account, so outbox dispatch and the expansion/research sweeps skip it
    // (the row/tombstone fences below remain the authoritative gates).
    for (const flag of ACCOUNT_DELETION_GRAPH_KILLS) {
      await tx.query(
        `INSERT INTO feature_flag_kills (account_id, flag, reason, created_by)
         VALUES ($1, $2, 'account_deletion', 'system:account-deletion')
         ON CONFLICT DO NOTHING`,
        [accountId, flag],
      );
    }
    // 6. A held graph pass that somehow passed the row fence is stale anyway.
    await tx.query(
      `UPDATE personal_graph_state SET deletion_generation = deletion_generation + 1, updated_at = now()
        WHERE owner_account_id = $1`,
      [accountId],
    );

    // 7. Revoke every credential. All statements are COALESCE-idempotent so a
    // retry of a partially-visible transaction never moves a timestamp twice.
    await tx.query(`UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE account_id = $1 AND revoked_at IS NULL`, [
      accountId,
      now,
    ]);
    await tx.query(
      `UPDATE agent_connections SET revoked_at = COALESCE(revoked_at, $2) WHERE owner_account_id = $1 AND revoked_at IS NULL`,
      [accountId, now],
    );
    await tx.query(
      `UPDATE native_sessions SET revoked_at = COALESCE(revoked_at, $2), revoke_reason = 'account_deletion'
        WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId, now],
    );
    await tx.query(`UPDATE sensor_connections SET enabled = false, updated_at = now() WHERE owner_account_id = $1 AND enabled`, [
      accountId,
    ]);
    await tx.query(
      `UPDATE collection_shares SET revoked_at = COALESCE(revoked_at, $2), revoke_reason = 'owner'
        WHERE owner_account_id = $1 AND revoked_at IS NULL`,
      [accountId, now],
    );
    await tx.query(
      `UPDATE share_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE owner_account_id = $1 AND revoked_at IS NULL`,
      [accountId, now],
    );
    await tx.query(
      `UPDATE share_invites SET revoked_at = COALESCE(revoked_at, $2)
        WHERE owner_account_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [accountId, now],
    );

    // 8. End the capture-v2 device authority in the same transaction: the
    // identity event, and the device cleanup through the runtime-installed
    // lifecycle hook — or inline when no runtime installed one, so the
    // acceptance is complete in every process (web, worker, tests). The two
    // never run together (endAuthority fires the hook itself).
    const event = { accountId, installationId: null, sessionId: null, reason: 'account_deletion', now };
    await endAuthority(tx, event);
    if (!getAuthorityLifecycle()) await endCaptureAuthority(tx, event);

    // 9. Arm the durable cleanup. System-owned: the job must survive the
    // account rows it deletes; its dedupe key makes the sweep agree.
    await enqueueJob(tx, {
      type: 'purge_account',
      owner: null,
      payload: { account_id: accountId },
      dedupeKey: `purge_account:${accountId}`,
      maxAttempts: 3,
    });

    const record = await loadDeletion(tx, accountId);
    return {
      status: statusOf(record!),
      status_token: token,
      disclosure: ACCOUNT_DELETION_DISCLOSURE,
    };
  });
}

async function storedTokenHash(db: Queryable, accountId: string): Promise<string | null> {
  const { rows } = await db.query<{ status_token_hash: string }>(
    'SELECT status_token_hash FROM account_deletions WHERE account_id = $1',
    [accountId],
  );
  return rows[0]?.status_token_hash ?? null;
}
