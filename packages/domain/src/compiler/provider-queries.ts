import { isProviderError, type AttemptObserver } from '@culture-atlas/providers';
import type { Queryable } from '../db/pool';

/**
 * ProviderQuery rows: every logical provider request made for an analysis
 * (or plan / discovery job). Stores the sanitized request (never keys, image
 * bytes or private prompts), a compact result summary (ids, names, ranks and
 * per-query affinity for inspection), timings and whether it was a replay.
 */

export type ProviderQueryParent = { analysisId: string } | { planId: string; planVersion?: number } | { discoveryJobId: string };

export interface ProviderQueryInput {
  parent: ProviderQueryParent;
  provider: 'qloo' | 'vlm' | 'research' | 'wikipedia' | 'text_model' | 'catalog';
  operation: string;
  request: unknown;
  results?: unknown;
  status: 'ok' | 'empty' | 'error';
  httpStatus?: number | null;
  errorCode?: string | null;
  durationMs?: number | null;
  isReplay?: boolean;
  queryContext?: Record<string, unknown>;
  traceId?: string | null;
  cacheTtlSeconds?: number;
}

export async function recordProviderQuery(db: Queryable, q: ProviderQueryInput): Promise<string> {
  const p = q.parent;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO provider_queries (analysis_id, plan_id, plan_version, discovery_job_id, provider, operation,
                                   sanitized_request, results, status, http_status, error_code, duration_ms,
                                   is_replay, query_context, trace_id, cache_expiry)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15,
             CASE WHEN $16::int IS NULL THEN NULL ELSE now() + ($16::int * interval '1 second') END)
     RETURNING id`,
    [
      'analysisId' in p ? p.analysisId : null,
      'planId' in p ? p.planId : null,
      'planId' in p ? (p.planVersion ?? null) : null,
      'discoveryJobId' in p ? p.discoveryJobId : null,
      q.provider,
      q.operation,
      JSON.stringify(q.request ?? {}),
      q.results === undefined ? null : JSON.stringify(q.results),
      q.status,
      q.httpStatus ?? null,
      q.errorCode ?? null,
      q.durationMs === undefined || q.durationMs === null ? null : Math.round(q.durationMs),
      q.isReplay ?? false,
      JSON.stringify(q.queryContext ?? {}),
      q.traceId ?? null,
      q.cacheTtlSeconds ?? null,
    ],
  );
  return rows[0]!.id;
}

/** Sum of HTTP attempts already spent on a provider for this analysis (survives job retries). */
export async function attemptsSpent(db: Queryable, analysisId: string, provider: string): Promise<number> {
  const { rows } = await db.query<{ n: number | null }>(
    `SELECT COALESCE(SUM(COALESCE((query_context->>'attempts')::int, 1)), 0)::int AS n
       FROM provider_queries WHERE analysis_id = $1 AND provider = $2`,
    [analysisId, provider],
  );
  return rows[0]?.n ?? 0;
}

/** Counts HTTP attempts for one logical call (used for query_context.attempts). */
export function attemptCounter(): { observer: AttemptObserver; count: () => number; lastStatus: () => number | null } {
  let n = 0;
  let status: number | null = null;
  return {
    observer: (e) => {
      n++;
      status = e.status;
    },
    count: () => n,
    lastStatus: () => status,
  };
}

/** Safe error summary for provider_queries / traces. */
export function errorSummary(err: unknown): { code: string; status: number | null } {
  if (isProviderError(err)) return { code: err.kind, status: err.status ?? null };
  return { code: 'internal', status: null };
}
