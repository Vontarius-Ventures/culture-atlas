import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadThresholds } from './labels';
import { forbiddenAccept, gateLines, scoreGrounding, scoreSeed, type GroundingRecord } from './release-gates';
import { label } from './test-golden';

const thresholdsFile = path.resolve(import.meta.dirname, '../../fixtures/eval/thresholds.json');

const exact = (candidate: string, extra: Partial<GroundingRecord> = {}): GroundingRecord => ({
  candidate,
  accepted: true,
  plan: 'tags',
  query: candidate.toLowerCase(),
  rule: 'Q-NAME',
  reason: 'exact_tag',
  tagFamily: 'decor',
  entityType: null,
  ...extra,
});

describe('grounding gate (thresholds.json "grounding")', () => {
  it('is read from the versioned thresholds and fails without hand judgements', async () => {
    const { thresholds } = await loadThresholds(thresholdsFile);
    const labels = new Map([['h01', label('h01')]]);
    const rows = [{ photo: 'h01', records: Array.from({ length: 40 }, (_, i) => exact(`Fixture style ${i}`)) }];
    const unjudged = scoreGrounding(rows, labels, thresholds.grounding);
    expect(unjudged.pass).toBe(false);
    expect(unjudged.gates.find((g) => g.metric === 'grounding_precision')).toMatchObject({ value: null, pass: false, note: 'needs hand judgement' });
    const judgements = rows[0]!.records.map((r) => ({ photo: 'h01', candidate: r.candidate, correct_match: true, good_candidate: true, findable: true }));
    const judged = scoreGrounding(rows, labels, thresholds.grounding, judgements);
    expect(judged.metrics).toMatchObject({ grounding_precision: 1, end_to_end_precision: 1, recall: 1, forbidden_accepts: 0, holdout_candidates: 40 });
    expect(judged.pass).toBe(true);
    // One wrong match among 40 breaks the 0.95 precision gate? No: 39/40 = 0.975. Three do.
    const wrong = judgements.map((j, i) => (i < 3 ? { ...j, correct_match: false } : j));
    expect(scoreGrounding(rows, labels, thresholds.grounding, wrong).gates.find((g) => g.metric === 'grounding_precision')).toMatchObject({ value: 0.925, pass: false });
  });

  it('counts every forbidden accept: an object or uncorroborated brand searched, a forbidden family or type, a subset or doubtful match', () => {
    const l = label('p13', { qloo: { forbidden_entity_types: ['urn:entity:album'], forbidden_tag_families: [] } });
    expect(forbiddenAccept(exact('Road bicycle', { plan: 'search', candidateType: 'object', corroborated: false }), l)).toBe('object_searched');
    expect(forbiddenAccept(exact('Fixturedale', { plan: 'search', candidateType: 'brand', corroborated: false, entityType: 'urn:entity:brand', tagFamily: null }), l)).toBe('brand_without_corroboration');
    expect(forbiddenAccept(exact('Still life', { tagFamily: 'occupation' }), l)).toBe('forbidden_tag_family');
    expect(forbiddenAccept(exact('Racing jacket', { plan: 'search', entityType: 'urn:entity:album', tagFamily: null }), l)).toBe('forbidden_entity_type');
    expect(forbiddenAccept(exact('Honda Civic', { rule: 'Q-SUBSET' }), l)).toBe('subset_match');
    expect(forbiddenAccept(exact('Smacked cucumber salad', { reason: 'similar_name' }), l)).toBe('not_an_exact_match');
    expect(forbiddenAccept(exact('Neoclassical'), l)).toBeNull();
    expect(forbiddenAccept({ ...exact('Neoclassical'), accepted: false, tagFamily: 'occupation' }, l)).toBeNull();
  });
});

describe('taste-seed gate (thresholds.json "seed")', () => {
  const picks = [
    { id: 'urn:tag:genre:music:bossa_nova', name: 'bossa nova', food: false },
    { id: 'urn:tag:cuisine:qloo:dim_sum', name: 'dim sum', food: true },
  ];
  const cuisine = (title: string) => ({ title, qlooId: `urn:tag:cuisine:qloo:${title.toLowerCase().replace(/ /g, '_')}` });

  it('flags Eat echoes of non-food picks and non-cuisine cards, and caps requests and concurrency', async () => {
    const { thresholds } = await loadThresholds(thresholdsFile);
    const run = {
      picks,
      requests: [{ filterType: 'urn:entity:brand' }, { filterType: 'urn:entity:artist' }, { filterType: 'urn:entity:movie' }, { filterType: 'urn:tag' }],
      peakInFlight: 3,
      categories: [{ category: 'eat', cards: [cuisine('Cantonese Dim Sum'), cuisine('Bossa Nova'), { title: 'Jazz Age Fare', qlooId: 'urn:tag:keyword:qloo:jazz_age_fare' }] }],
    };
    const r = scoreSeed(run, thresholds.seed, { eat_useful_share: 0.7, wear_fashion_brand_share: 1, play_watch_type_correct: 1 });
    expect(r.echoes).toEqual(['Bossa Nova']);
    expect(r.metrics).toMatchObject({ eat_echo_cards: 1, eat_food_share: 0.6667, requests: 4, in_flight: 3 });
    expect(r.pass).toBe(false);
    expect(gateLines('seed', r)[0]).toBe('seed: FAIL');
    const clean = { ...run, categories: [{ category: 'eat', cards: [cuisine('Cantonese Dim Sum'), cuisine('Hong Kong Dim Sum')] }] };
    expect(scoreSeed(clean, thresholds.seed, { eat_useful_share: 0.7, wear_fashion_brand_share: 1, play_watch_type_correct: 1 }).pass).toBe(true);
    expect(scoreSeed({ ...clean, peakInFlight: 4 }, thresholds.seed, { eat_useful_share: 0.7, wear_fashion_brand_share: 1, play_watch_type_correct: 1 }).pass).toBe(false);
  });

  it('with no food picks, any Eat call fails the gate; judged shares are required', async () => {
    const { thresholds } = await loadThresholds(thresholdsFile);
    const noFood = { picks: [picks[0]!], requests: [{ filterType: 'urn:entity:brand' }, { filterType: 'urn:tag' }], peakInFlight: 2, categories: [] };
    const r = scoreSeed(noFood, thresholds.seed, { wear_fashion_brand_share: 1, play_watch_type_correct: 1 });
    expect(r.metrics.eat_calls_without_food_picks).toBe(1);
    expect(r.pass).toBe(false);
    expect(scoreSeed({ ...noFood, requests: [{ filterType: 'urn:entity:brand' }] }, thresholds.seed).gates.filter((g) => !g.pass).map((g) => g.note)).toEqual([
      'needs hand judgement',
      'needs hand judgement',
    ]);
  });
});
