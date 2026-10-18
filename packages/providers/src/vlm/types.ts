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

/** Certainty multiplier for a stage-1 candidate the enrichment advises against (keep=false). */
export const ENRICHMENT_VETO_CERTAINTY_FACTOR = 0.5;
/** Hard cap on candidates in a merged reading (5 stage-1 + 4 additional). */
export const MERGED_CANDIDATES_MAX = 9;

/** Name key used to match enrichment confirmations to stage-1 candidates (case, accents, punctuation). */
export function candidateNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const dedupe = <T>(values: readonly T[]): T[] => [...new Set(values)];

function boxIsValid(box: { x: number; y: number; w: number; h: number }): boolean {
  return box.w > 0 && box.h > 0 && box.x + box.w <= 1 && box.y + box.h <= 1;
}

/** Overall uncertainty of a quick read, derived only from its own certainties. */
function quickUncertainty(quick: VlmQuickRead): VlmAnalysis['uncertainty']['overall'] {
  if (!quick.candidates.length) return 'high';
  const mean = quick.candidates.reduce((n, c) => n + c.certainty, 0) / quick.candidates.length;
  return mean >= 0.7 ? 'low' : mean >= 0.4 ? 'medium' : 'high';
}

function fromQuickCandidate(c: VlmQuickCandidate, id: string, rationale: string): VlmCandidate {
  return {
    id,
    name: c.name,
    type: c.type,
    relation: c.relation,
    rationale,
    certainty: c.certainty,
    region_ids: [],
    suggested_categories: dedupe(c.categories),
    tag_queries: c.tag_query?.trim() ? [c.tag_query.trim()] : [],
  };
}

/**
 * Existing candidates the enrichment advised against (keep=false), as name
 * keys. The first confirmation for a name wins; later contradictory entries
 * and names that are not existing candidates are ignored.
 */
export function vetoedCandidateKeys(
  base: Pick<VlmAnalysis, 'candidates'>,
  enrichment: Pick<VlmEnrichment, 'confirmed'>,
): Set<string> {
  const known = new Set(base.candidates.map((c) => candidateNameKey(c.name)));
  const decided = new Map<string, boolean>();
  for (const entry of enrichment.confirmed) {
    const key = candidateNameKey(entry.name);
    if (known.has(key) && !decided.has(key)) decided.set(key, entry.keep);
  }
  return new Set([...decided].filter(([, keep]) => !keep).map(([key]) => key));
}

/**
 * Applies a stage-2 enrichment to an existing reading (a merged quick read, or
 * the v2 frame aggregate built from quick reads). Deterministic and additive:
 *  - existing candidates keep their order, ids, names, types and categories;
 *    a confirmation fills an empty rationale; keep=false multiplies certainty
 *    by ENRICHMENT_VETO_CERTAINTY_FACTOR (advisory, never removes);
 *  - additional candidates are appended (duplicates of existing names skipped)
 *    with ids continuing after the existing ones, up to MERGED_CANDIDATES_MAX;
 *  - observations, visible text and regions are appended with fresh ids;
 *    regions with invalid geometry are dropped, and a region whose label names
 *    a candidate becomes that candidate's evidence;
 *  - uncertainty takes the enrichment's overall level; competing subjects are
 *    used only when the reading had none; title, interpretation and quality
 *    never change.
 */
export function mergeEnrichment(base: VlmAnalysis, enrichment: VlmEnrichment): VlmAnalysis {
  const out = VlmAnalysis.parse(structuredClone(base));
  const e = VlmEnrichment.parse(enrichment);
  const nextId = (prefix: string, used: readonly { id: string }[]) => {
    const taken = new Set(used.map((x) => x.id));
    let n = used.length + 1;
    while (taken.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  };
  // Regions first so candidates can reference them.
  const added: VlmAnalysis['regions'] = [];
  for (const region of e.regions) {
    if (!boxIsValid(region.box)) continue;
    added.push({ id: nextId('r', [...out.regions, ...added]), label: region.label, box: { ...region.box } });
  }
  out.regions.push(...added);
  const regionsFor = (name: string): string[] => {
    const key = candidateNameKey(name);
    if (!key) return [];
    return added
      .filter((r) => {
        const label = candidateNameKey(r.label);
        return !!label && (label === key || label.includes(key) || key.includes(label));
      })
      .map((r) => r.id);
  };

  const vetoed = vetoedCandidateKeys(out, e);
  for (const candidate of out.candidates) {
    const key = candidateNameKey(candidate.name);
    const confirmation = e.confirmed.find((c) => candidateNameKey(c.name) === key);
    if (confirmation && !candidate.rationale.trim()) candidate.rationale = confirmation.rationale;
    if (vetoed.has(key))
      candidate.certainty =
        Math.round(candidate.certainty * ENRICHMENT_VETO_CERTAINTY_FACTOR * 1000) / 1000;
    candidate.region_ids = dedupe([...candidate.region_ids, ...regionsFor(candidate.name)]);
  }
  const names = new Set(out.candidates.map((c) => candidateNameKey(c.name)));
  for (const extra of e.additional_candidates) {
    const key = candidateNameKey(extra.name);
    if (!key || names.has(key) || out.candidates.length >= MERGED_CANDIDATES_MAX) continue;
    names.add(key);
    const candidate = fromQuickCandidate(extra, nextId('c', out.candidates), extra.rationale);
    candidate.region_ids = regionsFor(extra.name);
    out.candidates.push(candidate);
  }

  const seenObservations = new Set(
    out.observations.map((o) => `${o.kind}|${candidateNameKey(o.text)}`),
  );
  for (const o of e.observations) {
    const key = `${o.kind}|${candidateNameKey(o.text)}`;
    if (!o.text.trim() || seenObservations.has(key)) continue;
    seenObservations.add(key);
    out.observations.push({ id: nextId('o', out.observations), text: o.text, kind: o.kind, region_ids: [] });
  }
  const seenText = new Set(out.visible_text.map((t) => t.text.trim()));
  for (const text of e.visible_text) {
    if (!text.trim() || seenText.has(text.trim())) continue;
    seenText.add(text.trim());
    out.visible_text.push({ text, region_id: null });
  }
  out.uncertainty = {
    overall: e.uncertainty.overall,
    notes: dedupe([...out.uncertainty.notes, ...e.uncertainty.notes]).slice(0, 5),
  };
  if (!out.competing_subjects.length)
    out.competing_subjects = dedupe(e.competing_subjects.filter((s) => s.trim()))
      .slice(0, 3)
      .map((label, i) => ({ id: `s${i + 1}`, label, region_ids: [] }));
  return VlmAnalysis.parse(out);
}

/**
 * Deterministic merge into today's VlmAnalysis with synthetic ids, so the
 * compiler, validateVision, the inspector and v2 frame aggregation stay
 * unchanged. Rules:
 *  - without an enrichment, the result carries the quick read alone:
 *    candidates c1..cN in stage-1 order with an empty rationale and one tag
 *    query from tag_query; no observations, regions or visible text;
 *    uncertainty derived from the mean stage-1 certainty;
 *  - with an enrichment, mergeEnrichment applies: confirmed rationales become
 *    candidate rationales; keep=false only lowers certainty (advisory veto),
 *    it never drops a candidate; additional candidates are appended after the
 *    stage-1 candidates, never reordering them; regions, observations,
 *    visible text and competing subjects come from the enrichment.
 */
export function toVlmAnalysis(quick: VlmQuickRead, enrichment?: VlmEnrichment): VlmAnalysis {
  const q = VlmQuickRead.parse(quick);
  const base = VlmAnalysis.parse({
    title: q.title,
    interpretation: q.interpretation,
    observations: [],
    visible_text: [],
    candidates: q.candidates.map((c, i) => fromQuickCandidate(c, `c${i + 1}`, '')),
    regions: [],
    uncertainty: { overall: quickUncertainty(q), notes: [] },
    competing_subjects: [],
    quality: { usable: q.quality.usable, issue: q.quality.issue },
  });
  return enrichment ? mergeEnrichment(base, enrichment) : base;
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
  /** The stage-1 quick read `analysis` was merged from (two-stage reading only). */
  quick?: VlmQuickRead;
  model: string;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface VlmProvider {
  readonly id: string;
  capability(): CapabilityEntry;
  analyzeImage(input: VlmAnalyzeInput, options?: CallOptions): Promise<VlmResult>;
}

/**
 * Stage-2 input: the photo (bounded to 768 px) plus the stage-1 title and
 * candidate names. Every string is passed as DATA, never as instructions.
 */
export interface VlmEnrichInput {
  image: VlmAnalyzeInput['image'];
  stage1: { title: string; candidates: string[] };
  focus?: VlmAnalyzeInput['focus'];
}

export interface VlmEnrichResult {
  enrichment: VlmEnrichment;
  model: string;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Stage-2 background enrichment (role vision_photo_enrich). Concentrate only, never Elorian. */
export interface VlmEnricher {
  readonly id: string;
  capability(): CapabilityEntry;
  enrichImage(input: VlmEnrichInput, options?: CallOptions): Promise<VlmEnrichResult>;
}
