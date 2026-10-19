import type { CapabilityEntry } from '../capabilities';
import type { CallOptions } from '../errors';

/**
 * Qloo adapter contract, implemented against the documented API
 * (https://github.com/qloo/docs-public):
 *   GET /search            canonical entities           -> searchEntities
 *   GET /v2/tags           valid taxonomy tags          -> lookupTags
 *   GET /v2/insights       related entities/tags        -> insights (feature.explainability)
 *   GET /v2/trending       entity momentum (optional)   -> trending
 *   GET /trends/entity     entity trend history         -> entityTrends
 * Auth header: X-Api-Key. Base URL: QLOO_API_URL.
 *
 * Rules: use only real returned IDs; never fabricate results; affinity is a
 * per-query normalized relationship strength (never a probability) and must
 * not be averaged across queries. When QLOO_API_KEY is unset every capability
 * reports 'unavailable/not_configured' and every call throws ProviderError('unavailable').
 */

export const QLOO_ENTITY_TYPES = [
  'urn:entity:actor',
  'urn:entity:album',
  'urn:entity:artist',
  'urn:entity:author',
  'urn:entity:book',
  'urn:entity:brand',
  'urn:entity:destination',
  'urn:entity:director',
  'urn:entity:locality',
  'urn:entity:movie',
  'urn:entity:person',
  'urn:entity:place',
  'urn:entity:podcast',
  'urn:entity:tv_show',
  'urn:entity:videogame',
] as const;
export type QlooEntityType = (typeof QLOO_ENTITY_TYPES)[number];

export interface QlooTagRef {
  id: string;
  name: string;
  type?: string;
}

/** Normalized entity (search or insights result). */
export interface QlooEntity {
  entity_id: string;
  name: string;
  types: string[];
  subtype?: string;
  popularity?: number;
  /** Human-readable place/locality context ("Madrid, Comunidad de Madrid, España"); used to tell same-named places apart. */
  disambiguation?: string;
  /** Selected documented properties (image, release_year, description, external ids, ...). */
  properties: Record<string, unknown>;
  tags: QlooTagRef[];
  /** Present on insights results. Internal ranking/inspection only. */
  query?: {
    affinity?: number;
    /** feature.explainability: contributing input entities with normalized influence. */
    explainability?: { entity_id: string; score: number }[];
  };
}

export interface QlooTag {
  id: string;
  name: string;
  type: string;
  parents?: string[];
  /** Qloo's 0..1 popularity percentile, when returned (used to drop obscure taste-seed tags). */
  popularity?: number;
}

/** What was sent (no API key), for provider_queries.sanitized_request. */
export interface QlooSanitizedRequest {
  method: 'GET' | 'POST';
  path: string;
  query: Record<string, string | string[]>;
}

export interface QlooResponse<T> {
  data: T;
  request: QlooSanitizedRequest;
  status: number;
  retrieved_at: string;
  duration_ms: number;
  /** Raw body as returned (store only where permitted). */
  raw?: unknown;
  /** True only for recorded fixtures; such results must be labeled "Example result". */
  is_replay: boolean;
  rate_limit?: { limit?: number; remaining?: number; reset_at?: string };
}

export interface QlooSearchRequest {
  query: string;
  types?: QlooEntityType[];
  /** Up to 100 per docs. */
  take?: number;
}

export interface QlooTagsRequest {
  /** filter.query partial name search. */
  query: string;
  /** filter.tag.types — exact tag-type URNs. */
  tagTypes?: string[];
  /** Up to 50 per page per docs. */
  take?: number;
  page?: number;
}

export interface QlooInsightsRequest {
  filterType: QlooEntityType | 'urn:tag' | 'urn:demographics';
  signalEntities?: string[];
  signalTags?: { id: string; weight?: number }[];
  signalLocationQuery?: string;
  /** filter.results.entities: restrict scored candidates. */
  filterResultsEntities?: string[];
  filterTags?: string[];
  /**
   * filter.tag.types: with filterType 'urn:tag', restrict returned tags to
   * these tag-type URNs (e.g. 'urn:tag:cuisine:qloo').
   */
  filterTagTypes?: string[];
  biasTrends?: 'off' | 'low' | 'medium' | 'high';
  explainability?: boolean;
  /** Typical max 50. */
  take?: number;
  page?: number;
}

export interface QlooInsightsResult {
  entities: QlooEntity[];
  tags: QlooTag[];
}

export interface QlooTrendingRequest {
  signalEntities: string[];
  filterType: QlooEntityType;
  /** ISO dates YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  take?: number;
  page?: number;
}

export interface QlooTrendPoint {
  date: string;
  population_percentile?: number;
  population_rank?: number;
  velocity?: number;
  [k: string]: unknown;
}

export interface QlooTrendingResult {
  entities: (QlooEntity & { trend?: QlooTrendPoint[] })[];
}

export interface QlooEntityTrendsRequest {
  entityId: string;
  startDate: string;
  endDate?: string;
}

export interface QlooEntityTrendsResult {
  entity_id: string;
  points: QlooTrendPoint[];
}

export interface QlooCapabilities {
  search: CapabilityEntry;
  tags: CapabilityEntry;
  insights: CapabilityEntry;
  explainability: CapabilityEntry;
  trending: CapabilityEntry;
  trendsEntity: CapabilityEntry;
}

export interface QlooProvider {
  readonly id: string;
  capability(): QlooCapabilities;
  searchEntities(req: QlooSearchRequest, options?: CallOptions): Promise<QlooResponse<QlooEntity[]>>;
  lookupTags(req: QlooTagsRequest, options?: CallOptions): Promise<QlooResponse<QlooTag[]>>;
  insights(req: QlooInsightsRequest, options?: CallOptions): Promise<QlooResponse<QlooInsightsResult>>;
  trending(req: QlooTrendingRequest, options?: CallOptions): Promise<QlooResponse<QlooTrendingResult>>;
  entityTrends(req: QlooEntityTrendsRequest, options?: CallOptions): Promise<QlooResponse<QlooEntityTrendsResult>>;
}
