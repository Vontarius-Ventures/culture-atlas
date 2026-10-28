import { randomUUID } from 'node:crypto';
import { isProviderError, ProviderError, type QlooEntity, type QlooInsightsRequest, type QlooTag } from '@culture-atlas/providers';
import { violatedExclusions } from '../composer/dietary';
import { BudgetExhaustedError, QlooSession, type RecordedQuery } from '../composer/provider-calls';
import {
  canonicalKeyFor,
  insertProviderQueries,
  insertRecommendations,
  upsertDiscoveryItem,
  yearOf,
  type RecommendationInsert,
  type RecommendationParent,
} from '../composer/store';
import type { Queryable } from '../db/pool';
import { FASHION_BRAND_TAG } from '../compiler/grounding';
import { canonicalTokens, nameTokens, CANONICAL_STOP, stemToken } from '../compiler/text';
import type { Category, ItemKind } from '../enums';
import { AppError } from '../errors';
import { requireServiceFeature } from '../flags/feature-flags';
import { JobCancelledError, type JobContext, type JobHandler } from '../jobs/handler';
import { hiddenKeys } from '../library/access';
import type { Owner } from '../principal';
import type { SeedCategoryState } from '../schemas/onboarding';
import { fillInterestsBoard } from '../services/collections';
import { rebuildFeedSnapshots } from '../services/discovery';
import { destinationFromQlooProperties, qlooImageUrl, qlooImageUrlIfRenderable } from '../services/display';
import {
  ensureSeedRun,
  readFoodExclusions,
  TASTE_SEED_INLINE_RETRIES,
  TASTE_SEED_MAX_CONCURRENCY,
  TASTE_SEED_MAX_QLOO_REQUESTS,
} from '../services/taste-seed';

/**
 * Taste seed (spec amendment 2.2, "Seeding the feed"; package B of
 * docs/build-plan-v2.2.md). Turns the account's onboarding picks into a
 * personal, Qloo-backed feed:
 *
 *  - Signals: the account's CURRENT explicit saves that carry a real Qloo id
 *    (onboarding picks are such saves). `urn:tag:*` ids go to
 *    `signal.interests.tags`, entity ids to `signal.interests.entities`.
 *  - Signal quality (docs/quality-plan.md §6): Eat is asked with FOOD picks
 *    only (S-EAT-SIGNAL); with none it makes no request and stays `empty`
 *    (S-EAT-EMPTY). Its tags are post-filtered: popularity, re-spellings of a
 *    pick, echoes of non-food picks, plural duplicates (S-EAT-POST). Wear
 *    asks for fashion brands only (S-WEAR-FILTER).
 *  - One Qloo insights request per category: brands (Wear), artists (Play),
 *    films (Watch), cuisine tags (Eat; measured faster and more relevant than
 *    location-less place queries, see docs/ARCHITECTURE.md). At most
 *    TASTE_SEED_MAX_QLOO_REQUESTS requests per attempt, inline retries
 *    included and the adapter's own retries disabled so every HTTP request is
 *    counted; at most TASTE_SEED_MAX_CONCURRENCY in flight. Eat may first
 *    search for pictured venues, but only with the budget's slack
 *    (seedPlaceSearchBudget: one request per pending category and one retry
 *    are kept back), so place searches never push a job past the cap.
 *  - Each category publishes as soon as it is fetched: recommendations
 *    (parent: the seed run, citing their provider query) into the account's
 *    feed pool, then a rebuilt FeedSnapshot with the usual feed rules. Screen
 *    15 advances on the first `ready` category.
 *  - Never fabricates: a category Qloo returns nothing for (after removing the
 *    picks themselves, hidden and saved items, and Eat items that match the
 *    account's food exclusions) is `empty`; the feed's labeled examples fill
 *    the gap. A Qloo failure leaves the category `unavailable`; the job throws
 *    a retryable error so the worker re-queues it with backoff (Retry-After
 *    honored), and categories that already published are not requested again.
 *  - Replayed Qloo data (QLOO_REPLAY_FIXTURES) is stored as origin `replay`
 *    and labeled "Example result" on every card.
 */

export const SEED_SIGNALS_MAX = 12;
export const SEED_RESULTS_TAKE = 15;
export const SEED_CARDS_PER_CATEGORY = 8;
/** Distinct cuisine/place names to search so expand waves don't repeat one query. */
export const EAT_PLACE_SEARCHES = 3;
/**
 * Requests of the seed's ONB-04 budget kept back for one retry of a failed
 * category; Eat place searches only spend what is left after one request per
 * pending category and this reserve.
 */
export const SEED_RETRY_RESERVE = 1;

/**
 * Eat place searches this attempt may make inside the per-job cap (ONB-04):
 * every pending category needs one request of its own and one is kept back
 * for a retry, so place searches only ever use the slack and never crowd out
 * a category or push the job past TASTE_SEED_MAX_QLOO_REQUESTS.
 */
export function seedPlaceSearchBudget(budgetLeft: number, pendingCategories: number): number {
  return Math.max(0, Math.min(EAT_PLACE_SEARCHES, budgetLeft - pendingCategories - SEED_RETRY_RESERVE));
}
/** Cuisine-tag insights measured ~12 s uncached on the hackathon key (Oct 2026). */
export const SEED_EAT_TIMEOUT_MS = 25_000;
/** Retry delay when Qloo's circuit is open and the adapter cannot say for how long (its default cooldown). */
const CIRCUIT_RETRY_MS = 30_000;

interface CategoryPlan {
  filterType: QlooInsightsRequest['filterType'];
  filterTagTypes?: string[];
  filterTags?: string[];
  kind: ItemKind;
  timeoutMs?: number;
}

export const SEED_CATEGORY_PLAN: Record<Category, CategoryPlan> = {
  wear: { filterType: 'urn:entity:brand', filterTags: [FASHION_BRAND_TAG], kind: 'brand' },
  play: { filterType: 'urn:entity:artist', kind: 'artist' },
  watch: { filterType: 'urn:entity:movie', kind: 'film' },
  eat: { filterType: 'urn:tag', filterTagTypes: ['urn:tag:cuisine:qloo'], kind: 'food', timeoutMs: SEED_EAT_TIMEOUT_MS },
};

/** Slowest first, so the total time is shortest while the fast ones still land first. */
const START_ORDER: Category[] = ['eat', 'wear', 'play', 'watch'];

export interface SeedSignal {
  id: string;
  name: string;
  /** A cuisine tag, a food item or an Eat pick: the only signals Eat is asked with. */
  food: boolean;
  /** The onboarding pick the user saw ("Late-night cinema"), when this signal came from one. */
  pickLabel?: string | null;
  /** That pick's category; signals are asked in their own category first. */
  pickCategory?: Category | null;
}

/** Cuisine tags under this floor were obscure one-offs in live Eat responses (e.g. "Shanghainese Dim Sum" at 0.23). */
export const SEED_EAT_MIN_POPULARITY = 0.3;

/** A save is a food signal when its tag is a cuisine, its item is food, or it was picked under Eat. */
export function isFoodSignal(input: { id: string; kind: string | null; category: string | null }): boolean {
  return input.id.startsWith('urn:tag:cuisine:') || input.kind === 'food' || input.category === 'eat';
}

/**
 * S-EAT-SIGNAL: Eat is asked with food signals only. Watch, Play and Wear are
 * asked with the picks made in that category ("Late-night cinema" -> Art House,
 * Film-noir for Watch); with none there, with every NON-food signal. A food
 * pick never steers a film, artist or brand, so it never appears in their reason.
 */
export function signalsFor(category: Category, signals: SeedSignals): SeedSignals {
  if (category === 'eat') return { tags: signals.tags.filter((s) => s.food), entities: signals.entities.filter((s) => s.food) };
  const own = (list: SeedSignal[]) => list.filter((s) => s.pickCategory === category);
  if (own(signals.tags).length + own(signals.entities).length > 0) return { tags: own(signals.tags), entities: own(signals.entities) };
  const nonFood = { tags: signals.tags.filter((s) => !s.food), entities: signals.entities.filter((s) => !s.food) };
  return nonFood.tags.length + nonFood.entities.length > 0 ? nonFood : signals;
}

/** The words the user saw: a pick's label, else the signal's own name. */
function shownName(signal: SeedSignal): string {
  return signal.pickLabel?.trim() || signal.name;
}

/**
 * "Because you picked Late-night cinema." only for the user's own picks; a
 * signal taken from cards already in the feed (interest expand) is
 * "Related to Tous in your feed." — never a pick the user did not make.
 */
export function reasonFor(contributors: readonly SeedSignal[]): string | null {
  if (!contributors.length) return null;
  const picks = [...new Set(contributors.filter((s) => s.pickLabel).map(shownName))];
  if (picks.length) return `Because you picked ${namesList(picks)}.`;
  return `Related to ${namesList([...new Set(contributors.map(shownName))])} in your feed.`;
}

/** Place search queries from food signals. "Sichuan" → "Sichuan restaurant". */
export function eatPlaceSearchQueries(signals: SeedSignals, max = EAT_PLACE_SEARCHES): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const signal of [...signals.tags, ...signals.entities]) {
    const name = signal.name.trim();
    if (!name) continue;
    const query = /restaurant/i.test(name) ? name : `${name} restaurant`;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= max) break;
  }
  return queries;
}

/** Words that make a dish name a re-spelling, not a new dish ("Dim Sum-Style Dishes" for "Dim Sum"). */
const RESPELL_FILLER: ReadonlySet<string> = new Set(['dish', 'fare', 'themed', 'traditional']);

function stemmedTokens(name: string): Set<string> {
  return new Set(
    nameTokens(name)
      .filter((t) => !CANONICAL_STOP.has(t))
      .map(stemToken)
      .filter((t) => !RESPELL_FILLER.has(t)),
  );
}

function stemmedJoin(name: string): string {
  return [...stemmedTokens(name)].join('');
}

/**
 * S-EAT-POST on returned cuisine tags, in Qloo's order:
 *  - popularity >= SEED_EAT_MIN_POPULARITY (an unknown popularity fails);
 *  - not a re-spelling of a food pick (same stemmed tokens, or the same
 *    letters without spaces: "Dim Sums", "Dimsum", "Dim Sum Style");
 *  - no content token shared with a NON-food pick ("Jazz Age Fare" for Jazz,
 *    "Bossa Nova" for Bossa Nova);
 *  - one card per stemmed name ("Sichuan Noodle" / "Sichuan Noodles").
 */
export function filterEatTags<T extends Pick<QlooTag, 'name' | 'popularity'>>(tags: readonly T[], signals: SeedSignals): T[] {
  const all = [...signals.tags, ...signals.entities];
  const foodPicks = all.filter((s) => s.food).map((s) => ({ tokens: stemmedTokens(s.name), joined: stemmedJoin(s.name) }));
  const nonFoodTokens = new Set(all.filter((s) => !s.food).flatMap((s) => [...canonicalTokens(s.name)]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of tags) {
    if (typeof t.popularity !== 'number' || t.popularity < SEED_EAT_MIN_POPULARITY) continue;
    const tokens = stemmedTokens(t.name);
    const joined = stemmedJoin(t.name);
    if (!joined) continue;
    if (foodPicks.some((p) => p.joined === joined || (p.tokens.size === tokens.size && [...tokens].every((x) => p.tokens.has(x))))) continue;
    if ([...canonicalTokens(t.name)].some((x) => nonFoodTokens.has(x))) continue;
    const key = [...tokens].sort().join(' ');
    if (seen.has(key) || seen.has(joined)) continue;
    seen.add(key);
    seen.add(joined);
    out.push(t);
  }
  return out;
}

export interface SeedSignals {
  tags: SeedSignal[];
  entities: SeedSignal[];
}

/** JSON-serializable stage output for one category (reused by a retry attempt). */
export interface SeedCard {
  key: string;
  kind: ItemKind;
  category: Category;
  title: string;
  year: number | null;
  qloo_id: string;
  subtitle: string | null;
  destination_url: string | null;
  origin: 'qloo' | 'replay';
  provider_query_id: string;
  reason: string;
}

export interface CategoryOutput {
  state: 'ready' | 'empty';
  cards: SeedCard[];
  queries: RecordedQuery[];
}

/** Real Qloo ids from the account's current explicit saves, most recent first. */
export async function loadSeedSignals(db: Queryable, accountId: string): Promise<SeedSignals> {
  // Entities carry `qloo`; tags (onboarding catalog picks, compiler style refs) carry `qloo_tag`.
  // Explicit saves are taste signals; a seed recommendation that was only
  // filed automatically is not an endorsement.
  const { rows } = await db.query<{
    title: string; kind: string | null; category: string | null; qloo_id: string;
    pick_label: string | null; pick_category: Category | null;
  }>(
    `SELECT di.title, di.kind, di.category,
            CASE WHEN jsonb_typeof(di.external_ids->'qloo') = 'string' THEN di.external_ids->>'qloo'
                 ELSE di.external_ids->>'qloo_tag' END AS qloo_id,
            pick.label AS pick_label, pick.category AS pick_category
       FROM saved_items si JOIN discovery_items di ON di.id = si.discovery_item_id
       LEFT JOIN LATERAL (
         SELECT op.label, op.category FROM onboarding_pick_items opi JOIN onboarding_picks op ON op.id = opi.pick_id
          WHERE opi.discovery_item_id = di.id AND opi.account_id = si.owner_account_id
          ORDER BY op.created_at DESC LIMIT 1) pick ON true
      WHERE si.owner_account_id = $1
        AND (jsonb_typeof(di.external_ids->'qloo') = 'string' OR jsonb_typeof(di.external_ids->'qloo_tag') = 'string')
        -- A seed/expand recommendation that was only filed (older Interests auto-board) is not a signal.
        AND (pick.label IS NOT NULL
             OR NOT EXISTS (SELECT 1 FROM recommendations r JOIN taste_seed_runs tr ON tr.id = r.taste_seed_run_id
                             WHERE r.discovery_item_id = di.id AND tr.owner_account_id = si.owner_account_id)
             OR EXISTS (SELECT 1 FROM preference_events pe WHERE pe.owner_account_id = si.owner_account_id
                         AND pe.action = 'save' AND pe.target_type = 'discovery_item' AND pe.target_id = di.id))
      ORDER BY si.saved_at DESC, si.id
      LIMIT 200`,
    [accountId],
  );
  const seen = new Set<string>();
  const out: SeedSignals = { tags: [], entities: [] };
  for (const r of rows) {
    const id = r.qloo_id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const list = id.startsWith('urn:tag:') ? out.tags : out.entities;
    if (list.length < SEED_SIGNALS_MAX)
      list.push({
        id,
        name: r.title,
        food: isFoodSignal({ id, kind: r.kind, category: r.pick_category ?? r.category }),
        // An explicit save is the user's pick too ("Because you picked <title>").
        pickLabel: r.pick_label ?? r.title,
        pickCategory: r.pick_category ?? (r.category as Category | null),
      });
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight; waits for all, then rethrows the first error. */
export async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        errors.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (errors.length) throw errors[0];
}

function namesList(names: readonly string[]): string {
  const n = names.filter(Boolean).slice(0, 2);
  return n.length === 2 ? `${n[0]} and ${n[1]}` : (n[0] ?? 'your picks');
}

const GENERIC_VENUE_WORDS = new Set([
  'restaurant', 'restaurante', 'ristorante', 'restaurants', 'style', 'food', 'cuisine', 'kitchen', 'house', 'shop',
  'the', 'a', 'and', 'de', 'del', 'la', 'le', 'el', 'cafe', 'bar', 'noodle', 'noodles', 'place', 'eatery', 'diner',
]);

/**
 * "Ramen restaurant" or "Restaurante de Sichuan" names a cuisine, not a
 * place worth a card: nothing is left once the searched cuisine and generic
 * venue words are removed.
 */
export function isGenericVenueName(title: string, query: string): boolean {
  const words = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  const cuisine = new Set(words(query));
  return words(title).every((w) => cuisine.has(w) || GENERIC_VENUE_WORDS.has(w));
}

async function eatPlaceCards(
  session: QlooSession,
  signals: SeedSignals,
  signalNames: Map<string, SeedSignal>,
  generic: string,
  foodExclusions: readonly string[],
  maxSearches: number,
): Promise<SeedCard[]> {
  const cards: SeedCard[] = [];
  const seen = new Set<string>();
  const seenTitles = new Set<string>();
  if (maxSearches <= 0) return cards;
  for (const placeQuery of eatPlaceSearchQueries(signals, maxSearches)) {
    try {
      // Search is faster than place insights (which timed out at 25s on this key).
      const { response, queryId } = await session.search(placeQuery, ['urn:entity:place'], {
        purpose: 'taste_seed',
        category: 'eat',
      });
      const origin = response.is_replay ? ('replay' as const) : ('qloo' as const);
      // Transient renderability probe only (VAL-EVID-005): a venue needs a
      // real Qloo photo behind its URL to earn a card, but the provider's
      // image URL and prose are transient-only — neither persists nor displays,
      // so the card below carries neither.
      const probed = await Promise.all(
        response.data.map(async (e) => ({
          e,
          pictured: await qlooImageUrlIfRenderable(qlooImageUrl(e.properties)),
        })),
      );
      for (const { e, pictured } of probed) {
        if (!pictured) continue;
        if (violatedExclusions({ title: e.name, cuisine: e.name }, foodExclusions).length) continue;
        // One card per name, and never a venue whose name is just the cuisine.
        const titleKey = e.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (seenTitles.has(titleKey) || isGenericVenueName(e.name, placeQuery)) continue;
        seenTitles.add(titleKey);
        const key = canonicalKeyFor({ kind: 'food', title: e.name, qlooId: e.entity_id });
        if (seen.has(key)) continue;
        seen.add(key);
        const contributors = (e.query?.explainability ?? [])
          .filter((x) => signalNames.has(x.entity_id))
          .sort((a, b) => b.score - a.score)
          .map((x) => signalNames.get(x.entity_id)!);
        cards.push({
          key,
          kind: 'food',
          category: 'eat',
          title: e.name,
          year: null,
          qloo_id: e.entity_id,
          subtitle: e.disambiguation ?? 'Place',
          destination_url: destinationFromQlooProperties(e.properties),
          origin,
          provider_query_id: queryId,
          reason: reasonFor(contributors) ?? generic,
        });
      }
    } catch (err) {
      // Qloo throttled or down: fail the category like any other request would (the job retries),
      // instead of spending another request on cuisine tags during an outage.
      if (isProviderError(err) && (err.kind === 'rate_limited' || err.kind === 'server' || err.kind === 'unavailable')) throw err;
      // Out of budget, or this search failed on its own (bad request, timeout): fall back to cuisine tags.
      if (err instanceof BudgetExhaustedError || isProviderError(err)) break;
      throw err;
    }
  }
  return cards;
}

export async function fetchCategory(
  session: QlooSession,
  category: Category,
  input: {
    signals: SeedSignals;
    excludedKeys: ReadonlySet<string>;
    foodExclusions: readonly string[];
    take?: number;
    /** Qloo insights page (1-based). Expand uses later pages once the first is already in the pool. */
    page?: number;
    /** Eat place searches allowed before the cuisine-tag request (the caller's budget); default EAT_PLACE_SEARCHES. */
    placeSearches?: number;
  },
): Promise<CategoryOutput> {
  const plan = SEED_CATEGORY_PLAN[category];
  const signals = signalsFor(category, input.signals);
  // S-EAT-EMPTY: no food picks, no Eat request; the labeled examples fill Eat.
  if (signals.tags.length + signals.entities.length === 0) return { state: 'empty', cards: [], queries: [] };
  const signalIds = new Set([...input.signals.tags, ...input.signals.entities].map((s) => s.id));
  // Reasons name only the signals actually sent for THIS category, in the words the user saw.
  const signalNames = new Map([...signals.tags, ...signals.entities].map((s) => [s.id, s]));
  const ownQueries = () => session.recorded.filter((q) => q.query_context['category'] === category);
  const generic = reasonFor([...signals.tags, ...signals.entities]) ?? 'From your interests.';
  const seen = new Set<string>();
  const cards: SeedCard[] = [];
  const consider = (card: SeedCard) => {
    if (cards.length >= SEED_CARDS_PER_CATEGORY) return;
    if (signalIds.has(card.qloo_id) || seen.has(card.key) || input.excludedKeys.has(card.key)) return;
    seen.add(card.key);
    cards.push(card);
  };

  // Pictured venues first so expand waves spend Qloo budget on new photos, not cuisine tags.
  if (category === 'eat') {
    for (const card of await eatPlaceCards(session, signals, signalNames, generic, input.foodExclusions, input.placeSearches ?? EAT_PLACE_SEARCHES)) {
      consider(card);
    }
    if (cards.length > 0) return { state: 'ready', cards, queries: ownQueries() };
  }

  const { response, queryId } = await session.insights(
    {
      filterType: plan.filterType,
      ...(signals.tags.length ? { signalTags: signals.tags.map((t) => ({ id: t.id })) } : {}),
      ...(signals.entities.length ? { signalEntities: signals.entities.map((e) => e.id) } : {}),
      ...(plan.filterTagTypes ? { filterTagTypes: plan.filterTagTypes } : {}),
      ...(plan.filterTags ? { filterTags: plan.filterTags } : {}),
      ...(plan.filterType.startsWith('urn:entity:') ? { explainability: true } : {}),
      take: input.take ?? SEED_RESULTS_TAKE,
      ...(input.page && input.page > 1 ? { page: input.page } : {}),
    },
    { purpose: 'taste_seed', category },
    plan.timeoutMs ? { timeoutMs: plan.timeoutMs } : {},
  );
  const origin = response.is_replay ? ('replay' as const) : ('qloo' as const);

  if (plan.filterType === 'urn:tag') {
    const cuisine: QlooTag[] = response.data.tags.filter((t) => /(^|:)cuisine(:|$)/.test(t.type ?? '') || t.id.startsWith('urn:tag:cuisine:'));
    const tags = filterEatTags(cuisine, input.signals);
    for (const t of tags) {
      if (violatedExclusions({ title: t.name, cuisine: t.name }, input.foodExclusions).length) continue;
      consider({
        key: canonicalKeyFor({ kind: plan.kind, title: t.name, qlooId: t.id }),
        kind: plan.kind,
        category,
        title: t.name,
        year: null,
        qloo_id: t.id,
        subtitle: 'Cuisine',
        destination_url: null,
        origin,
        provider_query_id: queryId,
        reason: generic,
      });
    }
  } else {
    const entities: QlooEntity[] = response.data.entities;
    for (const e of entities) {
      const contributors = (e.query?.explainability ?? [])
        .filter((x) => signalNames.has(x.entity_id))
        .sort((a, b) => b.score - a.score)
        .map((x) => signalNames.get(x.entity_id)!);
      const year = plan.kind === 'film' ? yearOf(e) : null;
      // Qloo prose and Qloo image URLs are transient-only (VAL-EVID-005):
      // neither is extracted, persisted or displayed from these cards.
      consider({
        key: canonicalKeyFor({ kind: plan.kind, title: e.name, qlooId: e.entity_id }),
        kind: plan.kind,
        category,
        title: e.name,
        year,
        qloo_id: e.entity_id,
        subtitle: year ? String(year) : null,
        destination_url: destinationFromQlooProperties(e.properties),
        origin,
        provider_query_id: queryId,
        reason: reasonFor(contributors) ?? generic,
      });
    }
  }
  return { state: cards.length ? 'ready' : 'empty', cards, queries: ownQueries() };
}

async function publishCategory(ctx: JobContext<'taste_seed'>, runId: string, owner: Owner, category: Category, out: CategoryOutput): Promise<void> {
  await ctx.ensureActive();
  await ctx.db.transaction(async (tx) => {
    const run = await tx.query('SELECT id FROM taste_seed_runs WHERE id = $1 FOR UPDATE', [runId]);
    if (!run.rowCount) throw new JobCancelledError('account deleted');
    const parent: RecommendationParent = { kind: 'taste_seed', runId };
    await insertProviderQueries(tx, parent, out.queries, ctx.job.trace_id);
    await tx.query('DELETE FROM recommendations WHERE taste_seed_run_id = $1 AND category = $2', [runId, category]);
    const recs: RecommendationInsert[] = [];
    for (const [i, c] of out.cards.entries()) {
      const itemId = await upsertDiscoveryItem(tx, owner, {
        kind: c.kind,
        category: c.category,
        canonical_key: c.key,
        title: c.title,
        display_metadata: {
          subtitle: c.subtitle,
          year: c.year,
          destination_url: c.destination_url,
          example: c.origin === 'replay',
        },
        external_ids: { qloo: c.qloo_id },
      });
      recs.push({
        discovery_item_id: itemId,
        category: c.category,
        rank: i + 1,
        title: c.title,
        external_ids: { qloo: c.qloo_id },
        display_reason: c.reason,
        origin: c.origin,
        provider_query_ids: [c.provider_query_id],
        destination_url: c.destination_url,
      });
    }
    await insertRecommendations(tx, parent, recs);
    await tx.query(
      `UPDATE taste_seed_categories
          SET state = $3, card_count = $4, ready_at = CASE WHEN $3 = 'ready' THEN now() ELSE NULL END, updated_at = now()
        WHERE run_id = $1 AND category = $2`,
      [runId, category, out.state, out.cards.length],
    );
    if (out.state === 'ready') {
      await tx.query('UPDATE taste_seed_runs SET first_ready_at = COALESCE(first_ready_at, now()), updated_at = now() WHERE id = $1', [runId]);
    }
    await rebuildFeedSnapshots(tx, owner);
  });
}

async function categoryStates(db: Queryable, runId: string): Promise<Map<Category, SeedCategoryState>> {
  const { rows } = await db.query<{ category: Category; state: SeedCategoryState }>(
    'SELECT category, state FROM taste_seed_categories WHERE run_id = $1',
    [runId],
  );
  return new Map(rows.map((r) => [r.category, r.state]));
}

/** Requests the job may still make (ONB-04 cap minus what every attempt so far reserved). */
async function seedRequestsLeft(db: Queryable, runId: string): Promise<number> {
  const { rows } = await db.query<{ used: number }>('SELECT qloo_requests_used AS used FROM taste_seed_runs WHERE id = $1', [runId]);
  return Math.max(0, TASTE_SEED_MAX_QLOO_REQUESTS - (rows[0]?.used ?? TASTE_SEED_MAX_QLOO_REQUESTS));
}

/** Atomically reserves one of the job's Qloo requests; false once the per-job cap is reached. */
async function reserveSeedRequest(db: Queryable, runId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'UPDATE taste_seed_runs SET qloo_requests_used = qloo_requests_used + 1 WHERE id = $1 AND qloo_requests_used < $2',
    [runId, TASTE_SEED_MAX_QLOO_REQUESTS],
  );
  return (rowCount ?? 0) > 0;
}

/** Qloo as a whole is throttling or failing (not one slow category). */
function isOutage(err: unknown): boolean {
  return isProviderError(err) && (err.kind === 'rate_limited' || err.kind === 'server' || err.kind === 'unavailable');
}

async function markUnavailable(db: Queryable, runId: string, categories: readonly Category[]): Promise<void> {
  if (!categories.length) return;
  await db.query(
    `UPDATE taste_seed_categories SET state = 'unavailable', updated_at = now()
      WHERE run_id = $1 AND category = ANY($2::text[]) AND state IN ('pending', 'unavailable')`,
    [runId, [...categories]],
  );
}

async function setRunState(db: Queryable, runId: string, state: 'running' | 'retrying' | 'partial' | 'complete' | 'failed', extra: { signalCount?: number } = {}): Promise<void> {
  const terminal = state === 'partial' || state === 'complete' || state === 'failed';
  await db.query(
    `UPDATE taste_seed_runs SET state = $2, signal_count = COALESCE($3, signal_count), updated_at = now(),
            finished_at = CASE WHEN $4 THEN now() ELSE NULL END
      WHERE id = $1`,
    [runId, state, extra.signalCount ?? null, terminal],
  );
}

type Failure = { error: unknown; retryable: boolean };

function failureOf(err: unknown): Failure {
  if (err instanceof BudgetExhaustedError) return { error: err, retryable: true };
  // An open circuit is transient too: it carries the time until the next trial request.
  if (isProviderError(err)) return { error: err, retryable: err.retryable || (err.kind === 'unavailable' && (err.retryAfterMs ?? 0) > 0) };
  return { error: err, retryable: false };
}

/** The error the worker sees: a provider error keeps Retry-After; budget exhaustion becomes a retryable 503. */
function retryError(failures: readonly Failure[]): unknown {
  const retryable = failures.filter((f) => f.retryable);
  const withDelay = retryable.find((f) => isProviderError(f.error) && (f.error.retryAfterMs ?? 0) > 0);
  const provider = withDelay ?? retryable.find((f) => isProviderError(f.error));
  if (provider) return provider.error;
  return new AppError('provider_unavailable', { message: 'Part of this is taking longer than usual. Try again in a little while.', retryable: true });
}

/**
 * The Interests board holds what the user picked (already explicit saves),
 * never the seed's recommendations: filing those would mark every feed card
 * saved and feed Qloo's own output back in as if the user endorsed it.
 */
async function fileInterestsBoard(db: Queryable, accountId: string, _runId: string): Promise<void> {
  const { rows } = await db.query<{ discovery_item_id: string }>(
    `SELECT DISTINCT opi.discovery_item_id
       FROM onboarding_pick_items opi
       JOIN saved_items si ON si.discovery_item_id = opi.discovery_item_id AND si.owner_account_id = opi.account_id
       JOIN discovery_items di ON di.id = opi.discovery_item_id
      WHERE opi.account_id = $1 AND di.is_sample IS NOT TRUE`,
    [accountId],
  );
  await fillInterestsBoard(
    db,
    accountId,
    rows.map((r) => r.discovery_item_id),
  );
}

export const tasteSeed: JobHandler<'taste_seed'> = async (ctx) => {
  const accountId = ctx.job.owner_account_id;
  if (!accountId) throw new AppError('invalid_input', { message: 'Building a feed needs an account.', retryable: false });
  await requireServiceFeature({ db: ctx.db, config: ctx.config }, accountId, 'taste_seed_enabled');
  const owner: Owner = { kind: 'account', accountId };
  const runId = await ensureSeedRun(ctx.db, {
    accountId,
    jobId: ctx.job.id,
    tasteRevision: ctx.payload.taste_revision,
    catalogVersion: ctx.payload.catalog_version,
    categories: ctx.payload.categories,
  });
  const result = { resultType: 'taste_seed', resultId: runId };

  await ctx.setStage('reading_picks');
  const before = await categoryStates(ctx.db, runId);
  const todo = START_ORDER.filter((c) => ctx.payload.categories.includes(c) && before.get(c) !== 'ready' && before.get(c) !== 'empty');
  const signals = await loadSeedSignals(ctx.db, accountId);
  await setRunState(ctx.db, runId, 'running', { signalCount: signals.tags.length + signals.entities.length });

  if (todo.length > 0 && signals.tags.length + signals.entities.length === 0) {
    // Nothing real to ask Qloo about: every category stays empty (examples fill the feed).
    for (const c of todo) await publishCategory(ctx, runId, owner, c, { state: 'empty', cards: [], queries: [] });
    await setRunState(ctx.db, runId, 'complete');
    return { state: 'complete', ...result };
  }

  const failures: Failure[] = [];
  // ONB-04: at most TASTE_SEED_MAX_QLOO_REQUESTS for the whole job, across every attempt.
  let jobBudgetLeft = await seedRequestsLeft(ctx.db, runId);
  if (todo.length > 0 && jobBudgetLeft <= 0) {
    failures.push({ error: new BudgetExhaustedError(), retryable: false });
    await markUnavailable(ctx.db, runId, todo);
  } else if (todo.length > 0) {
    const session = new QlooSession(ctx.providers.qloo, {
      maxRequests: Math.min(ctx.budget.qlooRequests, TASTE_SEED_MAX_QLOO_REQUESTS, jobBudgetLeft),
      maxRetries: Math.min(ctx.budget.providerRetries, TASTE_SEED_INLINE_RETRIES),
      signal: ctx.signal,
      newId: randomUUID,
      clientMaxRetries: 0,
      reserveRequest: () => reserveSeedRequest(ctx.db, runId),
    });
    if (!session.insightsUsable()) {
      const reason = session.capability().reason;
      const breaker = (ctx.providers.qloo as { breaker?: { remainingMs?: () => number } }).breaker;
      failures.push({
        // Circuit open: retry once the cooldown has passed instead of spending the remaining attempts now.
        error: reason === 'circuit_open'
          ? new ProviderError('qloo', 'unavailable', 'qloo circuit is open', { retryAfterMs: Math.max(breaker?.remainingMs?.() ?? CIRCUIT_RETRY_MS, 1000) })
          : new AppError('provider_unavailable', { message: 'Part of this is taking longer than usual. Try again in a little while.', retryable: false }),
        retryable: reason !== 'not_configured' && reason !== 'access_denied' && reason !== 'not_implemented',
      });
      await markUnavailable(ctx.db, runId, todo);
    } else {
      const [hidden, saved, prefs] = await Promise.all([
        hiddenKeys(ctx.db, owner),
        ctx.db.query<{ canonical_key: string }>(
          `SELECT di.canonical_key FROM saved_items si JOIN discovery_items di ON di.id = si.discovery_item_id WHERE si.owner_account_id = $1`,
          [accountId],
        ),
        ctx.db.query<{ preferences: unknown }>('SELECT preferences FROM accounts WHERE id = $1', [accountId]),
      ]);
      const excludedKeys = new Set([...hidden, ...saved.rows.map((r) => r.canonical_key)]);
      const foodExclusions = readFoodExclusions(prefs.rows[0]?.preferences);
      // ONB-04: Eat place searches come out of this attempt's slack, never out of another category's request.
      const placeSearches = seedPlaceSearchBudget(jobBudgetLeft, todo.length);

      // Qloo throttled or down: stop asking in this attempt (the job retries later),
      // so an outage costs as few of the job's requests as possible.
      let outage = false;
      const runCategory = async (category: Category) => {
        if (outage) {
          failures.push({ error: new AppError('provider_unavailable', { retryable: true }), retryable: true });
          await markUnavailable(ctx.db, runId, [category]);
          return;
        }
        let out: CategoryOutput;
        try {
          out = await ctx.runStage(`category:${category}`, () => fetchCategory(session, category, { signals, excludedKeys, foodExclusions, placeSearches }));
        } catch (err) {
          if (!(err instanceof BudgetExhaustedError) && !isProviderError(err)) throw err;
          if (isOutage(err)) outage = true;
          failures.push(failureOf(err));
          await markUnavailable(ctx.db, runId, [category]);
          return;
        }
        await publishCategory(ctx, runId, owner, category, out);
      };

      await ctx.setStage('recommending');
      try {
        let rest = todo;
        if (ctx.attempt > 1 && todo.length > 1) {
          // A retry first probes Qloo with one request (a fast category) before fanning out.
          const probe = todo.find((c) => c !== 'eat') ?? todo[0]!;
          await runCategory(probe);
          rest = todo.filter((c) => c !== probe);
        }
        await forEachLimited(rest, TASTE_SEED_MAX_CONCURRENCY, runCategory);
      } finally {
        // Failed attempts are evidence too (inspector); successful ones were stored on publish.
        const failed = session.recorded.filter((q) => q.status === 'error');
        if (failed.length && !ctx.signal.aborted) {
          const exists = await ctx.db.query('SELECT 1 FROM taste_seed_runs WHERE id = $1', [runId]);
          if (exists.rowCount) await insertProviderQueries(ctx.db, { kind: 'taste_seed', runId }, failed, ctx.job.trace_id);
        }
      }
    }
    jobBudgetLeft = await seedRequestsLeft(ctx.db, runId);
  }

  if (failures.length === 0) {
    await setRunState(ctx.db, runId, 'complete');
    await fileInterestsBoard(ctx.db, accountId, runId);
    return { state: 'complete', ...result };
  }
  // A retry needs requests left in the job's budget; otherwise the job ends with what it has.
  if (failures.some((f) => f.retryable) && ctx.attempt < ctx.job.max_attempts && jobBudgetLeft > 0) {
    await setRunState(ctx.db, runId, 'retrying');
    throw retryError(failures);
  }
  const after = await categoryStates(ctx.db, runId);
  const anyReady = [...after.values()].includes('ready');
  await setRunState(ctx.db, runId, anyReady ? 'partial' : 'failed');
  if (anyReady) {
    await fileInterestsBoard(ctx.db, accountId, runId);
    return { state: 'partial', ...result };
  }
  throw new AppError('provider_unavailable', { message: 'Part of this is taking longer than usual. Try again in a little while.', retryable: false });
};
