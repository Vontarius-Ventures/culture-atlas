import { z } from 'zod';
import { ClaimType, ReferenceType } from '../enums';
import { DiscoveryCard, SourceDto, Timestamp, Uuid } from './common';

/** GET /v1/references/{id} — public facts only; never other users' context. */
export const ReferenceQuery = z.object({
  /** Optional capture context (owned/granted) to compute related cards against. */
  capture_id: Uuid.optional(),
});

export const ReferenceResponse = z.object({
  id: Uuid,
  name: z.string(),
  type: ReferenceType,
  /** Under 150 words. */
  overview: z.string().nullable(),
  /** Up to three sections; full initial page under 500 words. */
  sections: z.array(z.object({ heading: z.string(), body: z.string(), claim_ids: z.array(Uuid) })).max(3),
  claims: z.array(
    z.object({ id: Uuid, text: z.string(), claim_type: ClaimType, source_ids: z.array(Uuid) }),
  ),
  /** Expandable sources (closed by default in UI). */
  sources: z.array(SourceDto),
  related: z.array(DiscoveryCard),
  research_status: z.enum(['none', 'pending', 'complete', 'failed', 'unsupported']),
  revision: z.number().int(),
  updated_at: Timestamp,
});
export type ReferenceResponse = z.infer<typeof ReferenceResponse>;
