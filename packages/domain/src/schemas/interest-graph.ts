import { z } from 'zod';
import { ItemKind, RecommendationOrigin } from '../enums';
import { Cursor, IdParams, Timestamp, Uuid } from './common';

/**
 * Typed owner/native interest-graph DTOs (PR 8 package E; VAL-API-001).
 *
 * Conventions (schemas/common.ts): request bodies are strictObject so unknown
 * mutation fields are rejected; response objects are plain z.object so older
 * clients keep decoding when fields are ADDED. No raw affinity scores appear
 * anywhere in these DTOs.
 *
 * Authority: every route below is owner/native-only (`auth: 'owner'` in
 * ROUTES, bridged for the four graph operations in authz/native-owner.ts).
 * There is no account id to name: the owner is always the caller, agents are
 * refused with scope_denied, and cross-owner ids resolve as non-disclosing
 * 404s. Optimistic control mutations share ONE revision
 * (personal_graph_state.suppression_revision) with a consistent typed
 * rejection (409 revision_conflict, details.current_revision), and both
 * PATCH bodies are desired-state so retries of an already-satisfied request
 * are idempotent no-ops instead of conflicts.
 */

/** GET /v2/me/interest-graph — bounded pagination over the owner's two lists. */
export const InterestGraphQuery = z.object({
  /** Page size applied to both lists. */
  limit: z.coerce.number().int().min(1).max(100).default(25),
  interests_cursor: Cursor.optional(),
  tentative_cursor: Cursor.optional(),
});
export type InterestGraphQuery = z.infer<typeof InterestGraphQuery>;

/** One confirmed explicit interest (the owner's own current save or pick). */
export const InterestSummaryItem = z.object({
  /** Stable projected edge id (null until the projection has caught up). */
  edge_id: Uuid.nullable(),
  item_id: Uuid,
  canonical_key: z.string(),
  kind: ItemKind,
  title: z.string(),
  origin: z.literal('explicit'),
  state: z.literal('confirmed'),
  saved_item_id: Uuid,
  pick_ids: z.array(Uuid),
  capture_id: Uuid.nullable(),
  analysis_id: Uuid.nullable(),
});
export type InterestSummaryItem = z.infer<typeof InterestSummaryItem>;

/** One derived tentative affinity (suppression survives projection rebuilds). */
export const TentativeInterestItem = z.object({
  edge_id: Uuid,
  node_id: Uuid,
  name: z.string(),
  relation: z.enum(['depicted', 'resembles', 'user_selected']),
  resolution_status: z.enum(['resolved', 'user_confirmed']),
  is_anchor: z.boolean(),
  origin: z.literal('derived'),
  state: z.enum(['tentative', 'suppressed']),
  capture_id: Uuid,
  analysis_id: Uuid.nullable(),
  analysis_version: z.number().int().nullable(),
  capture_reference_id: Uuid,
  reference_id: Uuid,
});
export type TentativeInterestItem = z.infer<typeof TentativeInterestItem>;

/** The owner's graph-control state every control response echoes back. */
export const InterestGraphSettings = z.object({
  /** Shared optimistic revision of every typed graph-control mutation. */
  revision: z.number().int().nonnegative(),
  /** True while background discovery refresh is paused for this account. */
  discovery_paused: z.boolean(),
  paused_at: Timestamp.nullable(),
});
export type InterestGraphSettings = z.infer<typeof InterestGraphSettings>;

/** Honest projection/background status (no provider or model calls on read). */
export const InterestGraphProjection = z.object({
  state: z.enum(['never_projected', 'idle', 'queued', 'running', 'ready', 'failed']),
  support_version: z.number().int().nonnegative(),
  target_taste_revision: z.number().int().nonnegative(),
  applied_taste_revision: z.number().int().nonnegative(),
  current_taste_revision: z.number().int().nonnegative(),
  lagging: z.boolean(),
  pending_events: z.number().int().nonnegative(),
  last_projected_at: Timestamp.nullable(),
});
export type InterestGraphProjection = z.infer<typeof InterestGraphProjection>;

const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), next_cursor: Cursor.nullable() });

/** GET /v2/me/interest-graph response. */
export const InterestGraphSummaryResponse = z.object({
  owner_account_id: Uuid,
  settings: InterestGraphSettings,
  projection: InterestGraphProjection,
  counts: z.object({
    confirmed: z.number().int().nonnegative(),
    tentative: z.number().int().nonnegative(),
    suppressed: z.number().int().nonnegative(),
  }),
  interests: Page(InterestSummaryItem),
  tentative: Page(TentativeInterestItem),
});
export type InterestGraphSummaryResponse = z.infer<typeof InterestGraphSummaryResponse>;

/** PATCH /v2/me/interest-graph/settings body (desired state; strict). */
export const UpdateInterestGraphSettingsRequest = z.strictObject({
  /** The settings revision the caller last read; stale revisions conflict. */
  expected_revision: z.number().int().nonnegative(),
  discovery_paused: z.boolean(),
});
export type UpdateInterestGraphSettingsRequest = z.infer<typeof UpdateInterestGraphSettingsRequest>;

export const UpdateInterestGraphSettingsResponse = z.object({
  settings: InterestGraphSettings,
});
export type UpdateInterestGraphSettingsResponse = z.infer<typeof UpdateInterestGraphSettingsResponse>;

/** PATCH /v2/me/interest-graph/interests/{id} body (desired state; strict). */
export const UpdateInterestGraphInterestRequest = z.strictObject({
  expected_revision: z.number().int().nonnegative(),
  /** Suppressing hides the tentative affinity; restoring shows it again. */
  state: z.enum(['suppressed', 'tentative']),
});
export type UpdateInterestGraphInterestRequest = z.infer<typeof UpdateInterestGraphInterestRequest>;

export const UpdateInterestGraphInterestResponse = z.object({
  edge_id: Uuid,
  node_id: Uuid,
  state: z.enum(['suppressed', 'tentative']),
  settings: InterestGraphSettings,
});
export type UpdateInterestGraphInterestResponse = z.infer<typeof UpdateInterestGraphInterestResponse>;

export const InterestGraphIdParams = IdParams;

// --- Recommendation connection (Why this) ---------------------------------------

/** One shared cultural edge behind a connection, with named endpoints. */
export const ConnectionEdge = z.object({
  subject: z.object({ node_id: Uuid, name: z.string() }),
  predicate: z.enum(['CREATED_BY', 'ABOUT', 'USES_TECHNIQUE', 'HAS_ATTRIBUTE', 'DOCUMENTED_ASSOCIATION', 'AUDIENCE_AFFINITY']),
  object: z.object({ node_id: Uuid, name: z.string() }),
  association_subtype: z.string().nullable(),
});
export type ConnectionEdge = z.infer<typeof ConnectionEdge>;

/**
 * A permitted source link: the reviewed source's public location plus the
 * bounded excerpt/evidence locator the connection rests on. Never content
 * beyond what the source's rights permit.
 */
export const ConnectionSource = z.object({
  id: Uuid,
  url: z.url(),
  title: z.string().nullable(),
  publisher: z.string().nullable(),
  locator: z.string().nullable(),
  excerpt: z.string().nullable(),
  retrieved_at: Timestamp,
});
export type ConnectionSource = z.infer<typeof ConnectionSource>;

/** The owner's own current support behind the relevance half (no scores). */
export const ConnectionSupportRoot = z.object({
  edge_id: Uuid,
  origin: z.enum(['explicit_save', 'pick_group', 'capture_reference', 'analysis']),
  label: z.string(),
});
export type ConnectionSupportRoot = z.infer<typeof ConnectionSupportRoot>;

/**
 * GET /v2/me/recommendations/{id}/connection response. `provenance` says
 * honestly what backs the reason: a valid pinned account graph-run proof
 * (graph_run, with the owner's support roots), a valid pinned scoped proof
 * (scoped_discovery, grant-scoped Discover more results) or the pre-graph
 * record (legacy) — legacy rows are never retroactively graph-proven, and an
 * invalid pinned proof yields `unavailable` rather than a substitution.
 */
export const RecommendationConnectionResponse = z.object({
  recommendation_id: Uuid,
  origin: RecommendationOrigin,
  provenance: z.enum(['graph_run', 'scoped_discovery', 'legacy']),
  state: z.enum(['connected', 'unavailable']),
  intent: z.enum(['personal', 'photo']).nullable(),
  graph_run_id: Uuid.nullable(),
  reason: z.object({ text: z.string().nullable(), template: z.string().nullable() }),
  path: z.array(ConnectionEdge).nullable(),
  sources: z.array(ConnectionSource),
  support: z.object({ roots: z.array(ConnectionSupportRoot) }).nullable(),
  unavailable_reason: z.string().nullable(),
});
export type RecommendationConnectionResponse = z.infer<typeof RecommendationConnectionResponse>;
