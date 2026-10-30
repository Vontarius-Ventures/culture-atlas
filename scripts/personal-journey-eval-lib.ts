/**
 * Pure aggregation for the fresh personal-preference comparison
 * (scripts/personal-journey-eval.ts; VAL-QUAL-002). No I/O: the runner
 * records raw outcomes, this module folds them into the pre-review counts,
 * and every empty/error/unavailable outcome stays in the denominators —
 * nothing may inflate successful coverage by dropping failed attempts.
 */

export interface FeedCard {
  id: string;
  title: string;
  category: string | null;
  subtitle: string | null;
  is_example: boolean;
  recommendation_id: string | null;
  evidence_available: boolean;
}

export interface JourneyOutcome {
  journey_id: string;
  variant: string;
  account_email: string;
  account_id: string | null;
  picks: string[];
  saved_item: { title: string; reference_key: string; item_id: string | null; linked: boolean } | null;
  errors: string[];
  jobs: Array<{ id: string; type: string; state: string }>;
  provider_queries: Array<{ provider: string; operation: string; status: string }>;
  model_attempts_delta: number;
  latency_ms: number | null;
  outcome: 'cards' | 'empty' | 'error';
  cards: FeedCard[];
  graph_cards: Array<{ title: string; connection: unknown; why_state: string | null }>;
  notes: string[];
}

export interface Aggregate {
  variant: string;
  journeys_attempted: number;
  journeys_with_cards: number;
  journeys_empty: number;
  journeys_error: number;
  non_example_cards: number;
  example_cards: number;
  distinct_non_example_titles: number;
  duplicate_non_example_cards: number;
  cards_with_why: number;
  provider_calls: number;
  model_attempts_delta: number;
  per_journey: Array<{
    journey_id: string;
    outcome: string;
    non_example_cards: number;
    example_cards: number;
    distinct_titles: number;
    latency_ms: number | null;
    provider_calls: number;
    errors: string[];
  }>;
}

/** Fold raw outcomes into the pre-review aggregate. Judgments are NOT applied here. */
export function aggregate(outcomes: JourneyOutcome[]): Aggregate {
  const agg: Aggregate = {
    variant: outcomes[0]?.variant ?? '',
    journeys_attempted: outcomes.length,
    journeys_with_cards: 0,
    journeys_empty: 0,
    journeys_error: 0,
    non_example_cards: 0,
    example_cards: 0,
    distinct_non_example_titles: 0,
    duplicate_non_example_cards: 0,
    cards_with_why: 0,
    provider_calls: 0,
    model_attempts_delta: 0,
    per_journey: [],
  };
  for (const o of outcomes) {
    const personal = o.cards.filter((c) => !c.is_example);
    const examples = o.cards.filter((c) => c.is_example);
    const titles = personal.map((c) => c.title);
    const distinct = new Set(titles).size;
    if (o.outcome === 'cards') agg.journeys_with_cards += 1;
    else if (o.outcome === 'empty') agg.journeys_empty += 1;
    else agg.journeys_error += 1;
    agg.non_example_cards += personal.length;
    agg.example_cards += examples.length;
    agg.distinct_non_example_titles += distinct;
    agg.duplicate_non_example_cards += titles.length - distinct;
    agg.cards_with_why += o.graph_cards.filter((g) => g.why_state === 'connected').length;
    agg.provider_calls += o.provider_queries.length;
    agg.model_attempts_delta += o.model_attempts_delta;
    agg.per_journey.push({
      journey_id: o.journey_id,
      outcome: o.outcome,
      non_example_cards: personal.length,
      example_cards: examples.length,
      distinct_titles: distinct,
      latency_ms: o.latency_ms,
      provider_calls: o.provider_queries.length,
      errors: o.errors,
    });
  }
  return agg;
}

/** Domain coverage: distinct domains among the non-example cards, judged only from the card categories recorded. */
export function domainCoverage(outcomes: JourneyOutcome[]): {
  domains: string[];
  per_domain_cards: Record<string, number>;
} {
  const per_domain: Record<string, number> = {};
  for (const o of outcomes) {
    for (const card of o.cards.filter((c) => !c.is_example)) {
      const domain = card.category ?? 'uncategorized';
      per_domain[domain] = (per_domain[domain] ?? 0) + 1;
    }
  }
  return { domains: Object.keys(per_domain).sort(), per_domain_cards: per_domain };
}
