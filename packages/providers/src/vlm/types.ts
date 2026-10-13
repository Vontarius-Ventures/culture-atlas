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
