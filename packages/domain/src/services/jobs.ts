import type { ServiceContext } from '../context';
import { ACTIVE_JOB_STATES, type JobState } from '../enums';
import type { ErrorCode } from '../errors';
import { AppError } from '../errors';
import type { JobRecord } from '../jobs/types';
import { listStages, type StageRecord } from '../jobs/stages';
import { getJobById } from '../jobs/queue';
import { grantedIds, isGrantLimited, planWithinGrant, visibleItemIds } from '../library/access';
import type { JobResponse } from '../schemas/jobs';
import { iso } from '../util/time';

/** Browser polling cadence (spec): 1.5 s while active, back off after 15 s. */
export function pollAfterMs(state: JobState, createdAt: Date, now: Date): number | null {
  if (!ACTIVE_JOB_STATES.includes(state)) return null;
  return now.getTime() - createdAt.getTime() > 15_000 ? 4_000 : 1_500;
}

const RESULT_TYPES = new Set(['capture', 'analysis', 'plan', 'discovery_job', 'sensor_connection']);

/** Pure mapper from a job row (+ stages) to the public JobResponse. */
export function toJobResponse(job: JobRecord, stages: StageRecord[], now: Date = new Date()): JobResponse {
  const visibleError = job.state === 'failed' || job.state === 'partial';
  return {
    id: job.id,
    type: job.type,
    state: job.state,
    stage: job.stage,
    sections: stages.map((s) => ({ name: s.stage, status: s.status === 'skipped' ? 'skipped' : s.status })),
    error:
      visibleError && job.error_code
        ? { code: job.error_code as ErrorCode, message: job.error_message ?? '', retryable: job.error_retryable ?? false }
        : null,
    result:
      job.result_type && job.result_id && RESULT_TYPES.has(job.result_type)
        ? { type: job.result_type as NonNullable<JobResponse['result']>['type'], id: job.result_id }
        : null,
    poll_after_ms: pollAfterMs(job.state, job.created_at, now),
    created_at: iso(job.created_at),
    updated_at: iso(job.updated_at),
  };
}

/** Whether a limited agent's CURRENT grant still covers what a job produces. */
async function jobWithinGrant(ctx: ServiceContext, job: JobRecord): Promise<boolean> {
  const p = ctx.principal;
  if (p.kind !== 'agent' || !isGrantLimited(p)) return true;
  const resultId = job.result_id;
  if (job.result_type === 'plan' && resultId) {
    const { rows } = await ctx.db.query<{ selected_item_ids: string[] }>('SELECT selected_item_ids FROM plans WHERE id = $1', [resultId]);
    return rows[0] ? planWithinGrant(ctx, rows[0].selected_item_ids) : false;
  }
  if (job.result_type === 'discovery_job' && resultId) {
    const { rows } = await ctx.db.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM discovery_jobs dj
           JOIN collection_items ci ON ci.collection_id = dj.origin_collection_id
           JOIN saved_items si ON si.id = ci.saved_item_id AND si.discovery_item_id = dj.origin_item_id
          WHERE dj.id = $1 AND dj.origin_collection_id = ANY($2::uuid[])) AS ok`,
      [resultId, grantedIds(p)],
    );
    return rows[0]?.ok === true;
  }
  const captureId =
    job.type === 'analyze_capture'
      ? (job.payload as { capture_id?: string }).capture_id
      : job.result_type === 'capture'
        ? resultId
        : null;
  if (captureId) {
    const { rows } = await ctx.db.query<{ id: string }>(
      `SELECT id FROM discovery_items WHERE capture_id = $1 AND kind = 'capture'`,
      [captureId],
    );
    const visible = await visibleItemIds(ctx, rows.map((r) => r.id));
    return visible.size > 0;
  }
  return job.agent_connection_id === p.connectionId;
}

/**
 * GET /v1/jobs/{id} — owner check plus CURRENT grant check for agents (the
 * job's result must still be within the connection's grant). 404 otherwise.
 */
export async function getJob(ctx: ServiceContext, input: { id: string }): Promise<JobResponse> {
  const p = ctx.principal;
  const job = await getJobById(ctx.db, input.id);
  if (!job) throw new AppError('not_found');
  const owned =
    p.kind === 'anonymous'
      ? job.owner_session_id === p.sessionId
      : p.kind === 'account' || p.kind === 'agent'
        ? job.owner_account_id === p.accountId
        : false;
  if (!owned) throw new AppError('not_found');
  // The sensor-bridge token only sees the jobs it started.
  if (p.kind === 'agent' && p.purpose === 'sensor_bridge' && job.agent_connection_id !== p.connectionId) {
    throw new AppError('not_found');
  }
  if (!(await jobWithinGrant(ctx, job))) throw new AppError('not_found');
  return toJobResponse(job, await listStages(ctx.db, job.id), ctx.now());
}
