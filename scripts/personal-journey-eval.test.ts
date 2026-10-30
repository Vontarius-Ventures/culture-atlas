import { describe, expect, it } from 'vitest';
import { aggregate, domainCoverage, type FeedCard, type JourneyOutcome } from './personal-journey-eval-lib';

/**
 * Deterministic coverage for the fresh personal-preference comparison's
 * pre-review aggregation (VAL-QUAL-002). No DB, no network, no live
 * providers: these cases pin the denominator honesty the contract requires —
 * empty/error/unavailable attempts can never inflate successful coverage,
 * and duplicates never count as distinct useful cards.
 */

function card(title: string, overrides: Partial<FeedCard> = {}): FeedCard {
  return {
    id: `${title}-id`,
    title,
    category: 'play',
    subtitle: null,
    is_example: false,
    recommendation_id: null,
    evidence_available: false,
    ...overrides,
  };
}

function outcome(overrides: Partial<JourneyOutcome> = {}): JourneyOutcome {
  return {
    journey_id: 'rodin-sculpture',
    variant: 'graph',
    account_email: 'x@journey.test',
    account_id: 'a1',
    picks: [],
    saved_item: null,
    errors: [],
    jobs: [],
    provider_queries: [],
    model_attempts_delta: 0,
    latency_ms: null,
    outcome: 'cards',
    cards: [],
    graph_cards: [],
    notes: [],
    ...overrides,
  };
}

describe('personal-journey aggregation', () => {
  it('counts every journey attempt in the denominator, including empty and error outcomes', () => {
    const agg = aggregate([
      outcome({ journey_id: 'j1', outcome: 'cards', cards: [card('A')] }),
      outcome({ journey_id: 'j2', outcome: 'empty', cards: [card('Example', { is_example: true })] }),
      outcome({ journey_id: 'j3', outcome: 'error', errors: ['POST /v1/accounts -> 500'] }),
    ]);
    expect(agg.journeys_attempted).toBe(3);
    expect(agg.journeys_with_cards).toBe(1);
    expect(agg.journeys_empty).toBe(1);
    expect(agg.journeys_error).toBe(1);
    // An error journey's zero cards can never become "coverage".
    expect(agg.non_example_cards).toBe(1);
  });

  it('separates example cards from personal cards and counts duplicates separately from distinct titles', () => {
    const agg = aggregate([
      outcome({
        cards: [
          card('La Grande Jatte'),
          card('La Grande Jatte'),
          card('The Bedroom'),
          card('Sample evening', { is_example: true }),
        ],
      }),
    ]);
    expect(agg.non_example_cards).toBe(3);
    expect(agg.distinct_non_example_titles).toBe(2);
    expect(agg.duplicate_non_example_cards).toBe(1);
    expect(agg.example_cards).toBe(1);
  });

  it('counts only connected Why-this disclosures as cards_with_why', () => {
    const agg = aggregate([
      outcome({
        cards: [card('A'), card('B'), card('C')],
        graph_cards: [
          { title: 'A', connection: null, why_state: 'connected' },
          { title: 'B', connection: null, why_state: 'support_withdrawn' },
          { title: 'C', connection: null, why_state: 'no_recommendation_id' },
        ],
      }),
    ]);
    expect(agg.cards_with_why).toBe(1);
  });

  it('sums provider calls and ledger deltas across journeys without dropping any', () => {
    const agg = aggregate([
      outcome({ journey_id: 'j1', provider_queries: [{ provider: 'qloo', operation: 'insights', status: 'ok' }], model_attempts_delta: 0 }),
      outcome({
        journey_id: 'j2',
        provider_queries: [
          { provider: 'qloo', operation: 'insights', status: 'ok' },
          { provider: 'qloo', operation: 'insights', status: 'error' },
        ],
        model_attempts_delta: 1,
      }),
    ]);
    expect(agg.provider_calls).toBe(3);
    expect(agg.model_attempts_delta).toBe(1);
  });

  it('keeps per-journey latency as observed, null when no personal card ever appeared', () => {
    const agg = aggregate([
      outcome({ journey_id: 'j1', latency_ms: 4200 }),
      outcome({ journey_id: 'j2', outcome: 'empty', latency_ms: null }),
    ]);
    expect(agg.per_journey.map((j) => j.latency_ms)).toEqual([4200, null]);
  });

  it('records domain coverage only from non-example card categories', () => {
    const coverage = domainCoverage([
      outcome({
        cards: [
          card('A', { category: 'play' }),
          card('B', { category: 'watch' }),
          card('C', { category: null }),
          card('D', { is_example: true, category: 'eat' }),
        ],
      }),
    ]);
    expect(coverage.domains).toEqual(['play', 'uncategorized', 'watch']);
    expect(coverage.per_domain_cards).toEqual({ play: 1, watch: 1, uncategorized: 1 });
  });
});
