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

/**
 * What a reference is about (reading v2, docs/quality-plan.md §3.1). The
 * server maps it to discovery categories (G-CATEGORY); the model never picks
 * an app section.
 */
export const VLM_DOMAINS = [
  'fashion',
  'music',
  'film',
  'food',
  'architecture',
  'interior',
  'design',
  'craft',
  'art',
  'vehicle',
  'sport',
  'place',
  'signage',
  'people',
  'other',
] as const;
export type VlmDomain = (typeof VLM_DOMAINS)[number];
/** What a claim rests on: text read in the photo, a logo, a distinctive form, or only context. */
export const VLM_EVIDENCE = ['read_text', 'logo', 'distinctive_form', 'context'] as const;
export type VlmEvidence = (typeof VLM_EVIDENCE)[number];
/** Stage-2 verdict on a first-reading candidate (reading v2; the v1 keep flag maps onto it, §4.4). */
export const VLM_VERDICTS = ['supported', 'weak', 'unsupported'] as const;
export type VlmVerdict = (typeof VLM_VERDICTS)[number];

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

/** Candidate fields of the legacy full reading (atlas_observations_v2, unchanged for the model). */
const VlmCandidateFields = {
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
  /** Discovery categories. For guarded readings only G-CATEGORY fills these (§4.3). */
  suggested_categories: z.array(z.enum(VLM_CATEGORIES)).default([]),
  /** Optional Qloo tag search phrases for styles/aesthetics. */
  tag_queries: z.array(z.string()).default([]),
};

/**
 * Stored and merged candidate. The reading-v2 fields are optional (absent or
 * null), so stored analyses, fixtures/vlm, full readings and existing typed
 * literals still parse and compile; the guardrails infer them when they are
 * absent (§4.4) and always fill them on guarded candidates.
 */
export const VlmCandidate = z.object({
  ...VlmCandidateFields,
  domain: z.enum(VLM_DOMAINS).nullish(),
  evidence: z.enum(VLM_EVIDENCE).nullish(),
  /** Verbatim text or logo wording the claim rests on (read_text/logo only). */
  evidence_text: z.string().nullish(),
});

function analysisShape<C extends z.ZodType>(candidate: C) {
  return {
    /** Short editorial title, e.g. "Vintage racing references". */
    title: z.string(),
    /** One sentence; plausible readings phrased as resemblance. */
    interpretation: z.string(),
    observations: z.array(VlmObservation),
    visible_text: z.array(z.object({ text: z.string(), region_id: z.string().nullable().default(null) })),
    candidates: z.array(candidate),
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
  };
}

/** Stored and merged reading: what the compiler, validateVision, the inspector and v2 frame aggregation use. */
export const VlmAnalysis = z.object(analysisShape(VlmCandidate));
export type VlmAnalysis = z.infer<typeof VlmAnalysis>;
export type VlmCandidate = z.infer<typeof VlmCandidate>;

/**
 * The legacy single full reading exactly as the model is asked for it
 * (schema atlas_observations_v2, prompt vlm-full-v2). Its output is parsed
 * into VlmAnalysis, which adds the null v2 fields.
 */
export const VlmFullReading = z.object(analysisShape(z.object(VlmCandidateFields)));

/*
 * Two-stage photo reading (spec amendment 2.2, docs/analysis-latency-plan.md
 * "Recommended reading format"). Stage 1 (`vision_photo`) returns the slim
 * quick read interactively; stage 2 (`vision_photo_enrich`) returns an
 * enrichment in the background. `toVlmAnalysis` merges both into VlmAnalysis
 * so the compiler, validateVision, the inspector and v2 frame aggregation stay
 * unchanged. Length limits in comments are prompt targets; the schema maxima
 * are hard limits.
 *
 * Two reading versions exist. The profile's schemaVersion selects one, so a
 * qualification artifact binds the exact reading:
 *  - v1 (atlas_quick_read_v1 / atlas_enrichment_v1): model-chosen categories
 *    and a keep flag; qualified in phase 4 and kept byte-identical;
 *  - v2 (atlas_quick_read_v2 / atlas_enrichment_v2, docs/quality-plan.md §3):
 *    domain + evidence instead of categories, a verdict instead of keep, and
 *    illegible_text_present.
 * `VlmQuickRead` and `VlmEnrichment` accept either version; the model is
 * always sent the exact versioned schema.
 */

const VlmQuality = z.object({
  usable: z.boolean(),
  issue: z.enum(['blurred', 'no_subject', 'too_dark', 'unsupported_content']).nullable(),
});

/** Stage-1 candidate, reading v1: model-chosen categories. */
export const VlmQuickCandidateV1 = z.object({
  /** Specific, searchable name, max 80 chars. */
  name: z.string().max(80),
  type: z.enum(VLM_REFERENCE_TYPES),
  relation: z.enum(['depicted', 'resembles']),
  certainty: z.number().min(0).max(1),
  categories: z.array(z.enum(VLM_CATEGORIES)).max(4),
  /** Taxonomy phrase for style/tradition/cuisine (Qloo /v2/tags), else null. */
  tag_query: z.string().nullable(),
});
export type VlmQuickCandidateV1 = z.infer<typeof VlmQuickCandidateV1>;

/**
 * Stage-1 candidate, reading v2 (§3.1): no ids, boxes, rationale or
 * categories; `domain` says what the reference is about and `evidence` what
 * the claim rests on. Invariants the guardrails normalize instead of refining
 * (a refine failure would fail the whole call): evidence_text only for
 * read_text/logo; tag_query for style/tradition/cuisine.
 */
export const VlmQuickCandidate = z.object({
  /** Specific, searchable name, max 80 chars. */
  name: z.string().max(80),
  type: z.enum(VLM_REFERENCE_TYPES),
  relation: z.enum(['depicted', 'resembles']),
  certainty: z.number().min(0).max(1),
  domain: z.enum(VLM_DOMAINS),
  evidence: z.enum(VLM_EVIDENCE),
  /** Verbatim text or logo wording, max 60 chars; null unless evidence is read_text or logo. */
  evidence_text: z.string().max(60).nullable(),
  /** Taxonomy phrase for style/tradition/cuisine (Qloo /v2/tags), else null. */
  tag_query: z.string().nullable(),
});
export type VlmQuickCandidate = z.infer<typeof VlmQuickCandidate>;

const quickReadShape = <C extends z.ZodType>(candidate: C) => ({
  /** <= 6 words (prompt), max 60 chars. */
  title: z.string().max(60),
  /** One sentence, <= 20 words (prompt), max 160 chars. */
  interpretation: z.string().max(160),
  /** v1 asks for 3-5, v2 for 0-5. */
  candidates: z.array(candidate).max(5),
  quality: VlmQuality,
});

/** Stage 1, interactive: 512 px, maxOutputTokens 600, 10 s timeout, effort none. */
export const VlmQuickReadV1 = z.object(quickReadShape(VlmQuickCandidateV1));
export const VlmQuickReadV2 = z.object(quickReadShape(VlmQuickCandidate));
export type VlmQuickReadV1 = z.infer<typeof VlmQuickReadV1>;
export type VlmQuickReadV2 = z.infer<typeof VlmQuickReadV2>;
/** Either reading version (recorded v1 outputs keep parsing). Never sent to a model as a schema. */
export const VlmQuickRead = z.union([VlmQuickReadV2, VlmQuickReadV1]);
export type VlmQuickRead = VlmQuickReadV1 | VlmQuickReadV2;

const enrichmentShape = {
  observations: z
    .array(z.object({ text: z.string(), kind: VlmObservation.shape.kind }))
    .max(5),
  visible_text: z.array(z.string()).max(8),
  regions: z.array(z.object({ label: z.string(), box: VlmRegion.shape.box })).max(4),
  uncertainty: z.object({
    overall: z.enum(['low', 'medium', 'high']),
    notes: z.array(z.string()).max(3),
  }),
  competing_subjects: z.array(z.string()).max(3),
};

/** Stage 2, background, reading v1: 768 px, maxOutputTokens 1200, 20 s timeout, effort none. */
export const VlmEnrichmentV1 = z.object({
  ...enrichmentShape,
  /** Per stage-1 candidate. keep=false is advisory: it lowers certainty, never removes published cards. */
  confirmed: z.array(
    z.object({
      name: z.string(),
      /** <= 15 words (prompt). */
      rationale: z.string(),
      keep: z.boolean(),
    }),
  ),
  additional_candidates: z.array(VlmQuickCandidateV1.extend({ rationale: z.string() })).max(4),
});

/** Stage 2, reading v2 (§3.2): verdicts, verbatim text only plus an illegible-text flag; 1600 output tokens. */
export const VlmEnrichmentV2 = z.object({
  ...enrichmentShape,
  /** Text is present in the photo but cannot be read (never described inside visible_text). */
  illegible_text_present: z.boolean(),
  /** Per first-reading candidate. For a published card the verdict is advisory; for a held claim it is binding. */
  confirmed: z.array(
    z.object({
      name: z.string(),
      /** <= 15 words (prompt). */
      rationale: z.string(),
      verdict: z.enum(VLM_VERDICTS),
    }),
  ),
  additional_candidates: z.array(VlmQuickCandidate.extend({ rationale: z.string() })).max(4),
  /**
   * Evidence boxes: the prompt asks for up to four and the merge keeps the
   * first four valid ones (ENRICHMENT_REGIONS_MAX). The schema tolerates up to
   * eight, because a photo with five signed objects drew five boxes in the v2
   * smoke and a cap overflow on boxes must not fail the whole stage 2 (which
   * would drop every held claim).
   */
  regions: z.array(z.object({ label: z.string(), box: VlmRegion.shape.box })).max(8),
});
export type VlmEnrichmentV1 = z.infer<typeof VlmEnrichmentV1>;
export type VlmEnrichmentV2 = z.infer<typeof VlmEnrichmentV2>;
/** Either reading version. Never sent to a model as a schema. */
export const VlmEnrichment = z.union([VlmEnrichmentV2, VlmEnrichmentV1]);
export type VlmEnrichment = VlmEnrichmentV1 | VlmEnrichmentV2;
type Confirmation = VlmEnrichment['confirmed'][number];

export function isEnrichmentV2(e: VlmEnrichment): e is VlmEnrichmentV2 {
  return 'illegible_text_present' in e;
}

/**
 * A v1 rationale that hedges (§4.4): with keep=true it maps to 'weak', which
 * is binding only for held brand-like, place, work and creator claims.
 */
export const ENRICHMENT_HEDGE_RE =
  /no (legible|visible) (badge|logo|mark)|cannot be confirmed|not (clearly )?legible|looks more|unclear whether|hard to (tell|confirm)/i;

/** The stage-2 verdict of one confirmation entry (v2 verbatim; v1 keep plus the hedge rule). */
export function confirmationVerdict(entry: Confirmation): VlmVerdict {
  if ('verdict' in entry) return entry.verdict;
  if (!entry.keep) return 'unsupported';
  return ENRICHMENT_HEDGE_RE.test(entry.rationale) ? 'weak' : 'supported';
}

/** Certainty multiplier for a published stage-1 candidate the enrichment advises against (unsupported). */
export const ENRICHMENT_VETO_CERTAINTY_FACTOR = 0.5;
/** Hard cap on candidates in a merged reading (5 stage-1 + 4 additional). */
export const MERGED_CANDIDATES_MAX = 9;
/** Evidence regions one enrichment may add (the first valid ones). */
export const ENRICHMENT_REGIONS_MAX = 4;

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
  const mean = quick.candidates.reduce((n: number, c: { certainty: number }) => n + c.certainty, 0) / quick.candidates.length;
  return mean >= 0.7 ? 'low' : mean >= 0.4 ? 'medium' : 'high';
}

function fromQuickCandidate(c: VlmQuickCandidateV1 | VlmQuickCandidate, id: string, rationale: string): VlmCandidate {
  const v2 = 'domain' in c;
  return {
    id,
    name: c.name,
    type: c.type,
    relation: c.relation,
    rationale,
    certainty: c.certainty,
    region_ids: [],
    // v2: the server derives categories (G-CATEGORY); the model never picks a section.
    suggested_categories: v2 ? [] : dedupe(c.categories),
    tag_queries: c.tag_query?.trim() ? [c.tag_query.trim()] : [],
    domain: v2 ? c.domain : null,
    evidence: v2 ? c.evidence : null,
    evidence_text: v2 ? c.evidence_text : null,
  };
}

/**
 * Per-name stage-2 verdicts for the given candidates, keyed by
 * candidateNameKey. The first confirmation for a name wins; later
 * contradictory entries and names that are not candidates are ignored (a
 * confirmation of the title is not a candidate).
 */
export function enrichmentVerdicts(
  candidates: readonly Pick<VlmCandidate, 'name'>[],
  enrichment: Pick<VlmEnrichment, 'confirmed'>,
): Map<string, VlmVerdict> {
  const known = new Set(candidates.map((c) => candidateNameKey(c.name)));
  const decided = new Map<string, VlmVerdict>();
  for (const entry of enrichment.confirmed as Confirmation[]) {
    const key = candidateNameKey(entry.name);
    if (known.has(key) && !decided.has(key)) decided.set(key, confirmationVerdict(entry));
  }
  return decided;
}

/**
 * Existing candidates the enrichment advised against (verdict unsupported, or
 * v1 keep=false), as name keys. The first confirmation for a name wins.
 */
export function vetoedCandidateKeys(
  base: Pick<VlmAnalysis, 'candidates'>,
  enrichment: Pick<VlmEnrichment, 'confirmed'>,
): Set<string> {
  return new Set(
    [...enrichmentVerdicts(base.candidates, enrichment)].filter(([, v]) => v === 'unsupported').map(([key]) => key),
  );
}

/**
 * What the guardrails need to know about a merge beyond the merged reading
 * (docs/quality-plan.md §3.4). It never changes the stored shape.
 */
export interface VlmMergeContext {
  reading: 'v1' | 'v2';
  /** Stage-2 verdicts for published and held candidates, by candidateNameKey (first entry wins). */
  verdicts: Record<string, VlmVerdict>;
  /** Ids of held stage-1 candidates carried through the merge (positions after the published ones). */
  heldIds: string[];
  /** Ids of candidates appended from additional_candidates, in order. */
  additionIds: string[];
  /** The enrichment's own visible_text entries, verbatim (before G-VTEXT). */
  stage2Text: string[];
  /** v2: text is present but illegible; v1: always false. */
  illegibleTextPresent: boolean;
}

/**
 * Applies a stage-2 enrichment to an existing reading (a merged quick read, or
 * the v2 frame aggregate built from quick reads). Deterministic and additive:
 *  - existing candidates keep their order, ids, names, types and categories;
 *    a confirmation fills an empty rationale; an unsupported verdict (v1
 *    keep=false) multiplies certainty by ENRICHMENT_VETO_CERTAINTY_FACTOR
 *    (advisory, never removes);
 *  - held candidates (claims the guardrails kept back from stage 1) follow the
 *    existing ones with their own ids; they get rationales and evidence
 *    regions, and their verdicts are reported in the merge context;
 *  - additional candidates are appended (duplicates of existing or held names
 *    skipped) with ids continuing after the existing ones, up to
 *    MERGED_CANDIDATES_MAX;
 *  - observations, visible text and regions are appended with fresh ids;
 *    regions with invalid geometry are dropped, and a region whose label names
 *    a candidate becomes that candidate's evidence;
 *  - uncertainty takes the enrichment's overall level (v2 adds a note when
 *    text is present but illegible); competing subjects are used only when the
 *    reading had none; title, interpretation and quality never change.
 */
export function mergeEnrichmentContext(
  base: VlmAnalysis,
  enrichment: VlmEnrichment,
  held: readonly VlmCandidate[] = [],
): { analysis: VlmAnalysis; merge: VlmMergeContext } {
  const out = VlmAnalysis.parse(structuredClone(base));
  const kept = held.map((c) => VlmCandidate.parse(structuredClone(c)));
  const e = VlmEnrichment.parse(enrichment);
  const v2 = isEnrichmentV2(e);
  const nextId = (prefix: string, used: readonly { id: string }[]) => {
    const taken = new Set(used.map((x) => x.id));
    let n = used.length + 1;
    while (taken.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  };
  // Regions first so candidates can reference them.
  const added: VlmAnalysis['regions'] = [];
  for (const region of e.regions) {
    if (added.length >= ENRICHMENT_REGIONS_MAX) break;
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

  const confirmed = e.confirmed as Confirmation[];
  const verdicts = enrichmentVerdicts([...out.candidates, ...kept], e);
  const vetoed = vetoedCandidateKeys(out, e);
  for (const candidate of [...out.candidates, ...kept]) {
    const key = candidateNameKey(candidate.name);
    const confirmation = confirmed.find((c) => candidateNameKey(c.name) === key);
    if (confirmation && !candidate.rationale.trim()) candidate.rationale = confirmation.rationale;
    candidate.region_ids = dedupe([...candidate.region_ids, ...regionsFor(candidate.name)]);
  }
  for (const candidate of out.candidates)
    if (vetoed.has(candidateNameKey(candidate.name)))
      candidate.certainty =
        Math.round(candidate.certainty * ENRICHMENT_VETO_CERTAINTY_FACTOR * 1000) / 1000;
  out.candidates.push(...kept);

  const names = new Set(out.candidates.map((c) => candidateNameKey(c.name)));
  const additionIds: string[] = [];
  for (const extra of e.additional_candidates) {
    const key = candidateNameKey(extra.name);
    if (!key || names.has(key) || out.candidates.length >= MERGED_CANDIDATES_MAX) continue;
    names.add(key);
    const candidate = fromQuickCandidate(extra, nextId('c', out.candidates), extra.rationale);
    candidate.region_ids = regionsFor(extra.name);
    out.candidates.push(candidate);
    additionIds.push(candidate.id);
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
  const illegible = v2 && e.illegible_text_present;
  out.uncertainty = {
    overall: e.uncertainty.overall,
    notes: dedupe([
      ...out.uncertainty.notes,
      ...e.uncertainty.notes,
      ...(illegible ? ['Some text in the photo is not legible.'] : []),
    ]).slice(0, 5),
  };
  if (!out.competing_subjects.length)
    out.competing_subjects = dedupe(e.competing_subjects.filter((s) => s.trim()))
      .slice(0, 3)
      .map((label, i) => ({ id: `s${i + 1}`, label, region_ids: [] }));
  return {
    analysis: VlmAnalysis.parse(out),
    merge: {
      reading: v2 ? 'v2' : 'v1',
      verdicts: Object.fromEntries(verdicts),
      heldIds: kept.map((c) => c.id),
      additionIds,
      stage2Text: e.visible_text.filter((t) => t.trim()),
      illegibleTextPresent: illegible,
    },
  };
}

/** mergeEnrichmentContext without held claims, returning only the merged reading. */
export function mergeEnrichment(base: VlmAnalysis, enrichment: VlmEnrichment): VlmAnalysis {
  return mergeEnrichmentContext(base, enrichment).analysis;
}

/**
 * Deterministic merge into VlmAnalysis with synthetic ids, so the compiler,
 * validateVision, the inspector and v2 frame aggregation stay unchanged.
 * Accepts either reading version. Rules:
 *  - without an enrichment, the result carries the quick read alone:
 *    candidates c1..cN in stage-1 order with an empty rationale and one tag
 *    query from tag_query; v1 categories are carried, v2 carries domain and
 *    evidence and leaves categories to G-CATEGORY; no observations, regions or
 *    visible text; uncertainty derived from the mean stage-1 certainty;
 *  - with an enrichment, mergeEnrichment applies.
 * Guardrails are not applied here; the compiler applies them (guardrails.ts).
 */
export function toVlmAnalysis(quick: VlmQuickRead, enrichment?: VlmEnrichment): VlmAnalysis {
  const q = VlmQuickRead.parse(quick);
  const candidates = q.candidates as (VlmQuickCandidateV1 | VlmQuickCandidate)[];
  const base = VlmAnalysis.parse({
    title: q.title,
    interpretation: q.interpretation,
    observations: [],
    visible_text: [],
    candidates: candidates.map((c, i) => fromQuickCandidate(c, `c${i + 1}`, '')),
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
 * candidate names (published and held claims). Every string is passed as
 * DATA, never as instructions.
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
