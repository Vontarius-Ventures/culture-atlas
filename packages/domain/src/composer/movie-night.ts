import {
  isProviderError,
  isUsable,
  type QlooEntity,
  type QlooEntityType,
  type TextModelProvider,
} from '@culture-atlas/providers';
import type { PlanSection, SectionStatus } from '../enums';
import { LIMITS } from '../enums';
import { suggestArtists, suggestDishes, suggestFilms, writeProse, inputLabels } from './creative';
import { stripExcludedMentions, stripSafetyClaims, violatedExclusions } from './dietary';
import { reciprocalRankFusion, selectForExploration, type FusedCandidate, type RankedList } from './fusion';
import type { ComposedPick, InputContribution, PlanSnapshot, SnapshotItem } from './plan-types';
import { BudgetExhaustedError, withProviderRetries, type QlooSession, type RecordedQuery } from './provider-calls';
import { canonicalKeyFor, normalizeLabel, yearOf } from './store';

/**
 * Movie-night composer: one film + two alternates, up to three dishes, music
 * before/after (artist mix; verified tracks only with a catalog adapter, which
 * this release does not have).
 *
 * Sources, in priority order:
 *  1. Qloo insights with the inputs' real entity ids (resolved via /search when
 *     needed). Per-query ranking is kept, exclusions applied first, lists
 *     fused with RRF, then diversified by contributing input and selected for
 *     the exploration level. Each pick cites the provider queries that returned it.
 *  2. When Qloo is unavailable or returns nothing: creative suggestions from the
 *     composer model, flagged origin 'vlm_creative' and attributed to inputs.
 *  3. Otherwise the section is 'unavailable' (never fabricated).
 * Works only from the plan's input snapshot (never live collection state).
 */

export interface ComposeEnv {
  qloo: QlooSession;
  /** Null when the composer model is unavailable. */
  composer: TextModelProvider | null;
  hidden: ReadonlySet<string>;
  maxRetries: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Idempotent stage runner (JobContext.runStage) — passthrough in unit tests. */
  runStage<R>(name: string, fn: () => Promise<R>): Promise<R>;
}

export interface SectionResult<T> {
  status: SectionStatus;
  value: T;
}

export interface FilmResult {
  feature: ComposedPick | null;
  alternates: ComposedPick[];
}
export interface MusicResult {
  before: ComposedPick[];
  after: ComposedPick[];
}
export interface FoodResult {
  dishes: ComposedPick[];
}

export interface ComposeOptions {
  sections: readonly PlanSection[];
  /** Canonical keys never to propose again per section (previous picks on replacement). */
  avoidKeys?: Partial<Record<PlanSection, ReadonlySet<string>>>;
  /** Replacement instruction (user data). */
  extraInstruction?: string | null;
  /** Current feature film when only music/food are recomposed. */
  currentFilm?: ComposedPick | null;
}

export interface ComposeOutput {
  film?: SectionResult<FilmResult>;
  music?: SectionResult<MusicResult>;
  food?: SectionResult<FoodResult>;
  queries: RecordedQuery[];
}

interface StageOut<T> {
  value: T;
  queries: RecordedQuery[];
}

const FILTER_TYPES: Record<'film' | 'music' | 'food', QlooEntityType> = {
  film: 'urn:entity:movie',
  music: 'urn:entity:artist',
  food: 'urn:entity:place',
};

const SEARCH_TYPES: Partial<Record<SnapshotItem['kind'], QlooEntityType>> = {
  film: 'urn:entity:movie',
  artist: 'urn:entity:artist',
  brand: 'urn:entity:brand',
};

/** Real Qloo entity ids already known for an input (item or its anchors). */
export function knownQlooIds(item: SnapshotItem): string[] {
  const ids: string[] = [];
  const own = item.external_ids['qloo'];
  if (typeof own === 'string') ids.push(own);
  for (const a of item.anchors) {
    const q = a.external_ids['qloo'];
    if (typeof q === 'string') ids.push(q);
  }
  return [...new Set(ids)];
}

/** Inputs with usable cultural anchors: references, provider ids, or a named thing. */
export function inputHasAnchors(item: SnapshotItem): boolean {
  if (item.anchors.length > 0 || knownQlooIds(item).length > 0) return true;
  return item.kind !== 'capture' && item.title.trim().length > 0;
}

function namesMatch(a: string, b: string): boolean {
  const x = normalizeLabel(a);
  const y = normalizeLabel(b);
  return x.length > 0 && y.length > 0 && (x === y || x.startsWith(y) || y.startsWith(x));
}

async function stage<T>(env: ComposeEnv, name: string, fn: () => Promise<T>): Promise<StageOut<T>> {
  return env.runStage(name, async () => {
    const before = env.qloo.recorded.length;
    const value = await fn();
    return { value, queries: env.qloo.recorded.slice(before) };
  });
}

/** Resolve inputs without provider ids through /search (bounded, exact-ish name match only). */
export async function resolveInputs(env: ComposeEnv, snapshot: PlanSnapshot): Promise<StageOut<Record<string, string[]>>> {
  const stored = await resolveStage(env, snapshot);
  // Stage outputs round-trip through jsonb, which does not keep key order:
  // restore the input order so signals (and attribution) are deterministic.
  const value = Object.fromEntries(snapshot.items.map((i) => [i.item_id, stored.value[i.item_id] ?? []]));
  return { value, queries: stored.queries };
}

function resolveStage(env: ComposeEnv, snapshot: PlanSnapshot): Promise<StageOut<Record<string, string[]>>> {
  return stage(env, 'resolve', async () => {
    const out: Record<string, string[]> = {};
    for (const item of snapshot.items) out[item.item_id] = knownQlooIds(item);
    if (!env.qloo.searchUsable()) return out;
    let searches = 0;
    for (const item of snapshot.items) {
      if (out[item.item_id]!.length > 0) continue;
      const names =
        item.kind === 'capture'
          ? item.anchors.slice(0, 2).map((a) => ({ name: a.name, type: undefined as QlooEntityType | undefined }))
          : [{ name: item.title, type: SEARCH_TYPES[item.kind] }];
      for (const n of names) {
        if (searches >= 5) break;
        searches++;
        try {
          const { response } = await env.qloo.search(n.name, n.type ? [n.type] : undefined, { purpose: 'resolve_input', input_item_id: item.item_id });
          const hit = response.data.find((e) => namesMatch(e.name, n.name));
          if (hit) out[item.item_id]!.push(hit.entity_id);
        } catch (err) {
          if (err instanceof BudgetExhaustedError) return out;
          if (!isProviderError(err)) throw err;
          // Resolution failures leave the input to creative composition.
        }
      }
    }
    return out;
  });
}

interface Candidate {
  key: string;
  entity: QlooEntity;
  queryId: string;
  isReplay: boolean;
  inputs: string[];
}

function attributionFromExplainability(entity: QlooEntity, signalOwner: Map<string, string>): string[] {
  // Strongest contributing input first, so the reason names what drove this pick.
  const ex = [...(entity.query?.explainability ?? [])].sort((a, b) => b.score - a.score);
  return [...new Set(ex.map((e) => signalOwner.get(e.entity_id)).filter((x): x is string => Boolean(x)))];
}

/**
 * Reason for a Qloo pick, from the signal Qloo says produced it (its
 * explainability): the strongest input first, so picks in one plan read
 * differently instead of one boilerplate line.
 */
export function qlooReasonFor(snapshot: PlanSnapshot, inputIds: readonly string[], year: number | null = null): string {
  const names = [...new Set(inputIds)].map((id) => titleOf(snapshot, id));
  if (names.length === 0) return 'Close to the mood of the items you selected.';
  const fans = names.length === 1 ? names[0] : `${names[0]} (and ${names.length === 2 ? names[1] : `${names.length - 1} more of your picks`})`;
  return year ? `Loved by fans of ${fans}; from ${year}.` : `Loved by fans of ${fans}.`;
}

function titleOf(snapshot: PlanSnapshot, itemId: string): string {
  const it = snapshot.items.find((i) => i.item_id === itemId);
  return it ? (it.capture?.title ?? it.title) : 'your selection';
}

/** Plain-language reason: names inputs, phrases mixes as creative pairings, never a score. */
export function reasonFor(snapshot: PlanSnapshot, inputIds: readonly string[]): string {
  const names = [...new Set(inputIds)].map((id) => titleOf(snapshot, id));
  if (names.length === 0) return 'Suggested from the items you selected.';
  if (names.length === 1) return `Connected to ${names[0]}.`;
  const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `A creative pairing that draws on ${list}.`;
}

/**
 * Run fused Qloo insights for one section. Returns null when Qloo cannot be
 * used or produced nothing usable (caller falls back to creative ideas).
 */
async function qlooSection(
  env: ComposeEnv,
  snapshot: PlanSnapshot,
  signals: Record<string, string[]>,
  input: { section: 'film' | 'music'; count: number; exclude: (key: string) => boolean; extraSignals?: string[]; perInputQueries: number },
): Promise<{ picks: ComposedPick[]; failed: boolean } | null> {
  if (!env.qloo.insightsUsable()) return null;
  const signalOwner = new Map<string, string>();
  for (const [itemId, ids] of Object.entries(signals)) for (const id of ids) if (!signalOwner.has(id)) signalOwner.set(id, itemId);
  const all = [...new Set([...Object.values(signals).flat(), ...(input.extraSignals ?? [])])].slice(0, 10);
  if (all.length === 0) return null;

  const lists: RankedList<Candidate>[] = [];
  let failed = false;
  const run = async (signalEntities: string[], forInput: string | null) => {
    try {
      const { response, queryId } = await env.qloo.insights(
        { filterType: FILTER_TYPES[input.section], signalEntities, explainability: true, take: 20 },
        { purpose: `plan_${input.section}`, input_item_id: forInput },
      );
      const items = response.data.entities
        .map((entity) => ({
          key: canonicalKeyFor({ kind: input.section === 'film' ? 'film' : 'artist', title: entity.name, qlooId: entity.entity_id }),
          entity,
          queryId,
          isReplay: response.is_replay,
          inputs: forInput ? [forInput] : attributionFromExplainability(entity, signalOwner),
        }))
        .filter((c) => !input.exclude(c.key) && !signalOwner.has(c.entity.entity_id));
      lists.push({ id: queryId, items });
    } catch (err) {
      if (err instanceof BudgetExhaustedError) return;
      if (!isProviderError(err)) throw err;
      failed = true;
    }
  };
  await run(all, null);
  const perInput = Object.entries(signals).filter(([, ids]) => ids.length > 0).slice(0, input.perInputQueries);
  if (perInput.length > 1) for (const [itemId, ids] of perInput) await run(ids.slice(0, 5), itemId);

  if (lists.every((l) => l.items.length === 0)) return failed && lists.length === 0 ? { picks: [], failed: true } : null;
  const fused = reciprocalRankFusion(lists);
  const merged = new Map<string, { inputs: Set<string>; queries: Set<string>; replay: boolean }>();
  for (const l of lists) {
    for (const c of l.items) {
      const m = merged.get(c.key) ?? { inputs: new Set<string>(), queries: new Set<string>(), replay: true };
      c.inputs.forEach((i) => m.inputs.add(i));
      m.queries.add(c.queryId);
      m.replay &&= c.isReplay;
      merged.set(c.key, m);
    }
  }
  const groupOf = (c: FusedCandidate<Candidate>) => [...(merged.get(c.key)?.inputs ?? [])].sort()[0] ?? null;
  const chosen = selectForExploration(fused, snapshot.exploration, input.count, groupOf);
  const picks = chosen.map((c): ComposedPick => {
    const m = merged.get(c.key)!;
    const inputs = [...m.inputs];
    return {
      key: c.key,
      kind: input.section === 'film' ? 'film' : 'artist',
      category: input.section === 'film' ? 'watch' : 'play',
      title: c.item.entity.name,
      year: input.section === 'film' ? yearOf(c.item.entity) : null,
      detail: null,
      description: null,
      qloo_id: c.item.entity.entity_id,
      existing_item_id: null,
      origin: m.replay ? 'replay' : 'qloo',
      provider_query_ids: [...m.queries],
      contributing_input_ids: inputs,
      contributing_reference_ids: referenceIdsFor(snapshot, inputs),
      reason: qlooReasonFor(snapshot, inputs, input.section === 'film' ? yearOf(c.item.entity) : null),
      is_fixed: false,
    };
  });
  return { picks, failed };
}

function referenceIdsFor(snapshot: PlanSnapshot, inputIds: readonly string[]): string[] {
  const ids = new Set(inputIds);
  return [...new Set(snapshot.items.filter((i) => ids.has(i.item_id)).flatMap((i) => i.anchors.map((a) => a.reference_id)))];
}

function citedInputs(snapshot: PlanSnapshot, labels: readonly string[]): string[] {
  const map = inputLabels(snapshot);
  return [...new Set(labels.map((l) => map.get(l)).filter((x): x is string => Boolean(x)))];
}

function composerUsable(env: ComposeEnv): TextModelProvider | null {
  return env.composer && isUsable(env.composer.capability()) ? env.composer : null;
}

function inputKeys(snapshot: PlanSnapshot): Set<string> {
  return new Set(snapshot.items.map((i) => i.canonical_key));
}

function fixedFilmPick(snapshot: PlanSnapshot): ComposedPick | null {
  const fixed = snapshot.items.find((i) => i.item_id === snapshot.fixed_film_item_id && i.kind === 'film');
  if (!fixed) return null;
  return {
    key: fixed.canonical_key,
    kind: 'film',
    category: 'watch',
    title: fixed.title,
    year: fixed.year,
    detail: fixed.subtitle,
    description: null,
    qloo_id: typeof fixed.external_ids['qloo'] === 'string' ? (fixed.external_ids['qloo'] as string) : null,
    existing_item_id: fixed.item_id,
    origin: 'vlm_creative',
    provider_query_ids: [],
    contributing_input_ids: [fixed.item_id],
    contributing_reference_ids: fixed.anchors.map((a) => a.reference_id),
    reason: 'Your pick for the evening.',
    is_fixed: true,
  };
}

async function filmSection(env: ComposeEnv, snapshot: PlanSnapshot, signals: Record<string, string[]>, opts: ComposeOptions): Promise<StageOut<SectionResult<FilmResult>>> {
  return stage(env, 'film', async () => {
    const fixed = fixedFilmPick(snapshot);
    const count = fixed ? LIMITS.planAlternatesFilms : 1 + LIMITS.planAlternatesFilms;
    const avoid = opts.avoidKeys?.film ?? new Set<string>();
    const inputs = inputKeys(snapshot);
    const exclude = (key: string) => env.hidden.has(key) || inputs.has(key) || avoid.has(key) || key === fixed?.key;
    const q = await qlooSection(env, snapshot, signals, {
      section: 'film',
      count,
      exclude,
      extraSignals: fixed?.qloo_id ? [fixed.qloo_id] : [],
      perInputQueries: 2,
    });
    let picks = q?.picks ?? [];
    if (picks.length < count) {
      const model = composerUsable(env);
      if (model) {
        try {
          const ideas = await withProviderRetries(
            () =>
              suggestFilms(model, snapshot, {
                count: count - picks.length + 2,
                avoidTitles: [...picks.map((p) => p.title), ...snapshot.items.filter((i) => i.kind === 'film').map((i) => i.title)],
                extraInstruction: opts.extraInstruction,
                signal: env.signal,
              }),
            { maxRetries: env.maxRetries, sleep: env.sleep },
          );
          for (const f of ideas.data.films) {
            const key = canonicalKeyFor({ kind: 'film', title: f.title, year: f.year ?? null });
            if (exclude(key) || picks.some((p) => p.key === key || namesMatch(p.title, f.title))) continue;
            const cited = citedInputs(snapshot, f.inputs);
            picks.push({
              key,
              kind: 'film',
              category: 'watch',
              title: f.title,
              year: f.year ?? null,
              detail: null,
              description: null,
              qloo_id: null,
              existing_item_id: null,
              origin: 'vlm_creative',
              provider_query_ids: [],
              contributing_input_ids: cited,
              contributing_reference_ids: referenceIdsFor(snapshot, cited),
              reason: stripSafetyClaims(f.reason) || reasonFor(snapshot, cited),
              is_fixed: false,
            });
            if (picks.length >= count) break;
          }
        } catch (err) {
          if (!isProviderError(err)) throw err;
        }
      }
    }
    picks = picks.slice(0, count);
    const feature = fixed ?? picks[0] ?? null;
    const alternates = fixed ? picks : picks.slice(1);
    const status: SectionStatus = !feature
      ? 'unavailable'
      : alternates.length < LIMITS.planAlternatesFilms
        ? 'partial'
        : 'complete';
    return { status, value: { feature, alternates } };
  });
}

async function musicSection(
  env: ComposeEnv,
  snapshot: PlanSnapshot,
  signals: Record<string, string[]>,
  film: ComposedPick | null,
  opts: ComposeOptions,
): Promise<StageOut<SectionResult<MusicResult>>> {
  return stage(env, 'music', async () => {
    const count = 4;
    const avoid = opts.avoidKeys?.music ?? new Set<string>();
    const inputs = inputKeys(snapshot);
    const exclude = (key: string) => env.hidden.has(key) || inputs.has(key) || avoid.has(key);
    const q = await qlooSection(env, snapshot, signals, {
      section: 'music',
      count,
      exclude,
      extraSignals: film?.qloo_id ? [film.qloo_id] : [],
      perInputQueries: 1,
    });
    const picks = q?.picks ?? [];
    if (picks.length < count) {
      const model = composerUsable(env);
      if (model) {
        try {
          const ideas = await withProviderRetries(
            () =>
              suggestArtists(model, snapshot, {
                count: count - picks.length + 2,
                avoidNames: [...picks.map((p) => p.title), ...snapshot.items.filter((i) => i.kind === 'artist').map((i) => i.title)],
                film: film?.title ?? null,
                extraInstruction: opts.extraInstruction,
                signal: env.signal,
              }),
            { maxRetries: env.maxRetries, sleep: env.sleep },
          );
          for (const a of ideas.data.artists) {
            const key = canonicalKeyFor({ kind: 'artist', title: a.name });
            if (exclude(key) || picks.some((p) => p.key === key || namesMatch(p.title, a.name))) continue;
            const cited = citedInputs(snapshot, a.inputs);
            picks.push({
              key,
              kind: 'artist',
              category: 'play',
              title: a.name,
              year: null,
              detail: null,
              description: null,
              qloo_id: null,
              existing_item_id: null,
              origin: 'vlm_creative',
              provider_query_ids: [],
              contributing_input_ids: cited,
              contributing_reference_ids: referenceIdsFor(snapshot, cited),
              reason: stripSafetyClaims(a.reason) || reasonFor(snapshot, cited),
              is_fixed: false,
            });
            if (picks.length >= count) break;
          }
        } catch (err) {
          if (!isProviderError(err)) throw err;
        }
      }
    }
    const chosen = picks.slice(0, count);
    const half = Math.ceil(chosen.length / 2);
    const status: SectionStatus = chosen.length === 0 ? 'unavailable' : chosen.length < 2 ? 'partial' : 'complete';
    return { status, value: { before: chosen.slice(0, half), after: chosen.slice(half) } };
  });
}

/** Cuisine hints from Qloo place insights (tags only; places are not dishes). */
async function cuisineHints(env: ComposeEnv, signals: Record<string, string[]>): Promise<{ hints: string[]; queryIds: string[] }> {
  if (!env.qloo.insightsUsable()) return { hints: [], queryIds: [] };
  const all = [...new Set(Object.values(signals).flat())].slice(0, 10);
  if (all.length === 0) return { hints: [], queryIds: [] };
  try {
    const { response, queryId } = await env.qloo.insights(
      { filterType: FILTER_TYPES.food, signalEntities: all, take: 15 },
      { purpose: 'plan_food_cuisine_hints' },
    );
    const counts = new Map<string, number>();
    const isCuisine = (t: { id: string; type?: string }) => /cuisine/i.test(t.type ?? '') || /cuisine/i.test(t.id);
    for (const t of response.data.tags) if (isCuisine(t)) counts.set(t.name, (counts.get(t.name) ?? 0) + 2);
    for (const e of response.data.entities) for (const t of e.tags) if (isCuisine(t)) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    const hints = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);
    return { hints, queryIds: hints.length ? [queryId] : [] };
  } catch (err) {
    if (err instanceof BudgetExhaustedError || isProviderError(err)) return { hints: [], queryIds: [] };
    throw err;
  }
}

function selectedDishPick(snapshot: PlanSnapshot, item: SnapshotItem): ComposedPick {
  return {
    key: item.canonical_key,
    kind: 'food',
    category: 'eat',
    title: item.title,
    year: null,
    detail: item.detail ?? item.subtitle,
    description: item.subtitle,
    qloo_id: null,
    existing_item_id: item.item_id,
    origin: 'vlm_creative',
    provider_query_ids: [],
    contributing_input_ids: [item.item_id],
    contributing_reference_ids: item.anchors.map((a) => a.reference_id),
    reason: 'From your collection.',
    is_fixed: false,
  };
}

async function foodSection(
  env: ComposeEnv,
  snapshot: PlanSnapshot,
  signals: Record<string, string[]>,
  film: ComposedPick | null,
  opts: ComposeOptions,
): Promise<StageOut<SectionResult<FoodResult>>> {
  return stage(env, 'food', async () => {
    const exclusions = snapshot.constraints.dietary_exclusions;
    const avoid = opts.avoidKeys?.food ?? new Set<string>();
    const compatibleSelected = snapshot.items
      .filter((i) => i.kind === 'food' && !avoid.has(i.canonical_key) && !env.hidden.has(i.canonical_key))
      .filter((i) => violatedExclusions({ title: i.title, description: i.subtitle, cuisine: i.detail }, exclusions).length === 0);
    const dishes: ComposedPick[] = [];
    const model = composerUsable(env);
    if (model) {
      const { hints, queryIds } = await cuisineHints(env, signals);
      try {
        const ideas = await withProviderRetries(
          () =>
            suggestDishes(model, snapshot, {
              count: LIMITS.planDishesMax + 2,
              cuisineHints: hints,
              selectedDishes: compatibleSelected.map((i) => i.title),
              avoidTitles: [],
              film: film?.title ?? null,
              extraInstruction: opts.extraInstruction,
              signal: env.signal,
            }),
          { maxRetries: env.maxRetries, sleep: env.sleep },
        );
        for (const d of ideas.data.dishes) {
          if (violatedExclusions(d, exclusions).length > 0) continue;
          const selected = compatibleSelected.find((i) => namesMatch(i.title, d.title));
          if (selected) {
            if (!dishes.some((p) => p.key === selected.canonical_key)) dishes.push(selectedDishPick(snapshot, selected));
          } else {
            const cited = citedInputs(snapshot, d.inputs);
            const refs = referenceIdsFor(snapshot, cited);
            const key = canonicalKeyFor({ kind: 'food', title: d.title, referenceIds: refs });
            if (avoid.has(key) || env.hidden.has(key) || dishes.some((p) => p.key === key || namesMatch(p.title, d.title))) continue;
            dishes.push({
              key,
              kind: 'food',
              category: 'eat',
              title: d.title,
              year: null,
              detail: d.cuisine ?? null,
              description: stripSafetyClaims(d.description) || null,
              qloo_id: null,
              existing_item_id: null,
              origin: 'vlm_creative',
              provider_query_ids: queryIds,
              contributing_input_ids: cited,
              contributing_reference_ids: refs,
              reason: stripSafetyClaims(d.reason) || reasonFor(snapshot, cited),
              is_fixed: false,
            });
          }
          if (dishes.length >= LIMITS.planDishesMax) break;
        }
      } catch (err) {
        if (!isProviderError(err)) throw err;
      }
    }
    if (dishes.length === 0) {
      for (const i of compatibleSelected.slice(0, LIMITS.planDishesMax)) dishes.push(selectedDishPick(snapshot, i));
    }
    const status: SectionStatus = dishes.length === 0 ? 'unavailable' : model ? 'complete' : 'partial';
    return { status, value: { dishes } };
  });
}

/** Compose the requested sections. Providers that fail degrade sections, never the whole plan. */
export async function composeMovieNight(env: ComposeEnv, snapshot: PlanSnapshot, opts: ComposeOptions): Promise<ComposeOutput> {
  const queries: RecordedQuery[] = [];
  const resolved = await resolveInputs(env, snapshot);
  queries.push(...resolved.queries);
  const signals = resolved.value;
  const out: ComposeOutput = { queries };
  let film = opts.currentFilm ?? null;
  if (opts.sections.includes('film')) {
    const r = await filmSection(env, snapshot, signals, opts);
    queries.push(...r.queries);
    out.film = r.value;
    film = r.value.value.feature ?? film;
  }
  if (opts.sections.includes('music')) {
    const r = await musicSection(env, snapshot, signals, film, opts);
    queries.push(...r.queries);
    out.music = r.value;
  }
  if (opts.sections.includes('food')) {
    const r = await foodSection(env, snapshot, signals, film, opts);
    queries.push(...r.queries);
    out.food = r.value;
  }
  return out;
}

/** strong: some pick draws on it (or it is the fixed film); weak: usable but unused; none: no anchors. */
export function inputContributions(snapshot: PlanSnapshot, picks: readonly ComposedPick[]): InputContribution[] {
  const used = new Set(picks.flatMap((p) => p.contributing_input_ids));
  return snapshot.items.map((item) => {
    if (!inputHasAnchors(item)) {
      return { item_id: item.item_id, contribution: 'none', note: `${item.capture?.title ?? item.title} didn’t have enough detail to use.` };
    }
    if (used.has(item.item_id) || item.item_id === snapshot.fixed_film_item_id) {
      return { item_id: item.item_id, contribution: 'strong', note: null };
    }
    return { item_id: item.item_id, contribution: 'weak', note: `${item.capture?.title ?? item.title} contributed little to this plan.` };
  });
}

export interface Prose {
  title: string;
  summary: string;
  rationale: string | null;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Deterministic prose used when the composer model is unavailable. */
export function fallbackProse(snapshot: PlanSnapshot, film: ComposedPick | null, contributions: InputContribution[]): Prose {
  const names = snapshot.items.map((i) => i.capture?.title ?? i.title);
  const weak = contributions.filter((c) => c.contribution !== 'strong').map((c) => c.note).filter(Boolean) as string[];
  // Only disclose weak inputs when the plan actually drew on something; when no
  // section could be composed, the section states already say so.
  const anyStrong = contributions.some((c) => c.contribution === 'strong');
  const swap = weak.length === 1 ? 'You can swap it for another item.' : 'You can swap them for other items.';
  return {
    title: film ? `Movie night: ${film.title}` : 'Movie night',
    summary: `A creative pairing built from ${listNames(names)}.`,
    rationale: weak.length && anyStrong ? `${weak.join(' ')} ${swap}` : null,
  };
}

export async function composeProse(
  env: ComposeEnv,
  snapshot: PlanSnapshot,
  sections: { film: ComposedPick | null; dishes: ComposedPick[]; artists: ComposedPick[] },
  contributions: InputContribution[],
): Promise<Prose> {
  const base = fallbackProse(snapshot, sections.film, contributions);
  const model = composerUsable(env);
  if (!model) return base;
  return env.runStage('compose', async () => {
    try {
      const weakInputs = contributions
        .filter((c) => c.contribution !== 'strong')
        .map((c) => titleOf(snapshot, c.item_id));
      const r = await withProviderRetries(
        () =>
          writeProse(model, snapshot, {
            film: sections.film?.title ?? null,
            dishes: sections.dishes.map((d) => d.title),
            artists: sections.artists.map((a) => a.title),
            weakInputs,
            signal: env.signal,
          }),
        { maxRetries: env.maxRetries, sleep: env.sleep },
      );
      // Shown as written, minus safety promises and any sentence naming an excluded ingredient.
      const exclusions = snapshot.constraints.dietary_exclusions;
      const shown = (text: string) => stripExcludedMentions(stripSafetyClaims(text), exclusions);
      const rationale = [base.rationale, r.data.rationale ? shown(r.data.rationale) : null].filter(Boolean).join(' ');
      return {
        title: violatedExclusions({ title: r.data.title }, exclusions).length ? base.title : r.data.title,
        summary: shown(r.data.summary) || base.summary,
        rationale: rationale || null,
      };
    } catch (err) {
      if (!isProviderError(err)) throw err;
      return base;
    }
  });
}
