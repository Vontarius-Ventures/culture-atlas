import type { Queryable } from '../db/pool';

/**
 * Durable spend-ledger reconciliation against the configured ceilings
 * (PR 8 operations, VAL-OPS-002).
 *
 * The report is built from DURABLE rows only: the ledger's reserved/
 * unknown/billed micros and per-provider request counts. No payload,
 * identity, title or secret is read or emitted. It exists so the operator
 * can answer, from the database alone, the two questions the $-ceiling
 * contract asks before any further paid call:
 *
 *  - what has the durable ledger actually charged so far (settled costs plus
 *    every not-yet-settled attempt at its reservation)?
 *  - how much of the ALL-TIME total ceiling does that leave?
 *
 * It deliberately reconciles rather than trusts the ledger's own admission
 * decision: unknown-outcome attempts stay charged at their reservation until
 * billing reconciliation, and provider request counts are activity signals,
 * never proof of billing.
 */
export interface SpendLedgerTotals {
  /** Sum of reserved micros over every not-yet-settled attempt (reserved or unknown state). */
  reservedMicros: number;
  /** Sum of reconciled billed micros over settled attempts. */
  settledMicros: number;
  /** Attempts whose billing outcome is still unknown. */
  unknownAttempts: number;
  /** Every attempt row in the ledger. */
  totalAttempts: number;
  /** The all-time charge the total-ceiling decision uses: settled + outstanding. */
  chargedMicros: number;
}

export async function collectSpendLedgerTotals(db: Queryable): Promise<SpendLedgerTotals> {
  const { rows } = await db.query<{
    reservedMicros: string | number;
    settledMicros: string | number;
    unknownAttempts: string | number;
    totalAttempts: string | number;
  }>(
    `SELECT
       COALESCE(SUM(reserved_micros) FILTER (WHERE state <> 'settled'), 0) AS "reservedMicros",
       COALESCE(SUM(cost_micros) FILTER (WHERE state = 'settled'), 0) AS "settledMicros",
       count(*) FILTER (WHERE state = 'unknown') AS "unknownAttempts",
       count(*) AS "totalAttempts"
     FROM inference_attempts`,
  );
  const row = rows[0]!;
  const reservedMicros = Math.max(0, Math.round(Number(row.reservedMicros ?? 0)));
  const settledMicros = Math.max(0, Math.round(Number(row.settledMicros ?? 0)));
  return {
    reservedMicros,
    settledMicros,
    unknownAttempts: Math.max(0, Math.round(Number(row.unknownAttempts ?? 0))),
    totalAttempts: Math.max(0, Math.round(Number(row.totalAttempts ?? 0))),
    chargedMicros: reservedMicros + settledMicros,
  };
}

/** Counted provider requests by provider and operation. Counts only. */
export interface ProviderQueryActivity {
  provider: string;
  operation: string;
  count: number;
}

/**
 * Live provider request activity grouped by provider and operation. A count
 * is a request that was MADE, not a charge that was billed: it never feeds
 * the ceiling arithmetic, only the operator's reconciliation.
 */
export async function collectProviderQueryActivity(db: Queryable): Promise<ProviderQueryActivity[]> {
  const { rows } = await db.query<{ provider: string; operation: string; count: string | number }>(
    `SELECT provider, operation, count(*) AS count
       FROM provider_queries
      GROUP BY provider, operation
      ORDER BY provider, operation`,
  );
  return rows.map((row) => ({
    provider: row.provider,
    operation: row.operation,
    count: Math.max(0, Math.round(Number(row.count ?? 0))),
  }));
}

/** The configured USD ceilings read from an environment map (never echoed). */
export interface SpendCeilings {
  dailyUsd: number | null;
  accountDailyUsd: number | null;
  maxUnknownUsd: number | null;
  totalUsd: number | null;
}

function usdCeiling(env: Record<string, string | undefined>, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function spendCeilingsFromEnv(env: Record<string, string | undefined>): SpendCeilings {
  return {
    dailyUsd: usdCeiling(env, 'MODEL_DAILY_SPEND_LIMIT_USD'),
    accountDailyUsd: usdCeiling(env, 'MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD'),
    maxUnknownUsd: usdCeiling(env, 'MODEL_MAX_UNKNOWN_SPEND_USD'),
    totalUsd: usdCeiling(env, 'MODEL_TOTAL_SPEND_LIMIT_USD'),
  };
}

export type SpendCeilingStatus = 'within' | 'exceeded' | 'not_configured';

export interface SpendReconciliation {
  totals: SpendLedgerTotals;
  /** Provider request counts (activity, never billing proof). */
  providerQueries: ProviderQueryActivity[];
  ceilings: SpendCeilings;
  ceilingStatus: SpendCeilingStatus;
  /** Total ceiling minus charged micros; null when no total ceiling is configured. */
  remainingTotalMicros: number | null;
  /** Human-readable reconciliation notes for the operator (no values echoed beyond micros). */
  notes: string[];
}

export function buildSpendReconciliation(input: {
  totals: SpendLedgerTotals;
  activity: ProviderQueryActivity[];
  ceilings: SpendCeilings;
}): SpendReconciliation {
  const totalMicros =
    input.ceilings.totalUsd === null ? null : Math.floor(input.ceilings.totalUsd * 1_000_000);
  const notes = [
    'Unknown-outcome attempts are charged at their reservation until billing reconciliation.',
    'Provider request counts do not establish whether the provider billed them.',
  ];
  let ceilingStatus: SpendCeilingStatus;
  let remainingTotalMicros: number | null;
  if (totalMicros === null) {
    ceilingStatus = 'not_configured';
    remainingTotalMicros = null;
    notes.push(
      'No all-time total ceiling is configured: paid graph admission stays fail-closed and cumulative spend is unbounded (VAL-OPS-002).',
    );
  } else {
    remainingTotalMicros = totalMicros - input.totals.chargedMicros;
    if (remainingTotalMicros < 0) {
      ceilingStatus = 'exceeded';
      notes.push(
        'Charged ledger spend exceeds the configured all-time total ceiling; the ledger refuses further admission.',
      );
    } else {
      ceilingStatus = 'within';
      notes.push(
        'The all-time ceiling never reopens on restart or day rollover; reconcile billing before raising it.',
      );
    }
  }
  return {
    totals: input.totals,
    providerQueries: input.activity,
    ceilings: input.ceilings,
    ceilingStatus,
    remainingTotalMicros,
    notes,
  };
}

/**
 * One JSON log line per reconciliation: counts and micros only. The ledger
 * totals, the ceiling decision and the provider request counts; never a
 * payload, identity or secret.
 */
export function toSpendReconciliationLine(
  report: SpendReconciliation,
  options: { now?: Date } = {},
): string {
  return JSON.stringify({
    time: (options.now ?? new Date()).toISOString(),
    event: 'spend_reconciliation',
    ledger: report.totals,
    ceilingStatus: report.ceilingStatus,
    remainingTotalMicros: report.remainingTotalMicros,
    providerQueries: report.providerQueries,
  });
}
