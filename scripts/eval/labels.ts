import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { nameSimilarity, normalizeName } from '../../packages/domain/src/compiler/text';

/**
 * Golden-set schemas for the photo evaluation (docs/quality-plan.md §7.1).
 *
 * Photos never live in git: the manifest pins each photo by sha256 and by its
 * public raw URL at a pinned commit. Labels are hand-written per photo; the
 * held-out split was labelled before any model output for it existed.
 */

export const REFERENCE_TYPES = ['object', 'creator', 'work', 'brand', 'style', 'tradition', 'place', 'cuisine'] as const;
export const CATEGORIES = ['wear', 'play', 'watch', 'eat'] as const;
export const SUBJECT_DOMAINS = [
  'fashion', 'music', 'film', 'food', 'architecture', 'interior', 'design', 'craft', 'art',
  'vehicle', 'sport', 'place', 'signage', 'people', 'other',
] as const;

/** Claim classes a label can forbid outright (scorer metric M1). */
export const FORBIDDEN_CLASSES = [
  'brand_without_text',
  'medium',
  'person_identity',
  'person_descriptor',
  'role_inference',
  'cuisine_without_food',
  'unusable_with_candidates',
] as const;
export type ForbiddenClass = (typeof FORBIDDEN_CLASSES)[number];

const regexSource = z.string().min(1).refine(
  (s) => {
    try {
      new RegExp(s, 'iu');
      return true;
    } catch {
      return false;
    }
  },
  { message: 'pattern must be a valid regular expression' },
);

/** An expected or acceptable reference. Needs a name or a pattern. */
export const LabelEntrySchema = z
  .object({
    name: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).default([]),
    pattern: regexSource.nullable().optional(),
    type: z.enum(REFERENCE_TYPES).optional(),
    /** Good only when the final visible_text contains this string (brands, sign names). */
    requires_text: z.string().min(1).optional(),
    /** A generic object: demoting it is intended, so it never counts as a clean drop (M4). */
    generic: z.boolean().default(false),
    note: z.string().optional(),
  })
  .strict()
  .refine((e) => !!e.name || !!e.pattern, { message: 'entry needs a name or a pattern' });
export type LabelEntry = z.infer<typeof LabelEntrySchema>;

export const FORBIDDEN_FIELDS = ['candidate', 'text', 'visible_text', 'observations'] as const;
export const ForbiddenEntrySchema = z
  .object({
    pattern: regexSource,
    /** candidate (default): published candidate names; text: title + interpretation. */
    field: z.enum(FORBIDDEN_FIELDS).default('candidate'),
    /** Also a claim of this forbidden class (M1) when the label lists the class. */
    class: z.enum(FORBIDDEN_CLASSES).optional(),
    why: z.string().min(1),
  })
  .strict();
export type ForbiddenEntry = z.infer<typeof ForbiddenEntrySchema>;

export const PHOTO_ID = /^(p|h)\d{2}$/;

export const PhotoLabelSchema = z
  .object({
    id: z.string().regex(PHOTO_ID),
    split: z.enum(['tune', 'holdout']),
    file: z.string().min(1),
    subject_domains: z.array(z.enum(SUBJECT_DOMAINS)).min(1),
    quality: z
      .object({
        usable: z.boolean(),
        issue: z.enum(['blurred', 'no_subject', 'too_dark', 'unsupported_content']).nullable().default(null),
      })
      .strict(),
    expected: z.array(LabelEntrySchema).default([]),
    acceptable: z.array(LabelEntrySchema).default([]),
    forbidden: z.array(ForbiddenEntrySchema).default([]),
    forbidden_classes: z.array(z.enum(FORBIDDEN_CLASSES)).default([]),
    /** Categories any published candidate may carry on this photo. */
    allowed_categories: z.array(z.enum(CATEGORIES)).default([]),
    must_read_text: z.array(z.string().min(1)).default([]),
    must_not_read_text: z.array(regexSource).default([]),
    people: z.object({ present: z.boolean() }).strict(),
    qloo: z
      .object({
        forbidden_entity_types: z.array(z.string().startsWith('urn:entity:')).default([]),
        forbidden_tag_families: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ forbidden_entity_types: [], forbidden_tag_families: [] }),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (l.id.startsWith('p') !== (l.split === 'tune'))
      ctx.addIssue({ code: 'custom', message: `${l.id}: p* photos are tune, h* photos are holdout` });
    if (!l.quality.usable && (l.expected.length || l.acceptable.length))
      ctx.addIssue({ code: 'custom', message: `${l.id}: an unusable photo has no expected or acceptable references` });
    if (!l.quality.usable && !l.forbidden_classes.includes('unusable_with_candidates'))
      ctx.addIssue({ code: 'custom', message: `${l.id}: an unusable photo must forbid unusable_with_candidates` });
  });
export type PhotoLabel = z.infer<typeof PhotoLabelSchema>;

export const ManifestPhotoSchema = z
  .object({
    id: z.string().regex(PHOTO_ID),
    split: z.enum(['tune', 'holdout']),
    file: z.string().regex(/^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    source: z
      .object({
        repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
        /** null only when the upstream path itself would put a person's name in git (photo p11). */
        path: z.string().min(1).nullable(),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        license: z.string().min(1),
        raw_url: z.string().url().startsWith('https://raw.githubusercontent.com/').nullable(),
        /** Why path and raw_url are withheld; the operator copies the photo from the private sources list. */
        withheld: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const s = p.source;
    if ((s.path === null) !== (s.raw_url === null) || (s.path === null) !== !!s.withheld)
      ctx.addIssue({ code: 'custom', message: `${p.id}: path and raw_url are both set, or both withheld with a reason` });
    if (s.raw_url && !s.raw_url.includes(`/${s.repo}/${s.commit}/`))
      ctx.addIssue({ code: 'custom', message: `${p.id}: raw_url must name the pinned repo and commit` });
  });
export type ManifestPhoto = z.infer<typeof ManifestPhotoSchema>;

export const GoldenManifestSchema = z
  .object({
    version: z.string().regex(/^golden-v\d+$/),
    photos: z.array(ManifestPhotoSchema).min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    const hashes = new Set<string>();
    for (const p of m.photos) {
      if (ids.has(p.id)) ctx.addIssue({ code: 'custom', message: `duplicate photo id ${p.id}` });
      if (hashes.has(p.sha256)) ctx.addIssue({ code: 'custom', message: `duplicate photo hash for ${p.id}` });
      ids.add(p.id);
      hashes.add(p.sha256);
    }
  });
export type GoldenManifest = z.infer<typeof GoldenManifestSchema>;

export const GateSchema = z.object({ op: z.enum(['<=', '>=', '==']), value: z.number().min(0) }).strict();
export type Gate = z.infer<typeof GateSchema>;
const gates = z.record(z.string().regex(/^M\d+(_[a-z0-9]+)*$/), GateSchema);
/** Versioned pass thresholds (fixtures/eval/thresholds.json). Changing them needs the owner and a version bump. */
export const ThresholdsSchema = z
  .object({
    version: z.string().regex(/^thr-v\d+$/),
    /** Hermetic and local replays (tune split). */
    replay: gates,
    /** Live evaluation and re-qualification, every split. */
    live: gates,
    /** Stricter live gates for the tune split only (§10). */
    live_tune: gates,
    grounding: z.record(z.string(), z.number()),
    seed: z.record(z.string(), z.number()),
    text: z.record(z.string(), z.number()),
  })
  .strict();
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export interface GoldenSet {
  dir: string;
  manifest: GoldenManifest;
  labels: Map<string, PhotoLabel>;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Loads and cross-checks a golden set directory (manifest.json + labels/<id>.json). */
export async function loadGoldenSet(dir: string): Promise<GoldenSet> {
  const manifest = GoldenManifestSchema.parse(JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')));
  const labels = new Map<string, PhotoLabel>();
  const files = (await readdir(path.join(dir, 'labels'))).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) {
    const label = PhotoLabelSchema.parse(JSON.parse(await readFile(path.join(dir, 'labels', f), 'utf8')));
    if (f !== `${label.id}.json`) throw new Error(`Label file ${f} holds id ${label.id}`);
    labels.set(label.id, label);
  }
  for (const p of manifest.photos) {
    const label = labels.get(p.id);
    if (!label) throw new Error(`No label for manifest photo ${p.id}`);
    if (label.split !== p.split || label.file !== p.file)
      throw new Error(`Label ${p.id} disagrees with the manifest on split or file`);
  }
  for (const id of labels.keys())
    if (!manifest.photos.some((p) => p.id === id)) throw new Error(`Label ${id} has no manifest photo`);
  return { dir, manifest, labels };
}

export async function loadThresholds(file: string): Promise<{ thresholds: Thresholds; sha256: string }> {
  const raw = await readFile(file);
  return { thresholds: ThresholdsSchema.parse(JSON.parse(raw.toString('utf8'))), sha256: sha256Hex(raw) };
}

/** Stable digest of the golden set (manifest plus labels, sorted), bound into qualification artifacts. */
export function goldenDigest(golden: Pick<GoldenSet, 'manifest' | 'labels'>): string {
  const labels = [...golden.labels.keys()].sort().map((id) => golden.labels.get(id));
  return sha256Hex(JSON.stringify({ manifest: golden.manifest, labels }));
}

/**
 * Text comparison for transcriptions and requires_text: case- and
 * accent-insensitive containment; non-Latin text is compared verbatim
 * after Unicode normalization (§4.2 "CJK compared verbatim").
 */
export function foldText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
export function textContains(haystack: string, needle: string): boolean {
  const n = foldText(needle);
  return !!n && foldText(haystack).includes(n);
}

/**
 * Does a label entry match a published candidate name (§7.1 "Matching")?
 * Exact: the pattern matches, or the canonical name equals the name or an
 * alias. Fuzzy (only when no entry matches exactly): nameSimilarity >= 0.75.
 */
export function entryMatches(entry: LabelEntry, name: string, how: 'exact' | 'fuzzy' | 'any' = 'any'): boolean {
  const names = [entry.name, ...entry.aliases].filter((n): n is string => !!n);
  if (how !== 'fuzzy') {
    if (entry.pattern && new RegExp(entry.pattern, 'iu').test(name)) return true;
    const key = normalizeName(name);
    for (const n of names) {
      if (key && key === normalizeName(n)) return true;
      if (!key && foldText(n) === foldText(name)) return true;
    }
    if (how === 'exact') return false;
  }
  return names.some((n) => nameSimilarity(name, n) >= 0.75);
}

/** The first entry that matches exactly, else the first fuzzy match. */
export function findEntry<T extends LabelEntry>(entries: readonly T[], name: string): T | undefined {
  return entries.find((e) => entryMatches(e, name, 'exact')) ?? entries.find((e) => entryMatches(e, name, 'fuzzy'));
}
