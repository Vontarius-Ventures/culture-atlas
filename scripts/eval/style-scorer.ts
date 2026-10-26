/**
 * score-style-v1 (prp/2026-10-23-style-analysis §G.3), the automatic part.
 *
 * Scores GET /v1/captures/{id} responses (as scripts/style/live-check.ts
 * saves them) on the metrics that need no judge:
 *   M-S4 people/identity violations (G-STYLE-PERSON regex on every shown string; must be 0)
 *   M-R3 reason faithfulness (every attribute a card names is in the published reading; must be 1.0)
 *   M-C1 coverage (photos with >= 1 published aesthetic and a non-empty "More like this" rail)
 *   M-C2 rail fill (fashion photos with >= 4 More-like-this cards)
 *   M-S3 style recall against labels (expected aesthetics/materials matched by any claim)
 *   label auto-verdicts: expected/acceptable matches count supported, forbidden matches unsupported
 *   M-T timing p50/p90 per milestone (from the live check's milestones)
 * Every rate carries a Wilson 95% interval (R-14). The judged metrics
 * (M-S1/M-S2 precision, M-R1/M-R2 relevance, M-S5 palette, M-G regions) need
 * the two independent vision judges and owner calibration and are reported
 * as not run.
 */
import { z } from 'zod';
import { styleTextAboutPerson } from '../../packages/providers/src/vlm/style';

export const STYLE_SCORER_VERSION = 'score-style-v1';

const Bucket = z.object({ expected: z.array(z.string()).default([]), acceptable: z.array(z.string()).default([]), forbidden: z.array(z.string()).default([]) });
/** fixtures/eval/style-v1/labels/<id>.json (design §G.1). */
export const StyleLabel = z.object({
  id: z.string(),
  photo: z.string(),
  split: z.enum(['tune', 'holdout']),
  subjects: z.array(
    z.object({
      category: z.enum(['fashion', 'interior', 'food', 'place', 'media', 'other']),
      label_any: z.array(z.string()).default([]),
      aesthetics: Bucket.default({ expected: [], acceptable: [], forbidden: [] }),
      materials: Bucket.default({ expected: [], acceptable: [], forbidden: [] }),
      construction_any: z.array(z.string()).default([]),
      palette_names_any: z.array(z.string()).default([]),
      era_acceptable: z.array(z.string()).default([]),
    }),
  ),
  forbidden_people_claims: z.boolean().default(true),
});
export type StyleLabel = z.infer<typeof StyleLabel>;

interface Claim {
  name: string;
  display: string;
  wording?: string;
}
interface Subject {
  id: string;
  category: string;
  label: string;
  aesthetics: Claim[];
  materials: Claim[];
  lineage: Claim[];
  construction: Claim[];
  details: { text: string; display: string }[];
  mood: Claim[];
  palette: { name: string; display: string }[];
  era: Claim | null;
}
export interface CaptureView {
  style_reading?: { summary: string; subjects: Subject[] } | null;
  rails?: { key: string; kind: string; cards: { title: string; reason?: string | null; style_match?: { attributes: string[] } | null }[] }[];
}

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const matches = (claim: string, terms: readonly string[]) => {
  const c = ` ${fold(claim)} `;
  return terms.some((t) => c.includes(` ${fold(t)} `) || ` ${fold(t)} `.includes(c));
};

/** Wilson 95% score interval for k successes in n trials. */
export function wilson(k: number, n: number): { rate: number | null; low: number | null; high: number | null; n: number } {
  if (n === 0) return { rate: null, low: null, high: null, n };
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { rate: p, low: Math.max(0, (c - r) / d), high: Math.min(1, (c + r) / d), n };
}

function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

export interface PhotoInput {
  id: string;
  view: CaptureView;
  milestones?: Record<string, number>;
  label?: StyleLabel;
}

export function scoreStyle(photos: readonly PhotoInput[]) {
  let violations = 0;
  let cardsChecked = 0;
  let cardsFaithful = 0;
  let covered = 0;
  let styled = 0;
  let fashion = 0;
  let filled = 0;
  let recallHit = 0;
  let recallTotal = 0;
  let supported = 0;
  let unsupported = 0;
  let unjudged = 0;
  const perPhoto: Record<string, unknown>[] = [];
  const timings: Record<string, number[]> = {};
  for (const p of photos) {
    const reading = p.view.style_reading;
    const subjects = reading?.subjects ?? [];
    const shown: string[] = [reading?.summary ?? ''];
    for (const s of subjects) {
      shown.push(s.label);
      for (const c of [...s.aesthetics, ...s.materials, ...s.lineage, ...s.construction, ...s.mood, ...s.palette]) shown.push(c.display);
      for (const d of s.details) shown.push(d.display);
      if (s.era) shown.push(s.era.display);
    }
    const personHits = shown.filter((t) => t && styleTextAboutPerson(t));
    violations += personHits.length;
    // smatch-1 reasons may also name a construction claim (shown in the reading as well).
    const claimNames = new Set(subjects.flatMap((s) => [...s.aesthetics, ...s.materials, ...s.lineage, ...(s.era ? [s.era] : []), ...s.mood, ...s.construction].map((c) => fold(c.name))));
    const mlt = (p.view.rails ?? []).filter((r) => r.kind === 'more_like_this');
    const mltCards = mlt.reduce((n, r) => n + r.cards.length, 0);
    for (const r of p.view.rails ?? [])
      for (const c of r.cards) {
        const attrs = c.style_match?.attributes ?? [];
        if (!attrs.length) continue;
        cardsChecked++;
        if (attrs.every((a) => claimNames.has(fold(a)))) cardsFaithful++;
      }
    const hasAesthetic = subjects.some((s) => s.aesthetics.length > 0);
    if (subjects.length) styled++;
    if (hasAesthetic && mltCards > 0) covered++;
    if (subjects.some((s) => s.category === 'fashion')) {
      fashion++;
      if (mltCards >= 4) filled++;
    }
    if (p.label)
      for (const ls of p.label.subjects) {
        const s = subjects.find((x) => x.category === ls.category) ?? subjects[0];
        const aesthetics = s?.aesthetics.map((a) => a.name) ?? [];
        const materials = s?.materials.map((m) => m.name) ?? [];
        for (const e of ls.aesthetics.expected) {
          recallTotal++;
          if (aesthetics.some((a) => matches(a, [e]))) recallHit++;
        }
        for (const e of ls.materials.expected) {
          recallTotal++;
          if (materials.some((m) => matches(m, [e]))) recallHit++;
        }
        for (const [claims, bucket] of [
          [aesthetics, ls.aesthetics],
          [materials, ls.materials],
        ] as const)
          for (const c of claims) {
            if (matches(c, bucket.forbidden)) unsupported++;
            else if (matches(c, [...bucket.expected, ...bucket.acceptable])) supported++;
            else unjudged++;
          }
      }
    for (const [k, v] of Object.entries(p.milestones ?? {})) (timings[k] ??= []).push(v);
    perPhoto.push({ id: p.id, subjects: subjects.length, aesthetics: subjects.reduce((n, s) => n + s.aesthetics.length, 0), more_like_this_cards: mltCards, people_violations: personHits.length, milestones_ms: p.milestones ?? {} });
  }
  return {
    scorer: STYLE_SCORER_VERSION,
    photos: photos.length,
    metrics: {
      'M-S4_people_violations': violations,
      'M-R3_reason_faithfulness': wilson(cardsFaithful, cardsChecked),
      'M-C1_coverage': wilson(covered, styled),
      'M-C2_rail_fill_fashion': wilson(filled, fashion),
      'M-S3_recall': wilson(recallHit, recallTotal),
      label_auto_verdicts: { supported, unsupported, unjudged },
      'M-T_ms': Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, { p50: percentile(v, 50), p90: percentile(v, 90), n: v.length }])),
      not_run: ['M-S1', 'M-S2', 'M-S5', 'M-S6', 'M-Q1', 'M-Q2', 'M-R1', 'M-R2', 'M-G'],
    },
    per_photo: perPhoto,
  };
}
