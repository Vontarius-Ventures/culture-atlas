import type { z } from 'zod';
import { RawExtraction } from '../../packages/providers/src/research/wikipedia';
import {
  ArtistIdeas,
  DishIdeas as PlanDishIdeas,
  FilmIdeas,
  PlanProse,
} from '../../packages/domain/src/composer/creative';
import { DishIdeas as EatDishIdeas } from '../../packages/domain/src/compiler/dishes';

/**
 * Text-role qualification fixtures (quality plan §8): which structured request
 * a fixture file exercises. A fixture is `{system, prompt, schema}` where
 * `schema` is a key of this table. Each entry pins the role that serves the
 * call in production, the schema name sent on the wire, the zod schema the
 * reply must satisfy and the production output cap (`maxTokens` of the
 * production builder), so a qualification run sends what production sends.
 *
 * The composer role serves five different calls. `eat_dish_ideas` is the one
 * every photo analysis with food references makes (compiler Eat section), so
 * a composer qualified on `plan_prose` alone would not have exercised the call
 * that decides whether an upload ends `complete` or `partial`.
 */
export interface TextFixtureSchemaEntry {
  role: 'research_text' | 'composer';
  /** Name sent as the structured-output schema name (two entries share `dish_ideas`, as in production). */
  schemaName: string;
  schema: z.ZodType;
  /** maxTokens of the production request builder. */
  maxTokens: number;
  /** Where production makes this call. */
  use: string;
}

export const TEXT_FIXTURE_SCHEMAS = {
  reference_notes: {
    role: 'research_text',
    schemaName: 'reference_notes',
    schema: RawExtraction,
    maxTokens: 4_000,
    use: 'research claim extraction (packages/providers/src/research/wikipedia.ts extractionRequest)',
  },
  eat_dish_ideas: {
    role: 'composer',
    schemaName: 'dish_ideas',
    schema: EatDishIdeas,
    maxTokens: 1_500,
    use: 'Eat dish ideas on every photo analysis (packages/domain/src/compiler/dishes.ts eatDishIdeasRequest)',
  },
  plan_prose: {
    role: 'composer',
    schemaName: 'plan_prose',
    schema: PlanProse,
    maxTokens: 400,
    use: 'movie-night plan title and summary (packages/domain/src/composer/creative.ts proseRequest)',
  },
  film_ideas: {
    role: 'composer',
    schemaName: 'film_ideas',
    schema: FilmIdeas,
    maxTokens: 800,
    use: 'movie-night film ideas (creative.ts filmIdeasRequest)',
  },
  artist_ideas: {
    role: 'composer',
    schemaName: 'artist_ideas',
    schema: ArtistIdeas,
    maxTokens: 800,
    use: 'movie-night artist ideas (creative.ts artistIdeasRequest)',
  },
  plan_dish_ideas: {
    role: 'composer',
    schemaName: 'dish_ideas',
    schema: PlanDishIdeas,
    maxTokens: 1_000,
    use: 'movie-night dish ideas with dietary exclusions (creative.ts dishIdeasRequest)',
  },
} as const satisfies Record<string, TextFixtureSchemaEntry>;

export type TextFixtureSchemaKey = keyof typeof TEXT_FIXTURE_SCHEMAS;
export const TEXT_FIXTURE_SCHEMA_KEYS = Object.keys(TEXT_FIXTURE_SCHEMAS) as TextFixtureSchemaKey[];

export function isTextFixtureSchemaKey(value: unknown): value is TextFixtureSchemaKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEXT_FIXTURE_SCHEMAS, value);
}

export interface ParsedTextFixture {
  system: string;
  prompt: string;
  schema: TextFixtureSchemaKey;
  entry: TextFixtureSchemaEntry;
}

/**
 * Validates one text fixture file: exactly `{system, prompt, schema}`, a known
 * schema key and, when `role` is given, a schema that this role serves in
 * production (a research_text profile must never qualify on composer prompts).
 */
export function parseTextFixture(value: unknown, role?: string): ParsedTextFixture {
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    typeof v.system !== 'string' ||
    !v.system ||
    typeof v.prompt !== 'string' ||
    !v.prompt ||
    !isTextFixtureSchemaKey(v.schema) ||
    Object.keys(v).some((k) => !['system', 'prompt', 'schema'].includes(k))
  )
    throw new Error(
      `Text fixture must be {system, prompt, schema: ${TEXT_FIXTURE_SCHEMA_KEYS.join('|')}}.`,
    );
  const entry: TextFixtureSchemaEntry = TEXT_FIXTURE_SCHEMAS[v.schema];
  if (role !== undefined && entry.role !== role)
    throw new Error(`Text fixture schema ${v.schema} belongs to role ${entry.role}, not ${role}.`);
  return { system: v.system, prompt: v.prompt, schema: v.schema, entry };
}
