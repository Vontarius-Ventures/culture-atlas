/**
 * Style reading + style-driven rails on the web (prp/2026-10-23-style-analysis/design.md
 * sections E.2, F.1, F.2, D.4 and amendments R-15/R-16/R-17).
 *
 * The server owns every word a user reads about style: wording ("asserted" vs
 * "resembles"), `display` strings, reasons and the experimental label. This
 * module only parses what the server sent and derives presentation state; it
 * never composes "Resembles …" or any claim text itself.
 *
 * Every new field is additive and optional. Parsing is lenient on purpose: an
 * older analysis (no `style_reading`, no `rails`) or one malformed claim must
 * never break the capture page, it just shows less. A claim without a server
 * `display` string is shown only when it is asserted (its name is then the
 * display text); an unasserted claim without `display` is not shown at all.
 *
 * Until the shared contract (@culture-atlas/domain) carries these fields, the
 * capture response is read through `StyledCaptureResponse`, which keeps the
 * base contract validation and lifts the style fields out beside it.
 */
import { z } from 'zod';
import {
  AnalysisSummary,
  CaptureResponse,
  DiscoveryCard,
  ItemDetailResponse,
} from '@culture-atlas/domain/schemas';

// ---- copy (design/copy.json `experimental.*` and `style.*`, verbatim; D.4) ----------

export const STYLE_COPY = {
  'experimental.badge': 'Experimental',
  'experimental.note': 'Photo and video readings are experimental. They can miss or misread details.',
  'experimental.rail_caption': 'From an experimental reading',
  'experimental.why_line': 'Suggested from an experimental reading of your photo.',
  'style.paused':
    "Photo reading is paused right now. Your photo is saved, and we'll read it when it's back.",
  'style.limit':
    "We've hit today's limit for experimental readings. Your photo is saved, and you can read it tomorrow.",
  'style.failed': "We couldn't read the style of this one.",
  'style.empty': 'No clear style to read here.',
  'style.no_city': 'Add a city to see places with this style.',
  'style.rail_empty': 'Qloo found nothing close to this style yet.',
  'style.reading': 'Reading the style…',
  'style.rail_running': 'Finding things with this style…',
  'style.updated': 'Style reading updated',
  'style.try_again': 'Try again',
  'style.add_city': 'Add city',
  'style.qloo_links': 'Qloo also links: {names}',
  'style.show_details': 'Show all details',
  // Web-only supporting copy (not part of the D.4 table).
  'style.title': 'Style reading',
  'style.more_like_this_style': 'Show more like this style',
} as const;

/** Normalizes apostrophes so server copy compares equal to the D.4 table. */
export function asciiCopy(text: string): string {
  return text.replace(/[‘’]/g, "'");
}

// ---- lenient building blocks -------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Array whose invalid elements are dropped individually (a bad claim never hides the rest). */
function lenientArray<T extends z.ZodType>(item: T, max = 50) {
  return z.unknown().optional().transform((value) => {
    if (!Array.isArray(value)) return [] as z.output<T>[];
    const out: z.output<T>[] = [];
    for (const raw of value.slice(0, max)) {
      const parsed = item.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  });
}

/** Optional object: absent or invalid becomes null. */
function lenientObject<T extends z.ZodType>(schema: T) {
  return z.unknown().optional().transform((value) => {
    if (value === null || value === undefined) return null;
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as z.output<T>) : null;
  });
}

const unit = z.number().min(0).max(1);
export const StyleRegion = z.object({ x: unit, y: unit, w: unit, h: unit }).refine(
  (r) => r.w > 0 && r.h > 0,
);
export type StyleRegion = z.infer<typeof StyleRegion>;

const region = lenientObject(StyleRegion);
const optText = z.string().trim().min(1).max(400).nullable().optional().catch(null);
const wording = z.enum(['asserted', 'resembles']).catch('resembles');
const strength = z.enum(['clear', 'likely', 'possible']).nullable().optional().catch(null);
const flag = z.boolean().optional().catch(false);

const claimBase = {
  name: z.string().trim().min(1).max(200),
  wording,
  display: optText,
  region,
  strength,
  /** Stage-2 veto (B.4): the claim fades out. */
  retracted: flag,
  /** Held for stage-2 confirmation: never shown. */
  held: flag,
};

export const AestheticClaim = z.object({
  ...claimBase,
  features: lenientArray(z.string().trim().min(1).max(120), 8),
});
export const EraClaim = z.object({ ...claimBase });
export const MaterialClaim = z.object({ ...claimBase, texture: optText });
export const ConstructionClaim = z.object({ ...claimBase, kind: optText });
export const DetailClaim = z.object({
  text: z.string().trim().min(1).max(200),
  wording,
  display: optText,
  region,
  retracted: flag,
  held: flag,
});
export const PaletteEntry = z.object({
  swatch: z.number().int().min(0),
  name: z.string().trim().min(1).max(80),
  hex: z.string().regex(HEX),
  display: optText,
  retracted: flag,
});
export const MoodClaim = z.object({
  name: z.string().trim().min(1).max(80),
  display: optText,
  retracted: flag,
  held: flag,
});

export const StyleSubject = z.object({
  id: z.string().min(1).max(16),
  category: z.string().catch('other'),
  label: z.string().trim().min(1).max(160),
  region,
  aesthetics: lenientArray(AestheticClaim, 6),
  era: lenientObject(EraClaim),
  lineage: lenientArray(EraClaim, 4),
  materials: lenientArray(MaterialClaim, 6),
  construction: lenientArray(ConstructionClaim, 8),
  palette: lenientArray(PaletteEntry, 6),
  mood: lenientArray(MoodClaim, 4),
  details: lenientArray(DetailClaim, 8),
  brand: lenientObject(
    z.object({ name: z.string().trim().min(1).max(120), read_text: z.string().max(200).nullable().optional() }),
  ),
  qloo_links: lenientArray(z.string().trim().min(1).max(80), 8),
  rail: z.string().nullable().optional().catch(null),
});
export type StyleSubject = z.infer<typeof StyleSubject>;
export type AestheticClaim = z.infer<typeof AestheticClaim>;
export type PaletteEntry = z.infer<typeof PaletteEntry>;

export const StyleReading = z.object({
  version: z.string().optional().catch(undefined),
  summary: optText,
  swatches: lenientArray(
    z.object({ index: z.number().int().min(0), hex: z.string().regex(HEX), share: unit }),
    8,
  ),
  subjects: lenientArray(StyleSubject, 2),
  retracted: lenientArray(z.string().max(120), 40),
});
export type StyleReading = z.infer<typeof StyleReading>;

export const StyleMatch = z.object({
  subject_id: z.string().nullable().optional().catch(null),
  attributes: lenientArray(z.string().trim().min(1).max(80), 4),
  palette: lenientArray(z.string().trim().min(1).max(40), 3),
  via: z.string().nullable().optional().catch(null),
  experimental: z.boolean().optional().catch(false),
});
export type StyleMatch = z.infer<typeof StyleMatch>;

/** DiscoveryCard plus the two optional E.2 fields. */
export const StyledCard = DiscoveryCard.extend({
  reason: z.string().trim().min(1).max(140).nullable().optional().catch(null),
  style_match: lenientObject(StyleMatch).optional(),
});
export type StyledCard = z.infer<typeof StyledCard>;

export const Rail = z.object({
  key: z.string().min(1).max(64),
  kind: z.enum(['more_like_this', 'cross_domain']).catch('cross_domain'),
  title: z.string().trim().min(1).max(80),
  subtitle: optText,
  subject_id: z.string().nullable().optional().catch(null),
  status: z.string().catch('ready'),
  empty_message: optText,
  cards: lenientArray(StyledCard, 24),
});
export type Rail = z.infer<typeof Rail>;

export const ExperimentalLabel = z.object({
  label: z.string().trim().min(1).max(40),
  note: z.string().trim().min(1).max(240),
});
export type ExperimentalLabel = z.infer<typeof ExperimentalLabel>;

// ---- capture response ---------------------------------------------------------------

export interface StyleExtras {
  /** `sections.style`; null for analyses made before style reading existed. */
  status: string | null;
  reading: StyleReading | null;
  /** null when the server sent no `rails` (older analyses): render `recommendations`. */
  rails: Rail[] | null;
  experimental: ExperimentalLabel | null;
  /** `daily_limit`, `ai_paused`, … when the server says why a reading waits. */
  waitingReason: string | null;
}

export type StyledCapture = Omit<CaptureResponse, 'recommendations'> & {
  recommendations: StyledCard[];
  style: StyleExtras;
};

// Section names and statuses the shared contract accepts today (read from the schema itself,
// so this shim retires itself once the contract adds `style` and the E.2 statuses).
const KNOWN_SECTIONS = new Set<string>(AnalysisSummary.shape.sections.keyType.options);
const KNOWN_STATUSES = new Set<string>(AnalysisSummary.shape.sections.valueType.options);
/** New terminal statuses (E.2/R-16c) mapped onto the current shared enum for the base parse. */
const STATUS_COMPAT: Record<string, string> = {
  ready: 'complete',
  empty: 'complete',
  held: 'partial',
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Splits a raw GET /v1/captures/{id} body into the part the shared contract
 * validates today and the additive style fields. Pure; unit-tested.
 */
export function splitStyledCapture(raw: unknown): { base: unknown; extras: StyleExtras } {
  const extras: StyleExtras = {
    status: null,
    reading: null,
    rails: null,
    experimental: null,
    waitingReason: null,
  };
  if (!isObj(raw)) return { base: raw, extras };
  const base: Json = { ...raw };
  delete base.style_reading;
  delete base.rails;
  delete base.waiting_reason;
  if (isObj(raw.analysis)) {
    const analysis: Json = { ...raw.analysis };
    const sections = isObj(analysis.sections) ? analysis.sections : {};
    const kept: Json = {};
    for (const [key, value] of Object.entries(sections)) {
      if (key === 'style') {
        extras.status = typeof value === 'string' ? value : null;
        continue;
      }
      if (!KNOWN_SECTIONS.has(key)) continue;
      kept[key] =
        typeof value === 'string' && !KNOWN_STATUSES.has(value)
          ? (STATUS_COMPAT[value] ?? 'partial')
          : value;
    }
    analysis.sections = kept;
    const exp = lenientObject(ExperimentalLabel).parse(analysis.experimental);
    extras.experimental = exp;
    delete analysis.experimental;
    if (typeof analysis.waiting_reason === 'string') extras.waitingReason = analysis.waiting_reason;
    delete analysis.waiting_reason;
    base.analysis = analysis;
  }
  if (typeof raw.waiting_reason === 'string') extras.waitingReason = raw.waiting_reason;
  extras.reading = lenientObject(StyleReading).parse(raw.style_reading);
  if (Array.isArray(raw.rails)) extras.rails = lenientArray(Rail, 12).parse(raw.rails);
  // A reading is only shown once the section says it is ready (E.2: null until ready).
  if (extras.status !== null && extras.status !== 'ready') extras.reading = null;
  if (extras.status === null && extras.reading) extras.status = 'ready';
  return { base, extras };
}

/** Response schema for getCapture: base contract + lifted style fields. */
export const StyledCaptureResponse = z.unknown().transform((raw, ctx): StyledCapture => {
  const { base, extras } = splitStyledCapture(raw);
  const parsed = CaptureResponse.safeParse(base);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: 'custom' } as never);
    return z.NEVER;
  }
  const recRaw = isObj(raw) && Array.isArray(raw.recommendations) ? raw.recommendations : [];
  const recommendations = parsed.data.recommendations.map((card, i) => {
    const extra = StyledCard.safeParse(recRaw[i]);
    return extra.success ? { ...card, reason: extra.data.reason, style_match: extra.data.style_match } : card;
  });
  return { ...parsed.data, recommendations, style: extras };
});

/** GET /v1/items/{id} plus the "Why this?" style fields (E.2 last note). */
export const StyledItemResponse = z.unknown().transform((raw, ctx) => {
  const parsed = ItemDetailResponse.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: 'custom' } as never);
    return z.NEVER;
  }
  const r = isObj(raw) ? raw : {};
  const why = isObj(r.why_this) ? r.why_this : {};
  const styleMatch = lenientObject(StyleMatch).parse(r.style_match ?? why.style_match);
  const lineRaw = r.experimental_line ?? why.experimental_line;
  const experimentalLine =
    typeof lineRaw === 'string' && lineRaw.trim() ? lineRaw.trim().slice(0, 200) : null;
  return { ...parsed.data, style_match: styleMatch, experimental_line: experimentalLine };
});
export type StyledItem = z.output<typeof StyledItemResponse>;

// ---- presentation derivations (pure) -------------------------------------------------

export const ACTIVE_STATUSES = new Set(['pending', 'running']);

/** R-16c: ready | empty | failed | held are terminal, and so is anything unknown. */
export function isActiveStatus(status: string | null | undefined): boolean {
  return Boolean(status && ACTIVE_STATUSES.has(status));
}

/** True while the page should keep re-reading the capture for style work. */
export function styleWorkPending(extras: StyleExtras | null | undefined): boolean {
  if (!extras) return false;
  if (isActiveStatus(extras.status)) return true;
  return (extras.rails ?? []).some((r) => isActiveStatus(r.status));
}

export type StyleCardState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'ready'; reading: StyleReading }
  | { kind: 'empty' }
  | { kind: 'failed' }
  | { kind: 'paused' }
  | { kind: 'limit' };

export function styleCardState(extras: StyleExtras | null | undefined): StyleCardState {
  if (!extras || extras.status === null) return { kind: 'none' };
  const { status, waitingReason } = extras;
  if (waitingReason === 'ai_paused' || status === 'paused') return { kind: 'paused' };
  if (status === 'held' || waitingReason === 'daily_limit') return { kind: 'limit' };
  if (isActiveStatus(status)) return { kind: 'loading' };
  if (status === 'ready') {
    if (!extras.reading || visibleSubjects(extras.reading).length === 0) return { kind: 'empty' };
    return { kind: 'ready', reading: extras.reading };
  }
  if (status === 'empty') return { kind: 'empty' };
  if (status === 'failed') return { kind: 'failed' };
  return { kind: 'none' };
}

/** Text the user reads for a claim, or null when it must not be shown. */
export function claimText(claim: {
  name?: string;
  text?: string;
  wording?: 'asserted' | 'resembles';
  display?: string | null;
  held?: boolean;
}): string | null {
  if (claim.held) return null;
  if (claim.display) return claim.display;
  // Without a server display string only an asserted claim may show (its own name).
  if (claim.wording === 'asserted') return claim.name ?? claim.text ?? null;
  return null;
}

/** Mood never has asserted wording: without `display` it is not shown. */
export function moodText(m: { display?: string | null; held?: boolean }): string | null {
  return m.held ? null : (m.display ?? null);
}

/** "Feels rugged, utilitarian": joins mood displays onto one line (F.1 §2). */
export function moodLine(moods: Array<{ display?: string | null; held?: boolean; retracted?: boolean }>): string | null {
  const parts = moods
    .filter((m) => !m.retracted)
    .map(moodText)
    .filter((t): t is string => Boolean(t));
  if (parts.length === 0) return null;
  const [first, ...rest] = parts;
  // Server strings are "Feels rugged"; later ones drop the repeated "Feels ".
  return [first, ...rest.map((p) => p.replace(/^feels\s+/i, ''))].join(', ');
}

export function visibleSubjects(reading: StyleReading): StyleSubject[] {
  return reading.subjects.filter(
    (s) =>
      s.aesthetics.some((a) => claimText(a)) ||
      s.palette.length > 0 ||
      s.materials.some((m) => claimText(m)) ||
      s.details.some((d) => claimText(d)) ||
      s.construction.some((c) => claimText(c)) ||
      Boolean(s.era && claimText(s.era)),
  );
}

/** Retracted claim paths from `retracted[]`, e.g. "subjects[0].aesthetics[1]". */
export function isRetracted(
  reading: StyleReading,
  subjectIndex: number,
  slot: string,
  index: number | null,
  flagged?: boolean,
): boolean {
  if (flagged) return true;
  const path = `subjects[${subjectIndex}].${slot}${index === null ? '' : `[${index}]`}`;
  return reading.retracted.includes(path);
}

export interface DetailRow {
  key: string;
  group: 'Era & lineage' | 'Materials' | 'Construction' | 'Details';
  text: string;
  resembles: boolean;
  region: StyleRegion | null;
  retracted: boolean;
}

/** Era & lineage, Materials, Construction, Details rows in that order (F.1 §2). */
export function detailRows(reading: StyleReading, subjectIndex: number): DetailRow[] {
  const s = reading.subjects[subjectIndex];
  if (!s) return [];
  const rows: DetailRow[] = [];
  const push = (
    group: DetailRow['group'],
    slot: string,
    index: number | null,
    claim: { name?: string; text?: string; wording: 'asserted' | 'resembles'; display?: string | null; held?: boolean; region?: StyleRegion | null; retracted?: boolean },
  ) => {
    const text = claimText(claim);
    if (!text) return;
    rows.push({
      key: `${slot}:${index ?? 0}:${text}`,
      group,
      text,
      resembles: claim.wording !== 'asserted',
      region: claim.region ?? null,
      retracted: isRetracted(reading, subjectIndex, slot, index, claim.retracted),
    });
  };
  if (s.era) push('Era & lineage', 'era', null, s.era);
  s.lineage.forEach((c, i) => push('Era & lineage', 'lineage', i, c));
  s.materials.forEach((c, i) => push('Materials', 'materials', i, c));
  s.construction.forEach((c, i) => push('Construction', 'construction', i, c));
  s.details.forEach((c, i) => push('Details', 'details', i, c));
  return rows;
}

/** Swatch circle diameter: proportional to share, 28–56 px (F.1 §2). */
export function swatchSize(share: number | undefined): number {
  if (share === undefined || !Number.isFinite(share)) return 28;
  return Math.round(Math.min(56, Math.max(28, 28 + share * 56)));
}

/** Palette entries with the share of their swatch (for sizing). */
export function paletteWithShare(reading: StyleReading, subject: StyleSubject) {
  return subject.palette
    .filter((p) => !p.retracted)
    .map((p) => ({
      ...p,
      share: reading.swatches.find((s) => s.index === p.swatch)?.share,
      text: p.display ?? p.name,
    }));
}

/** aria-label strength word; strength is never drawn (R-17). */
export function strengthLabel(s: 'clear' | 'likely' | 'possible' | null | undefined): string | null {
  return s ?? null;
}

/** "upper left of the photo" for screen readers (F.1 §1 quadrant helper). */
export function regionQuadrant(r: StyleRegion): string {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const v = cy < 1 / 3 ? 'upper' : cy > 2 / 3 ? 'lower' : 'middle';
  const h = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center';
  if (v === 'middle' && h === 'center') return 'center of the photo';
  if (v === 'middle') return `middle ${h} of the photo`;
  if (h === 'center') return `${v} middle of the photo`;
  return `${v} ${h} of the photo`;
}

/**
 * Pixel rectangle of a normalized region on an <img> rendered with
 * `object-fit: cover` (the capture photo). Clipped to the element box.
 * Same normalized-box convention as the crop/Focus tool (lib/client/crop.ts).
 */
export function regionToRect(
  r: StyleRegion,
  box: { width: number; height: number },
  natural: { width: number; height: number } | null,
  fit: 'cover' | 'fill' = 'cover',
) {
  let scaleX = box.width;
  let scaleY = box.height;
  let offX = 0;
  let offY = 0;
  if (fit === 'cover' && natural && natural.width > 0 && natural.height > 0) {
    const s = Math.max(box.width / natural.width, box.height / natural.height);
    scaleX = natural.width * s;
    scaleY = natural.height * s;
    offX = (box.width - scaleX) / 2;
    offY = (box.height - scaleY) / 2;
  }
  const left = Math.max(0, offX + r.x * scaleX);
  const top = Math.max(0, offY + r.y * scaleY);
  const right = Math.min(box.width, offX + (r.x + r.w) * scaleX);
  const bottom = Math.min(box.height, offY + (r.y + r.h) * scaleY);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** `style.qloo_links` with names filled; null when there are none. */
export function qlooLinksLine(names: string[]): string | null {
  if (names.length === 0) return null;
  return STYLE_COPY['style.qloo_links'].replace('{names}', names.join(', '));
}

/** Rails split for display: More-like-this (in order) and the cross-domain group. */
export function splitRails(rails: Rail[]) {
  return {
    moreLikeThis: rails.filter((r) => r.kind === 'more_like_this'),
    crossDomain: rails.filter((r) => r.kind === 'cross_domain'),
  };
}

/** Message for a terminal rail with no cards, or null when the rail shows cards. */
export function railEmptyMessage(rail: Rail): string | null {
  if (isActiveStatus(rail.status) || rail.cards.length > 0) return null;
  if (rail.empty_message) return rail.empty_message;
  if (rail.status === 'failed') return 'Related discoveries are taking longer.';
  return STYLE_COPY['style.rail_empty'];
}

export function needsCity(message: string | null | undefined): boolean {
  return asciiCopy(message ?? '') === asciiCopy(STYLE_COPY['style.no_city']);
}

/**
 * The experimental label from `/v2/capabilities` `availability.analysis` (D.3).
 * Any `experimental: true` analysis is labeled, whatever the environment; the
 * badge copy is always "Experimental" (D.4), with the server note when sent.
 */
export function analysisExperimental(
  entry: { available?: boolean; experimental?: boolean; label?: string; note?: string } | undefined,
): ExperimentalLabel | null {
  if (!entry?.experimental) return null;
  return {
    label: STYLE_COPY['experimental.badge'],
    note: entry.note?.trim() || STYLE_COPY['experimental.note'],
  };
}
