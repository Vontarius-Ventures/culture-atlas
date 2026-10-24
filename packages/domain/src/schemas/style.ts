import { z } from 'zod';
import { DiscoveryCard } from './common';

/**
 * Style reading and rails on the wire (prp/2026-10-23-style-analysis §E.2,
 * amended R-15/R-16). Every field is additive and optional for old clients.
 * Internal certainty numbers are never sent: `strength` is a coarse band
 * derived after wording. Every claim carries a server-composed `display`
 * string that clients render verbatim.
 */

export const StyleRegion = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) });
export type StyleRegion = z.infer<typeof StyleRegion>;
export const StyleWording = z.enum(['asserted', 'resembles']);
export const StyleStrength = z.enum(['clear', 'likely', 'possible']);
export const StyleSubjectCategory = z.enum(['fashion', 'interior', 'food', 'place', 'media', 'other']);

export const StyleAestheticDto = z.object({
  name: z.string(),
  wording: StyleWording,
  display: z.string(),
  strength: StyleStrength,
  /** Claim regions only while STYLE_SHOW_CLAIM_REGIONS is on (R-15); otherwise null. */
  region: StyleRegion.nullable(),
  features: z.array(z.string()),
});
export const StyleClaimDto = z.object({ name: z.string(), display: z.string(), wording: StyleWording });
export const StyleMaterialDto = z.object({ name: z.string(), texture: z.string(), wording: StyleWording, display: z.string(), strength: StyleStrength.nullable(), region: StyleRegion.nullable() });
export const StyleConstructionDto = z.object({ name: z.string(), kind: z.string(), wording: StyleWording, display: z.string(), strength: StyleStrength.nullable(), region: StyleRegion.nullable() });
export const StylePaletteDto = z.object({ swatch: z.number().int().nonnegative(), name: z.string(), hex: z.string().regex(/^#[0-9A-F]{6}$/), display: z.string() });
export const StyleMoodDto = z.object({ name: z.string(), display: z.string() });
export const StyleDetailDto = z.object({ text: z.string(), display: z.string(), wording: StyleWording, strength: StyleStrength.nullable(), region: StyleRegion.nullable() });

export const StyleSubjectDto = z.object({
  id: z.enum(['s1', 's2']),
  category: StyleSubjectCategory,
  label: z.string(),
  /** Subject regions are coarse and always sent; normalized to the displayed capture image. */
  region: StyleRegion,
  aesthetics: z.array(StyleAestheticDto),
  era: z.object({ name: z.string(), display: z.string(), wording: StyleWording }).nullable(),
  lineage: z.array(StyleClaimDto),
  materials: z.array(StyleMaterialDto),
  construction: z.array(StyleConstructionDto),
  palette: z.array(StylePaletteDto),
  mood: z.array(StyleMoodDto),
  details: z.array(StyleDetailDto),
  brand: z.object({ name: z.string(), read_text: z.string() }).nullable(),
  /** Qloo's own similar_brand tag names, rendered as text only ("Qloo also links: …"); [] if none. */
  qloo_links: z.array(z.string()),
  /** The rail key for this subject's "More like this". */
  rail: z.string(),
});
export type StyleSubjectDto = z.infer<typeof StyleSubjectDto>;

export const StyleReadingDto = z.object({
  version: z.literal('atlas_style_reading_v1'),
  summary: z.string(),
  swatches: z.array(z.object({ index: z.number().int().nonnegative(), hex: z.string().regex(/^#[0-9A-F]{6}$/), share: z.number().min(0).max(1) })),
  subjects: z.array(StyleSubjectDto).max(2),
  /** Claim paths removed after a stage-2 veto; clients fade those claims out. */
  retracted: z.array(z.string()),
});
export type StyleReadingDto = z.infer<typeof StyleReadingDto>;

/**
 * Terminal statuses for polling are ready | empty | failed | held (R-16c);
 * clients treat any unknown status as terminal.
 */
export const RailStatus = z.enum(['pending', 'running', 'ready', 'empty', 'failed', 'held']);
export type RailStatus = z.infer<typeof RailStatus>;

/** DiscoveryCard additions (C.4): the reason and the structured match behind it. */
export const CardStyleMatch = DiscoveryCard.shape.style_match.unwrap().unwrap();
export type CardStyleMatch = z.infer<typeof CardStyleMatch>;

/** One rail in display order (E.2): "More like this" per style subject, then the cross-domain categories. */
export const RailDto = z.object({
  key: z.string(),
  kind: z.enum(['more_like_this', 'cross_domain']),
  title: z.string(),
  /** The attributes that drove the rail ("Workwear · duck canvas"). */
  subtitle: z.string().nullable(),
  subject_id: z.string().nullable(),
  status: RailStatus,
  /** e.g. "Add a city to see places with this style." */
  empty_message: z.string().nullable(),
  /** The first More-like-this rail and the cross-domain group carry the experimental caption (R-17). */
  caption: z.string().nullable().optional(),
  cards: z.array(DiscoveryCard),
});
export type RailDto = z.infer<typeof RailDto>;

export const AnalysisExperimental = z.object({ label: z.string(), note: z.string() });

/** Copy keys every client renders verbatim (D.4; mirrored in design/copy.json under `experimental` and `style`). */
export const STYLE_COPY = {
  experimental: {
    badge: 'Experimental',
    note: 'Photo and video readings are experimental. They can miss or misread details.',
    rail_caption: 'From an experimental reading',
    why_line: 'Suggested from an experimental reading of your photo.',
  },
  style: {
    paused: "Photo reading is paused right now. Your photo is saved, and we'll read it when it's back.",
    limit: "We've hit today's limit for experimental readings. Your photo is saved, and you can read it tomorrow.",
    failed: "We couldn't read the style of this one.",
    empty: 'No clear style to read here.',
    no_city: 'Add a city to see places with this style.',
    rail_empty: 'Qloo found nothing close to this style yet.',
    reading: 'Reading the style…',
    rail_running: 'Finding things with this style…',
    updated: 'Style reading updated',
    try_again: 'Try again',
    add_city: 'Add city',
    qloo_links: 'Qloo also links: {names}',
    show_details: 'Show all details',
  },
} as const;

/** POST /v1/captures/{id}/style/retry -> 202 */
export const StyleRetryResponse = z.object({ job_id: z.string().uuid(), sections: z.object({ style: z.literal('running') }) });

/** PUT /v1/me/city (C.6): user-entered free text, never inferred. null clears it. */
export const SetCityRequest = z.strictObject({ city: z.string().trim().min(1).max(80).nullable() });
export type SetCityRequest = z.infer<typeof SetCityRequest>;

/** GET /v2/media/{id}/analysis/{analysisId} result.style preview (E.3). */
export const MediaStylePreview = z.object({
  status: RailStatus,
  summary: z.string().nullable(),
  aesthetics: z.array(z.object({ subject_id: z.string(), display: z.string(), wording: StyleWording })).max(4),
  swatches: z.array(z.string().regex(/^#[0-9A-F]{6}$/)),
  frame_index: z.number().int().nonnegative().nullable(),
});
export type MediaStylePreview = z.infer<typeof MediaStylePreview>;
