import { afterEach, describe, expect, it } from 'vitest';
import {
  homeKindOf,
  drinkKindOf,
  homeKindOfReading,
  homeMatch,
  HOME_INDUSTRY,
  HOME_RAIL_INDUSTRIES,
  homeEvidence,
  homeFamilyGenreAllowed,
  homeRailCarry,
  homeRailGate,
  homeVocabulary,
  rankHomeCatalogue,
  tokenStandsAloneInLabel,
  WEAR_INDUSTRIES,
  wearIndustryAllowed,
  type HomeKind,
} from './home-affinity';
import { homeBrands, setHomeBrandsForTesting, type HomeBrand } from './home-vocabulary';
import { affinityReason, entityProfile, scoreMatch, subjectProfile } from './affinity';
import { storedAesthetic, storedSubject } from './test-support';
import type { StoredSubject } from './types';
import type { QlooEntity } from '@culture-atlas/providers';

/**
 * The catalogue tests run against a small synthetic copy of a real recorded
 * page shape (ids and names verbatim from fixtures/qloo/home-brands) so the
 * ranking logic is pinned independently of the fixture contents. Filler
 * brands carry unrelated words: with too few brands no word can be rare
 * (idf never passes 1), so a realistic population is part of the setup.
 */
const brand = (over: Partial<HomeBrand>): HomeBrand => ({
  id: 'B-1',
  name: 'Fixture House',
  popularity: 0.9,
  price_level: null,
  industry_ids: ['urn:tag:industry:qloo:furniture'],
  genre_ids: ['urn:tag:genre:brand:household'],
  style_tags: [],
  seen_on: 'i_furniture_p1.json',
  ...over,
});

const filler = (i: number, industry = 'furniture'): HomeBrand =>
  brand({
    id: `F-${i}`,
    name: `Fixture Filler ${i}`,
    industry_ids: [`urn:tag:industry:qloo:${industry}`],
    style_tags: [{ id: `urn:tag:aesthetic_property:qloo:filler_style_${i}`, name: `Filler Style ${i}` }],
  });
const population = (extra: HomeBrand[]): HomeBrand[] => [
  ...Array.from({ length: 10 }, (_, i) => filler(i + 1)),
  ...Array.from({ length: 4 }, (_, i) => filler(i + 20, 'tableware')),
  ...extra,
];

const westElmLike = brand({
  id: 'B-2',
  name: 'Fixture Elm',
  style_tags: [
    { id: 'urn:tag:aesthetic_property:qloo:mid_century_modern', name: 'Mid-Century Modern' },
    { id: 'urn:tag:aesthetic_property:qloo:clean_lines', name: 'Clean Lines' },
  ],
});
const midCentury = storedSubject({
  category: 'interior',
  label: 'Walnut credenza',
  aesthetics: [{ name: 'Mid-century modern', certainty: 0.9, wording: 'asserted', display: 'Mid-century modern', strength: 'clear', corroborated_by: [], held: false, basis: 'visible', region: null, qloo: null, defining_features: ['tapered legs'], tag_query: null }],
});

afterEach(() => setHomeBrandsForTesting(undefined));

describe('home kind from the reading words (R-9)', () => {
  it('names the industry of the thing: vessels, cookware, furniture, decor, rooms, ceramics', () => {
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Slip-painted ceramic bowls' }))).toBe('tableware');
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Cast iron skillet' }))).toBe('kitchenware');
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Walnut credenza' }))).toBe('furniture');
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Sunroom dining nook' }))).toBe('interior');
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Terracotta figure' }))).toBeNull();
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Terracotta head vessel' }))).toBeNull();
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Ceramic face vessel' }))).toBeNull();
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Studio floor lamp' }))).toBe('decor');
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Something plain' }))).toBeNull();
  });

  it('a food subject is a drink only for coffee words (a dish is a place question)', () => {
    expect(drinkKindOf(storedSubject({ category: 'food', label: 'Espresso in a ceramic cup' }))).toBe('coffee');
    expect(drinkKindOf(storedSubject({ category: 'food', label: 'Tonkotsu ramen bowl' }))).toBeNull();
  });

  it('held and retracted home cues do not choose retrieval industries', () => {
    const hidden = storedSubject({
      label: 'Unidentified object',
      materials: [{ ...storedAesthetic('Porcelain', { retracted: true }), texture: 'smooth' }],
      construction: [{ ...storedAesthetic('Espresso', { held: true }), kind: 'brewed' }],
      aesthetics: [storedAesthetic('Tableware', { retracted: true })],
    });
    expect(homeKindOf(hidden)).toBeNull();
    expect(drinkKindOf(hidden)).toBeNull();
    expect(homeKindOf({ ...hidden, label: 'Walnut chair' })).toBe('furniture');
  });

  it('a sunroom without another room noun still reaches the home catalogue', () => {
    const sunroom = storedSubject({ category: 'interior', label: 'Sunroom with wood ceiling' });
    expect(homeKindOf(sunroom)).toBe('interior');
    expect(homeKindOfReading([sunroom])).toBe('interior');
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Wood-framed conservatory' }))).toBe('interior');
  });

  it('a coffee table is furniture, not a drink (the room keeps its own kind)', () => {
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Living room with glass coffee table' }))).not.toBe('coffee');
    expect(drinkKindOf(storedSubject({ category: 'food', label: 'Cake on a coffee table' }))).toBeNull();
  });

  it('every kind maps to a recorded Qloo industry filter', () => {
    expect(HOME_INDUSTRY.furniture).toBe('urn:tag:industry:qloo:furniture');
    expect(HOME_INDUSTRY.tableware).toBe('urn:tag:industry:qloo:tableware');
    expect(HOME_INDUSTRY.coffee).toBe('urn:tag:industry:qloo:coffee');
  });

  it('the reading\'s primary subject names the wear rail\'s object kind (an espresso machine is coffee)', () => {
    expect(homeKindOfReading([storedSubject({ category: 'food', label: 'Espresso in a ceramic cup' })])).toBe('coffee');
    expect(homeKindOfReading([storedSubject({ category: 'interior', label: 'Espresso machine on steel counter' })])).toBe('coffee');
    expect(homeKindOfReading([storedSubject({ category: 'interior', label: 'Cast iron skillet' })])).toBe('kitchenware');
    expect(homeKindOfReading([storedSubject({ category: 'fashion', label: 'Colour-block logo tee' })])).toBeNull();
    expect(homeKindOfReading([])).toBeNull();
  });

  it('a kitchen or coffee subject gates wear to its own industries — no eyewear or jewelry for an espresso (eval r3, cause 5)', () => {
    const brand = (tags: { id: string; name: string }[]): QlooEntity => ({ entity_id: 'E', name: 'Fixture Brand', types: ['urn:entity:brand'], properties: {}, tags });
    const coffee = brand([{ id: 'urn:tag:industry:qloo:coffee', name: 'Coffee' }]);
    const kitchenware = brand([{ id: 'urn:tag:industry:qloo:kitchenware', name: 'Kitchenware' }]);
    const eyewear = brand([{ id: 'urn:tag:genre:brand:fashion:accessories:eyewear', name: 'Eyewear' }, { id: 'urn:tag:industry:qloo:eyewear', name: 'Eyewear' }]);
    const jewelry = brand([{ id: 'urn:tag:genre:brand:fashion:accessories:jewelry', name: 'Jewelry' }, { id: 'urn:tag:industry:qloo:jewelry', name: 'Jewelry' }]);
    expect(WEAR_INDUSTRIES.coffee).toEqual(['urn:tag:industry:qloo:coffee', 'urn:tag:industry:qloo:kitchenware']);
    for (const kind of ['coffee', 'kitchenware'] as const) {
      expect(wearIndustryAllowed(coffee, kind)).toBe(true);
      expect(wearIndustryAllowed(kitchenware, kind)).toBe(true);
      expect(wearIndustryAllowed(eyewear, kind)).toBe(false);
      expect(wearIndustryAllowed(jewelry, kind)).toBe(false);
    }
    // Other kinds keep their own industry, and every allowed id is a recorded Qloo filter.
    expect(WEAR_INDUSTRIES.furniture).toEqual(['urn:tag:industry:qloo:furniture']);
    for (const ids of Object.values(WEAR_INDUSTRIES)) for (const id of ids) expect(Object.values(HOME_INDUSTRY)).toContain(id);
  });
});

describe('home-brand exemplars (smatch-1 over the home catalogue)', () => {
  it('does not seed a side chair from side-table or generic chair tags alone', () => {
    setHomeBrandsForTesting(population([
      brand({ id: 'SIDE', style_tags: [{ id: 'urn:tag:signature_product:qloo:side_tables', name: 'Side Tables' }] }),
      brand({ id: 'CHAIR', name: 'Fixture Chairs', style_tags: [{ id: 'urn:tag:signature_product:qloo:chairs', name: 'Chairs' }] }),
    ]));
    const chair = storedSubject({ category: 'interior', label: 'Spindle-back side chair', aesthetics: [storedAesthetic('Regency', { defining_features: ['Carved open splat back'] })] });
    expect(rankHomeCatalogue(chair, 'furniture')).toEqual([]);
  });

  it('does not seed a speckled mug from fine-dining or generic mug tags alone', () => {
    setHomeBrandsForTesting(population([
      brand({ id: 'DINING', industry_ids: [HOME_INDUSTRY.tableware], style_tags: [{ id: 'urn:tag:keyword:qloo:fine_dining', name: 'Fine Dining' }] }),
      brand({ id: 'MUG', name: 'Fixture Mugs', industry_ids: [HOME_INDUSTRY.tableware], style_tags: [{ id: 'urn:tag:signature_product:qloo:mugs', name: 'Mugs' }] }),
    ]));
    const mug = storedSubject({ category: 'interior', label: 'Speckled mug', aesthetics: [storedAesthetic('Rustic modern', { defining_features: ['Fine speckles'] })] });
    expect(rankHomeCatalogue(mug, 'tableware')).toEqual([]);
  });

  it('ranks only brands of the subject industry that share a style claim with the reading', () => {
    const flatpack = brand({
      id: 'B-3',
      name: 'Fixture Flatpack',
      industry_ids: ['urn:tag:industry:qloo:home_goods'],
      style_tags: [{ id: 'urn:tag:aesthetic_property:qloo:functionalist', name: 'Functionalist' }],
    });
    setHomeBrandsForTesting(population([westElmLike, flatpack]));
    const ranked = rankHomeCatalogue(midCentury, 'furniture');
    expect(ranked.map((x) => x.id)).toEqual(['B-2']); // Fixture Elm shares the named claim; Fixture Flatpack is another industry; fillers share no word.
  });

  it('a reading whose words no brand of the industry shares stays empty (no tag-only call, no invention)', () => {
    setHomeBrandsForTesting(population([westElmLike]));
    expect(rankHomeCatalogue(storedSubject({ category: 'interior', label: 'Walnut credenza' }), 'furniture')).toEqual([]);
  });

  it('exemplars never include an anchor entity and are capped', () => {
    setHomeBrandsForTesting(population([westElmLike, { ...westElmLike, id: 'B-4', name: 'Fixture Elm Two' }, { ...westElmLike, id: 'B-5', name: 'Fixture Elm Three' }]));
    const ranked = rankHomeCatalogue(midCentury, 'furniture', { exclude: new Set(['B-4']), max: 2 });
    expect(ranked.map((x) => x.id)).toEqual(['B-2', 'B-5']);
  });

  it('against the committed catalogue: a mid-century furniture reading reaches furniture brands, not tableware', () => {
    const furniture = rankHomeCatalogue(midCentury, 'furniture', { max: 8 });
    expect(furniture.length).toBeGreaterThan(0);
    const catalog = homeBrands();
    for (const x of furniture) {
      const row = catalog.find((b) => b.id === x.id)!;
      expect(row.industry_ids).toContain('urn:tag:industry:qloo:furniture');
    }
    expect(rankHomeCatalogue(storedSubject({ category: 'interior', label: 'Something plain' }), 'furniture')).toEqual([]);
  });
});

describe('home rail candidate gates (eval r3, home-rail precision)', () => {
  /**
   * Tag ids and names are verbatim from fixtures/qloo/home-brands (the recorded Qloo
   * responses); no tag is invented. The subjects are the recorded style readings of the
   * live r3 photos (h16 espresso, 05 ceramics): the rails that returned the fashion house
   * and the K-Cup/sugar reasons this gate exists to remove.
   */
  const claim = (name: string, over: Partial<StoredSubject['lineage'][number]> = {}): StoredSubject['lineage'][number] => ({
    name,
    certainty: 0.9,
    wording: 'asserted',
    display: name,
    strength: 'clear',
    corroborated_by: [],
    held: false,
    basis: 'visible',
    region: null,
    qloo: null,
    tag_query: null,
    ...over,
  });
  const espressoReading: StoredSubject = storedSubject({
    id: 's1',
    category: 'food',
    label: 'Espresso in ceramic cup',
    aesthetics: [
      { ...claim('Italian espresso bar', { wording: 'resembles', certainty: 0.8 }), defining_features: [] },
      { ...claim('Cafe', { wording: 'resembles', certainty: 0.8 }), defining_features: [] },
    ],
    materials: [{ ...claim('Glazed ceramic'), texture: 'glossy' }],
    construction: [{ ...claim('Demitasse cup with saucer'), kind: 'thrown' }],
    lineage: [claim('Italian coffee culture', { wording: 'resembles' })],
  });
  const ceramicsReading: StoredSubject = storedSubject({
    id: 's1',
    category: 'interior',
    label: 'Slip-painted ceramic bowls',
    aesthetics: [
      { ...claim('islamic ceramics', { wording: 'resembles', certainty: 0.7 }), defining_features: [] },
      { ...claim('artisanal', { wording: 'resembles', certainty: 0.7 }), defining_features: [] },
    ],
    materials: [{ ...claim('Glazed ceramic'), texture: 'glossy' }],
  });
  const qloo = (name: string, tags: readonly { id: string; name: string }[], id = 'E-1'): QlooEntity => ({ entity_id: id, name, types: ['urn:entity:brand'], properties: {}, tags: [...tags] });
  const evidenceOf = (e: QlooEntity, subject: StoredSubject) => homeEvidence(scoreMatch(subjectProfile(subject), entityProfile(e.tags ?? []), { fashion: false, v: homeVocabulary() }), e);
  const carried = (list: readonly QlooEntity[], subject: StoredSubject, kind: HomeKind) => homeRailCarry(list, subjectProfile(subject), kind);

  it('rejects unrelated meanings of back and fine while keeping their actual phrases', () => {
    const chair = storedSubject({ category: 'interior', label: 'Spindle-back side chair', aesthetics: [storedAesthetic('Regency', { defining_features: ['Carved open splat back'] })] });
    const mattress = qloo('Fixture Mattress', [
      { id: HOME_INDUSTRY.furniture, name: 'Furniture' },
      { id: 'urn:tag:keyword:qloo:back_pain_relief', name: 'Back Pain Relief' },
    ]);
    expect(carried([mattress], chair, 'furniture').list).toEqual([]);
    const mug = storedSubject({ category: 'interior', label: 'Speckled mug', aesthetics: [storedAesthetic('Rustic modern', { defining_features: ['Fine speckles'] })] });
    const dining = qloo('Fixture Dining', [
      { id: HOME_INDUSTRY.tableware, name: 'Tableware' },
      { id: 'urn:tag:keyword:qloo:fine_dining', name: 'Fine Dining' },
    ]);
    expect(carried([dining], mug, 'tableware').list).toEqual([]);
    const fineDining = storedSubject({ category: 'interior', label: 'Dining room', aesthetics: [storedAesthetic('Fine dining', { defining_features: [] })] });
    expect(carried([dining], fineDining, 'tableware').list).toHaveLength(1);
  });

  it('generic product nouns alone cannot carry a home recommendation', () => {
    const chair = storedSubject({ category: 'interior', label: 'Carved side chair' });
    const generic = qloo('Fixture Chairs', [
      { id: HOME_INDUSTRY.furniture, name: 'Furniture' },
      { id: 'urn:tag:signature_product:qloo:chairs', name: 'Chairs' },
    ]);
    expect(carried([generic], chair, 'furniture').list).toEqual([]);
  });

  it('keeps the actual feature phrase and can choose a valid alternative tag for an ambiguous word', () => {
    const subject = storedSubject({ category: 'interior', label: 'Ceramic bowl', aesthetics: [storedAesthetic('Handcrafted', { defining_features: ['Fine speckles'] })] });
    const entity = qloo('Fixture Maker', [
      { id: HOME_INDUSTRY.tableware, name: 'Tableware' },
      { id: 'urn:tag:signature_product:qloo:fine_dining', name: 'Fine Dining' },
      { id: 'urn:tag:keyword:qloo:fine_speckles', name: 'Fine Speckles' },
    ]);
    const match = homeMatch(subjectProfile(subject), entity);
    expect(match.hits.find((h) => h.token === 'fine')).toMatchObject({ source: 'Fine speckles', label: 'Fine Speckles' });
    expect(match.hits.some((h) => h.label === 'Fine Dining')).toBe(false);
  });

  it('a fashion house is never a home rail card or signal, even when Qloo also tags it the depicted industry', () => {
    // The bridal-gown house the live ceramics rail returned: its own tags say tableware too.
    const luisa = qloo('Luisa Beccaria', [
      { id: 'urn:tag:industry:qloo:tableware', name: 'Tableware' },
      { id: 'urn:tag:industry:qloo:fashion_apparel', name: 'Fashion & Apparel' },
      { id: 'urn:tag:genre:brand:fashion', name: 'Fashion' },
      { id: 'urn:tag:genre:brand:fashion:formalwear', name: 'Formalwear' },
      { id: 'urn:tag:keyword:qloo:artisanal', name: 'Artisanal' },
    ]);
    expect(homeRailGate(luisa, 'tableware')).toBe('fashion_house');
    // The streetwear label the live espresso rail returned, with the depicted industry and real coffee tags of its own.
    const kitsune = qloo('Maison Kitsuné', [
      { id: 'urn:tag:industry:qloo:coffee', name: 'Coffee' },
      { id: 'urn:tag:product_service:qloo:coffee_beans', name: 'Coffee Beans' },
      { id: 'urn:tag:lifestyle:qloo:cafe_culture', name: 'Cafe Culture' },
      { id: 'urn:tag:genre:brand:fashion', name: 'Fashion' },
      { id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual' },
    ]);
    expect(homeRailGate(kitsune, 'coffee')).toBe('fashion_house');
    expect(carried([luisa, kitsune], ceramicsReading, 'tableware').gated).toEqual({ fashion_house: 2 });
    // A brand whose genres name home products too is not a fashion house (fashion:home_accessories is recorded).
    expect(homeFamilyGenreAllowed(['urn:tag:genre:brand:fashion', 'urn:tag:genre:brand:fashion:home_accessories'])).toBe(true);
    expect(homeFamilyGenreAllowed(['urn:tag:genre:brand:household'])).toBe(true);
    // Signals are gated the same way: the exemplar pool of a kind never includes a fashion house.
    setHomeBrandsForTesting(
      population([
        brand({ id: 'B-FASHION', name: 'Fixture Bridal House', industry_ids: ['urn:tag:industry:qloo:tableware'], genre_ids: ['urn:tag:genre:brand:fashion', 'urn:tag:genre:brand:fashion:formalwear'], style_tags: [{ id: 'urn:tag:keyword:qloo:artisanal', name: 'Artisanal' }] }),
        brand({ id: 'B-GOOD', name: 'Fixture Tableware', industry_ids: ['urn:tag:industry:qloo:tableware'], style_tags: [{ id: 'urn:tag:keyword:qloo:artisanal', name: 'Artisanal' }] }),
      ]),
    );
    expect(rankHomeCatalogue(ceramicsReading, 'tableware').map((x) => x.id)).toEqual(['B-GOOD']);
  });

  it('a result whose own tags name no industry of the depicted kind is gated (industry), unless its catalogue row proves it', () => {
    const eyewear = qloo('Fixture Eyewear House', [{ id: 'urn:tag:industry:qloo:jewelry', name: 'Jewelry' }, { id: 'urn:tag:keyword:qloo:artisanal', name: 'Artisanal' }]);
    expect(homeRailGate(eyewear, 'tableware')).toBe('industry');
    expect(homeRailGate(eyewear, 'coffee')).toBe('industry');
    // A thin response tag set still proves membership through the harvested catalogue row.
    setHomeBrandsForTesting(population([brand({ id: 'B-VB', name: 'Fixture Porcelain', industry_ids: ['urn:tag:industry:qloo:tableware'] })]));
    expect(homeRailGate(qloo('Fixture Porcelain', [{ id: 'urn:tag:genre:brand:household', name: 'Household' }], 'B-VB'), 'tableware')).toBeNull();
  });

  it('the demitasse "cup" does not carry a K-Cup brand: a compound product token is not evidence', () => {
    expect(tokenStandsAloneInLabel('cup', 'K-Cup Coffee Pods')).toBe(false);
    expect(tokenStandsAloneInLabel('coffee', 'K-Cup Coffee Pods')).toBe(true);
    expect(tokenStandsAloneInLabel('cafe', 'Café União')).toBe(true);
    expect(tokenStandsAloneInLabel('ceramic', 'Ceramics')).toBe(true);
    expect(tokenStandsAloneInLabel('painted', 'Hand-Painted Details')).toBe(false);
    // A hyphenated compound the reading itself writes is real evidence, not a compound leak:
    // the live sunroom rail's top card cites "Mid-Century Modern Revival" for a mid-century reading.
    const rejuvenation = qloo('Rejuvenation', [
      { id: 'urn:tag:industry:qloo:furniture', name: 'Furniture' },
      { id: 'urn:tag:industry:qloo:retail', name: 'Retail' },
      { id: 'urn:tag:cultural_relevance:qloo:mid_century_modern_revival', name: 'Mid-Century Modern Revival' },
    ]);
    const ev = evidenceOf(rejuvenation, midCentury);
    expect(ev.carries).toBe(true);
    expect(ev.hits.map((h) => h.token)).toEqual(expect.arrayContaining(['midcentury', 'modern']));
    expect(affinityReason(ev.hits)).toBe('Shares the mid-century modern look in your photo');
  });

  it('a K-Cup-only pod brand carries nothing for the espresso reading (empty beats junk)', () => {
    const keurig = qloo('Keurig', [
      { id: 'urn:tag:industry:qloo:coffee', name: 'Coffee' },
      { id: 'urn:tag:industry:qloo:food_beverage', name: 'Food & Beverage' },
      { id: 'urn:tag:product_service:qloo:k_cup_pods', name: 'K-Cup Pods' },
    ]);
    const ev = evidenceOf(keurig, espressoReading);
    expect(ev.carries).toBe(false);
    const gate = carried([keurig], espressoReading, 'coffee');
    expect(gate.list).toEqual([]);
    expect(gate.gated).toEqual({ evidence: 1 });
  });

  it('a coffee brand with real espresso evidence carries, and its reason names espresso, not the pods', () => {
    // Gevalia's own tags: a real Espresso product and the K-Cup pods (the live rail's K-Cup reason).
    const gevalia = qloo('Gevalia Coffee', [
      { id: 'urn:tag:industry:qloo:coffee', name: 'Coffee' },
      { id: 'urn:tag:industry:qloo:food_beverage', name: 'Food & Beverage' },
      { id: 'urn:tag:product_service:qloo:espresso', name: 'Espresso' },
      { id: 'urn:tag:product_service:qloo:k_cup_coffee_pods', name: 'K-Cup Coffee Pods' },
    ]);
    const ev = evidenceOf(gevalia, espressoReading);
    expect(ev.carries).toBe(true);
    expect(ev.hits.some((h) => h.token === 'cup')).toBe(false); // the vessel word only reaches the compound
    expect(affinityReason(ev.hits)).toBe('Known for espresso, a shared detail with your photo');
    expect(carried([gevalia], espressoReading, 'coffee').list.map((e) => e.name)).toEqual(['Gevalia Coffee']);
  });

  it('a sugar house whose coffee tags are its own name is not an espresso card', () => {
    // União's recorded tags: the depicted coffee industry, but its coffee products are Café União.
    const uniao = qloo('União', [
      { id: 'urn:tag:industry:qloo:coffee', name: 'Coffee' },
      { id: 'urn:tag:industry:qloo:confectionery', name: 'Confectionery' },
      { id: 'urn:tag:industry:qloo:food_beverage', name: 'Food & Beverage' },
      { id: 'urn:tag:signature_product:qloo:cafe_uniao', name: 'Café União' },
      { id: 'urn:tag:product_line:qloo:cafe_espresso_uniao', name: 'Café Espresso União' },
      { id: 'urn:tag:cultural_relevance:qloo:coffee_culture', name: 'Coffee Culture' },
      { id: 'urn:tag:lifestyle:qloo:morning_coffee_ritual', name: 'Morning Coffee Ritual' },
      { id: 'urn:tag:keyword:qloo:sugar', name: 'Sugar' },
    ]);
    // It belongs to the depicted industry — the evidence is what disqualifies it: the brand
    // naming itself is not independent evidence, and "coffee" alone is below the rail's bar.
    expect(homeRailGate(uniao, 'coffee')).toBeNull();
    const ev = evidenceOf(uniao, espressoReading);
    expect(ev.hits.map((h) => h.label)).not.toContain('Café União');
    expect(ev.hits.map((h) => h.label)).not.toContain('Café Espresso União');
    expect(ev.carries).toBe(false);
    expect(carried([uniao], espressoReading, 'coffee').gated).toEqual({ evidence: 1 });
  });

  it('valid espresso and ceramics brands carry their readings (good matches preserved)', () => {
    const buondi = qloo('Buondi Caffe', [
      { id: 'urn:tag:industry:qloo:coffee', name: 'Coffee' },
      { id: 'urn:tag:industry:qloo:food_beverage', name: 'Food & Beverage' },
      { id: 'urn:tag:genre:brand:dining', name: 'Dining' },
      { id: 'urn:tag:genre:brand:food_and_beverage', name: 'Food & Beverage' },
      { id: 'urn:tag:product_service:qloo:espresso', name: 'Espresso' },
      { id: 'urn:tag:product_service:qloo:coffee_beans', name: 'Coffee Beans' },
      { id: 'urn:tag:cultural_relevance:qloo:portuguese_cafe_culture', name: 'Portuguese Cafe Culture' },
    ]);
    const buondiEv = evidenceOf(buondi, espressoReading);
    expect(buondiEv.carries).toBe(true);
    expect(affinityReason(buondiEv.hits)).toBe('Known for espresso, a shared detail with your photo');
    expect(carried([buondi], espressoReading, 'coffee').list.map((e) => e.name)).toEqual(['Buondi Caffe']);

    const villeroy = qloo('Villeroy & Boch', [
      { id: 'urn:tag:industry:qloo:tableware', name: 'Tableware' },
      { id: 'urn:tag:industry:qloo:ceramics', name: 'Ceramics' },
      { id: 'urn:tag:industry:qloo:home_goods', name: 'Home Goods' },
      { id: 'urn:tag:genre:brand:household', name: 'Household' },
      { id: 'urn:tag:keyword:qloo:ceramics', name: 'Ceramics' },
    ]);
    expect(homeRailGate(villeroy, 'tableware')).toBeNull();
    expect(homeRailGate(villeroy, 'ceramics')).toBeNull();
    const villeroyEv = evidenceOf(villeroy, ceramicsReading);
    expect(villeroyEv.carries).toBe(true);
    expect(affinityReason(villeroyEv.hits)).toBe('Known for ceramics, a shared detail with your photo');
    expect(carried([villeroy], ceramicsReading, 'tableware').list.map((e) => e.name)).toEqual(['Villeroy & Boch']);
  });

  it('every home-rail industry id is one the harvested catalogue recorded (no invented tag evidence)', () => {
    const recorded = new Set(homeBrands().flatMap((b) => b.industry_ids));
    for (const ids of Object.values(HOME_RAIL_INDUSTRIES))
      for (const id of ids) {
        expect(id).toMatch(/^urn:tag:industry:qloo:[a-z0-9_]+$/);
        expect(recorded.has(id)).toBe(true);
      }
    for (const kind of Object.keys(HOME_RAIL_INDUSTRIES) as HomeKind[]) expect(HOME_RAIL_INDUSTRIES[kind]).toContain(HOME_INDUSTRY[kind]);
  });
});
