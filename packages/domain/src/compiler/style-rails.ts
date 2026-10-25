import type { QlooEntity, QlooInsightsRequest, QlooEntityType } from '@culture-atlas/providers';
import { FASHION_BRAND_TAG } from './grounding';
import { RRF_K } from './fusion';
import type { AcceptedTag } from '../style/map-tags';
import { mediaKind, tagNamespace } from '../style/map-tags';
import type { Exemplar } from '../style/exemplars';
import { HOME_INDUSTRY } from '../style/home-affinity';
import type { HomeKind } from '../style/home-affinity';
import type { StoredSubject } from '../style/types';

/**
 * "More like this": same-domain style rails (style design §C.3, amended
 * R-1, R-4, R-9, R-10, R-20). Pure planning and result hygiene; the
 * compiler's style stage makes the calls (compiler/style-stage.ts).
 */

export const MORE_LIKE_THIS_TAKE = 20;
/** Tag-only insights calls (fashion or media with no identified entity) get a longer per-request timeout. */
export const TAG_ONLY_TIMEOUT_MS = 12_000;
/** A secondary call runs only when the primary leaves fewer than this many results after hygiene. */
export const SECONDARY_BELOW = 6;
export const SECONDARY_WEIGHT = 0.6;
export const PRICE_LEVEL_CAP = 3;

export type RailRecipe =
  | 'fashion_entity'
  | 'fashion_exemplar'
  | 'fashion_tag_only'
  | 'interior_city'
  | 'interior_entity'
  | 'interior_brand'
  | 'food_city'
  | 'coffee_brand'
  | 'place_city'
  | 'place_entity'
  | 'media_entity'
  | 'media_tag'
  | 'music_tag';

export type RailEmptyReason = 'no_city' | 'no_signal' | 'unsupported' | 'interior_brands_off';

export interface RailPlan {
  recipe: RailRecipe | null;
  primary: QlooInsightsRequest | null;
  /** Run only when the primary leaves < SECONDARY_BELOW results. */
  secondary: QlooInsightsRequest | null;
  /** Tag-only calls: per-request timeout and the flat detector apply; their top results never become bridges. */
  tagOnly: boolean;
  /** Results may seed cross-domain recommend() as bridge entities (C.5). */
  bridgeable: boolean;
  emptyReason: RailEmptyReason | null;
  /** The entity signal (E) used, for the entity-only reason fallback. */
  entity: { id: string; name: string } | null;
}

export interface PlanInput {
  subject: StoredSubject;
  /** E: an identified Qloo entity overlapping the subject (anchor), if any. */
  entity: { id: string; name: string; types: readonly string[] } | null;
  /** F: the subject's best filter tag id (C.2 rule 7). */
  filterTag: string | null;
  accepted: readonly AcceptedTag[];
  exemplars: readonly Exemplar[];
  /** The user's own city (C.6), never inferred. */
  city: string | null;
  /** R-9 / open item O-1: interior brand exemplars stay off until non-fashion brand tags are harvested. */
  interiorBrandsEnabled?: boolean;
  /** The home kind the reading's words name (chair, bowl, room, espresso; null when none): the brand-rail industry. */
  homeKind?: HomeKind | null;
}

const empty = (emptyReason: RailEmptyReason, recipe: RailRecipe | null = null): RailPlan => ({
  recipe,
  primary: null,
  secondary: null,
  tagOnly: false,
  bridgeable: false,
  emptyReason,
  entity: null,
});

function firstTag(accepted: readonly AcceptedTag[], namespaces: readonly string[], uses: readonly AcceptedTag['use'][] = ['filter', 'signal']): string | null {
  for (const ns of namespaces) {
    const t = accepted.find((a) => a.primary && uses.includes(a.use) && tagNamespace(a.id) === ns);
    if (t) return t.id;
  }
  return null;
}

/** Signal tags with their weights (only filter/signal-use primary tags; never reason-only or alternates). */
function signalTags(accepted: readonly AcceptedTag[], namespaces?: readonly string[]): { id: string; weight: number }[] {
  const seen = new Set<string>();
  const out: { id: string; weight: number }[] = [];
  for (const a of accepted) {
    if (!a.primary || a.use === 'reason' || seen.has(a.id)) continue;
    if (namespaces && !namespaces.includes(tagNamespace(a.id) ?? '')) continue;
    seen.add(a.id);
    out.push({ id: a.id, weight: a.slot === 'aesthetics' ? (a.wording === 'asserted' ? 1 : 0.5) : a.slot === 'materials' ? 0.5 : 0.3 });
  }
  return out.slice(0, 4);
}

const base = (filterType: QlooInsightsRequest['filterType']): QlooInsightsRequest => ({ filterType, explainability: true, take: MORE_LIKE_THIS_TAKE });

/** C.3 recipe per subject category (with R-1 exemplars, R-4 entity-first, R-9 interior). */
export function planMoreLikeThis(input: PlanInput): RailPlan {
  const { subject, entity, filterTag: F, accepted, city } = input;
  const e = entity ? { id: entity.id, name: entity.name } : null;
  switch (subject.category) {
    case 'fashion': {
      const personal = firstTag(accepted, ['personal_style']);
      if (entity && entity.types.includes('urn:entity:brand')) {
        const primary: QlooInsightsRequest = {
          ...base('urn:entity:brand'),
          filterTags: [F ?? FASHION_BRAND_TAG],
          signalEntities: [entity.id],
          ...(personal ? { signalTags: [{ id: personal, weight: 0.5 }] } : {}),
        };
        const secondary: QlooInsightsRequest | null = F ? { ...primary, filterTags: [FASHION_BRAND_TAG] } : null;
        return { recipe: 'fashion_entity', primary, secondary, tagOnly: false, bridgeable: true, emptyReason: null, entity: e };
      }
      const exemplars = input.exemplars.map((x) => x.id);
      if (exemplars.length >= 2) {
        const primary: QlooInsightsRequest = { ...base('urn:entity:brand'), filterTags: [F ?? FASHION_BRAND_TAG], signalEntities: exemplars };
        const secondary: QlooInsightsRequest | null = F ? { ...primary, filterTags: [FASHION_BRAND_TAG] } : null;
        return { recipe: 'fashion_exemplar', primary, secondary, tagOnly: false, bridgeable: true, emptyReason: null, entity: null };
      }
      const tags = signalTags(accepted, ['fashion_segment', 'personal_style', 'aesthetic_property', 'material', 'design_inspiration']);
      if (!tags.length) return empty('no_signal');
      return {
        recipe: 'fashion_tag_only',
        primary: { ...base('urn:entity:brand'), filterTags: [F ?? FASHION_BRAND_TAG], signalTags: tags, filterPopularityMin: 0.7 },
        secondary: null,
        tagOnly: true,
        bridgeable: false,
        emptyReason: null,
        entity: null,
      };
    }
    case 'interior': {
      const decor = firstTag(accepted, ['decor']);
      // R-9: an object (a chair, a bowl, a lamp) is a brand question, not a place question: it
      // gets the home-brand rail even with a city. A room keeps the place path when a city and
      // a decor tag exist; without them the room's style still reaches home brands.
      const kind = input.homeKind ?? null;
      const objectLike = kind !== null && kind !== 'interior';
      if (!objectLike && city && decor)
        return { recipe: 'interior_city', primary: { ...base('urn:entity:place'), filterTags: [decor], filterLocationQuery: city }, secondary: null, tagOnly: false, bridgeable: true, emptyReason: null, entity: null };
      if (entity && (entity.types.includes('urn:entity:place') || entity.types.includes('urn:entity:brand'))) {
        const type: QlooEntityType = entity.types.includes('urn:entity:place') ? 'urn:entity:place' : 'urn:entity:brand';
        if (type === 'urn:entity:place' && !city) return empty('no_city');
        return {
          recipe: 'interior_entity',
          primary: { ...base(type), signalEntities: [entity.id], ...(type === 'urn:entity:place' ? { filterLocationQuery: city! } : {}) },
          secondary: null,
          tagOnly: false,
          bridgeable: true,
          emptyReason: null,
          entity: e,
        };
      }
      if (input.interiorBrandsEnabled) {
        // The harvested home-brand catalogue (home-brands-1) supplies entity signals the reading
        // itself picked (probe: entity signal + industry filter returns coherent design brands).
        const signals = input.exemplars.map((x) => x.id);
        if (kind && signals.length)
          return {
            recipe: 'interior_brand',
            primary: { ...base('urn:entity:brand'), filterTags: [HOME_INDUSTRY[kind]], signalEntities: signals },
            secondary: null,
            tagOnly: false,
            bridgeable: true,
            emptyReason: null,
            entity: null,
          };
        // Honest empty when no home brand shares the reading's style: an object's only
        // question is brands (no_signal); a room's real question is places, so without
        // a city the honest state is "Add a city" (with a city, the room genuinely
        // found no style-matched brand: no_signal).
        return empty(!city && !objectLike ? 'no_city' : 'no_signal');
      }
      return empty('no_city');
    }
    case 'food': {
      const drink = input.homeKind === 'coffee' ? 'coffee' : null;
      if (!city) {
        // A coffee or tea drink is a brand question even without a place: coffee brands the
        // reading matches (a dish keeps the honest "Add a city": its places need one).
        if (drink && input.interiorBrandsEnabled) {
          const signals = input.exemplars.map((x) => x.id);
          if (signals.length)
            return {
              recipe: 'coffee_brand',
              primary: { ...base('urn:entity:brand'), filterTags: [HOME_INDUSTRY.coffee], signalEntities: signals },
              secondary: null,
              tagOnly: false,
              bridgeable: true,
              emptyReason: null,
              entity: null,
            };
          return empty('no_signal');
        }
        return empty('no_city');
      }
      const genre = accepted.find((a) => a.primary && a.use !== 'reason' && a.id.startsWith('urn:tag:genre:place:restaurant'))?.id ?? null;
      const placeE = entity && entity.types.includes('urn:entity:place') ? entity : null;
      if (!genre && !placeE) return empty('no_signal');
      return {
        recipe: 'food_city',
        // filter.location.query, not signal.location.query: measured 0.4-0.6 s (probe i08/i18) vs 2.2-6.2 s
        // for the signal form (probe i20, first live check), and it keeps results inside the city.
        primary: { ...base('urn:entity:place'), ...(genre ? { filterTags: [genre] } : {}), filterLocationQuery: city, ...(placeE ? { signalEntities: [placeE.id] } : {}) },
        secondary: null,
        tagOnly: false,
        bridgeable: true,
        emptyReason: null,
        entity: placeE ? { id: placeE.id, name: placeE.name } : null,
      };
    }
    case 'place': {
      const tag = firstTag(accepted, ['decor', 'setting']);
      const placeE = entity && (entity.types.includes('urn:entity:place') || entity.types.includes('urn:entity:destination')) ? entity : null;
      if (city && (tag || placeE))
        return {
          recipe: 'place_city',
          primary: { ...base('urn:entity:place'), ...(tag ? { filterTags: [tag] } : {}), filterLocationQuery: city, ...(placeE ? { signalEntities: [placeE.id] } : {}) },
          secondary: null,
          tagOnly: false,
          bridgeable: true,
          emptyReason: null,
          entity: placeE ? { id: placeE.id, name: placeE.name } : null,
        };
      // Destinations only through an entity signal (tag-only destinations are junk, probe i16).
      if (placeE)
        return { recipe: 'place_entity', primary: { ...base('urn:entity:destination'), signalEntities: [placeE.id] }, secondary: null, tagOnly: false, bridgeable: true, emptyReason: null, entity: { id: placeE.id, name: placeE.name } };
      return empty('no_city');
    }
    case 'media': {
      const music = mediaKind(subject) === 'music';
      if (entity) {
        const type: QlooEntityType | null = entity.types.some((t) => t === 'urn:entity:movie' || t === 'urn:entity:tv_show')
          ? 'urn:entity:movie'
          : entity.types.some((t) => t === 'urn:entity:artist' || t === 'urn:entity:album')
            ? 'urn:entity:artist'
            : null;
        if (type) {
          const style = firstTag(accepted, type === 'urn:entity:movie' ? ['style'] : ['genre:music']);
          return {
            recipe: 'media_entity',
            primary: { ...base(type), signalEntities: [entity.id], ...(style ? { signalTags: [{ id: style, weight: 0.5 }] } : {}) },
            secondary: null,
            tagOnly: false,
            bridgeable: true,
            emptyReason: null,
            entity: e,
          };
        }
      }
      if (music) {
        const genre = firstTag(accepted, ['genre:music'], ['filter', 'signal']);
        if (!genre) return empty('no_signal');
        return { recipe: 'music_tag', primary: { ...base('urn:entity:artist'), filterTags: [genre], filterPopularityMin: 0.9 }, secondary: null, tagOnly: true, bridgeable: false, emptyReason: null, entity: null };
      }
      const style = firstTag(accepted, ['style', 'subgenre'], ['filter', 'signal']);
      if (!style) return empty('no_signal');
      return { recipe: 'media_tag', primary: { ...base('urn:entity:movie'), filterTags: [style], filterPopularityMin: 0.9 }, secondary: null, tagOnly: true, bridgeable: false, emptyReason: null, entity: null };
    }
    default:
      return empty('unsupported');
  }
}

/** Overlap score of one result with the subject's accepted tags (list C): sum of slot weights of the shared ids. */
export function overlapScore(accepted: readonly AcceptedTag[], entity: Pick<QlooEntity, 'tags'>): number {
  const tags = new Set(entity.tags.map((t) => t.id));
  const best = new Map<string, number>();
  for (const a of accepted) if (tags.has(a.id)) best.set(`${a.slot}:${a.claimName}`, Math.max(best.get(`${a.slot}:${a.claimName}`) ?? 0, a.weight));
  return [...best.values()].reduce((s, w) => s + w, 0);
}

/**
 * Flat-affinity detector (C.3 hygiene 1, R-10). A list is unmatched when the
 * results carry no explainability, the affinity spread is below 0.005, and
 * fewer than half carry any accepted tag. Returns 'ok', 'flat_kept' (a flat
 * list from a call WITH filter.tags: kept at RRF weight 0, so only the
 * overlap re-rank orders it) or 'flat_discarded'.
 */
export function flatVerdict(request: Pick<QlooInsightsRequest, 'filterTags'>, entities: readonly QlooEntity[], accepted: readonly AcceptedTag[]): 'ok' | 'flat_kept' | 'flat_discarded' {
  if (!entities.length) return 'ok';
  const explained = entities.some((e) => (e.query?.explainability?.length ?? 0) > 0);
  const aff = entities.map((e) => e.query?.affinity).filter((a): a is number => typeof a === 'number');
  const spread = aff.length ? Math.max(...aff) - Math.min(...aff) : 0;
  const carrying = entities.filter((e) => overlapScore(accepted, e) > 0).length;
  const flat = !explained && spread < 0.005 && carrying < entities.length / 2;
  if (!flat) return 'ok';
  return request.filterTags?.length ? 'flat_kept' : 'flat_discarded';
}

const cityFold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * C.3 hygiene 3: a place whose address does not contain the requested
 * city's own name is dropped (the probe's Brooklyn -> Manhattan leak). A
 * result without an address is kept (nothing says it is elsewhere).
 */
export function outsideCity(entity: Pick<QlooEntity, 'properties'>, city: string): boolean {
  const address = entity.properties.address;
  if (typeof address !== 'string' || !address.trim()) return false;
  const token = cityFold(city.split(',')[0] ?? city);
  if (!token) return false;
  return !` ${cityFold(address)} `.includes(` ${token} `);
}

export interface RailCandidate {
  entity: QlooEntity;
  /** Which lists returned it. */
  sources: ('primary' | 'secondary')[];
  overlap: number;
  score: number;
}

/**
 * Weighted reciprocal rank fusion (RRF_K = 60) over list A (primary, weight
 * 1, or 0 when flat-but-filtered), list B (secondary, 0.6) and list C (the
 * style-overlap re-rank of A and B). Ties keep first-seen order.
 */
export function fuseRail(
  primary: readonly QlooEntity[],
  secondary: readonly QlooEntity[],
  accepted: readonly AcceptedTag[],
  weights: { primary: number; secondary: number } = { primary: 1, secondary: SECONDARY_WEIGHT },
): RailCandidate[] {
  const byId = new Map<string, RailCandidate & { first: number }>();
  let order = 0;
  const add = (list: readonly QlooEntity[], source: 'primary' | 'secondary', w: number) => {
    list.forEach((e, i) => {
      const c = byId.get(e.entity_id) ?? { entity: e, sources: [], overlap: overlapScore(accepted, e), score: 0, first: order++ };
      if (!c.sources.includes(source)) {
        c.sources.push(source);
        c.score += w / (RRF_K + i + 1);
      }
      byId.set(e.entity_id, c);
    });
  };
  add(primary, 'primary', weights.primary);
  add(secondary, 'secondary', weights.secondary);
  const listC = [...byId.values()].filter((c) => c.overlap > 0).sort((a, b) => b.overlap - a.overlap || a.first - b.first);
  listC.forEach((c, i) => {
    c.score += 1 / (RRF_K + i + 1);
  });
  return [...byId.values()].sort((a, b) => b.score - a.score || a.first - b.first).map(({ first: _f, ...c }) => c);
}

/** The result's price level name (Qloo uses one id for every level, so the NAME is the level). */
export function priceLevel(entity: Pick<QlooEntity, 'tags'>): string | null {
  return entity.tags.find((t) => t.id.startsWith('urn:tag:price_level:'))?.name ?? null;
}

/** selectDiverse for the rail (R-20): at most 3 per price level unless fewer than `slots` results remain. */
export function selectRail(candidates: readonly RailCandidate[], slots: number): RailCandidate[] {
  if (candidates.length <= slots) return [...candidates];
  const picked: RailCandidate[] = [];
  const perLevel = new Map<string, number>();
  const deferred: RailCandidate[] = [];
  for (const c of candidates) {
    if (picked.length >= slots) break;
    const level = priceLevel(c.entity);
    if (level && (perLevel.get(level) ?? 0) >= PRICE_LEVEL_CAP) {
      deferred.push(c);
      continue;
    }
    if (level) perLevel.set(level, (perLevel.get(level) ?? 0) + 1);
    picked.push(c);
  }
  for (const c of deferred) if (picked.length < slots) picked.push(c);
  return picked;
}

/** C.3 brand bonus: Qloo's own similar_brand names on the identified brand, as text (R-18: the tag's own name only). */
export function qlooLinks(entity: Pick<QlooEntity, 'tags'> | null | undefined): string[] {
  if (!entity) return [];
  return [...new Set(entity.tags.filter((t) => t.id.startsWith('urn:tag:similar_brand:') && t.name?.trim()).map((t) => t.name.trim()))].slice(0, 5);
}
