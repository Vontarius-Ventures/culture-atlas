import { z } from 'zod';
import type {
  QlooEntity,
  QlooEntityTrendsResult,
  QlooInsightsResult,
  QlooTag,
  QlooTagRef,
  QlooTrendPoint,
  QlooTrendingResult,
} from './types';

/**
 * Lenient normalization of documented Qloo response shapes
 * (https://github.com/qloo/docs-public). Rules:
 *  - The top-level envelope must be recognizable, otherwise the response is
 *    invalid (ProviderError 'invalid_response') — we never guess.
 *  - Individual results without a real id/name are DROPPED, never repaired.
 *  - Unknown fields are ignored; documented optional fields are kept.
 */

export class QlooShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QlooShapeError';
  }
}

const RawTag = z
  .object({
    id: z.string().optional(),
    tag_id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    subtype: z.string().optional(),
    parents: z.array(z.unknown()).optional(),
    popularity: z.number().nullable().optional(),
  })
  .loose();

const RawEntity = z
  .object({
    entity_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    types: z.array(z.string()).optional(),
    subtype: z.string().optional(),
    popularity: z.number().optional(),
    disambiguation: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.unknown()).optional(),
    query: z.unknown().optional(),
  })
  .loose();

/** Properties we keep (display/inspection). Everything else is dropped. */
const KEPT_PROPERTIES = [
  'release_year',
  'release_date',
  'description',
  'short_description',
  'image',
  'website',
  'external',
  'akas',
  'content_rating',
  'duration',
  'genre',
  'address',
  'country',
  'geocode',
] as const;

function normalizeTagRef(value: unknown): QlooTagRef | null {
  const parsed = RawTag.safeParse(value);
  if (!parsed.success) return null;
  const id = parsed.data.id ?? parsed.data.tag_id;
  const name = parsed.data.name;
  if (!id || !name) return null;
  return { id, name, type: parsed.data.type ?? parsed.data.subtype };
}

export function normalizeTag(value: unknown): QlooTag | null {
  const parsed = RawTag.safeParse(value);
  if (!parsed.success) return null;
  const id = parsed.data.id ?? parsed.data.tag_id;
  const name = parsed.data.name;
  if (!id || !name) return null;
  const parents = (parsed.data.parents ?? [])
    .map((p) =>
      typeof p === 'string'
        ? p
        : typeof p === 'object' && p && 'id' in p
          ? String((p as { id: unknown }).id)
          : // /v2/tags lists the entity types a tag is used on as parents: [{ type: 'urn:entity:place' }].
            typeof p === 'object' && p && 'type' in p && typeof (p as { type: unknown }).type === 'string'
            ? (p as { type: string }).type
            : null,
    )
    .filter((p): p is string => !!p);
  const tag: QlooTag = { id, name, type: parsed.data.type ?? parsed.data.subtype ?? 'urn:tag', parents: parents.length ? parents : undefined };
  if (typeof parsed.data.popularity === 'number') tag.popularity = parsed.data.popularity;
  return tag;
}

/** Flattens documented explainability variants into [{entity_id, score}]. */
export function normalizeExplainability(value: unknown): { entity_id: string; score: number }[] | undefined {
  if (value === undefined || value === null) return undefined;
  const out: { entity_id: string; score: number }[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const rec = v as Record<string, unknown>;
    const id = typeof rec.entity_id === 'string' ? rec.entity_id : typeof rec.id === 'string' ? rec.id : undefined;
    const score = typeof rec.score === 'number' ? rec.score : typeof rec.influence === 'number' ? rec.influence : undefined;
    if (id && score !== undefined) {
      out.push({ entity_id: id, score });
      return;
    }
    for (const nested of Object.values(rec)) if (typeof nested === 'object') visit(nested);
  };
  visit(value);
  return out;
}

export function normalizeEntity(value: unknown): QlooEntity | null {
  const parsed = RawEntity.safeParse(value);
  if (!parsed.success) return null;
  const e = parsed.data;
  const entityId = e.entity_id ?? e.id;
  if (!entityId || !e.name) return null;
  const types = e.types?.length ? e.types : [e.subtype, e.type].filter((t): t is string => !!t && t !== 'urn:entity');
  const properties: Record<string, unknown> = {};
  for (const key of KEPT_PROPERTIES) if (e.properties && key in e.properties) properties[key] = e.properties[key];
  const tags = (e.tags ?? []).map(normalizeTagRef).filter((t): t is QlooTagRef => !!t);
  const entity: QlooEntity = { entity_id: entityId, name: e.name, types, properties, tags };
  if (e.subtype) entity.subtype = e.subtype;
  if (typeof e.popularity === 'number') entity.popularity = e.popularity;
  if (e.disambiguation?.trim()) entity.disambiguation = e.disambiguation.trim();
  if (e.query && typeof e.query === 'object') {
    const q = e.query as Record<string, unknown>;
    entity.query = {};
    if (typeof q.affinity === 'number') entity.query.affinity = q.affinity;
    const ex = normalizeExplainability(q.explainability);
    if (ex) entity.query.explainability = ex;
  }
  return entity;
}

function record(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new QlooShapeError('response body is not an object');
  return body as Record<string, unknown>;
}

/** `results` may be an array or an object holding `entities` / `tags`. */
function resultsOf(body: unknown): { array?: unknown[]; object?: Record<string, unknown> } {
  const rec = record(body);
  const results = rec.results;
  if (Array.isArray(results)) return { array: results };
  if (results && typeof results === 'object') return { object: results as Record<string, unknown> };
  throw new QlooShapeError('response has no results');
}

function mapDefined<T>(items: unknown[], fn: (v: unknown) => T | null): T[] {
  return items.map(fn).filter((v): v is T => v !== null);
}

export function parseSearch(body: unknown): QlooEntity[] {
  const { array, object } = resultsOf(body);
  const items = array ?? (Array.isArray(object?.entities) ? (object!.entities as unknown[]) : null);
  if (!items) throw new QlooShapeError('search results are not a list');
  return mapDefined(items, normalizeEntity);
}

export function parseTags(body: unknown): QlooTag[] {
  const { array, object } = resultsOf(body);
  const items = array ?? (Array.isArray(object?.tags) ? (object!.tags as unknown[]) : null);
  if (!items) throw new QlooShapeError('tag results are not a list');
  return mapDefined(items, normalizeTag);
}

export function parseInsights(body: unknown): QlooInsightsResult {
  const { array, object } = resultsOf(body);
  if (array) return { entities: mapDefined(array, normalizeEntity), tags: [] };
  const entities = Array.isArray(object?.entities) ? mapDefined(object!.entities as unknown[], normalizeEntity) : [];
  const tags = Array.isArray(object?.tags) ? mapDefined(object!.tags as unknown[], normalizeTag) : [];
  if (!Array.isArray(object?.entities) && !Array.isArray(object?.tags)) throw new QlooShapeError('insights results have no entities or tags');
  return { entities, tags };
}

function normalizePoint(value: unknown): QlooTrendPoint | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const date = typeof rec.date === 'string' ? rec.date : typeof rec.week === 'string' ? rec.week : undefined;
  if (!date) return null;
  const point: QlooTrendPoint = { date };
  for (const key of ['population_percentile', 'population_rank', 'velocity', 'population_percent_delta'] as const) {
    if (typeof rec[key] === 'number') point[key] = rec[key];
  }
  return point;
}

export function parseTrending(body: unknown): QlooTrendingResult {
  const { array, object } = resultsOf(body);
  const items = array ?? (Array.isArray(object?.entities) ? (object!.entities as unknown[]) : null);
  if (!items) throw new QlooShapeError('trending results are not a list');
  return {
    entities: mapDefined(items, (v) => {
      const entity = normalizeEntity(v);
      if (!entity) return null;
      const raw = (v as Record<string, unknown>).trends ?? (v as Record<string, unknown>).trend;
      const trend = Array.isArray(raw) ? mapDefined(raw, normalizePoint) : undefined;
      return trend ? { ...entity, trend } : entity;
    }),
  };
}

export function parseEntityTrends(body: unknown, entityId: string): QlooEntityTrendsResult {
  const rec = record(body);
  const results = rec.results;
  let items: unknown[] | null = null;
  if (Array.isArray(results)) items = results;
  else if (results && typeof results === 'object') {
    const r = results as Record<string, unknown>;
    items = Array.isArray(r.trends) ? r.trends : Array.isArray(r.data) ? r.data : null;
  } else if (Array.isArray(rec.trends)) items = rec.trends;
  if (!items) throw new QlooShapeError('entity trend results are not a list');
  return { entity_id: entityId, points: mapDefined(items, normalizePoint) };
}
