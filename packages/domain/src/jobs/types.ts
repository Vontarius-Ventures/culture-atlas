import { z } from 'zod';
import { Category, Exploration, JobState, type JobType, PlanSection } from '../enums';
import type { ErrorCode } from '../errors';
import { Focus, Uuid } from '../schemas/common';

/** Payload schemas per job type. enqueueJob validates payloads against these. */
export const JobPayloads = {
  analyze_capture: z.object({
    capture_id: Uuid,
    /** Version the resulting analysis will get. */
    analysis_version: z.number().int().positive(),
    compiler_version: z.string(),
    focus: Focus,
    /** Present for correction re-analyses. */
    correction: z
      .object({
        previous_analysis_id: Uuid,
        reject_reference_ids: z.array(Uuid).default([]),
        confirm_reference_id: Uuid.optional(),
        replacement: z.object({ name: z.string(), type: z.string().optional() }).optional(),
      })
      .optional(),
    /** Optional targeted retry: only these sections are recomputed. */
    sections: z.array(z.string()).optional(),
    /**
     * v2 media analysis whose validated vision reading (Concentrate, possibly
     * aggregated over video frames) replaces the observe stage's VLM call.
     */
    media_analysis_id: Uuid.optional(),
  }),
  discover_related: z.object({
    discovery_job_id: Uuid,
    origin_item_id: Uuid,
    category: Category.optional(),
    taste_revision: z.number().int().nonnegative(),
  }),
  generate_plan: z.object({
    plan_id: Uuid,
    version: z.number().int().positive(),
    exploration: Exploration,
  }),
  replace_plan_section: z.object({
    plan_id: Uuid,
    base_version: z.number().int().positive(),
    version: z.number().int().positive(),
    section: PlanSection,
    instruction: z.string().optional(),
  }),
  sensor_poll: z.object({ sensor_connection_id: Uuid }),
  purge_deleted: z.object({ before: z.iso.datetime({ offset: true }).optional() }),
} as const satisfies Record<JobType, z.ZodType>;

export type JobPayload<T extends JobType> = z.infer<(typeof JobPayloads)[T]>;

/** Row shape of the `jobs` table as returned by queue functions. */
export interface JobRecord<T extends JobType = JobType> {
  id: string;
  owner_account_id: string | null;
  owner_session_id: string | null;
  agent_connection_id: string | null;
  type: T;
  state: JobState;
  stage: string | null;
  attempt: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_expiry: Date | null;
  heartbeat_at: Date | null;
  budget: JobBudget;
  payload: JobPayload<T>;
  dedupe_key: string | null;
  error_code: ErrorCode | null;
  error_message: string | null;
  error_retryable: boolean | null;
  result_type: string | null;
  result_id: string | null;
  trace_id: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  cancel_requested_at: Date | null;
}

export interface JobBudget {
  qloo_requests?: number;
  research_refs?: number;
  provider_retries?: number;
  deadline_ms?: number;
}

/** What a job handler returns on success. */
export interface JobOutcome {
  /** 'partial' when some sections failed/unavailable but useful output exists. */
  state: 'complete' | 'partial';
  resultType?: string;
  resultId?: string;
}

/** Errors thrown by handlers are converted with these fields. */
export interface JobFailure {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export const JobRecordState = JobState;
