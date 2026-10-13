import type { Queryable } from '../db/pool';

/**
 * Idempotent per-stage outputs (job_stages). A worker retrying after a lost
 * lease or crash reads completed stages back instead of re-calling providers.
 * A 'complete' stage is never overwritten.
 */

export type StageStatus = 'running' | 'complete' | 'failed' | 'skipped';

export interface StageRecord<T = unknown> {
  job_id: string;
  stage: string;
  status: StageStatus;
  attempt: number;
  output: T | null;
  error_code: string | null;
  started_at: Date;
  completed_at: Date | null;
}

export async function getStage<T = unknown>(
  db: Queryable,
  jobId: string,
  stage: string,
): Promise<StageRecord<T> | null> {
  const { rows } = await db.query<StageRecord<T>>(
    'SELECT * FROM job_stages WHERE job_id = $1 AND stage = $2',
    [jobId, stage],
  );
  return rows[0] ?? null;
}

export async function listStages(db: Queryable, jobId: string): Promise<StageRecord[]> {
  const { rows } = await db.query<StageRecord>(
    'SELECT * FROM job_stages WHERE job_id = $1 ORDER BY started_at',
    [jobId],
  );
  return rows;
}

/**
 * Writes a stage result. Returns the stored record, which is the EXISTING
 * completed record if one was already written (first completion wins).
 */
export async function recordStage<T>(
  db: Queryable,
  input: { jobId: string; stage: string; status: StageStatus; attempt: number; output?: T; errorCode?: string },
): Promise<StageRecord<T>> {
  const terminal = input.status !== 'running';
  const { rows } = await db.query<StageRecord<T>>(
    `INSERT INTO job_stages (job_id, stage, status, attempt, output, error_code, completed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, CASE WHEN $7 THEN now() ELSE NULL END)
     ON CONFLICT (job_id, stage) DO UPDATE
       SET status = EXCLUDED.status, attempt = EXCLUDED.attempt, output = EXCLUDED.output,
           error_code = EXCLUDED.error_code, completed_at = EXCLUDED.completed_at
     WHERE job_stages.status <> 'complete'
     RETURNING *`,
    [
      input.jobId,
      input.stage,
      input.status,
      input.attempt,
      input.output === undefined ? null : JSON.stringify(input.output),
      input.errorCode ?? null,
      terminal,
    ],
  );
  if (rows[0]) return rows[0];
  const existing = await getStage<T>(db, input.jobId, input.stage);
  if (!existing) throw new Error(`stage ${input.stage} vanished for job ${input.jobId}`);
  return existing;
}

/**
 * Run a stage exactly once per job: returns the stored output if the stage is
 * already complete, otherwise runs fn and stores its output.
 */
export async function runStageOnce<T>(
  db: Queryable,
  input: { jobId: string; stage: string; attempt: number },
  fn: () => Promise<T>,
): Promise<T> {
  const existing = await getStage<T>(db, input.jobId, input.stage);
  if (existing?.status === 'complete') return existing.output as T;
  await recordStage(db, { ...input, status: 'running' });
  try {
    const output = await fn();
    const stored = await recordStage(db, { ...input, status: 'complete', output });
    return stored.output as T;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    await recordStage(db, {
      ...input,
      status: 'failed',
      errorCode: typeof code === 'string' ? code : 'internal',
    });
    throw err;
  }
}

/**
 * Merge one section status into a jsonb section_statuses column (analyses or
 * plan_versions) idempotently.
 */
export async function setSectionStatus(
  db: Queryable,
  table: 'analyses' | 'plan_versions',
  id: string,
  section: string,
  status: string,
): Promise<void> {
  await db.query(
    `UPDATE ${table} SET section_statuses = section_statuses || jsonb_build_object($2::text, $3::text) WHERE id = $1`,
    [id, section, status],
  );
}
