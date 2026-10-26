import type { QlooEntity } from '@culture-atlas/providers';
import type { StoredSubject } from './types';
import { entityProfile, scoreMatch, subjectProfile, type EntityTagLike } from './affinity';
import type { StyleVocabulary, VocabEntry } from './vocabulary';
import { HOME_BRANDS_VERSION, homeBrands, type HomeBrand } from './home-vocabulary';

/**
 * smatch-1 for interior and craft objects: the same affinity machinery as
 * fashion rails, over the home-brand catalogue (home-brands-1). A room,
 * a chair, a ceramic bowl or an espresso gets "more like this" from the
 * reading's own words: the top catalogue matches become entity SIGNALS for
 * one industry-filtered, explainable Qloo call (probe: entity signal +
 * industry filter returns coherent design brands; a tag-only signal does
 * not). Every card is a real Qloo id from a real response; every reason
 * names a tag the result itself carries.
 */

export type HomeKind = 'furniture' | 'tableware' | 'kitchenware' | 'decor' | 'ceramics' | 'interior' | 'coffee';

/** The Qloo industry filter for each kind (probe fixtures/qloo/home-brands/raw). */
export const HOME_INDUSTRY: Record<HomeKind, string> = {
  furniture: 'urn:tag:industry:qloo:furniture',
  tableware: 'urn:tag:industry:qloo:tableware',
  kitchenware: 'urn:tag:industry:qloo:kitchenware',
  decor: 'urn:tag:industry:qloo:home_decor',
  ceramics: 'urn:tag:industry:qloo:ceramics',
  interior: 'urn:tag:industry:qloo:interior_design',
  coffee: 'urn:tag:industry:qloo:coffee',
};

const WORDS: Record<HomeKind, RegExp> = {
  tableware: /\b(?:bowls?|plates?|mugs?|cups?|saucers?|dishes|platters?|trays?|teapots?|jugs?|pitchers?|vases?|glassware|stemware|tumblers?|cutlery|flatware|silverware|tableware|dinnerware|chalices?|goblets?)\b/i,
  kitchenware: /\b(?:skillets?|saucepans?|stockpots?|dutch ovens?|casseroles?|kettles?|cookware|bakeware|graters?|utensils?|mortars?|pestles?|grinders?|woks?|colanders?|fryers?)\b/i,
  furniture: /\b(?:chairs?|sofas?|couches?|armchairs?|settees?|chaises?|tables?|desks?|bookcases?|shel(f|ves|ving)|sideboards?|credenzas?|cabinets?|dressers?|wardrobes?|nightstands?|beds?|stools?|benches?|ottomans?|loveseats?|futons?)\b/i,
  decor: /\b(?:mirrors?|rugs?|carpets?|artworks?|paintings?|prints?|posters?|clocks?|candles?|cushions?|pillows?|lamps?|pendants?|sconces?|chandeliers?|screens?|bentwood)\b/i,
  ceramics: /\b(?:ceramics?|pottery|porcelain|stoneware|earthenware|terracotta|glazes?|glazed|slipware|slip-painted)\b/i,
  interior: /\b(?:rooms?|sunrooms?|conservator(?:y|ies)|interiors?|nooks?|cafes?|bars?|dining|bedrooms?|living|kitchens?|offices?|workspaces?|venues?|alcoves?|lofts?|apartments?|motels?|spaces?)\b/i,
  coffee: /\b(?:espresso|latte|cappuccino|macchiato|americano|mocha|cortado|flat whites?|coffee(?! ?tables?)|coffeehouses?)\b/i,
};

/** The kind of home thing a subject is, from its own words (label first, then materials, construction, aesthetics). */
export function homeKindOf(subject: Pick<StoredSubject, 'label' | 'materials' | 'construction' | 'aesthetics'>): HomeKind | null {
  const text = [subject.label, ...subject.materials.map((m) => m.name), ...subject.construction.map((c) => c.name), ...subject.aesthetics.map((a) => a.name)].join(' ; ');
  for (const kind of ['tableware', 'kitchenware', 'furniture', 'decor', 'coffee'] as const) if (WORDS[kind].test(text)) return kind;
  if (WORDS.ceramics.test(text)) return 'ceramics';
  if (WORDS.interior.test(text)) return 'interior';
  return null;
}

/** Whether a FOOD subject is a drink (coffee and tea are brands; a dish without a city stays a place question). */
export function drinkKindOf(subject: Pick<StoredSubject, 'label' | 'materials' | 'construction' | 'aesthetics'>): HomeKind | null {
  const text = [subject.label, ...subject.materials.map((m) => m.name), ...subject.construction.map((c) => c.name)].join(' ; ');
  return WORDS.coffee.test(text) ? 'coffee' : null;
}

let vocabFor: readonly HomeBrand[] | undefined;
let vocab: StyleVocabulary | undefined;

/**
 * The home catalogue as a vocabulary-shaped object: ExemplarBrand rows (for
 * the idf table over home brands) with byId labels from the recorded tag
 * names, so rare design words ("walnut", "mid century") weigh more than
 * common ones ("modern", "quality"). Rebuilt whenever the catalogue instance
 * changes (tests swap in synthetic catalogues).
 */
export function homeVocabulary(): StyleVocabulary {
  const list = homeBrands();
  if (vocab && vocabFor === list) return vocab;
  const byId = new Map<string, VocabEntry>();
  const brands = list.map((b) => ({
    id: b.id,
    name: b.name,
    popularity: b.popularity,
    style_tag_ids: b.style_tags.map((t) => t.id),
    price_level: b.price_level,
    genre_ids: b.genre_ids,
  }));
  for (const b of list)
    for (const t of b.style_tags)
      if (!byId.has(t.id)) byId.set(t.id, { id: t.id, label: t.name, namespace: '', entityTypes: ['urn:entity:brand'], count: 1, seenOn: { entityId: b.id, fixture: `home-brands/raw/${b.seen_on}` } });
  vocabFor = list;
  vocab = { version: HOME_BRANDS_VERSION, entries: [], byId, byName: new Map(), aliases: new Map(), brands };
  return vocab;
}

/** A home brand's matchable tags: its recorded style tags by their own names, its genres and price. */
export function homeBrandTags(b: HomeBrand): EntityTagLike[] {
  const out: EntityTagLike[] = b.style_tags.map((t) => ({ id: t.id, name: t.name }));
  for (const g of b.genre_ids) out.push({ id: g, name: g.split(':').pop()!.replace(/_/g, ' ') });
  if (b.price_level) out.push({ id: 'urn:tag:price_level:qloo:_', name: b.price_level });
  return out;
}

export interface HomeExemplar {
  id: string;
  name: string;
  score: number;
}

/** Home-brand exemplars of one industry that share a style claim with the reading (gated like rankCatalogue). */
export function rankHomeCatalogue(
  subject: StoredSubject,
  kind: HomeKind,
  options: { exclude?: ReadonlySet<string>; max?: number } = {},
): HomeExemplar[] {
  const v = homeVocabulary();
  const q = subjectProfile(subject);
  const industry = HOME_INDUSTRY[kind];
  const out: HomeExemplar[] = [];
  const seenNames = new Set<string>();
  for (const b of homeBrands()) {
    if (!b.industry_ids.includes(industry)) continue;
    if (options.exclude?.has(b.id)) continue;
    const m = scoreMatch(q, entityProfile(homeBrandTags(b)), { fashion: false, v });
    if (m.score <= 0 || !m.styleHit) continue;
    const key = b.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    out.push({ id: b.id, name: b.name, score: m.score });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.max ?? 6);
}

/**
 * The home kind of a READING's primary subject (interior words, or a coffee drink): what the
 * photo is actually about for brand questions (eval r3, relevance cause 5).
 */
export function homeKindOfReading(subjects: readonly Pick<StoredSubject, 'category' | 'label' | 'materials' | 'construction' | 'aesthetics'>[]): HomeKind | null {
  const s = subjects[0];
  if (!s) return null;
  if (s.category === 'interior') return homeKindOf(s);
  if (s.category === 'food') return drinkKindOf(s);
  return null;
}

/**
 * The industries a Wear rail may show for a home kind (eval r3, cause 5): an espresso machine or
 * a coffee drink gets coffee and kitchenware brands only — never the eyewear and jewelry houses
 * a coffee brand's co-likers pull in. Other kinds keep their own industry.
 */
export const WEAR_INDUSTRIES: Record<HomeKind, readonly string[]> = {
  coffee: [HOME_INDUSTRY.coffee, HOME_INDUSTRY.kitchenware],
  kitchenware: [HOME_INDUSTRY.kitchenware, HOME_INDUSTRY.coffee],
  furniture: [HOME_INDUSTRY.furniture],
  tableware: [HOME_INDUSTRY.tableware],
  decor: [HOME_INDUSTRY.decor],
  ceramics: [HOME_INDUSTRY.ceramics],
  interior: [HOME_INDUSTRY.interior],
};

/** Whether a real Qloo brand entity itself carries one of the allowed industry tags. */
export function wearIndustryAllowed(entity: Pick<QlooEntity, 'tags'>, kind: HomeKind): boolean {
  const allowed = new Set(WEAR_INDUSTRIES[kind]);
  return (entity.tags ?? []).some((t) => allowed.has(t.id));
}
