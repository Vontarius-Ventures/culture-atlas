import { z } from 'zod';
import { JobState, JobType, RecommendationOrigin } from '../enums';
import { Image, Timestamp, Uuid } from './common';

/**
 * GET /v1/demo/traces/{job_id} — demo inspector. Only the owning demo owner
 * (DEMO_INSPECTOR_ACCOUNT_IDS) or a developer may read it; never public.
 * Tokens, credentials and private deployment details are redacted.
 * Unlike consumer DTOs, this MAY show provider names, ids and scores.
 */
export const TraceParams = z.object({ job_id: Uuid });

export const TraceResponse = z.object({
  job: z.object({
    id: Uuid,
    type: JobType,
    state: JobState,
    created_at: Timestamp,
    finished_at: Timestamp.nullable(),
  }),
  capture: z.object({ id: Uuid, image: Image.nullable() }).nullable(),
  observations: z.array(z.unknown()),
  resolved_entities: z.array(
    z.object({
      name: z.string(),
      provider: z.string(),
      provider_id: z.string(),
      type: z.string().nullable(),
      reference_id: Uuid.nullable(),
    }),
  ),
  provider_queries: z.array(
    z.object({
      id: Uuid,
      provider: z.string(),
      operation: z.string(),
      request: z.unknown(),
      result_summary: z.unknown(),
      status: z.enum(['ok', 'empty', 'error']),
      is_replay: z.boolean(),
      retrieved_at: Timestamp,
      duration_ms: z.number().int().nullable(),
    }),
  ),
  references: z.array(
    z.object({ id: Uuid, name: z.string(), claim_count: z.number().int(), source_count: z.number().int() }),
  ),
  recommendations: z.array(
    z.object({
      id: Uuid,
      title: z.string(),
      category: z.string().nullable(),
      origin: RecommendationOrigin,
      rank: z.number().int(),
      provider_query_ids: z.array(Uuid),
    }),
  ),
  taste_changes: z.array(z.object({ at: Timestamp, action: z.string(), target_id: Uuid })),
  agent_calls: z.array(
    z.object({ at: Timestamp, client_name: z.string(), tool: z.string(), summary: z.string() }),
  ),
  events: z.array(
    z.object({
      at: Timestamp,
      kind: z.string(),
      name: z.string(),
      data: z.unknown(),
      duration_ms: z.number().int().nullable(),
    }),
  ),
});
export type TraceResponse = z.infer<typeof TraceResponse>;
