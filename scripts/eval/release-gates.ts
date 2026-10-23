import { normalizeName } from '../../packages/domain/src/compiler/text';
import type { PhotoLabel } from './labels';
import type { QlooAcceptRecord } from './scorer';

/**
 * The grounding and taste-seed gates of thresholds.json (quality plan §10),
 * as pure functions, so a live grounding run (eval:live --qloo) and a live
 * seed measurement (measure-taste-seed.ts) end with PASS or FAIL against the
 * versioned thresholds instead of numbers read by eye.
 *
 * What a machine can decide is decided here: forbidden accepts, doubtful
 * names, sample sizes, request and concurrency caps, Eat calls without food
 * picks, echo cards, the cuisine share of Eat. What needs a person (is the
 * accepted Qloo item the right one; is a card useful) comes from a judgement
 * file; without one those gates are reported as "needs hand judgement" and
 * the run does not pass. Nothing is ever assumed correct.
 */

export interface GateRow {
  metric: string;
  value: number | null;
  op: '<=' | '>=';
  limit: number;
  pass: boolean;
  note?: string;
}
export interface GateReport {
  metrics: Record<string, number | null>;
  gates: GateRow[];
  pass: boolean;
}

function gate(metrics: Record<string, number | null>, gates: Record<string, number>, key: string, metric: string, op: '<=' | '>='): GateRow | null {
  const limit = gates[key];
  if (limit === undefined) return null;
  const value = metrics[metric] ?? null;
  if (value === null) return { metric, value, op, limit, pass: false, note: 'needs hand judgement' };
  return { metric, value, op, limit, pass: op === '<=' ? value <= limit : value >= limit };
}
const ratio = (num: number, den: number): number | null => (den ? Math.round((num / den) * 10_000) / 10_000 : null);

// ---- grounding -----------------------------------------------------------------

/** Tag families grounding must never accept (quality plan §5, Q-TAGTYPES). */
export const FORBIDDEN_TAG_FAMILIES = [
  'occupation',
  'category:place',
  'specialty_dish',
  'menu_highlight',
  'ambience',
  'offerings',
  'amenity',
  'nearby_attraction',
  'neighborhood_characteristics',
  'keyword',
] as const;

export interface GroundingJudgement {
  photo: string;
  candidate: string;
  /** The accepted Qloo item is the candidate (precision). */
  correct_match?: boolean;
  /** The candidate itself is a good reference for the photo (end-to-end precision). */
  good_candidate?: boolean;
  /** The correct Qloo item was among the results (recall denominator). */
  findable?: boolean;
}

export type GroundingRecord = QlooAcceptRecord & { candidateType?: string; corroborated?: boolean; textOnly?: boolean };

/** Why an accepted record breaks a grounding rule, or null. */
export function forbiddenAccept(r: GroundingRecord, label?: PhotoLabel): string | null {
  if (!r.accepted) return null;
  // Decision 2: a text-only reference is never searched, so it can never be accepted.
  if (r.textOnly === true) return 'text_only_searched';
  if (r.plan === 'search' && r.candidateType === 'object' && r.corroborated === false) return 'object_searched';
  if (r.plan === 'search' && (r.candidateType === 'brand' || r.entityType === 'urn:entity:brand') && r.corroborated === false) return 'brand_without_corroboration';
  if (r.tagFamily && FORBIDDEN_TAG_FAMILIES.some((f) => r.tagFamily === f || r.tagFamily!.startsWith(`${f}:`))) return 'forbidden_tag_family';
  if (label && r.entityType && label.qloo.forbidden_entity_types.includes(r.entityType)) return 'forbidden_entity_type';
  if (label && r.tagFamily && label.qloo.forbidden_tag_families.includes(r.tagFamily)) return 'forbidden_tag_family';
  if (r.rule === 'Q-SUBSET') return 'subset_match';
  if (r.rule === 'Q-DOUBT') return 'doubtful_match';
  if (r.reason && !r.reason.startsWith('exact')) return 'not_an_exact_match';
  return null;
}

export function scoreGrounding(
  rows: readonly { photo: string; records: readonly GroundingRecord[] }[],
  labels: ReadonlyMap<string, PhotoLabel>,
  gates: Record<string, number>,
  judgements: readonly GroundingJudgement[] = [],
): GateReport & { forbidden: { photo: string; candidate: string; why: string }[] } {
  const judged = new Map(judgements.map((j) => [`${j.photo}|${j.candidate}`, j]));
  const lookups = rows.flatMap((r) => r.records.filter((x) => x.plan && x.plan !== 'none').map((x) => ({ photo: r.photo, r: x })));
  const accepted = lookups.filter((l) => l.r.accepted);
  const forbidden = [
    ...accepted.map((l) => ({ photo: l.photo, candidate: l.r.candidate, why: forbiddenAccept(l.r, labels.get(l.photo)) })),
    // A text-only reference must never reach Qloo at all: even a rejected lookup is a forbidden search.
    ...lookups.filter((l) => l.r.textOnly === true && !l.r.accepted).map((l) => ({ photo: l.photo, candidate: l.r.candidate, why: 'text_only_searched' })),
  ].filter((f): f is { photo: string; candidate: string; why: string } => f.why !== null);
  const verdict = (l: (typeof lookups)[number]) => judged.get(`${l.photo}|${l.r.candidate}`);
  const allAcceptedJudged = accepted.every((l) => typeof verdict(l)?.correct_match === 'boolean');
  const allE2eJudged = accepted.every((l) => typeof verdict(l)?.correct_match === 'boolean' && typeof verdict(l)?.good_candidate === 'boolean');
  const findable = lookups.filter((l) => verdict(l)?.findable === true);
  const metrics: Record<string, number | null> = {
    lookups: lookups.length,
    accepted: accepted.length,
    labelled_candidates: lookups.length,
    holdout_candidates: lookups.filter((l) => labels.get(l.photo)?.split === 'holdout').length,
    forbidden_accepts: forbidden.length,
    // Lookups planned for a text-only reference (decision 2): must be 0, accepted or not.
    text_only_searched: lookups.filter((l) => l.r.textOnly === true).length,
    doubtful_name_published: accepted.filter((l) => l.r.rule === 'Q-DOUBT').length,
    // Accepted brand or object searches whose record does not say whether the brand was read
    // (records written before eval:live stored it): reported, they cannot be checked here.
    unverifiable_brand_accepts: accepted.filter(
      (l) => l.r.plan === 'search' && (l.r.candidateType === 'object' || l.r.candidateType === 'brand' || l.r.entityType === 'urn:entity:brand') && l.r.corroborated === undefined,
    ).length,
    grounding_precision: accepted.length && allAcceptedJudged ? ratio(accepted.filter((l) => verdict(l)!.correct_match).length, accepted.length) : null,
    end_to_end_precision:
      accepted.length && allE2eJudged ? ratio(accepted.filter((l) => verdict(l)!.correct_match && verdict(l)!.good_candidate).length, accepted.length) : null,
    recall: findable.length ? ratio(findable.filter((l) => l.r.accepted && verdict(l)!.correct_match).length, findable.length) : null,
  };
  const results = [
    gate(metrics, gates, 'grounding_precision_min', 'grounding_precision', '>='),
    gate(metrics, gates, 'end_to_end_precision_min', 'end_to_end_precision', '>='),
    gate(metrics, gates, 'recall_min', 'recall', '>='),
    gate(metrics, gates, 'forbidden_accepts_max', 'forbidden_accepts', '<='),
    gate(metrics, gates, 'doubtful_name_published_max', 'doubtful_name_published', '<='),
    gate(metrics, gates, 'labelled_candidates_min', 'labelled_candidates', '>='),
    gate(metrics, gates, 'holdout_candidates_min', 'holdout_candidates', '>='),
  ].filter((g): g is GateRow => g !== null);
  return { metrics, gates: results, pass: results.length > 0 && results.every((g) => g.pass), forbidden };
}

// ---- taste seed ----------------------------------------------------------------

export interface SeedRun {
  picks: readonly { id: string; name: string; food: boolean }[];
  /** One entry per Qloo request: its filter.type (urn:tag for Eat's cuisine call). */
  requests: readonly { filterType: string | null }[];
  peakInFlight: number;
  categories: readonly { category: string; cards: readonly { title: string; qlooId: string | null }[] }[];
}
export interface SeedJudgement {
  eat_useful_share?: number;
  wear_fashion_brand_share?: number;
  play_watch_type_correct?: number;
}

const SKIP = new Set(['the', 'and', 'of', 'a', 'an', 'cuisine', 'food', 'style', 'music', 'fashion']);
const words = (s: string) => normalizeName(s.replace(/^urn:tag:[a-z_]+:[a-z_]+:/, '').replace(/_/g, ' ')).split(' ').filter((t) => t.length >= 3 && !SKIP.has(t));

export function scoreSeed(run: SeedRun, gates: Record<string, number>, judged: SeedJudgement = {}): GateReport & { echoes: string[] } {
  const foodPicks = run.picks.some((p) => p.food);
  const eat = run.categories.find((c) => c.category === 'eat')?.cards ?? [];
  const nonFood = new Set(run.picks.filter((p) => !p.food).flatMap((p) => words(p.name)));
  const echoes = eat.filter((c) => words(c.title).some((w) => nonFood.has(w))).map((c) => c.title);
  const metrics: Record<string, number | null> = {
    requests: run.requests.length,
    in_flight: run.peakInFlight,
    eat_calls_without_food_picks: foodPicks ? 0 : run.requests.filter((r) => r.filterType === 'urn:tag').length,
    eat_echo_cards: echoes.length,
    eat_food_share: foodPicks ? ratio(eat.filter((c) => c.qlooId?.startsWith('urn:tag:cuisine:')).length, eat.length) : null,
    eat_useful_share: foodPicks ? (judged.eat_useful_share ?? null) : null,
    wear_fashion_brand_share: judged.wear_fashion_brand_share ?? null,
    play_watch_type_correct: judged.play_watch_type_correct ?? null,
  };
  const results = [
    gate(metrics, gates, 'requests_max', 'requests', '<='),
    gate(metrics, gates, 'in_flight_max', 'in_flight', '<='),
    gate(metrics, gates, 'eat_calls_without_food_picks_max', 'eat_calls_without_food_picks', '<='),
    gate(metrics, gates, 'eat_echo_cards_max', 'eat_echo_cards', '<='),
    ...(foodPicks
      ? [gate(metrics, gates, 'eat_food_share_min', 'eat_food_share', '>='), gate(metrics, gates, 'eat_useful_share_min', 'eat_useful_share', '>=')]
      : []),
    gate(metrics, gates, 'wear_fashion_brand_share_min', 'wear_fashion_brand_share', '>='),
    gate(metrics, gates, 'play_watch_type_correct_min', 'play_watch_type_correct', '>='),
  ].filter((g): g is GateRow => g !== null);
  return { metrics, gates: results, pass: results.length > 0 && results.every((g) => g.pass), echoes };
}

/** Human-readable lines for a gate report. */
export function gateLines(name: string, r: GateReport): string[] {
  return [
    `${name}: ${r.pass ? 'PASS' : 'FAIL'}`,
    ...r.gates.map((g) => `  ${g.pass ? 'ok  ' : 'FAIL'} ${g.metric} ${g.value ?? 'n/a'} (${g.op} ${g.limit})${g.note ? ` ${g.note}` : ''}`),
  ];
}
