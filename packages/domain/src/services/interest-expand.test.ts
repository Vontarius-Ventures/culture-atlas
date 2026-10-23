import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../enums';
import { expandInsightsPage, pickExpandSignals, withEatCuisineSignals } from '../pipeline/interest-expand';
import { interestExpandCategory, interestExpandWave, INTEREST_EXPAND_WINDOW_MS } from './interest-expand';

describe('interest expand wave', () => {
  it('buckets time into a stable wave and rotates category', () => {
    const t0 = new Date(Math.floor(1_700_000_000_000 / INTEREST_EXPAND_WINDOW_MS) * INTEREST_EXPAND_WINDOW_MS);
    const same = new Date(t0.getTime() + INTEREST_EXPAND_WINDOW_MS - 1);
    const next = new Date(t0.getTime() + INTEREST_EXPAND_WINDOW_MS);
    expect(interestExpandWave(same)).toBe(interestExpandWave(t0));
    expect(interestExpandWave(next)).toBe(interestExpandWave(t0) + 1);
    expect(CATEGORIES).toContain(interestExpandCategory(0));
    expect(interestExpandCategory(1)).not.toBe(interestExpandCategory(0));
    expect(interestExpandCategory(4)).toBe(interestExpandCategory(0));
  });
});

describe('expand insights paging', () => {
  it('stays on page 1 until a full take of that category is already saved', () => {
    expect(expandInsightsPage(0)).toBe(1);
    expect(expandInsightsPage(24)).toBe(1);
    expect(expandInsightsPage(25)).toBe(2);
    expect(expandInsightsPage(49)).toBe(2);
    expect(expandInsightsPage(50)).toBe(3);
  });
});

describe('expand signal windows', () => {
  const pool = Array.from({ length: 12 }, (_, i) => ({
    id: `FIXTURE-ARTIST-${String(i).padStart(2, '0')}`,
    name: `Artist ${i}`,
    food: false,
  }));

  it('takes six signals and shifts a full window each category cycle', () => {
    expect(pickExpandSignals(pool, 0).entities.map((s) => s.id)).toEqual([
      'FIXTURE-ARTIST-00',
      'FIXTURE-ARTIST-01',
      'FIXTURE-ARTIST-02',
      'FIXTURE-ARTIST-03',
      'FIXTURE-ARTIST-04',
      'FIXTURE-ARTIST-05',
    ]);
    expect(pickExpandSignals(pool, 4).entities.map((s) => s.id)).toEqual([
      'FIXTURE-ARTIST-06',
      'FIXTURE-ARTIST-07',
      'FIXTURE-ARTIST-08',
      'FIXTURE-ARTIST-09',
      'FIXTURE-ARTIST-10',
      'FIXTURE-ARTIST-11',
    ]);
  });

  it('returns nothing when the pool is empty', () => {
    expect(pickExpandSignals([], 0)).toEqual({ tags: [], entities: [] });
  });
});

describe('eat cuisine fallback', () => {
  it('adds seed cuisine tags when the expand window is only restaurants', () => {
    const taken = {
      tags: [] as { id: string; name: string; food: boolean }[],
      entities: [{ id: 'FIXTURE-PLACE-0001', name: 'ISIRI Multi Cuisine Restaurant', food: true }],
    };
    const seed = {
      tags: [
        { id: 'urn:tag:cuisine:qloo:fixture_sichuan', name: 'Sichuan', food: true },
        { id: 'urn:tag:genre:music:fixture_jazz', name: 'Jazz', food: false },
      ],
      entities: [],
    };
    expect(withEatCuisineSignals(taken, seed).tags.map((t) => t.name)).toEqual(['Sichuan']);
    expect(withEatCuisineSignals(taken, seed).entities).toEqual(taken.entities);
  });

  it('leaves a window that already has tags alone', () => {
    const taken = {
      tags: [{ id: 'urn:tag:cuisine:qloo:fixture_ramen', name: 'Ramen', food: true }],
      entities: [],
    };
    const seed = {
      tags: [{ id: 'urn:tag:cuisine:qloo:fixture_sichuan', name: 'Sichuan', food: true }],
      entities: [],
    };
    expect(withEatCuisineSignals(taken, seed)).toBe(taken);
  });
});


