import { randomUUID } from 'node:crypto';
import type { QlooProvider } from '@culture-atlas/providers';
import { QlooSession } from '../composer/provider-calls';
import type { Db, Queryable } from '../db/pool';

/**
 * Durable budgets of one LOGICAL graph work item (VAL-DISC-006).
 *
 * A logical expansion or relation-research item makes at most
 * `GRAPH_EXPANSION_QLOO_ATTEMPTS` Qloo HTTP attempts including retries and
 * honors a `GRAPH_EXPANSION_DEADLINE_MS` logical deadline. The budget lives in
 * the `graph_work_budgets` row keyed by the item's logical identity (the queue
 * dedupe key of the expansion dispatch window, or the research pair): the
 * FIRST job attempt anchors the deadline and creates the allowance, and every
 * later attempt — after lease loss, worker restart or redelivery — reserves
 * against the very same row. Nothing about a retry resets attempts, the
 * deadline or the spend accounting.
 *
 * Reservations are single atomic UPDATEs (`qloo_attempts_used + 1` guarded by
 * the cap), so concurrent sessions or processes can never exceed the cap, and
 * a stopped budget refuses further work. The Qloo session built here wraps the
 * CALLER'S shared provider instance (the same process-wide Qloo concurrency
 * limiter every other Qloo caller uses) with the adapter's own retries
 * disabled, so every HTTP attempt is one counted, durably reserved attempt.
 *
 * Paid research does not flow through this table's money accounting: its paid
 * model calls reserve through the existing model-gateway spend ledger (durable
 * account/global daily limits). A research work item still anchors its logical
 * deadline here and carries `qloo_attempts_max = 0` — relation research makes
 * no Qloo calls, so any accidental Qloo usage in that path is refused.
 */

/** PR 8 operational bound: Qloo HTTP attempts per logical expansion, retries included. */
export const GRAPH_EXPANSION_QLOO_ATTEMPTS = 4;

/** PR 8 operational bound: the logical deadline of one expansion or research item. */
export const GRAPH_EXPANSION_DEADLINE_MS = 45_000;

export interface GraphWorkBudgetRow {
  id: string;
  owner_account_id: string;
  work_kind: 'expansion' | 'research';
  work_key: string;
  qloo_attempts_used: number;
  qloo_attempts_max: number;
  deadline_started_at: Date;
  deadline_ms: number;
  state: 'active' | 'stopped' | 'complete';
}

const BUDGET_COLUMNS = `id, owner_account_id, work_kind, work_key, qloo_attempts_used, qloo_attempts_max,
                       deadline_started_at, deadline_ms, state`;

export interface GraphWorkBudgetState {
  row: GraphWorkBudgetRow;
  /** True when this call created the row (the first attempt of the logical item). */
  created: boolean;
  /** Durable attempts still reservable right now. */
  remainingQlooAttempts: number;
  /** The deadline end, anchored at the first attempt and never re-anchored. */
  deadlineAt: Date;
  /** Milliseconds left on the logical deadline (negative once expired). */
  deadlineRemainingMs: number;
  deadlineExpired: boolean;
}

export interface EnsureGraphWorkBudgetInput {
  ownerAccountId: string;
  workKind: 'expansion' | 'research';
  /** Logical identity of the work item (stable across job attempts). */
  workKey: string;
  /** Controlled clock for the anchor decision (default: now). */
  at?: Date;
  /** Deadline clock for the remaining/expired computation (default: now). */
  now?: Date;
  /** Overrides the work-kind default allowance. */
  qlooAttemptsMax?: number;
  /** Overrides the work-kind default deadline. */
  deadlineMs?: number;
}

/**
 * Creates the logical item's budget on first sight and re-reads the SAME row
 * on every later attempt. The conflict path never rewrites
 * `deadline_started_at`, `qloo_attempts_used` or `qloo_attempts_max`, so a
 * redelivered or restarted job inherits the original anchor and the remaining
 * allowance exactly.
 */
export async function ensureGraphWorkBudget(db: Queryable, input: EnsureGraphWorkBudgetInput): Promise<GraphWorkBudgetState> {
  const at = input.at ?? new Date();
  const now = input.now ?? new Date();
  const qlooAttemptsMax = input.qlooAttemptsMax ?? (input.workKind === 'expansion' ? GRAPH_EXPANSION_QLOO_ATTEMPTS : 0);
  const deadlineMs = input.deadlineMs ?? GRAPH_EXPANSION_DEADLINE_MS;
  const { rowCount } = await db.query(
    `INSERT INTO graph_work_budgets (owner_account_id, work_kind, work_key, qloo_attempts_max, deadline_started_at, deadline_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_account_id, work_key) DO NOTHING`,
    [input.ownerAccountId, input.workKind, input.workKey, qlooAttemptsMax, at, deadlineMs],
  );
  const { rows } = await db.query<GraphWorkBudgetRow>(
    `SELECT ${BUDGET_COLUMNS} FROM graph_work_budgets WHERE owner_account_id = $1 AND work_key = $2`,
    [input.ownerAccountId, input.workKey],
  );
  const row = rows[0];
  if (!row) throw new Error('Graph work budget row vanished immediately after upsert.');
  const deadlineAt = new Date(row.deadline_started_at.getTime() + row.deadline_ms);
  const deadlineRemainingMs = deadlineAt.getTime() - now.getTime();
  return {
    row,
    created: (rowCount ?? 0) > 0,
    remainingQlooAttempts: Math.max(0, row.qloo_attempts_max - row.qloo_attempts_used),
    deadlineAt,
    deadlineRemainingMs,
    deadlineExpired: deadlineRemainingMs <= 0,
  };
}

/**
 * Atomically reserves one more Qloo HTTP attempt of the logical item; false
 * once the durable cap is reached (or the budget is no longer active). A
 * refused reservation sends no request — the caller stops bounded work
 * instead of starting an uncontrolled paid fallback.
 */
export async function reserveGraphWorkQlooAttempt(
  db: Queryable,
  input: { ownerAccountId: string; workKey: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE graph_work_budgets
        SET qloo_attempts_used = qloo_attempts_used + 1, updated_at = now()
      WHERE owner_account_id = $1 AND work_key = $2 AND state = 'active'
        AND qloo_attempts_used < qloo_attempts_max
      RETURNING id`,
    [input.ownerAccountId, input.workKey],
  );
  return (rowCount ?? 0) > 0;
}

/** Marks the logical item terminal: 'stopped' (deadline/exhaustion) or 'complete'. */
export async function setGraphWorkBudgetState(
  db: Queryable,
  input: { ownerAccountId: string; workKey: string; state: 'stopped' | 'complete' },
): Promise<void> {
  await db.query(
    `UPDATE graph_work_budgets SET state = $3, updated_at = now()
      WHERE owner_account_id = $1 AND work_key = $2`,
    [input.ownerAccountId, input.workKey, input.state],
  );
}

export interface GraphWorkQlooSessionInput {
  ownerAccountId: string;
  workKey: string;
  /** The durable remaining allowance (the session can never spend more). */
  remainingQlooAttempts: number;
  signal?: AbortSignal;
}

/**
 * A Qloo session for graph work: every counted request first reserves one
 * durable attempt, the adapter's own retries are off (so each HTTP attempt is
 * one counted, durably reserved attempt) and the session's request cap is the
 * durable remaining allowance. The session wraps the caller's shared provider
 * instance, so graph work shares the process-wide Qloo throttle with every
 * other caller rather than getting a private one.
 */
export function graphWorkQlooSession(
  qloo: QlooProvider,
  db: Queryable,
  input: GraphWorkQlooSessionInput,
): QlooSession {
  return new QlooSession(qloo, {
    maxRequests: input.remainingQlooAttempts,
    // A retry IS a new HTTP attempt: it must reserve again, never ride free.
    maxRetries: 0,
    signal: input.signal,
    newId: randomUUID,
    clientMaxRetries: 0,
    reserveRequest: () => reserveGraphWorkQlooAttempt(db, { ownerAccountId: input.ownerAccountId, workKey: input.workKey }),
  });
}

/** Re-reads the durable budget row (post-reservation state, tests and telemetry). */
export async function loadGraphWorkBudget(
  db: Db | Queryable,
  input: { ownerAccountId: string; workKey: string },
): Promise<GraphWorkBudgetRow | null> {
  const { rows } = await db.query<GraphWorkBudgetRow>(
    `SELECT ${BUDGET_COLUMNS} FROM graph_work_budgets WHERE owner_account_id = $1 AND work_key = $2`,
    [input.ownerAccountId, input.workKey],
  );
  return rows[0] ?? null;
}
