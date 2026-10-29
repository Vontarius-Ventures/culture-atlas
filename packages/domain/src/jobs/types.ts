import { z } from 'zod';
import { Category, Exploration, JobState, type JobType, PlanSection } from '../enums';
import type { ErrorCode } from '../errors';
import { GraphPredicate } from '../interest-graph/schema';
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
  /**
   * Seeds the account's feed pool from its onboarding picks: Qloo insights per
   * category (at most 6 Qloo requests, at most 3 concurrent), then a new
   * FeedSnapshot. Reads the picks current at run time; `taste_revision` is the
   * revision that completed onboarding (dedupe and staleness checks).
   */
  taste_seed: z.object({
    taste_revision: z.number().int().nonnegative(),
    catalog_version: z.string().min(1).max(64).nullable(),
    categories: z.array(Category).min(1).max(4).default(['wear', 'play', 'watch', 'eat']),
  }),
  /**
   * One Qloo insights (or Eat search) pass that appends cards to the latest
   * taste seed. `wave` buckets refreshes so pull-to-refresh does not spend a
   * request every time; `category` is which lane this wave walks.
   */
  interest_expand: z.object({
    wave: z.number().int().nonnegative(),
    category: Category,
  }),
  analyze_audio: z.object({
    analysis_id: Uuid,
    asset_id: Uuid,
    expected_generation: z.number().int().positive(),
  }),
  /**
   * PR 8 interest graph: project one account's private graph from current
   * authoritative state. The payload mirrors the owning account (defense in
   * depth); the projector reads current state itself, so retries and replays
   * of the same job always converge to the same result. `catch_up` marks a
   * support-version catch-up job (upgrade reprojection): no mutation intent
   * exists for it — the account is behind the current projection semantics —
   * so the run is labeled support_version_catch_up, never mutation lineage.
   */
  project_interest_graph: z.object({
    account_id: Uuid,
    catch_up: z.enum(['support_version']).optional(),
  }),
  /**
   * One bounded expansion refresh of the owning account's eligible explicit
   * and active-photo roots (PR 8 discovery). The payload mirrors the owning
   * account; the engine reads current state itself, so retries and redelivery
   * converge. The LOGICAL budget (four Qloo attempts including retries, a
   * 45-second deadline) is durable and keyed by the job's dedupe key, so no
   * redelivery resets it.
   */
  expand_interest_graph: z.object({
    account_id: Uuid,
  }),
  /**
   * One bounded relation-research pair (PR 8): the paid model evaluates the
   * public pair against at most two approved source documents; proposals (at
   * most ten) are stored as unreviewed `proposed` assertions that only the
   * review gate can validate. Dispatch is fail-closed behind the research
   * flag, a qualified role and durable account/global spend limits.
   */
  research_graph_relation: z.object({
    account_id: Uuid,
    subject_node_id: Uuid,
    object_node_id: Uuid,
    predicate: GraphPredicate,
    association_subtype: z.string().min(1).max(200).optional(),
  }),
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
  /**
   * True only when this execution's DURABLE publication transaction already
   * committed, making the returned outcome final (the scoped graph branch:
   * its one publication transaction wrote the scoped results, their pinned
   * proofs and the discovery parent's terminal status together). When true,
   * the worker's finalization carries this outcome through to completion
   * even if a queued real heartbeat observes a LATER cancellation, or the
   * attempt deadline fires, while the remaining stage/trace/finalization
   * writes land: a committed discovery must never be retroactively
   * classified as cancelled (DISC-SCR-042). Handlers without such a
   * committed publication omit it, so cancellation, lease loss and the
   * deadline keep their ordinary meaning for them.
   */
  publicationCommitted?: true;
}

/** Errors thrown by handlers are converted with these fields. */
export interface JobFailure {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export const JobRecordState = JobState;
