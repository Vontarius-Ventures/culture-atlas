import type { QlooEntity } from '@culture-atlas/providers';
import type { StoredSubject } from './types';
import { entityProfile, familiesOf, scoreMatch, styleTokens, subjectProfile, wordWeight, type EntityTagLike, type MatchHit, type MatchSlot, type StyleMatchResult, type SubjectProfile } from './affinity';
import { MIN_ABSOLUTE } from './affinity-rail';
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
    // The signal itself must belong to the depicted industry, not a fashion house Qloo also
    // tags with it (a bridal-gown house tagged tableware is not a tableware exemplar).
    if (!homeFamilyGenreAllowed(b.genre_ids)) continue;
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

// ---- home-rail candidate gates (eval r3, home-rail precision) --------------------

/** Generic market, tier and channel industries: they name no product, so they never disqualify. */
const GENERIC_INDUSTRIES: readonly string[] = [
  'urn:tag:industry:qloo:food_beverage',
  'urn:tag:industry:qloo:food_and_beverage',
  'urn:tag:industry:qloo:consumer_packaged_goods',
  'urn:tag:industry:qloo:home_goods',
  'urn:tag:industry:qloo:retail',
  'urn:tag:industry:qloo:e_commerce',
  'urn:tag:industry:qloo:ecommerce',
  'urn:tag:industry:qloo:online_marketplace',
  'urn:tag:industry:qloo:luxury_goods',
  'urn:tag:industry:qloo:lifestyle',
  'urn:tag:industry:qloo:lifestyle_goods',
  'urn:tag:industry:qloo:design',
  'urn:tag:industry:qloo:general_merchandise',
  'urn:tag:industry:qloo:department_stores',
  'urn:tag:industry:qloo:off_price_retail',
  'urn:tag:industry:qloo:supermarket',
  'urn:tag:industry:qloo:supermarket_chain',
  'urn:tag:industry:qloo:grocery_convenience_stores',
  'urn:tag:industry:qloo:manufacturing',
  'urn:tag:industry:qloo:textiles',
];

/**
 * The industries a home rail of a kind may show (eval r3, home-rail precision): the depicted
 * kind's own industry, the adjacent home industries its products genuinely share (a bowl maker
 * is tableware and ceramics), and generic industries that name no product. Every id is one the
 * harvested catalogue recorded (pinned by the home-affinity tests: no invented tag ids).
 */
export const HOME_RAIL_INDUSTRIES: Record<HomeKind, readonly string[]> = {
  furniture: [
    HOME_INDUSTRY.furniture,
    'urn:tag:industry:qloo:home_furnishings',
    'urn:tag:industry:qloo:furniture_design',
    'urn:tag:industry:qloo:furniture_manufacturing',
    'urn:tag:industry:qloo:commercial_furniture',
    'urn:tag:industry:qloo:cabinetry',
    'urn:tag:industry:qloo:mattresses',
    'urn:tag:industry:qloo:home_textiles',
    'urn:tag:industry:qloo:lighting',
    'urn:tag:industry:qloo:hardware',
    'urn:tag:industry:qloo:home_improvement',
    'urn:tag:industry:qloo:building_materials',
    ...GENERIC_INDUSTRIES,
  ],
  tableware: [
    HOME_INDUSTRY.tableware,
    'urn:tag:industry:qloo:ceramics',
    'urn:tag:industry:qloo:glassware',
    'urn:tag:industry:qloo:dinnerware',
    'urn:tag:industry:qloo:tabletop',
    'urn:tag:industry:qloo:cutlery',
    'urn:tag:industry:qloo:housewares',
    'urn:tag:industry:qloo:sanitary_ware',
    'urn:tag:industry:qloo:hospitality_equipment',
    'urn:tag:industry:qloo:artisan_manufacturing',
    ...GENERIC_INDUSTRIES,
  ],
  kitchenware: [
    HOME_INDUSTRY.kitchenware,
    'urn:tag:industry:qloo:cookware',
    'urn:tag:industry:qloo:bakeware',
    'urn:tag:industry:qloo:cutlery',
    'urn:tag:industry:qloo:kitchen_supplies',
    'urn:tag:industry:qloo:kitchen_appliances',
    'urn:tag:industry:qloo:home_appliances',
    'urn:tag:industry:qloo:small_appliances',
    'urn:tag:industry:qloo:cooking_technology',
    'urn:tag:industry:qloo:cooking_supplies',
    'urn:tag:industry:qloo:food_storage',
    'urn:tag:industry:qloo:housewares',
    HOME_INDUSTRY.coffee,
    ...GENERIC_INDUSTRIES,
  ],
  decor: [
    HOME_INDUSTRY.decor,
    'urn:tag:industry:qloo:decor',
    'urn:tag:industry:qloo:interior_decor',
    'urn:tag:industry:qloo:wall_art',
    'urn:tag:industry:qloo:lighting',
    'urn:tag:industry:qloo:gifts',
    'urn:tag:industry:qloo:giftware',
    'urn:tag:industry:qloo:luxury_gifts',
    'urn:tag:industry:qloo:personalized_gifts',
    'urn:tag:industry:qloo:decorative_arts',
    'urn:tag:industry:qloo:art',
    ...GENERIC_INDUSTRIES,
  ],
  ceramics: [
    HOME_INDUSTRY.ceramics,
    'urn:tag:industry:qloo:tableware',
    'urn:tag:industry:qloo:glassware',
    'urn:tag:industry:qloo:dinnerware',
    'urn:tag:industry:qloo:decorative_arts',
    'urn:tag:industry:qloo:artisan_manufacturing',
    'urn:tag:industry:qloo:gifts',
    'urn:tag:industry:qloo:giftware',
    'urn:tag:industry:qloo:sanitary_ware',
    ...GENERIC_INDUSTRIES,
  ],
  interior: [
    HOME_INDUSTRY.interior,
    'urn:tag:industry:qloo:interior_decor',
    'urn:tag:industry:qloo:interior_design_services',
    'urn:tag:industry:qloo:decor',
    'urn:tag:industry:qloo:home_decor',
    'urn:tag:industry:qloo:furniture',
    'urn:tag:industry:qloo:home_furnishings',
    'urn:tag:industry:qloo:lighting',
    'urn:tag:industry:qloo:architecture',
    'urn:tag:industry:qloo:industrial_design',
    'urn:tag:industry:qloo:product_design',
    'urn:tag:industry:qloo:art',
    // Interior media is the room question's own channel (a design magazine may be the card).
    'urn:tag:industry:qloo:media_entertainment',
    'urn:tag:industry:qloo:publishing',
    'urn:tag:industry:qloo:lifestyle_publishing',
    'urn:tag:industry:qloo:digital_media',
    'urn:tag:industry:qloo:lifestyle_media',
    ...GENERIC_INDUSTRIES,
  ],
  coffee: [
    HOME_INDUSTRY.coffee,
    'urn:tag:industry:qloo:coffee_industry',
    'urn:tag:industry:qloo:coffee_roasting',
    'urn:tag:industry:qloo:coffee_shop',
    'urn:tag:industry:qloo:coffee_shops',
    'urn:tag:industry:qloo:coffee_machines',
    'urn:tag:industry:qloo:coffee_manufacturing',
    'urn:tag:industry:qloo:specialty_coffee',
    'urn:tag:industry:qloo:cafe_chain',
    'urn:tag:industry:qloo:beverages',
    'urn:tag:industry:qloo:organic_beverages',
    'urn:tag:industry:qloo:functional_beverages',
    ...GENERIC_INDUSTRIES,
  ],
};

/** Qloo product-family genres that name home products (a fashion house may still make them). */
const HOME_GENRE_RE = /^urn:tag:genre:brand:(?:household|fashion:home_accessories|food_and_beverage|dining|entertainment)(?::|$)/;

/**
 * Whether a candidate's own Qloo product families are home products (eval r3, home-rail
 * precision). A fashion house is never a home rail card even when Qloo also tags it with the
 * depicted industry (the coffee-filtered pages return streetwear and bridal houses that merely
 * operate cafés or sell tableware) — unless its own genres name home products too.
 */
export function homeFamilyGenreAllowed(genreIds: readonly string[]): boolean {
  const f = familiesOf(genreIds);
  const fashion = f.apparel || f.formal || f.couture || f.footwear || f.bag || f.jewelry || f.eyewear || f.watch || f.swimwear || f.lingerie;
  return !fashion || genreIds.some((g) => HOME_GENRE_RE.test(g));
}

/** Why a Qloo result cannot be a home rail card of the depicted kind, or null when it may. */
export type HomeRailGate = 'fashion_house' | 'industry' | null;

/**
 * Whether a Qloo result itself belongs to the depicted industry's catalogue (eval r3,
 * home-rail precision): its own tags carry a recorded industry of the kind's family — or its
 * harvested home-catalogue row does, when the response's tag set is thin — and its own product
 * families are not a fashion house's. The industry filter of the insights call is not proof:
 * Qloo returns co-liked brands of other industries (measured on the recorded home-brand pages).
 */
export function homeRailGate(entity: Pick<QlooEntity, 'entity_id' | 'tags'>, kind: HomeKind): HomeRailGate {
  const tags = entity.tags ?? [];
  if (!homeFamilyGenreAllowed(tags.filter((t) => t.id.startsWith('urn:tag:genre:brand:')).map((t) => t.id))) return 'fashion_house';
  if (tags.some((t) => HOME_RAIL_INDUSTRIES[kind].includes(t.id))) return null;
  const row = homeBrands().find((b) => b.id === entity.entity_id);
  return row && row.industry_ids.includes(HOME_INDUSTRY[kind]) ? null : 'industry';
}

/** The slots whose claims a reason may name (the same slots affinityReason picks from). */
const HOME_REASON_SLOTS: readonly MatchSlot[] = ['aesthetics', 'lineage', 'era', 'materials', 'construction', 'label'];

/** A word this rare in the home catalogue, when it also names the candidate, is its own brand name. */
const SELF_NAME_WEIGHT = 2;

/**
 * The space-delimited words of a tag label or claim, folded the way styleTokens folds them:
 * underscores, slashes and ampersands separate words (the tokenizer splits them too), a hyphen
 * glues a compound into one word ("K-Cup", "Mid-Century").
 */
function chunkWords(text: string): readonly string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[_/]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** The token is a whole word of the text (a simple plural of it is the same word). */
function wordOf(token: string, chunks: readonly string[]): boolean {
  return chunks.some((w) => w === token || w === `${token}s` || w === `${token}es` || (w.length > 3 && w.endsWith('ies') && `${w.slice(0, -3)}y` === token));
}

/**
 * The token is a whole word of the tag label: a hyphenated compound is one word, so "cup"
 * inside "K-Cup Coffee Pods" is a pod format, not the demitasse vessel the reading names.
 */
export function tokenStandsAloneInLabel(token: string, label: string): boolean {
  return wordOf(token, chunkWords(label));
}

/**
 * The reading writes the same hyphenated compound the tag does ("mid-century" in both): then
 * the words inside it are real shared evidence, not a compound product token.
 */
function sameCompound(claim: string, label: string): boolean {
  const claimChunks = chunkWords(claim);
  return chunkWords(label).some((l) => l.includes('-') && claimChunks.includes(l));
}

/**
 * A tag that echoes the candidate's own distinctive name ("Café União", "Buondi Espresso") is
 * the brand naming itself, not independent evidence for what the photo shows.
 */
export function labelEchoesCandidate(label: string, matched: string, nameTokens: ReadonlySet<string>): boolean {
  return styleTokens(label).some((t) => t !== matched && nameTokens.has(t) && wordWeight(t, homeVocabulary()) >= SELF_NAME_WEIGHT);
}

/** The shared evidence a home rail card actually carries (eval r3, home-rail precision). */
export interface HomeEvidence {
  /** The shared hits that are real evidence (reasons and claims cite these only). */
  hits: readonly MatchHit[];
  /** The match re-computed over that evidence alone (same normalization and factors). */
  score: number;
  /** Whether the card carries something reason-worthy (empty beats junk). */
  carries: boolean;
}

/**
 * The shared evidence a home rail card actually carries (eval r3, home-rail precision): hits
 * whose word stands alone in the entity's own tag label — or in the same hyphenated compound
 * the reading itself uses — and whose tag is not the brand naming itself. What is left must
 * clear the rail's own absolute bar (MIN_ABSOLUTE) and name a claim the reason may cite, or the
 * card is not shown (empty beats junk).
 */
export function homeEvidence(match: StyleMatchResult, entity: Pick<QlooEntity, 'name'>): HomeEvidence {
  const nameTokens = new Set(styleTokens(entity.name));
  const hits = match.hits.filter((h) => (tokenStandsAloneInLabel(h.token, h.label) || sameCompound(h.claim, h.label)) && !labelEchoesCandidate(h.label, h.token, nameTokens));
  const all = match.hits.reduce((t, h) => t + h.contribution, 0);
  const kept = hits.reduce((t, h) => t + h.contribution, 0);
  const score = match.score * (all > 0 ? kept / all : 0);
  return { hits, score, carries: score >= MIN_ABSOLUTE && hits.some((h) => HOME_REASON_SLOTS.includes(h.slot)) };
}

export interface HomeRailCarry {
  /** The results that may be cards, in the response's own order. */
  list: readonly QlooEntity[];
  /** The carried evidence per entity id (hits and score reasons cite). */
  evidence: ReadonlyMap<string, HomeEvidence>;
  /** How many results each gate removed. */
  gated: Readonly<Record<string, number>>;
}

/**
 * The Qloo results a home rail of the depicted kind may carry (eval r3, home-rail precision),
 * pure: a result must itself belong to the depicted industry's catalogue (industry and
 * fashion-house gates) and must carry real shared evidence (no compound product token, no
 * self-named tag, at least one claim a reason may name, above the rail's own score bar).
 * buildHomeRail wires this before its affinity ranking, so the reference scores come only from
 * candidates that can actually be cards.
 */
export function homeRailCarry(list: readonly QlooEntity[], q: SubjectProfile, kind: HomeKind): HomeRailCarry {
  const v = homeVocabulary();
  const gated: Record<string, number> = {};
  const evidence = new Map<string, HomeEvidence>();
  const carried: QlooEntity[] = [];
  for (const e of list) {
    const gate = homeRailGate(e, kind);
    if (gate) {
      gated[gate] = (gated[gate] ?? 0) + 1;
      continue;
    }
    const ev = homeEvidence(scoreMatch(q, entityProfile(e.tags ?? []), { fashion: false, v }), e);
    if (!ev.carries) {
      gated.evidence = (gated.evidence ?? 0) + 1;
      continue;
    }
    carried.push(e);
    evidence.set(e.entity_id, ev);
  }
  return { list: carried, evidence, gated };
}
