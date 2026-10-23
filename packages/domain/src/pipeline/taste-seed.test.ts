import { describe, expect, it } from 'vitest';
import { FASHION_BRAND_TAG } from '../compiler/grounding';
import { eatPlaceSearchQueries, filterEatTags, isFoodSignal, SEED_CATEGORY_PLAN, SEED_EAT_MIN_POPULARITY, signalsFor, type SeedSignal, type SeedSignals } from './taste-seed';

/**
 * Taste-seed signal rules (docs/quality-plan.md §6). The tag lists mirror the
 * shapes of the live Eat responses recorded in the diagnose phase (echoes of
 * non-food picks, re-spellings and plurals of a food pick, obscure one-offs);
 * names and ids here are fixtures, not Qloo data.
 */

const food = (id: string, name: string): SeedSignal => ({ id, name, food: true });
const other = (id: string, name: string): SeedSignal => ({ id, name, food: false });
const t = (slug: string, name: string, popularity?: number) => ({ id: `urn:tag:cuisine:qloo:fixture_${slug}`, name, type: 'urn:tag:cuisine:qloo', ...(popularity === undefined ? {} : { popularity }) });

const SIGNALS: SeedSignals = {
  tags: [
    food('urn:tag:cuisine:qloo:fixture_dim_sum', 'Dim Sum'),
    other('urn:tag:genre:music:fixture_bossa_nova', 'Bossa Nova'),
    other('urn:tag:genre:music:fixture_jazz', 'Jazz'),
    other('urn:tag:decor:qloo:fixture_quiet_luxury', 'Quiet Luxury'),
  ],
  entities: [other('FIXTURE-ARTIST-0001', 'Fixture Night Trio')],
};

describe('food signals (S-EAT-SIGNAL)', () => {
  it('a cuisine tag, a food item or an Eat pick is food; anything else is not', () => {
    expect(isFoodSignal({ id: 'urn:tag:cuisine:qloo:fixture_ramen', kind: 'style', category: null })).toBe(true);
    expect(isFoodSignal({ id: 'urn:tag:genre:qloo:fixture_tea', kind: 'food', category: 'eat' })).toBe(true);
    expect(isFoodSignal({ id: 'urn:tag:decor:qloo:fixture_wabi_sabi', kind: 'style', category: 'eat' })).toBe(true);
    expect(isFoodSignal({ id: 'urn:tag:genre:music:fixture_bossa_nova', kind: 'style', category: 'play' })).toBe(false);
    expect(isFoodSignal({ id: 'FIXTURE-MOVIE-0001', kind: 'film', category: 'watch' })).toBe(false);
  });

  it('Eat is asked with food signals only; the other categories with every signal', () => {
    expect(signalsFor('eat', SIGNALS)).toEqual({ tags: [SIGNALS.tags[0]], entities: [] });
    for (const c of ['wear', 'play', 'watch'] as const) expect(signalsFor(c, SIGNALS)).toBe(SIGNALS);
    expect(signalsFor('eat', { tags: [SIGNALS.tags[1]!], entities: [] })).toEqual({ tags: [], entities: [] });
  });

  it('Wear asks Qloo for fashion brands only (S-WEAR-FILTER); Eat for cuisine tags, then places with photos', () => {
    expect(SEED_CATEGORY_PLAN.wear.filterTags).toEqual([FASHION_BRAND_TAG]);
    expect(FASHION_BRAND_TAG).toBe('urn:tag:genre:brand:fashion');
    expect(SEED_CATEGORY_PLAN.eat.filterTagTypes).toEqual(['urn:tag:cuisine:qloo']);
    expect(SEED_CATEGORY_PLAN.play.filterTags).toBeUndefined();
    expect(SEED_CATEGORY_PLAN.watch.filterTags).toBeUndefined();
  });

  it('searches several pictured place queries, not only the first cuisine name', () => {
    expect(
      eatPlaceSearchQueries({
        tags: [food('urn:tag:cuisine:qloo:fixture_dim_sum', 'Dim Sum'), food('urn:tag:cuisine:qloo:fixture_sichuan', 'Sichuan')],
        entities: [{ id: 'FIXTURE-PLACE-0001', name: 'Havana 1957 Cuban Cuisine', food: true }],
      }),
    ).toEqual(['Dim Sum restaurant', 'Sichuan restaurant', 'Havana 1957 Cuban Cuisine restaurant']);
    expect(eatPlaceSearchQueries({ tags: [food('urn:tag:cuisine:qloo:fixture_bao', 'BAO Restaurant')], entities: [] })).toEqual([
      'BAO Restaurant',
    ]);
  });
});

describe('Eat post-filter (S-EAT-POST)', () => {
  it('drops echoes of non-food picks ("Bossa Nova", "Jazz Age Fare") and keeps real dishes', () => {
    const tags = [t('bossa_nova', 'Bossa Nova', 0.84), t('jazz_age_fare', 'Jazz Age Fare', 0.9), t('cantonese_dim_sum', 'Cantonese Dim Sum', 0.97), t('quiet_luxury_dining', 'Quiet Luxury Dining', 0.9)];
    expect(filterEatTags(tags, SIGNALS).map((x) => x.name)).toEqual(['Cantonese Dim Sum']);
  });

  it('drops re-spellings of a food pick ("Dim Sums", "Dimsum", "Dim Sum Style", "Dim Sum-Style Dishes")', () => {
    const tags = [t('a', 'Dim Sums', 0.9), t('b', 'Dimsum', 0.98), t('c', 'Dim Sum Style', 0.7), t('d', 'Dim Sum-Style Dishes', 0.61), t('e', 'Hong Kong Dim Sum', 0.99)];
    expect(filterEatTags(tags, SIGNALS).map((x) => x.name)).toEqual(['Hong Kong Dim Sum']);
  });

  it('keeps one card per stemmed name ("Sichuan Noodle" / "Sichuan Noodles", "Sichuan Ramen" / "Sichuan Style Ramen")', () => {
    const tags = [t('a', 'Sichuan Noodle', 0.91), t('b', 'Sichuan Noodles', 0.92), t('c', 'Sichuan Ramen', 0.94), t('d', 'Sichuan Style Ramen', 0.93)];
    expect(filterEatTags(tags, SIGNALS).map((x) => x.name)).toEqual(['Sichuan Noodle', 'Sichuan Ramen']);
  });

  it(`keeps only tags with popularity >= ${SEED_EAT_MIN_POPULARITY}; an unknown popularity fails`, () => {
    const tags = [t('a', 'Fuzhou Dim Sum Bowl', 0.23), t('b', 'Shijimi Ramen', 0.82), t('c', 'Kinmedai Ramen'), t('d', 'Yamashio Ramen', SEED_EAT_MIN_POPULARITY)];
    expect(filterEatTags(tags, SIGNALS).map((x) => x.name)).toEqual(['Shijimi Ramen', 'Yamashio Ramen']);
  });

  it('keeps Qloo order and never invents a tag', () => {
    const tags = [t('b', 'Shijimi Ramen', 0.82), t('a', 'Chinese Dim Sum', 0.93)];
    const out = filterEatTags(tags, SIGNALS);
    expect(out).toEqual(tags);
    expect(filterEatTags([], SIGNALS)).toEqual([]);
  });
});
