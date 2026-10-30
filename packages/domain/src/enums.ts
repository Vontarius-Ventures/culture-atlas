import { z } from 'zod';

/** Consumer discovery categories (filters: Wear, Play, Watch, Eat). */
export const CATEGORIES = ['wear', 'play', 'watch', 'eat'] as const;
export const Category = z.enum(CATEGORIES);
export type Category = z.infer<typeof Category>;

/** DiscoveryItem kinds. */
export const ITEM_KINDS = ['capture', 'style', 'brand', 'artist', 'track', 'film', 'food', 'reference'] as const;
export const ItemKind = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof ItemKind>;

/** Default category for each item kind (capture/reference have none). */
export const KIND_CATEGORY: Record<ItemKind, Category | null> = {
  capture: null,
  reference: null,
  style: 'wear',
  brand: 'wear',
  artist: 'play',
  track: 'play',
  film: 'watch',
  food: 'eat',
};

/** Collection detail filters (All, Photos, Music, Films, Food, Style). */
export const COLLECTION_FILTERS = ['photos', 'music', 'films', 'food', 'style'] as const;
export const CollectionFilter = z.enum(COLLECTION_FILTERS);
export type CollectionFilter = z.infer<typeof CollectionFilter>;
export const COLLECTION_FILTER_KINDS: Record<CollectionFilter, ItemKind[]> = {
  photos: ['capture'],
  music: ['artist', 'track'],
  films: ['film'],
  food: ['food'],
  style: ['style', 'brand'],
};

export const JOB_STATES = ['queued', 'running', 'partial', 'complete', 'failed', 'cancelled'] as const;
export const JobState = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobState>;
/** Active states: the browser keeps polling. All others are terminal. */
export const ACTIVE_JOB_STATES: readonly JobState[] = ['queued', 'running'];
export const TERMINAL_JOB_STATES: readonly JobState[] = ['partial', 'complete', 'failed', 'cancelled'];

export const JOB_TYPES = [
  'analyze_capture',
  'discover_related',
  'generate_plan',
  'replace_plan_section',
  'sensor_poll',
  'purge_deleted',
  /** Seeds a new account's feed from its onboarding picks (spec amendment 2.2). */
  'taste_seed',
  /** Walks the interest graph: more Qloo cards from cards already in the pool. */
  'interest_expand',
  /** Amendment 2.3 Music Mode: explicit Explore of a private audio asset. */
  'analyze_audio',
  /**
   * PR 8 interest graph: rebuilds one account's private projection from
   * current explicit state (outbox dispatch, backfill or sweeper). Never
   * calls providers and never touches live recommendations.
   */
  'project_interest_graph',
  /**
   * PR 8 interest graph: one bounded expansion refresh for one account's
   * eligible explicit and active-photo roots (the closed-app sweeper or a
   * feed-read enqueue). Durable per-logical-run budget; never the legacy
   * paid expansion.
   */
  'expand_interest_graph',
  /**
   * PR 8 interest graph: one bounded relation-research pair (at most two
   * source documents, at most ten proposed assertions, stored as unreviewed
   * proposals). Paid research dispatch is fail-closed behind the research
   * flag, a qualified role and durable account/global spend limits.
   */
  'research_graph_relation',
  /**
   * PR 8 deletion lifecycle: the durable private-store cleanup for one
   * accepted account deletion (VAL-DELETE-004). System-owned (no owner: it
   * must survive the account rows it deletes), enqueued by acceptance and
   * re-armed by the worker sweep after crashes, restarts or terminal
   * failures. Idempotent: objects are removed before rows, every delete is
   * re-runnable, and completion is claimed only after every required store
   * is gone. Failures leave the deletion failed-but-owed and never restore
   * any account authority.
   */
  'purge_account',
] as const;
export const JobType = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobType>;

export const SCOPES = [
  'captures:read',
  'captures:write',
  'collections:read',
  'collections:write',
  'taste:read',
  'taste:write',
  'plans:read',
  'plans:write',
  'setup:read',
  'preferences:read',
  'preferences:write',
  'media:read',
  'media:download',
  'media:write',
  'media:analyze',
  'devices:command',
] as const;
export const Scope = z.enum(SCOPES);
export type Scope = z.infer<typeof Scope>;
export const READ_ONLY_SCOPES: readonly Scope[] = [
  'captures:read',
  'collections:read',
  'taste:read',
  'plans:read',
];

export const LIBRARY_ACCESS = ['none', 'selected_collections', 'all'] as const;
export const LibraryAccess = z.enum(LIBRARY_ACCESS);
export type LibraryAccess = z.infer<typeof LibraryAccess>;

export const EXPLORATION = ['familiar', 'balanced', 'adventurous'] as const;
export const Exploration = z.enum(EXPLORATION);
export type Exploration = z.infer<typeof Exploration>;

export const CAPTURE_SOURCES = ['upload', 'camera', 'sensor', 'sample'] as const;
export const CaptureSource = z.enum(CAPTURE_SOURCES);
export type CaptureSource = z.infer<typeof CaptureSource>;

export const CAPTURE_STATUSES = ['pending', 'processing', 'ready', 'partial', 'failed', 'deleted'] as const;
export const CaptureStatus = z.enum(CAPTURE_STATUSES);
export type CaptureStatus = z.infer<typeof CaptureStatus>;

export const REFERENCE_TYPES = ['object', 'creator', 'work', 'brand', 'style', 'tradition', 'place', 'cuisine'] as const;
export const ReferenceType = z.enum(REFERENCE_TYPES);
export type ReferenceType = z.infer<typeof ReferenceType>;

export const CAPTURE_RELATIONS = ['depicted', 'resembles', 'user_selected'] as const;
export const CaptureRelation = z.enum(CAPTURE_RELATIONS);
export type CaptureRelation = z.infer<typeof CaptureRelation>;

export const RESOLUTION_STATUSES = ['resolved', 'unmatched', 'ambiguous', 'user_confirmed', 'rejected'] as const;
export const ResolutionStatus = z.enum(RESOLUTION_STATUSES);
export type ResolutionStatus = z.infer<typeof ResolutionStatus>;

export const CLAIM_TYPES = ['factual', 'interpretive'] as const;
export const ClaimType = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof ClaimType>;

export const PREFERENCE_ACTIONS = ['save', 'remove', 'hide', 'unhide'] as const;
export const PreferenceAction = z.enum(PREFERENCE_ACTIONS);
export type PreferenceAction = z.infer<typeof PreferenceAction>;
/** Stored event actions include 'correct' (written by capture corrections). */
export const PREFERENCE_EVENT_ACTIONS = [...PREFERENCE_ACTIONS, 'correct'] as const;

export const PREFERENCE_TARGET_TYPES = ['discovery_item', 'capture'] as const;
export const PreferenceTargetType = z.enum(PREFERENCE_TARGET_TYPES);
export type PreferenceTargetType = z.infer<typeof PreferenceTargetType>;

export const PLAN_TEMPLATES = ['movie_night'] as const;
export const PlanTemplate = z.enum(PLAN_TEMPLATES);
export type PlanTemplate = z.infer<typeof PlanTemplate>;

export const PLAN_SECTIONS = ['film', 'food', 'music'] as const;
export const PlanSection = z.enum(PLAN_SECTIONS);
export type PlanSection = z.infer<typeof PlanSection>;

/** Section status used by analyses and plan versions. */
export const SECTION_STATUSES = ['pending', 'running', 'complete', 'partial', 'failed', 'skipped', 'unavailable'] as const;
export const SectionStatus = z.enum(SECTION_STATUSES);
export type SectionStatus = z.infer<typeof SectionStatus>;

/** Analysis section names, published progressively. */
export const ANALYSIS_SECTIONS = ['observations', 'references', 'research', 'wear', 'play', 'watch', 'eat'] as const;
export const AnalysisSection = z.enum(ANALYSIS_SECTIONS);
export type AnalysisSection = z.infer<typeof AnalysisSection>;

/** Recommendation provenance (internal; never shown raw to consumers). */
export const RECOMMENDATION_ORIGINS = ['qloo', 'research', 'catalog', 'vlm_creative', 'sample', 'replay'] as const;
export const RecommendationOrigin = z.enum(RECOMMENDATION_ORIGINS);
export type RecommendationOrigin = z.infer<typeof RecommendationOrigin>;

export const SENSOR_MODES = ['poll', 'bridge'] as const;
export const SensorMode = z.enum(SENSOR_MODES);
export type SensorMode = z.infer<typeof SensorMode>;

/** Hard limits from the build spec. Runtime-tunable values live in config.ts. */
export const LIMITS = {
  uploadMaxBytes: 15 * 1024 * 1024,
  decodedMaxPixels: 40_000_000,
  derivativeMaxEdge: 2048,
  collectionNameMax: 80,
  collectionDescriptionMax: 500,
  planMinItems: 2,
  planMaxItems: 5,
  recommendationsPerCategory: 3,
  recommendationsPerAnalysis: 12,
  initialRenderedRecommendations: 6,
  relatedCachedMax: 6,
  /** Amendment 2.2: Qloo resolution is capped at 5 candidates per analysis (stage 1 reads 3-5). */
  vlmCandidatesToResolve: 5,
  /** Concurrent Qloo resolve requests per analysis (the hackathon key throttles bursts). */
  qlooResolveConcurrency: 3,
  /**
   * Model calls one photo reading may take: stage-1 quick read + stage-2
   * enrichment + two verifier checks (vision_verify, off by default; round 3:
   * one before the first section publishes, one before stage 2 publishes).
   * The verifier's calls are reserved separately and only when it is enabled.
   */
  visionCallsPerAnalysis: 4,
  anchorsMax: 5,
  researchedReferencesMax: 5,
  qlooRequestsPerJob: 12,
  providerRetriesPerStage: 2,
  analysisDeadlineMs: 60_000,
  clarifyingChoicesMax: 3,
  referenceInitialWordsMax: 150,
  referencePageWordsMax: 500,
  referenceSectionsMax: 3,
  planDishesMax: 3,
  planAlternatesFilms: 2,
  verifiedTracksMax: 5,
  instructionMaxChars: 280,
  dietaryExclusionsMax: 12,
  dietaryExclusionMaxChars: 40,
  idempotencyTtlHours: 24,
  anonymousTtlHours: 24,
  feedPageDefault: 12,
  feedPageMax: 24,
} as const;
