import { randomInt } from 'node:crypto';
import type { JobState, JobType } from '../enums';
import { AppError } from '../errors';
import type { Db, Queryable } from '../db/pool';
import { ownerColumns, type Owner } from '../principal';
import { JobPayloads, type JobBudget, type JobFailure, type JobPayload, type JobRecord } from './types';

/**
 * Database-backed job queue.
 *  - enqueueJob: insert with optional dedupe key. An existing non-failed,
 *    non-cancelled job with the same key is reused (spec: duplicate submission).
 *  - claimJobs: lease queued jobs (or running jobs whose lease expired) using
 *    FOR UPDATE SKIP LOCKED; increments attempt.
 *  - heartbeatJob: extend the lease; returns false when the lease was lost or
 *    cancellation was requested (the handler must stop without publishing).
 *  - completeJob / failJob: guarded by lease_owner so a worker that lost its
 *    lease cannot overwrite a newer attempt.
 */

const JOB_COLUMNS = '*';

export interface EnqueueOptions<T extends JobType> {
  type: T;
  owner: Owner | null;
  payload: JobPayload<T>;
  dedupeKey?: string;
  agentConnectionId?: string | null;
  availableAt?: Date;
  maxAttempts?: number;
  budget?: JobBudget;
  traceId?: string;
  resultType?: string;
  resultId?: string;
}

export async function enqueueJob<T extends JobType>(
  db: Queryable,
  opts: EnqueueOptions<T>,
): Promise<{ job: JobRecord<T>; reused: boolean }> {
  const payload = JobPayloads[opts.type].parse(opts.payload);
  const owner = opts.owner ? ownerColumns(opts.owner) : { owner_account_id: null, owner_session_id: null };
  const params = [
    owner.owner_account_id,
    owner.owner_session_id,
    opts.agentConnectionId ?? null,
    opts.type,
    opts.availableAt ?? null,
    opts.maxAttempts ?? 3,
    JSON.stringify(opts.budget ?? {}),
    JSON.stringify(payload),
    opts.dedupeKey ?? null,
    opts.traceId ?? null,
    opts.resultType ?? null,
    opts.resultId ?? null,
  ];
  const insertSql = `
    INSERT INTO jobs (owner_account_id, owner_session_id, agent_connection_id, type, available_at,
                      max_attempts, budget, payload, dedupe_key, trace_id, result_type, result_id)
    VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
    ${opts.dedupeKey ? `ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND state NOT IN ('failed', 'cancelled') DO NOTHING` : ''}
    RETURNING ${JOB_COLUMNS}`;
  // Loop handles the race where the conflicting job fails/cancels between our
  // INSERT and SELECT.
  for (let i = 0; i < 3; i++) {
    const inserted = await db.query<JobRecord<T>>(insertSql, params);
    if (inserted.rows[0]) return { job: inserted.rows[0], reused: false };
    const existing = await db.query<JobRecord<T>>(
      `SELECT ${JOB_COLUMNS} FROM jobs
        WHERE dedupe_key = $1 AND state NOT IN ('failed', 'cancelled')`,
      [opts.dedupeKey],
    );
    if (existing.rows[0]) return { job: existing.rows[0], reused: true };
  }
  throw new AppError('conflict', { message: 'Could not enqueue job', retryable: true });
}

export interface ClaimOptions {
  workerId: string;
  limit: number;
  leaseMs: number;
  types?: readonly JobType[];
  /** Restrict to specific job ids (tests, targeted reprocessing). */
  ids?: readonly string[];
}

export async function claimJobs(db: Queryable, opts: ClaimOptions): Promise<JobRecord[]> {
  const { rows } = await db.query<JobRecord>(
    `UPDATE jobs j
        SET state = 'running',
            lease_owner = $1,
            lease_expiry = now() + ($2::int * interval '1 millisecond'),
            heartbeat_at = now(),
            attempt = j.attempt + 1,
            started_at = COALESCE(j.started_at, now()),
            updated_at = now()
      WHERE j.id IN (
        SELECT id FROM jobs
         WHERE ((state = 'queued' AND available_at <= now())
             OR (state = 'running' AND lease_expiry < now()))
           AND attempt < max_attempts
           AND cancel_requested_at IS NULL
           AND ($4::text[] IS NULL OR type = ANY($4::text[]))
           AND ($5::uuid[] IS NULL OR id = ANY($5::uuid[]))
         ORDER BY available_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING j.*`,
    [opts.workerId, opts.leaseMs, opts.limit, opts.types ? [...opts.types] : null, opts.ids ? [...opts.ids] : null],
  );
  return rows;
}

/**
 * Fail running jobs whose lease expired after their final attempt, and finalize
 * cancellation for jobs whose cancel was requested while queued or abandoned.
 * Call periodically from the worker.
 */
export async function reapJobs(db: Queryable): Promise<{ failed: number; cancelled: number }> {
  const failed = await db.query(
    `UPDATE jobs SET state = 'failed', error_code = 'service_unavailable',
            error_message = 'The job did not finish in time.', error_retryable = true,
            lease_owner = NULL, lease_expiry = NULL, finished_at = now(), updated_at = now()
      WHERE state IN ('running', 'queued') AND attempt >= max_attempts
        AND (state = 'queued' OR lease_expiry < now())
        AND cancel_requested_at IS NULL`,
  );
  const cancelled = await db.query(
    `UPDATE jobs SET state = 'cancelled', lease_owner = NULL, lease_expiry = NULL,
            finished_at = now(), updated_at = now()
      WHERE cancel_requested_at IS NOT NULL
        AND (state = 'queued' OR (state = 'running' AND lease_expiry < now()))`,
  );
  return { failed: failed.rowCount ?? 0, cancelled: cancelled.rowCount ?? 0 };
}

/** Extends the lease. Returns false if the lease is lost or cancellation was requested. */
export async function heartbeatJob(
  db: Queryable,
  jobId: string,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const { rows } = await db.query<{ cancel_requested_at: Date | null }>(
    `UPDATE jobs SET lease_expiry = now() + ($3::int * interval '1 millisecond'),
            heartbeat_at = now(), updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND state = 'running'
      RETURNING cancel_requested_at`,
    [jobId, workerId, leaseMs],
  );
  return rows.length === 1 && rows[0]!.cancel_requested_at === null;
}

/** Updates the public progress stage. Returns false if the lease was lost. */
export async function setJobStage(
  db: Queryable,
  jobId: string,
  workerId: string,
  stage: string,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE jobs SET stage = $3, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND state = 'running'`,
    [jobId, workerId, stage],
  );
  return r.rowCount === 1;
}

export async function completeJob(
  db: Queryable,
  jobId: string,
  workerId: string,
  outcome: { state: 'complete' | 'partial'; resultType?: string; resultId?: string },
): Promise<boolean> {
  const r = await db.query(
    `UPDATE jobs SET state = $3, result_type = COALESCE($4, result_type),
            result_id = COALESCE($5, result_id), lease_owner = NULL, lease_expiry = NULL,
            error_code = NULL, error_message = NULL, error_retryable = NULL,
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND state = 'running'`,
    [jobId, workerId, outcome.state, outcome.resultType ?? null, outcome.resultId ?? null],
  );
  return r.rowCount === 1;
}

/** Exponential backoff with full jitter: base * 2^(attempt-1), capped, jittered 50-100%. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp / 2 + randomInt(0, Math.floor(exp / 2) + 1));
}

/**
 * Records a failure. Retryable failures with attempts left are re-queued with
 * backoff (state 'queued'); otherwise the job becomes 'failed'.
 */
export async function failJob(
  db: Queryable,
  jobId: string,
  workerId: string,
  failure: JobFailure,
  options: { retryAfterMs?: number } = {},
): Promise<{ state: JobState } | null> {
  const { rows } = await db.query<{ attempt: number; max_attempts: number }>(
    `SELECT attempt, max_attempts FROM jobs WHERE id = $1 AND lease_owner = $2 AND state = 'running'`,
    [jobId, workerId],
  );
  const row = rows[0];
  if (!row) return null;
  const retry = failure.retryable && row.attempt < row.max_attempts;
  const delay = options.retryAfterMs ?? backoffMs(row.attempt);
  const r = await db.query<{ state: JobState }>(
    `UPDATE jobs SET state = $3, error_code = $4, error_message = $5, error_retryable = $6,
            available_at = CASE WHEN $3 = 'queued' THEN now() + ($7::int * interval '1 millisecond') ELSE available_at END,
            lease_owner = NULL, lease_expiry = NULL,
            finished_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND state = 'running'
      RETURNING state`,
    [jobId, workerId, retry ? 'queued' : 'failed', failure.code, failure.message, failure.retryable, delay],
  );
  return r.rows[0] ?? null;
}

/**
 * Requests cancellation. Queued jobs are cancelled immediately; running jobs
 * are flagged and the worker stops at its next heartbeat/stage boundary.
 */
export async function cancelJob(db: Queryable, jobId: string): Promise<JobState | null> {
  const { rows } = await db.query<{ state: JobState }>(
    `UPDATE jobs SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
            state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
            finished_at = CASE WHEN state = 'queued' THEN now() ELSE finished_at END,
            updated_at = now()
      WHERE id = $1 AND state IN ('queued', 'running')
      RETURNING state`,
    [jobId],
  );
  return rows[0]?.state ?? null;
}

/** Cancel all active jobs producing a result (e.g. on capture/plan deletion). */
export async function cancelJobsForResult(
  db: Queryable,
  resultType: string,
  resultId: string,
): Promise<number> {
  const r = await db.query(
    `UPDATE jobs SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
            state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
            finished_at = CASE WHEN state = 'queued' THEN now() ELSE finished_at END,
            updated_at = now()
      WHERE result_type = $1 AND result_id = $2 AND state IN ('queued', 'running')`,
    [resultType, resultId],
  );
  return r.rowCount ?? 0;
}

/** Called by a worker that stopped because cancellation was requested. */
export async function markJobCancelled(db: Queryable, jobId: string, workerId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE jobs SET state = 'cancelled', lease_owner = NULL, lease_expiry = NULL,
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND state = 'running'`,
    [jobId, workerId],
  );
  return r.rowCount === 1;
}

export async function getJobById(db: Queryable, jobId: string): Promise<JobRecord | null> {
  const { rows } = await db.query<JobRecord>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`, [jobId]);
  return rows[0] ?? null;
}

/** True when the job is still owned by this worker and not cancelled. Use before publishing. */
export async function stillOwnsJob(db: Queryable, jobId: string, workerId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM jobs WHERE id = $1 AND lease_owner = $2 AND state = 'running'
        AND cancel_requested_at IS NULL AND lease_expiry > now()`,
    [jobId, workerId],
  );
  return rows.length === 1;
}

export type { Db };
