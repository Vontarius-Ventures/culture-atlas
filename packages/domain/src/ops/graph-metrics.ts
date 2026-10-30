import type { Queryable } from '../db/pool';
import { logEvent } from './log';

/**
 * Privacy-safe interest-graph observability (PR 8 operations, VAL-OPS-003).
 *
 * Everything here is computed from DURABLE state only: ids, revisions,
 * counts, codes and lags. No photo, title, interest text, claim, email or
 * secret is ever read or emitted — the snapshot queries aggregate rows and
 * the sampled run-outcome lines are allowlisted, so the telemetry surface
 * cannot carry private content even by mistake.
 *
 * The snapshot feeds the graph rollout's operational targets (see
 * docs/runbooks/graph-rollout.md):
 *  - projection lag (the oldest pending outbox intent) and pending backlog;
 *  - run failures in the last hour and the oldest still-queued/running run;
 *  - publication rejections (fence violations and rollback-disabled stops)
 *    in the last hour;
 *  - work-budget windows whose anchored deadline passed while still active
 *    (a crashed or stalled worker: the window never re-anchors);
 *  - the durable spend ledger's outstanding reservation charge, settled cost
 *    and unknown-outcome attempts (VAL-OPS-002: the inputs of the total
 *    ceiling decision);
 *  - owed account deletions and the oldest one's purge lag (VAL-DELETE-004:
 *    cleanup stays owed and observable while graph flags are off).
 */
export interface GraphOpsSnapshot {
  /** Oldest pending graph_outbox projection intent; alert when it grows. */
  GraphProjectionLagSeconds: number;
  /** Projection intents still pending dispatch. */
  GraphOutboxPending: number;
  /** graph_runs that failed in the last hour. */
  GraphRunsFailedLastHour: number;
  /** Oldest run still queued or running (age in seconds). */
  GraphRunLagSeconds: number;
  /**
   * Expansion publications refused in the last hour: fence rejections
   * (stale authority) and rollback-disabled stops (a flag kill landed at or
   * before the publication fence, VAL-OPS-001). Benign skips are excluded.
   */
  GraphExpansionRejectionsLastHour: number;
  /** Active work budgets whose anchored deadline already passed. */
  GraphBudgetWindowsStuck: number;
  /** Reserved micros of every not-yet-settled ledger attempt (worst-case charge). */
  ModelReservedMicros: number;
  /** Settled (billed) micros across the durable ledger. */
  ModelSettledMicros: number;
  /** Attempts whose billing outcome is still unknown. */
  ModelUnknownAttempts: number;
  /** Accepted account deletions whose durable cleanup has not completed. */
  AccountDeletionsOwed: number;
  /** Seconds since the oldest owed deletion was accepted. */
  AccountPurgeLagSeconds: number;
}

const GRAPH_OPS_METRIC_NAMES = [
  'GraphProjectionLagSeconds',
  'GraphOutboxPending',
  'GraphRunsFailedLastHour',
  'GraphRunLagSeconds',
  'GraphExpansionRejectionsLastHour',
  'GraphBudgetWindowsStuck',
  'ModelReservedMicros',
  'ModelSettledMicros',
  'ModelUnknownAttempts',
  'AccountDeletionsOwed',
  'AccountPurgeLagSeconds',
] as const satisfies ReadonlyArray<keyof GraphOpsSnapshot>;

export async function collectGraphOpsSnapshot(db: Queryable, now = new Date()): Promise<GraphOpsSnapshot> {
  const { rows } = await db.query<Record<keyof GraphOpsSnapshot, string | number | null>>(
    `SELECT
       COALESCE((SELECT EXTRACT(EPOCH FROM ($1::timestamptz - min(created_at)))
         FROM graph_outbox WHERE dispatch_state = 'pending'), 0) AS "GraphProjectionLagSeconds",
       (SELECT count(*) FROM graph_outbox WHERE dispatch_state = 'pending') AS "GraphOutboxPending",
       (SELECT count(*) FROM graph_runs WHERE state = 'failed'
          AND COALESCE(finished_at, updated_at) > $1::timestamptz - interval '1 hour') AS "GraphRunsFailedLastHour",
       COALESCE((SELECT EXTRACT(EPOCH FROM ($1::timestamptz - min(COALESCE(started_at, created_at))))
         FROM graph_runs WHERE state IN ('queued','running')), 0) AS "GraphRunLagSeconds",
       (SELECT count(*) FROM trace_events
         WHERE name IN ('graph_expansion_fenced','graph_expansion_disabled')
           AND created_at > $1::timestamptz - interval '1 hour') AS "GraphExpansionRejectionsLastHour",
       (SELECT count(*) FROM graph_work_budgets
         WHERE state = 'active'
           AND deadline_started_at + (deadline_ms::text || ' milliseconds')::interval < $1) AS "GraphBudgetWindowsStuck",
       COALESCE((SELECT SUM(reserved_micros) FROM inference_attempts WHERE state <> 'settled'), 0) AS "ModelReservedMicros",
       COALESCE((SELECT SUM(cost_micros) FROM inference_attempts WHERE state = 'settled'), 0) AS "ModelSettledMicros",
       (SELECT count(*) FROM inference_attempts WHERE state = 'unknown') AS "ModelUnknownAttempts",
       (SELECT count(*) FROM account_deletions
         WHERE cleanup_state IN ('pending','purging','failed')) AS "AccountDeletionsOwed",
       COALESCE((SELECT EXTRACT(EPOCH FROM ($1::timestamptz - min(accepted_at)))
         FROM account_deletions WHERE cleanup_state IN ('pending','purging','failed')), 0) AS "AccountPurgeLagSeconds"`,
    [now],
  );
  const row = rows[0]!;
  const out = {} as GraphOpsSnapshot;
  for (const name of GRAPH_OPS_METRIC_NAMES)
    out[name] = Math.max(0, Math.round(Number(row[name] ?? 0)));
  return out;
}

/**
 * One JSON log line in CloudWatch Embedded Metric Format (same shape as
 * toEmbeddedMetricLine in metrics.ts). Without CloudWatch the line is still a
 * readable structured log; with it the eleven values publish as custom
 * metrics.
 */
export function toGraphOpsMetricLine(
  snapshot: GraphOpsSnapshot,
  options: { namespace: string; environment: string; now?: Date },
): string {
  return JSON.stringify({
    _aws: {
      Timestamp: (options.now ?? new Date()).getTime(),
      CloudWatchMetrics: [
        {
          Namespace: options.namespace,
          Dimensions: [['Environment']],
          Metrics: GRAPH_OPS_METRIC_NAMES.map((name) => ({
            Name: name,
            Unit: name.endsWith('Seconds') ? 'Seconds' : 'Count',
          })),
        },
      ],
    },
    Environment: options.environment,
    event: 'graph_ops_snapshot',
    ...snapshot,
  });
}

/** A sampled run outcome: ids, codes and revisions only. */
export interface GraphRunOutcome {
  run_id: string;
  run_kind: string;
  state: string;
  published: boolean;
  input_taste_revision: number;
  input_projection_revision: number;
}

/**
 * The most recent run outcomes, newest first. Sampled for log lines, never
 * bulk-exported: the durable rows stay the source of truth.
 */
export async function recentGraphRunOutcomes(db: Queryable, limit = 5): Promise<GraphRunOutcome[]> {
  const { rows } = await db.query<GraphRunOutcome>(
    `SELECT id AS run_id, run_kind, state, published, input_taste_revision, input_projection_revision
       FROM graph_runs ORDER BY created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(50, Math.floor(limit)))],
  );
  return rows;
}

/**
 * One allowlisted log line per sampled run outcome: run id, kind, state,
 * published flag and the taste revision it covered. The allowlist cannot pass
 * titles, names or free text even if a future field tried (ops/log.ts).
 */
export function graphRunOutcomeLine(outcome: GraphRunOutcome, now = new Date()): void {
  logEvent(
    'info',
    'graph_run_outcome',
    {
      run_id: outcome.run_id,
      kind: outcome.run_kind,
      outcome: outcome.state,
      published: outcome.published,
      revision: outcome.input_taste_revision,
    },
    now,
  );
}
