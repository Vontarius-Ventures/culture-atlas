import type { Db } from '../db/pool';
import { interestGraphExpansionDedupeKey } from '../jobs/dedupe';
import { enqueueJob } from '../jobs/queue';
import {
  GRAPH_EXPANSION_DEADLINE_MS,
  GRAPH_EXPANSION_QLOO_ATTEMPTS,
  ensureGraphWorkBudget,
} from './budgets';
import { discoveryEnabledForAccount, discoveryEnabledInConfig, type DiscoveryGateConfig } from './expansion';
import { loadGraphRefreshRow } from './refresh';
import { PROJECTION_SUPPORT_VERSION } from './schema';

/**
 * The closed-app expansion sweeper (VAL-DISC-003). One cheap indexed pass
 * hands DUE accounts to the existing queue as `expand_interest_graph` jobs:
 *
 *  - DUE means the projector's successful pass stamped a fresh
 *    `expansion_due_since` marker (newer than the last dispatch stamp), or
 *    the periodic window opened (no dispatch for 15 minutes). Feed reads call
 *    the same pass scoped to the reading account, so a read ENQUEUES
 *    deduplicated due work and never does inline provider/model work.
 *  - An account is ELIGIBLE only with current projected support: the state
 *    row is caught up (applied revision, current support semantics) with no
 *    unsatisfied projection intents and no active projection job — expansion
 *    always walks freshly projected roots.
 *  - One active expansion per account (the queue dedupe key includes the
 *    dispatch stamp), so concurrent reads, mutation bursts and sweeper sweeps
 *    coalesce. A dispatched job that never runs still sits in the queue: a
 *    restarted worker claims it; nothing is consumed by dispatch alone.
 *  - Paused, flag-off or killed accounts are skipped with their due markers
 *    retained: nothing about an ineligible sweep consumes due-ness.
 *
 * The job carries the per-job queue budget; the DURABLE budget of the logical
 * expansion (four Qloo attempts including retries, 45-second deadline) is
 * anchored by the handler through the same dedupe key and never resets across
 * lease loss, restart or redelivery (VAL-DISC-006).
 */

/** The periodic refresh bound: at most one dispatch per account per 15 minutes. */
export const GRAPH_EXPANSION_PERIODIC_MS = 15 * 60 * 1000;

export interface DispatchGraphExpansionInput {
  config: DiscoveryGateConfig;
  /** Sweep only this account (feed-read style); omit for the global sweep. */
  ownerAccountId?: string;
  /** Max accounts handled in one sweep pass. */
  limit?: number;
  /** Controlled clock for the periodic window and the dispatch stamp. */
  now?: Date;
}

export interface DispatchedGraphExpansion {
  accountId: string;
  jobId: string;
  /** True when an existing active job already covered the dispatch window. */
  reused: boolean;
  /** 'due' = a fresh projection marker; 'periodic' = the 15-minute window. */
  trigger: 'due' | 'periodic';
}

export interface DispatchGraphExpansionResult {
  accounts: DispatchedGraphExpansion[];
}

export async function dispatchGraphExpansion(
  db: Db,
  input: DispatchGraphExpansionInput,
): Promise<DispatchGraphExpansionResult> {
  // Config gate first: without the operator opt-ins (discovery requires the
  // projection opt-in) nothing can be eligible at all, and due markers stay
  // exactly where they are for a later, enabled sweep.
  if (!discoveryEnabledInConfig(input.config)) return { accounts: [] };
  const now = input.now ?? new Date();
  const limit = Math.max(1, input.limit ?? 50);

  // Eligibility is decided BEFORE the limit. The kill prefilter is the
  // database half of `discoveryEnabledForAccount` for the two graph flags and
  // must stay in sync with `activeKills`; the per-account check in the loop
  // remains the authoritative final gate (the env kill list is invisible to
  // SQL, and a kill can land between this snapshot and the enqueue).
  const { rows } = await db.query<{
    owner_account_id: string;
    expansion_due_since: Date | null;
    last_expansion_at: Date | null;
  }>(
    `SELECT s.owner_account_id, rs.expansion_due_since, rs.last_expansion_at
       FROM personal_graph_state s
       LEFT JOIN graph_refresh_state rs ON rs.owner_account_id = s.owner_account_id
      WHERE s.applied_taste_revision = s.target_taste_revision
        AND s.support_version >= $2
        AND NOT EXISTS (SELECT 1 FROM graph_outbox o
                          WHERE o.owner_account_id = s.owner_account_id
                            AND o.dispatch_state IN ('pending','dispatched'))
        AND NOT EXISTS (SELECT 1 FROM jobs j
                          WHERE j.owner_account_id = s.owner_account_id
                            AND j.type = 'project_interest_graph' AND j.state IN ('queued','running'))
        AND NOT EXISTS (SELECT 1 FROM jobs j
                          WHERE j.owner_account_id = s.owner_account_id
                            AND j.type = 'expand_interest_graph' AND j.state IN ('queued','running'))
        AND NOT EXISTS (SELECT 1 FROM feature_flag_kills k
                          WHERE k.lifted_at IS NULL
                            AND k.flag IN ('interest_graph_discovery_enabled','interest_graph_projection_enabled')
                            AND (k.account_id IS NULL OR k.account_id = s.owner_account_id))
        AND rs.discovery_paused_at IS NULL
        AND (
              (rs.expansion_due_since IS NOT NULL
                 AND (rs.last_expansion_at IS NULL OR rs.expansion_due_since > rs.last_expansion_at))
           OR rs.last_expansion_at IS NULL
           OR rs.last_expansion_at <= $3::timestamptz - make_interval(secs => $5::int)
            )
        AND ($4::uuid IS NULL OR s.owner_account_id = $4::uuid)
      ORDER BY COALESCE(rs.expansion_due_since, rs.last_expansion_at) NULLS FIRST, s.owner_account_id
      LIMIT $1`,
    [limit, PROJECTION_SUPPORT_VERSION, now, input.ownerAccountId ?? null, GRAPH_EXPANSION_PERIODIC_MS / 1000],
  );

  const accounts: DispatchedGraphExpansion[] = [];
  for (const row of rows) {
    const accountId = row.owner_account_id;
    // Final concurrent gate check: a kill or env kill-list entry that landed
    // after the candidate snapshot skips the account; its due marker and
    // dispatch stamp stay exactly where they are.
    if (!(await discoveryEnabledForAccount(db, { accountId, config: input.config }))) continue;

    // The dedupe key is deterministic in the account's PRE-dispatch stamp, so
    // concurrent sweeps compute the same key (one job) while the stamp this
    // pass writes makes the next window's key fresh.
    const { job, reused } = await enqueueJob(db, {
      type: 'expand_interest_graph',
      owner: { kind: 'account', accountId },
      payload: { account_id: accountId },
      dedupeKey: interestGraphExpansionDedupeKey({ accountId, lastExpansionAt: row.last_expansion_at }),
      maxAttempts: 3,
      budget: {
        qloo_requests: GRAPH_EXPANSION_QLOO_ATTEMPTS,
        deadline_ms: GRAPH_EXPANSION_DEADLINE_MS,
      },
      resultType: 'graph_expansion',
    });
    await db.query(
      `INSERT INTO graph_refresh_state (owner_account_id, last_expansion_at)
       VALUES ($1, $2)
       ON CONFLICT (owner_account_id)
         DO UPDATE SET last_expansion_at = $2, updated_at = now()`,
      [accountId, now],
    );
    accounts.push({
      accountId,
      jobId: job.id,
      reused,
      trigger: row.expansion_due_since != null && (row.last_expansion_at == null || row.expansion_due_since > row.last_expansion_at)
        ? 'due'
        : 'periodic',
    });
  }
  return { accounts };
}

/**
 * The durable budget of one dispatched expansion window, pre-anchored at
 * dispatch so the handler's first attempt and every redelivery share one row.
 * Exported for the sweeper's own tests and for operational tooling; the
 * expansion handler performs the same upsert itself, so this is only a
 * convenience for callers that want the budget record to exist before the job
 * is ever claimed (e.g. an operator replaying a window by hand).
 */
export async function anchorExpansionBudget(
  db: Db,
  input: { accountId: string; dedupeKey: string; at?: Date },
): Promise<ReturnType<typeof ensureGraphWorkBudget>> {
  return ensureGraphWorkBudget(db, {
    ownerAccountId: input.accountId,
    workKind: 'expansion',
    workKey: input.dedupeKey,
    at: input.at,
  });
}

/** The refresh row of one account (sweeper observability; also feeds tests). */
export async function refreshRowFor(db: Db, accountId: string) {
  return loadGraphRefreshRow(db, accountId);
}
