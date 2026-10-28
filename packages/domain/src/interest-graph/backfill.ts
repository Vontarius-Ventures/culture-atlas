import type { Db } from '../db/pool';
import { projectionEnabledForAccount, type ProjectionGateConfig } from './intent';
import { projectAccountInterestGraph } from './projector';

/**
 * Checkpointed current-state backfill (PR 8 package B). Accounts that gathered
 * explicit state before the projection flag existed have no historical intent
 * rows: they are rebuilt from CURRENT authority and labeled
 * backfill_current_state, never from invented event provenance.
 *
 * The unit of work is one account, so the durable checkpoint is honest by
 * construction: an account only passes the checkpoint after its projection
 * committed, and re-projecting any account (crash, replay, restart) adds
 * nothing because the projection is a deterministic rebuild. The singleton
 * graph_backfill_state row keeps the last account the backfill projected, the
 * cumulative counts and the completion state.
 *
 * A run sweeps its population in batches. After a sweep, anything still due
 * (a mutation that landed during the sweep) forces another sweep from the
 * start; completion requires a full sweep that projects nothing. Accounts the
 * flag is off for stay due and are skipped without being counted — the result
 * reports them in dueRemaining. Scoped runs (accountIds) re-project exactly
 * those accounts, the targeted ops-tooling shape.
 */

export interface RunInterestGraphBackfillInput {
  config: ProjectionGateConfig;
  /** Restrict the run to exactly these accounts (targeted re-run); omit for the whole population. */
  accountIds?: readonly string[];
  /** Accounts per due-scan batch. */
  batchSize?: number;
  /** Hard cap on accounts projected in one call; hitting it leaves the run incomplete. */
  maxAccounts?: number;
  /** Sweep bound per call; continuous mutation leaves the run incomplete. */
  maxSweeps?: number;
}

export interface BackfillResult {
  state: 'complete' | 'incomplete';
  /** Accounts this call projected. */
  accountsProjected: number;
  /** Sweeps this call performed. */
  sweeps: number;
  /** Accounts still due after the run (waiting on the flag, or beyond this call's bounds). */
  dueRemaining: number;
  /** Last account the durable checkpoint recorded (null after completion). */
  checkpoint: string | null;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ACCOUNTS = 500;
const DEFAULT_MAX_SWEEPS = 5;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** An account is due when its projection is behind current authority. */
const DUE_PREDICATE = `(
     NOT EXISTS (SELECT 1 FROM personal_graph_state s WHERE s.owner_account_id = a.id)
     OR EXISTS (
           SELECT 1 FROM personal_graph_state s
            WHERE s.owner_account_id = a.id
              AND (s.applied_taste_revision < COALESCE(
                     (SELECT t.revision FROM taste_profiles t WHERE t.owner_account_id = a.id), 0)
                   OR EXISTS (SELECT 1 FROM graph_outbox o
                               WHERE o.owner_account_id = a.id
                                 AND o.dispatch_state IN ('pending','dispatched')))))`;

export async function runInterestGraphBackfill(db: Db, input: RunInterestGraphBackfillInput): Promise<BackfillResult> {
  const batchSize = Math.max(1, input.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxAccounts = Math.max(0, input.maxAccounts ?? DEFAULT_MAX_ACCOUNTS);
  const maxSweeps = Math.max(1, input.maxSweeps ?? DEFAULT_MAX_SWEEPS);
  const scoped = input.accountIds !== undefined;
  const ids = input.accountIds ? [...input.accountIds] : null;

  await db.query('INSERT INTO graph_backfill_state (id) VALUES (1) ON CONFLICT DO NOTHING');
  const { rows: initial } = await db.query<{ checkpoint: string | null }>(
    `UPDATE graph_backfill_state
        SET state = 'running', finished_at = NULL, updated_at = now(), passes = passes + 1
      WHERE id = 1
      RETURNING last_owner_account_id AS checkpoint`,
  );
  // Global runs resume after the durable cursor; a closing full sweep from the
  // start re-checks everything before completion. Scoped runs always sweep
  // their whole set.
  let checkpoint = scoped ? null : initial[0]?.checkpoint ?? null;
  let accountsProjected = 0;
  let sweeps = 0;
  let exhausted = false;
  let complete = false;

  while (sweeps < maxSweeps) {
    sweeps += 1;
    const startedFromCursor = checkpoint !== null;
    let projectedThisSweep = 0;
    for (;;) {
      const batch = await dueBatch(db, { checkpoint, ids, batchSize });
      if (batch.length === 0) break;
      for (const accountId of batch) {
        // The checkpoint advances past every examined account, projected or
        // skipped, so one sweep never re-examines the same account.
        checkpoint = accountId;
        if (accountsProjected >= maxAccounts) {
          exhausted = true;
          break;
        }
        if (!(await projectionEnabledForAccount(db, { accountId, config: input.config }))) continue;
        const result = await projectAccountInterestGraph(db, {
          accountId,
          config: input.config,
          source: 'backfill_current_state',
        });
        if (result.projected) {
          accountsProjected += 1;
          projectedThisSweep += 1;
          await db.query(
            `UPDATE graph_backfill_state
                SET last_owner_account_id = $1, accounts_projected = accounts_projected + 1, updated_at = now()
              WHERE id = 1`,
            [accountId],
          );
        }
      }
      if (exhausted) break;
    }
    if (exhausted) break;
    // A full sweep that projects nothing completes the run: everything
    // projectable is projected and only flag-blocked accounts remain due.
    if (projectedThisSweep === 0 && !startedFromCursor) {
      complete = true;
      break;
    }
    // Mutations during the sweep (or a stale cursor) force one more sweep
    // from the start before readiness can be declared.
    checkpoint = null;
  }

  const { rows: remaining } = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM accounts a WHERE ${DUE_PREDICATE} ${ids ? 'AND a.id = ANY($1::uuid[])' : ''}`,
    ids ? [ids] : [],
  );
  if (complete) {
    await db.query(
      `UPDATE graph_backfill_state
          SET state = 'complete', finished_at = now(), last_owner_account_id = NULL, updated_at = now()
        WHERE id = 1`,
    );
    checkpoint = null;
  } else {
    await db.query('UPDATE graph_backfill_state SET state = \'running\', updated_at = now() WHERE id = 1');
  }
  return {
    state: complete ? 'complete' : 'incomplete',
    accountsProjected,
    sweeps,
    dueRemaining: Number(remaining[0]!.n),
    checkpoint,
  };
}

function dueBatch(
  db: Db,
  input: { checkpoint: string | null; ids: string[] | null; batchSize: number },
): Promise<string[]> {
  const scope = input.ids ? 'AND a.id = ANY($2::uuid[])' : '';
  const sql = `SELECT a.id FROM accounts a
                WHERE ${DUE_PREDICATE}
                  AND a.id > COALESCE($1::uuid, '${ZERO_UUID}'::uuid)
                  ${scope}
                ORDER BY a.id
                LIMIT ${input.ids ? '$3' : '$2'}`;
  const params = input.ids ? [input.checkpoint, input.ids, input.batchSize] : [input.checkpoint, input.batchSize];
  return db.query<{ id: string }>(sql, params).then(({ rows }) => rows.map((r) => r.id));
}
