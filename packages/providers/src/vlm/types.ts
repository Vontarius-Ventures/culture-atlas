import { z } from 'zod';
import type { CapabilityEntry } from '../capabilities';
import type { CallOptions } from '../errors';

/**
 * Vision-language model contract. The adapter sends the normalized derivative
 * image and returns validated structured output. Text visible in the image is
 * DATA: it must never alter system/tool instructions (prompt-injection guard),
 * and the adapter exposes no tools to the model.
 */

export const VLM_REFERENCE_TYPES = ['object', 'creator', 'work', 'brand', 'style', 'tradition', 'place', 'cuisine'] as const;
export const VLM_CATEGORIES = ['wear', 'play', 'watch', 'eat'] as const;

export const VlmRegion = z.object({
  id: z.string(),
  label: z.string(),
  /** Normalized 0..1 bounding box. */
  box: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }),
});

export const VlmObservation = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(['garment', 'object', 'color', 'material', 'composition', 'setting', 'food', 'text', 'person_style', 'other']),
  region_ids: z.array(z.string()).default([]),
});

export const VlmCandidate = z.object({
  id: z.string(),
  /** Candidate reference name to resolve (Qloo search / tags / research). */
  name: z.string(),
  type: z.enum(VLM_REFERENCE_TYPES),
  /** 'depicted' needs strong evidence (e.g. legible logo); otherwise 'resembles'. */
  relation: z.enum(['depicted', 'resembles']),
  rationale: z.string(),
  /** Model-reported certainty 0..1 (internal only, never shown to consumers). */
  certainty: z.number().min(0).max(1),
  region_ids: z.array(z.string()).default([]),
  suggested_categories: z.array(z.enum(VLM_CATEGORIES)).default([]),
  /** Optional Qloo tag search phrases for styles/aesthetics. */
  tag_queries: z.array(z.string()).default([]),
});

export const VlmAnalysis = z.object({
  /** Short editorial title, e.g. "Vintage racing references". */
  title: z.string(),
  /** One sentence; plausible readings phrased as resemblance. */
  interpretation: z.string(),
  observations: z.array(VlmObservation),
  visible_text: z.array(z.object({ text: z.string(), region_id: z.string().nullable().default(null) })),
  candidates: z.array(VlmCandidate),
  regions: z.array(VlmRegion),
  uncertainty: z.object({
    overall: z.enum(['low', 'medium', 'high']),
    notes: z.array(z.string()).default([]),
  }),
  /** Several competing subjects -> UI asks "What caught your eye?" (max 3 choices). */
  competing_subjects: z.array(z.object({ id: z.string(), label: z.string(), region_ids: z.array(z.string()).default([]) })).max(3).default([]),
  quality: z.object({
    usable: z.boolean(),
    issue: z.enum(['blurred', 'no_subject', 'too_dark', 'unsupported_content']).nullable().default(null),
  }),
});
export type VlmAnalysis = z.infer<typeof VlmAnalysis>;
export type VlmCandidate = z.infer<typeof VlmCandidate>;

/*
 * Two-stage photo reading (spec amendment 2.2, docs/analysis-latency-plan.md
 * "Recommended reading format"). Stage 1 (`vision_photo`) returns the slim
 * VlmQuickRead interactively; stage 2 (`vision_photo_enrich`) returns
 * VlmEnrichment in the background. `toVlmAnalysis` merges both into today's
 * VlmAnalysis so the compiler, validateVision, the inspector and v2 frame
 * aggregation stay unchanged. Length limits in comments are prompt targets;
 * the schema maxima are hard limits.
 */

const VlmQuality = z.object({
  usable: z.boolean(),
  issue: z.enum(['blurred', 'no_subject', 'too_dark', 'unsupported_content']).nullable(),
});

/** Stage-1 candidate: specific and searchable; no ids, boxes or rationale. */
export const VlmQuickCandidate = z.object({
  /** Specific, searchable name, max 80 chars. */
  name: z.string().max(80),
  type: z.enum(VLM_REFERENCE_TYPES),
  relation: z.enum(['depicted', 'resembles']),
  certainty: z.number().min(0).max(1),
  categories: z.array(z.enum(VLM_CATEGORIES)).max(4),
  /** Taxonomy phrase for style/tradition/cuisine (Qloo /v2/tags), else null. */
  tag_query: z.string().nullable(),
});
export type VlmQuickCandidate = z.infer<typeof VlmQuickCandidate>;

/** Stage 1, interactive: 512 px, maxOutputTokens 600, 10 s timeout, effort none. */
export const VlmQuickRead = z.object({
  /** <= 6 words (prompt), max 60 chars. */
  title: z.string().max(60),
  /** One sentence, <= 20 words (prompt), max 160 chars. */
  interpretation: z.string().max(160),
  /** The prompt asks for 3-5. */
  candidates: z.array(VlmQuickCandidate).max(5),
  quality: VlmQuality,
});
export type VlmQuickRead = z.infer<typeof VlmQuickRead>;

/** Stage 2, background: 768 px, maxOutputTokens 1200, 20 s timeout, effort none. */
export const VlmEnrichment = z.object({
  observations: z
    .array(z.object({ text: z.string(), kind: VlmObservation.shape.kind }))
    .max(5),
  visible_text: z.array(z.string()).max(8),
  /** Per stage-1 candidate. keep=false is advisory: it lowers certainty, never removes published cards. */
  confirmed: z.array(
    z.object({
      name: z.string(),
      /** <= 15 words (prompt). */
      rationale: z.string(),
      keep: z.boolean(),
    }),
  ),
  additional_candidates: z.array(VlmQuickCandidate.extend({ rationale: z.string() })).max(4),
  regions: z.array(z.object({ label: z.string(), box: VlmRegion.shape.box })).max(4),
  uncertainty: z.object({
    overall: z.enum(['low', 'medium', 'high']),
    notes: z.array(z.string()).max(3),
  }),
  competing_subjects: z.array(z.string()).max(3),
});
export type VlmEnrichment = z.infer<typeof VlmEnrichment>;

/**
 * Deterministic merge into today's VlmAnalysis with synthetic ids (package C,
 * docs/build-plan-v2.2.md). Rules:
 *  - without an enrichment, the result carries the quick read alone
 *    (candidates with empty rationale, no observations/regions);
 *  - confirmed rationales become candidate rationales; keep=false only lowers
 *    certainty (advisory veto), it never drops a candidate;
 *  - additional candidates are appended after stage-1 candidates, never
 *    reordering them; regions/observations/visible text/competing subjects
 *    come from the enrichment.
 */
export function toVlmAnalysis(quick: VlmQuickRead, enrichment?: VlmEnrichment): VlmAnalysis {
  void quick;
  void enrichment;
  throw new Error('toVlmAnalysis is not implemented yet (package C).');
}

export interface VlmAnalyzeInput {
  image: { bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' };
  /** User focus: a chosen subject label or region. */
  focus?: { label?: string; box?: { x: number; y: number; w: number; h: number } };
  /** Named interests the user confirmed (used when visual evidence is weak). */
  confirmedInterests?: string[];
  /** Candidates the user rejected in a correction. */
  rejectedNames?: string[];
  maxCandidates?: number;
}

export interface VlmResult {
  analysis: VlmAnalysis;
  model: string;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface VlmProvider {
  readonly id: string;
  capability(): CapabilityEntry;
  analyzeImage(input: VlmAnalyzeInput, options?: CallOptions): Promise<VlmResult>;
}
