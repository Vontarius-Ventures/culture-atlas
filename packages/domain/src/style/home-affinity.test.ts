import { afterEach, describe, expect, it } from 'vitest';
import { homeKindOf, drinkKindOf, homeKindOfReading, HOME_INDUSTRY, rankHomeCatalogue, WEAR_INDUSTRIES, wearIndustryAllowed } from './home-affinity';
import { homeBrands, setHomeBrandsForTesting, type HomeBrand } from './home-vocabulary';
import { storedSubject } from './test-support';
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
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Terracotta figure' }))).toBe('ceramics');
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Studio floor lamp' }))).toBe('decor');
    expect(homeKindOf(storedSubject({ category: 'interior', label: 'Something plain' }))).toBeNull();
  });

  it('a food subject is a drink only for coffee words (a dish is a place question)', () => {
    expect(drinkKindOf(storedSubject({ category: 'food', label: 'Espresso in a ceramic cup' }))).toBe('coffee');
    expect(drinkKindOf(storedSubject({ category: 'food', label: 'Tonkotsu ramen bowl' }))).toBeNull();
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
