import { describe, expect, it } from 'vitest';
import { structuredOutputContract } from '../../packages/providers/src/model-gateway/schema';
import type { StructuredRequest, TextModelProvider } from '../../packages/providers/src/text/types';
import { WikipediaResearch, extractionRequest } from '../../packages/providers/src/research/wikipedia';
import {
  artistIdeasRequest,
  dishIdeasRequest,
  filmIdeasRequest,
  proseRequest,
  suggestArtists,
  suggestDishes,
  suggestFilms,
  writeProse,
} from '../../packages/domain/src/composer/creative';
import { composeDishIdeas, eatDishIdeasRequest } from '../../packages/domain/src/compiler/dishes';
import { PlanSnapshot } from '../../packages/domain/src/composer/plan-types';
import { TEXT_FIXTURE_SCHEMAS, TEXT_FIXTURE_SCHEMA_KEYS, parseTextFixture } from './text-schemas';

/** Captures the request a production function sends, and answers with `reply`. */
function capturing(reply: unknown) {
  const sent: Array<StructuredRequest<never>> = [];
  const model: TextModelProvider = {
    id: 'text:fixture',
    capability: () => ({ status: 'available', provider: 'fixture', checked_at: null }),
    async generateStructured(request) {
      sent.push(request as StructuredRequest<never>);
      return { data: reply as never, model: 'fixture/model-1', durationMs: 1 };
    },
  };
  return { model, sent };
}

const snapshot = PlanSnapshot.parse({
  template: 'movie_night',
  collection: null,
  constraints: { dietary_exclusions: ['peanuts'], instruction: null },
  exploration: 'balanced',
  items: [
    {
      item_id: 'FIXTURE-item-1',
      saved_item_id: null,
      kind: 'capture',
      category: null,
      title: 'Tea bowls',
      canonical_key: 'fixture:1',
      anchors: [{ reference_id: 'FIXTURE-ref-1', name: 'Raku ware', type: 'style', revision: 1 }],
    },
  ],
});

describe('text fixture schema registry', () => {
  it('every schema yields a strict structured-output contract (no local failure before dispatch)', () => {
    for (const key of TEXT_FIXTURE_SCHEMA_KEYS)
      expect(() => structuredOutputContract(TEXT_FIXTURE_SCHEMAS[key].schema), key).not.toThrow();
  });

  it('research fixtures are the exact request extractClaims sends', async () => {
    const { model, sent } = capturing({ overview_claim_indexes: [], sections: [], claims: [] });
    const research = new WikipediaResearch(
      { WIKIPEDIA_API_URL: 'https://example.invalid', WIKIPEDIA_ACTION_API_URL: 'https://example.invalid', WIKIMEDIA_USER_AGENT: 'fixture', RESEARCH_TIMEOUT_MS: 1000 },
      model,
    );
    const sources = [
      { url: 'https://example.invalid/a', title: 'FIXTURE title', publisher: 'FIXTURE', extract: 'FIXTURE text '.repeat(500), retrieved_at: '2026-10-19T00:00:00Z' },
    ];
    await research.extractClaims({ name: 'Raku ware', type: 'style', sources });
    const built = extractionRequest({ name: 'Raku ware', type: 'style', sources });
    expect(sent[0]).toEqual(built);
    expect(built.schemaName).toBe(TEXT_FIXTURE_SCHEMAS.reference_notes.schemaName);
    expect(built.maxTokens).toBe(TEXT_FIXTURE_SCHEMAS.reference_notes.maxTokens);
    expect(built.schema).toBe(TEXT_FIXTURE_SCHEMAS.reference_notes.schema);
    // The production 4000-character cap per source text is part of the fixture prompt.
    expect(built.prompt).not.toContain('FIXTURE text '.repeat(400));
  });

  it('composer fixtures are the exact requests the composer functions send', async () => {
    const cases = [
      {
        key: 'eat_dish_ideas' as const,
        run: (m: TextModelProvider) => composeDishIdeas(m, [{ id: 'r1', name: 'Sichuan cuisine', type: 'cuisine' }], {}),
        built: eatDishIdeasRequest([{ name: 'Sichuan cuisine', type: 'cuisine' }]),
        reply: { dishes: [] },
      },
      {
        key: 'plan_prose' as const,
        run: (m: TextModelProvider) => writeProse(m, snapshot, { film: 'Tampopo', dishes: ['Ramen'], artists: [], weakInputs: [] }),
        built: proseRequest(snapshot, { film: 'Tampopo', dishes: ['Ramen'], artists: [], weakInputs: [] }),
        reply: { title: 'T', summary: 'S.' },
      },
      {
        key: 'film_ideas' as const,
        run: (m: TextModelProvider) => suggestFilms(m, snapshot, { count: 2, avoidTitles: ['Tampopo'] }),
        built: filmIdeasRequest(snapshot, { count: 2, avoidTitles: ['Tampopo'] }),
        reply: { films: [] },
      },
      {
        key: 'artist_ideas' as const,
        run: (m: TextModelProvider) => suggestArtists(m, snapshot, { count: 2, avoidNames: [], film: null }),
        built: artistIdeasRequest(snapshot, { count: 2, avoidNames: [], film: null }),
        reply: { artists: [] },
      },
      {
        key: 'plan_dish_ideas' as const,
        run: (m: TextModelProvider) =>
          suggestDishes(m, snapshot, { count: 2, cuisineHints: [], selectedDishes: [], avoidTitles: [], film: null }),
        built: dishIdeasRequest(snapshot, { count: 2, cuisineHints: [], selectedDishes: [], avoidTitles: [], film: null }),
        reply: { dishes: [] },
      },
    ];
    for (const c of cases) {
      const { model, sent } = capturing(c.reply);
      await c.run(model);
      expect(sent[0], c.key).toEqual(c.built);
      const entry = TEXT_FIXTURE_SCHEMAS[c.key];
      expect([c.built.schemaName, c.built.maxTokens, c.built.schema === entry.schema], c.key).toEqual([entry.schemaName, entry.maxTokens, true]);
      expect(entry.role).toBe('composer');
    }
  });

  it('parseTextFixture accepts exactly {system, prompt, schema} with a known key', () => {
    const ok = parseTextFixture({ system: 's', prompt: 'p', schema: 'eat_dish_ideas' }, 'composer');
    expect(ok.entry.schemaName).toBe('dish_ideas');
    expect(() => parseTextFixture({ system: 's', prompt: 'p', schema: 'dish_ideas' })).toThrow(/Text fixture must be/);
    expect(() => parseTextFixture({ system: 's', prompt: 'p', schema: 'plan_prose', extra: 1 })).toThrow(/Text fixture must be/);
    expect(() => parseTextFixture({ system: '', prompt: 'p', schema: 'plan_prose' })).toThrow(/Text fixture must be/);
    expect(() => parseTextFixture(['system'])).toThrow(/Text fixture must be/);
  });

  it('refuses a fixture whose schema belongs to another role', () => {
    expect(() => parseTextFixture({ system: 's', prompt: 'p', schema: 'plan_prose' }, 'research_text')).toThrow(
      /belongs to role composer, not research_text/,
    );
    expect(() => parseTextFixture({ system: 's', prompt: 'p', schema: 'reference_notes' }, 'composer')).toThrow(
      /belongs to role research_text/,
    );
    expect(parseTextFixture({ system: 's', prompt: 'p', schema: 'reference_notes' }, 'research_text').schema).toBe('reference_notes');
  });
});
