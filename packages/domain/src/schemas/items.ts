import { z } from 'zod';
import { Category } from '../enums';
import { DiscoveryCard, ReferenceSummary, SourceDto, Uuid } from './common';

/** GET /v1/items/{id} — owned or approved public (sample) item with cached related results. */
export const ItemQuery = z.object({
  /** Recommendation context the card was opened from (capture/plan/related), for "Why this?". */
  recommendation_id: Uuid.optional(),
  /** Grant context for selected-collection agents. */
  collection_id: Uuid.optional(),
});
export type ItemQuery = z.infer<typeof ItemQuery>;

export const ItemDetailResponse = z.object({
  item: DiscoveryCard,
  /** Short explanation shown in the detail view. */
  reason: z.string().nullable(),
  /** "Why this?" disclosure: plain-language reason + optional sources. No raw scores. */
  why_this: z.object({ text: z.string(), sources: z.array(SourceDto) }).nullable(),
  /** Verified external destination only. */
  destination_url: z.url().nullable(),
  references: z.array(ReferenceSummary),
  /** Cached related discoveries (at most 6). Opening never triggers generation. */
  related: z.array(DiscoveryCard).max(6),
  related_state: z.enum(['none', 'cached', 'pending']),
  related_job_id: Uuid.nullable(),
  /** Collections (visible to the principal) this item belongs to. */
  collection_ids: z.array(Uuid),
  /** For kind=capture: the capture id to open the capture result. */
  capture_id: Uuid.nullable(),
});
export type ItemDetailResponse = z.infer<typeof ItemDetailResponse>;

/** POST /v1/items/{id}/discoveries — explicit bounded "Discover more" job. Returns 202. */
export const RelatedDiscoveryRequest = z.strictObject({
  category: Category.optional(),
  /** Grant context for selected-collection agents (the item must be in it). */
  collection_id: Uuid.optional(),
});
export type RelatedDiscoveryRequest = z.infer<typeof RelatedDiscoveryRequest>;

export const RelatedDiscoveryResponse = z.object({
  job_id: Uuid,
  discovery_job_id: Uuid,
  reused: z.boolean(),
});
export type RelatedDiscoveryResponse = z.infer<typeof RelatedDiscoveryResponse>;
