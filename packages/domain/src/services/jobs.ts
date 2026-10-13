import type { ServiceContext } from '../context';
import { ACTIVE_JOB_STATES, type JobState } from '../enums';
import type { ErrorCode } from '../errors';
import { notImplemented } from '../errors';
import type { JobRecord } from '../jobs/types';
import type { StageRecord } from '../jobs/stages';
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

/**
 * GET /v1/jobs/{id} — owner check plus CURRENT grant check for agents (the
 * job's result must still be within the connection's grant). 404 otherwise.
 * TODO(core owner): implement.
 */
export async function getJob(ctx: ServiceContext, input: { id: string }): Promise<JobResponse> {
  void ctx;
  void input;
  notImplemented('jobs.getJob');
}
