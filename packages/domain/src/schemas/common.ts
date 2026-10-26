import { z } from 'zod';
import {
  CaptureRelation,
  Category,
  ItemKind,
  LIMITS,
  ReferenceType,
} from '../enums';

/**
 * Shared DTO building blocks. Conventions:
 *  - Request bodies use z.strictObject (unknown mutation fields are rejected).
 *  - Response objects use z.object (clients ignore unknown fields).
 *  - Field names are snake_case on the wire; timestamps are ISO-8601 UTC strings.
 *  - No raw scores, provider names or affinity values appear in consumer DTOs;
 *    those live only in the demo inspector trace schema.
 */

export const Uuid = z.uuid();
export const Timestamp = z.iso.datetime({ offset: true });
/** Opaque pagination cursor (base64url). */
export const Cursor = z.string().min(1).max(512);

export const LimitQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.feedPageMax).optional(),
});
export const PageQuery = LimitQuery.extend({ cursor: Cursor.optional() });
export type PageQuery = z.infer<typeof PageQuery>;

export const IdParams = z.object({ id: Uuid });
export type IdParams = z.infer<typeof IdParams>;

/** Short-lived signed URL (private media) or a public sample asset path. */
export const Image = z.object({
  url: z.string().min(1),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  alt: z.string(),
});
export type Image = z.infer<typeof Image>;

/** Focus: what the user chose in the photo ("What caught your eye?"). */
export const Box = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type Box = z.infer<typeof Box>;

export const Focus = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('whole') }),
  z.strictObject({ kind: z.literal('choice'), choice_id: z.string().min(1).max(64), label: z.string().max(120).optional() }),
  z.strictObject({ kind: z.literal('region'), box: Box, label: z.string().max(120).optional() }),
]);
export type Focus = z.infer<typeof Focus>;

/**
 * The consumer card used everywhere (feed, capture results, related items,
 * collections, saved). `is_example` must be true for any sample or replayed
 * result; the UI labels those "Example result".
 */
export const DiscoveryCard = z.object({
  id: Uuid,
  kind: ItemKind,
  category: Category.nullable(),
  title: z.string(),
  subtitle: z.string().nullable(),
  image: Image.nullable(),
  is_example: z.boolean(),
  saved: z.boolean(),
  saved_item_id: Uuid.nullable(),
  /** Context-specific recommendation (capture/plan/related) this card came from, if any. */
  recommendation_id: Uuid.nullable(),
  /** True when "Why this?" has a reason and/or sources to show. */
  evidence_available: z.boolean(),
  /** The card's reason (display_reason, <= 90 chars) in capture rails; null when none (style design §C.4). */
  reason: z.string().max(200).nullable().optional(),
  /** The style overlap behind the reason; null outside capture rails (style design §C.4). */
  style_match: z
    .object({
      subject_id: z.string().nullable(),
      /** The style attributes (the claims' own names) the card shares with the photo. */
      attributes: z.array(z.string()),
      palette: z.array(z.string()),
      /** The identified entity or bridge it came through, when that is the connection. */
      via: z.string().nullable(),
      experimental: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type DiscoveryCard = z.infer<typeof DiscoveryCard>;

export const SourceDto = z.object({
  id: Uuid,
  url: z.url(),
  title: z.string().nullable(),
  publisher: z.string().nullable(),
  retrieved_at: Timestamp,
});
export type SourceDto = z.infer<typeof SourceDto>;

export const ReferenceSummary = z.object({
  id: Uuid,
  name: z.string(),
  type: ReferenceType,
  /** Relation to the capture when shown in a capture context. */
  relation: CaptureRelation.nullable(),
  /** True for resemblances / uncertain matches: UI must phrase as a resemblance. */
  qualified: z.boolean(),
  /** True when a reference page with sourced content is available. */
  has_page: z.boolean(),
  /**
   * Only for a text-only reference (a name read in the photo once, never
   * looked up or confirmed): the text it was read from. The UI shows it with
   * that text instead of phrasing it as a match or a resemblance.
   */
  read_text: z.string().nullable().optional(),
});
export type ReferenceSummary = z.infer<typeof ReferenceSummary>;

/** Body for 202 responses that start or reuse a job. */
export const JobAccepted = z.object({
  job_id: Uuid,
  /** True when an existing job for the same input/version was reused. */
  reused: z.boolean(),
});

export const Paginated = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), next_cursor: Cursor.nullable() });

/** Trimmed, non-empty user text with a max length. */
export const UserText = (max: number) => z.string().trim().min(1).max(max);
