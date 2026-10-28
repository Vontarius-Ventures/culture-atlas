import { z } from 'zod';
import { RECOMMENDATION_ORIGINS } from '../enums';

/**
 * Typed contracts for the interest graph (PR 8 package A).
 *
 * These schemas mirror the append-only migrations 210-250 and are the shared
 * vocabulary for every later graph feature (projection hooks, backfill,
 * discovery, feed proofs, deletion). They encode the PR 8 predicate policy:
 * only shared, public-source facts may be asserted, a generic RELATED_TO is
 * never admitted, and private interpretations stay account-scoped.
 */

// --- Policy ------------------------------------------------------------------------

/** Version of the projection/admission rules a graph run applied. */
export const INTEREST_GRAPH_POLICY_VERSION = 'graph-policy-1';

/**
 * Versioned completeness of an APPLIED projection (migration 290): which
 * projector semantics built the account's current `personal_graph_state`.
 * Version 1 is the legacy default — projections applied before migration 270
 * (shared-save graph support), which may silently omit explicit saves of
 * ownerless shared rows even at an equal taste revision with a done outbox.
 * The projector stamps the current version on every successful pass; backfill
 * due checks, dispatch catch-up and reconciled reads treat a behind-version
 * row as due for a current-state rebuild. Bump this constant (and take the
 * next migration number only if the marker itself needs schema work) whenever
 * the projector's completeness semantics change: each bump durably re-marks
 * every applied projection due exactly once, repaired by an ordinary
 * deterministic rebuild — never fabricated history or a blanket reset.
 */
export const PROJECTION_SUPPORT_VERSION = 2;

// --- Shared canonical identities -----------------------------------------------

export const GRAPH_NODE_KINDS = [
  'object',
  'creator',
  'work',
  'brand',
  'style',
  'tradition',
  'place',
  'cuisine',
  'technique',
  'attribute',
  'audience',
] as const;
export const GraphNodeKind = z.enum(GRAPH_NODE_KINDS);
export type GraphNodeKind = z.infer<typeof GraphNodeKind>;

export const GRAPH_NODE_DOMAINS = [
  'art',
  'sculpture',
  'ceramics',
  'interiors',
  'design',
  'music',
  'film',
  'food',
  'fashion',
] as const;
export const GraphNodeDomain = z.enum(GRAPH_NODE_DOMAINS);
export type GraphNodeDomain = z.infer<typeof GraphNodeDomain>;

export const GRAPH_EXTERNAL_PROVIDERS = ['qloo', 'wikidata', 'wikipedia'] as const;
export const GraphExternalProvider = z.enum(GRAPH_EXTERNAL_PROVIDERS);
export type GraphExternalProvider = z.infer<typeof GraphExternalProvider>;

/** PR 8 predicate policy v1: admitted predicates of the shared assertion set. */
export const GRAPH_PREDICATES = [
  'CREATED_BY',
  'ABOUT',
  'USES_TECHNIQUE',
  'HAS_ATTRIBUTE',
  'DOCUMENTED_ASSOCIATION',
  'AUDIENCE_AFFINITY',
] as const;
export const GraphPredicate = z.enum(GRAPH_PREDICATES);
export type GraphPredicate = z.infer<typeof GraphPredicate>;

/**
 * Account-scoped interpretations derived from a user's own authorized
 * capture analysis. VISUALLY_RESEMBLES is deliberately NOT a shared
 * predicate: it may only exist as a private link, never as public fact.
 */
export const PRIVATE_INTERPRETATIONS = ['VISUALLY_RESEMBLES', 'ABOUT', 'DOCUMENTED_ASSOCIATION'] as const;
export const PrivateInterpretation = z.enum(PRIVATE_INTERPRETATIONS);
export type PrivateInterpretation = z.infer<typeof PrivateInterpretation>;

export const GRAPH_EVIDENCE_KINDS = ['fact', 'subject_matter', 'audience', 'visual'] as const;
export const GraphEvidenceKind = z.enum(GRAPH_EVIDENCE_KINDS);
export type GraphEvidenceKind = z.infer<typeof GraphEvidenceKind>;

export const GraphNodeRow = z.object({
  id: z.string().uuid(),
  cultural_reference_id: z.string().uuid().nullable(),
  canonical_key: z.string(),
  canonical_name: z.string(),
  name_key: z.string(),
  node_kind: GraphNodeKind,
  domain: GraphNodeDomain,
  sense_key: z.string(),
  status: z.enum(['active', 'ambiguous', 'merged', 'retired']),
  merged_into_id: z.string().uuid().nullable(),
  revision: z.number().int(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type GraphNodeRow = z.infer<typeof GraphNodeRow>;

// --- Evidence contracts ---------------------------------------------------------

export const GraphSourceRevisionRow = z.object({
  id: z.string().uuid(),
  source_id: z.string().uuid(),
  url: z.string(),
  locator: z.string().nullable(),
  revision: z.number().int(),
  document_hash: z.string().nullable(),
  allowed_display_metadata: z.unknown(),
  retention_policy: z.unknown(),
  source_family_key: z.string(),
  rights: z.unknown(),
  rights_expires_at: z.date().nullable(),
  /**
   * Retraction status (migration 310): content stays immutable; a retracted
   * revision takes its evidence with it and invalidates dependent proofs.
   */
  validity_state: z.enum(['valid', 'retracted']),
  invalidated_at: z.date().nullable(),
  invalidation_reason: z.string().nullable(),
  retrieved_at: z.date(),
  created_at: z.date(),
});
export type GraphSourceRevisionRow = z.infer<typeof GraphSourceRevisionRow>;

export const GraphEvidenceRow = z.object({
  id: z.string().uuid(),
  source_revision_id: z.string().uuid(),
  locator: z.string().nullable(),
  permitted_excerpt: z.string().nullable(),
  structured_value: z.unknown().nullable(),
  validation_method: z.enum(['provider_metadata', 'curated_passage', 'machine_extraction']),
  validation_version: z.string(),
  evidence_kind: GraphEvidenceKind,
  expires_at: z.date().nullable(),
  /**
   * Review provenance (migration 300): reviewed corpus evidence records who
   * reviewed it and when. Machine-extracted proposals stay unreviewed (both
   * NULL) until a review admits them; the pair is all-or-nothing.
   */
  reviewed_by: z.string().nullable(),
  reviewed_at: z.date().nullable(),
  /**
   * Retraction status (migration 310): the content columns stay immutable, but
   * a retracted evidence row no longer justifies anything it supports.
   */
  validity_state: z.enum(['valid', 'retracted']),
  invalidated_at: z.date().nullable(),
  invalidation_reason: z.string().nullable(),
  created_at: z.date(),
});
export type GraphEvidenceRow = z.infer<typeof GraphEvidenceRow>;

export const GraphAssertionRow = z.object({
  id: z.string().uuid(),
  subject_node_id: z.string().uuid(),
  predicate: GraphPredicate,
  object_node_id: z.string().uuid(),
  association_subtype: z.string().nullable(),
  status: z.enum(['proposed', 'validated', 'disputed', 'rejected', 'superseded', 'retracted']),
  revision: z.number().int(),
  valid_from: z.date().nullable(),
  invalidated_at: z.date().nullable(),
  recorded_at: z.date(),
  superseded_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type GraphAssertionRow = z.infer<typeof GraphAssertionRow>;

export const GraphAssertionSupportRow = z.object({
  id: z.string().uuid(),
  assertion_id: z.string().uuid(),
  evidence_id: z.string().uuid(),
  role: z.enum(['supports', 'refutes']),
  derivation: z.enum(['primary', 'mirror', 'refresh', 'reextraction']),
  source_family_key: z.string(),
  created_at: z.date(),
});
export type GraphAssertionSupportRow = z.infer<typeof GraphAssertionSupportRow>;

// --- Provider rights policies (migration 300) -------------------------------------

/**
 * Durable operational record of each provider's approved privacy settings and
 * storage/display rights (no secrets). `transient_only` providers (Qloo while
 * its response-retention/public-display rights are undocumented) never have
 * their responses admitted as durable graph evidence; `rights_documented` is
 * false only while the rights themselves are honestly unresolved.
 */
export const ProviderRightsPolicyRow = z.object({
  provider: z.string(),
  response_retention: z.enum(['transient_only', 'permitted_documented']),
  public_display: z.enum(['owned_or_cleared_only', 'permitted_documented']),
  privacy_settings: z.unknown(),
  rights_documented: z.boolean(),
  unresolved_notes: z.string().nullable(),
  basis: z.string(),
  recorded_at: z.date(),
  updated_at: z.date(),
});
export type ProviderRightsPolicyRow = z.infer<typeof ProviderRightsPolicyRow>;

// --- Account-owned state ---------------------------------------------------------

export const PersonalGraphStateRow = z.object({
  owner_account_id: z.string().uuid(),
  target_taste_revision: z.number().int(),
  applied_taste_revision: z.number().int(),
  projection_revision: z.number().int(),
  deletion_generation: z.number().int(),
  state: z.enum(['idle', 'queued', 'running', 'ready', 'failed']),
  suppression_revision: z.number().int(),
  /** Versioned completeness marker of the applied projection (migration 290). */
  support_version: z.number().int(),
  last_error_code: z.string().nullable(),
  last_projected_at: z.date().nullable(),
  last_graph_run_id: z.string().uuid().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type PersonalGraphStateRow = z.infer<typeof PersonalGraphStateRow>;

/** Deployment-singleton checkpoint of the current-state backfill (migration 260). */
export const GraphBackfillStateRow = z.object({
  id: z.number().int(),
  state: z.enum(['running', 'complete']),
  started_at: z.date(),
  updated_at: z.date(),
  finished_at: z.date().nullable(),
  last_owner_account_id: z.string().uuid().nullable(),
  accounts_projected: z.number().int(),
  passes: z.number().int(),
});
export type GraphBackfillStateRow = z.infer<typeof GraphBackfillStateRow>;

export const PersonalInterestEdgeRow = z.object({
  id: z.string().uuid(),
  owner_account_id: z.string().uuid(),
  node_id: z.string().uuid().nullable(),
  discovery_item_id: z.string().uuid().nullable(),
  /** Private target for saves of shared/ownerless rows: the account's own save. */
  saved_item_id: z.string().uuid().nullable(),
  origin: z.enum(['explicit', 'derived']),
  state: z.enum(['confirmed', 'tentative', 'suppressed']),
  strength: z.number().nullable(),
  support_summary: z.unknown(),
  policy_version: z.string(),
  revision: z.number().int(),
  first_supported_at: z.date(),
  last_supported_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type PersonalInterestEdgeRow = z.infer<typeof PersonalInterestEdgeRow>;

export const PersonalInterestSupportOrigin = z.enum([
  'saved_item',
  'pick_group',
  'capture_reference',
  'analysis',
]);
export type PersonalInterestSupportOrigin = z.infer<typeof PersonalInterestSupportOrigin>;

export const PersonalInterestSupportRow = z.object({
  id: z.string().uuid(),
  owner_account_id: z.string().uuid(),
  edge_id: z.string().uuid(),
  origin_kind: PersonalInterestSupportOrigin,
  saved_item_id: z.string().uuid().nullable(),
  pick_id: z.string().uuid().nullable(),
  capture_id: z.string().uuid().nullable(),
  analysis_id: z.string().uuid().nullable(),
  capture_reference_id: z.string().uuid().nullable(),
  originating_event_id: z.string().uuid().nullable(),
  dependency_versions: z.unknown(),
  weight: z.number().nullable(),
  active: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type PersonalInterestSupportRow = z.infer<typeof PersonalInterestSupportRow>;

// --- Runs, frontier, proofs, outbox ----------------------------------------------

export const GRAPH_RUN_KINDS = ['projection', 'expansion', 'research'] as const;
export const GraphRunKind = z.enum(GRAPH_RUN_KINDS);
export type GraphRunKind = z.infer<typeof GraphRunKind>;

export const GraphRunRow = z.object({
  id: z.string().uuid(),
  owner_account_id: z.string().uuid(),
  job_id: z.string().uuid().nullable(),
  run_kind: GraphRunKind,
  input_taste_revision: z.number().int(),
  input_projection_revision: z.number().int(),
  input_generation: z.number().int(),
  policy_version: z.string(),
  budget: z.unknown(),
  state: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']),
  published: z.boolean(),
  started_at: z.date().nullable(),
  finished_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type GraphRunRow = z.infer<typeof GraphRunRow>;

export const GraphFrontierRow = z.object({
  id: z.string().uuid(),
  owner_account_id: z.string().uuid(),
  run_id: z.string().uuid(),
  node_id: z.string().uuid(),
  intent: z.enum(['expansion', 'research']),
  support_root_ids: z.array(z.string().uuid()),
  path_versions: z.unknown(),
  state: z.enum(['active', 'admitted', 'rejected', 'pruned', 'expired', 'published']),
  score: z.number().nullable(),
  dedupe_key: z.string(),
  expires_at: z.date(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type GraphFrontierRow = z.infer<typeof GraphFrontierRow>;

/** Longest a frontier candidate may live, in days (PR 8 operational bounds). */
export const GRAPH_FRONTIER_MAX_LIFETIME_DAYS = 7;

export const GraphOutboxRow = z.object({
  id: z.string().uuid(),
  owner_account_id: z.string().uuid(),
  event_type: z.enum(['taste', 'picks', 'claim', 'analysis', 'backfill', 'retract']),
  logical_event_key: z.string(),
  target_taste_revision: z.number().int(),
  target_generation: z.number().int(),
  job_intent: z.enum([
    'project_interest_graph',
    'expand_interest_graph',
    'research_graph_relation',
    'backfill',
  ]),
  payload: z.unknown(),
  dispatch_state: z.enum(['pending', 'dispatched', 'done', 'failed']),
  attempts: z.number().int(),
  created_at: z.date(),
  dispatched_at: z.date().nullable(),
  processed_at: z.date().nullable(),
});
export type GraphOutboxRow = z.infer<typeof GraphOutboxRow>;

/** Pinned assertion/evidence identity+revision pairs behind a proof. */
export const ProofDependency = z.object({ id: z.string().uuid(), revision: z.number().int().positive() });
export type ProofDependency = z.infer<typeof ProofDependency>;

export const RecommendationGraphProofRow = z.object({
  id: z.string().uuid(),
  owner_account_id: z.string().uuid(),
  recommendation_id: z.string().uuid(),
  graph_run_id: z.string().uuid(),
  proof_version: z.number().int(),
  assertion_ids: z.array(z.string().uuid()),
  assertion_revisions: z.array(z.number().int()),
  evidence_ids: z.array(z.string().uuid()),
  evidence_revisions: z.array(z.number().int()),
  support_edge_ids: z.array(z.string().uuid()),
  intent: z.enum(['personal', 'photo']),
  reason_template: z.string(),
  reason_template_version: z.string(),
  validity_state: z.enum(['valid', 'invalid', 'revoked', 'superseded']),
  invalidated_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type RecommendationGraphProofRow = z.infer<typeof RecommendationGraphProofRow>;

// --- Graph-parented recommendation/query contracts --------------------------------

/**
 * Origins accepted for graph-parented cards. Storage method is not
 * provenance: real origins only (qloo, research, catalog, replay...), and
 * there is deliberately no 'graph' origin.
 */
export const GraphRecommendationOrigin = z.enum(RECOMMENDATION_ORIGINS);
export type GraphRecommendationOrigin = z.infer<typeof GraphRecommendationOrigin>;

export const GraphRecommendationRow = z.object({
  id: z.string().uuid(),
  owner_account_id: z.string().uuid(),
  graph_run_id: z.string().uuid(),
  discovery_item_id: z.string().uuid(),
  origin: GraphRecommendationOrigin,
  title: z.string(),
  rank: z.number().int(),
  created_at: z.date(),
});
export type GraphRecommendationRow = z.infer<typeof GraphRecommendationRow>;

export const GraphProviderQueryRow = z.object({
  id: z.string().uuid(),
  owner_account_id: z.string().uuid(),
  graph_run_id: z.string().uuid(),
  provider: z.string(),
  operation: z.string(),
  created_at: z.date(),
});
export type GraphProviderQueryRow = z.infer<typeof GraphProviderQueryRow>;

// --- Rollout flags -----------------------------------------------------------------

/**
 * The four interest-graph rollout flags. All default false; each requires an
 * explicit operator opt-in and is killable globally or per account
 * (migration 250).
 */
export const INTEREST_GRAPH_FLAGS = [
  'interest_graph_projection_enabled',
  'interest_graph_discovery_enabled',
  'interest_graph_research_enabled',
  'interest_graph_framework_shadow_enabled',
] as const;
export type InterestGraphFlag = (typeof INTEREST_GRAPH_FLAGS)[number];
