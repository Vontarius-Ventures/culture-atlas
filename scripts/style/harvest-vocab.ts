/**
 * Style vocabulary harvest (svocab-N), design §C.2 and amendment R-1/R-2.
 *
 * PAID: every request counts against the Qloo key. Refuses to run without
 * --confirm-paid-requests, spaces requests at least 150 ms apart (well under
 * the key's 10 rps), stops at --max requests (default 40) and never retries
 * silently (a 429 waits 1100 ms and is retried once, and that retry counts).
 *
 * What it records (fixtures/qloo/style-vocab/):
 *   raw/<id>.json   each response as Qloo returned it, reduced to the fields
 *                   the vocabulary uses (entity id, name, types, popularity
 *                   and the tags in the harvested namespaces, each tag
 *                   verbatim: id, name, type). Nothing is renamed or invented.
 *   vocab.json      written by scripts/style/build-vocab.ts from raw/ only.
 *   brands.json     (R-1 exemplar matrix) written by build-vocab.ts.
 *
 * Usage:
 *   tsx scripts/style/harvest-vocab.ts --confirm-paid-requests [--max 40] [--only fashion,media,place,food,music] [--fashion-pages 20]
 * Env: QLOO_API_KEY, QLOO_API_URL (never printed).
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const HARVEST_NAMESPACES = [
  'fashion_segment',
  'personal_style',
  'aesthetic_property',
  'material',
  'design_inspiration',
  'cultural_relevance',
  'signature_piece',
  'price_level',
  'similar_brand',
  'genre:brand',
  // media
  'style:qloo',
  'theme:qloo',
  'subgenre:qloo',
  'genre:media',
  // places
  'decor',
  'setting',
  'ambience',
  'genre:place',
  'cuisine',
] as const;

/** Tag families that never enter the vocabulary, signals, filters or reasons (R-7d). */
export const NEVER_HARVEST_RE = /:(?:target_gender|target_age_group|target_income_level|market_archetype)(?::|$)/;

export function keepTag(type: string | undefined, id: string): boolean {
  if (NEVER_HARVEST_RE.test(id) || (type && NEVER_HARVEST_RE.test(type))) return false;
  const t = type ?? id;
  return HARVEST_NAMESPACES.some((ns) => t.includes(`:${ns}`));
}

interface Planned {
  id: string;
  path: string;
  params: Record<string, string | number>;
  kind: 'entities' | 'tags';
}

function plan(only: Set<string>, fashionPages: number): Planned[] {
  const out: Planned[] = [];
  if (only.has('fashion'))
    for (let page = 1; page <= fashionPages; page++)
      out.push({
        id: `fashion-brands-p${String(page).padStart(2, '0')}`,
        path: '/v2/insights',
        kind: 'entities',
        params: {
          'filter.type': 'urn:entity:brand',
          'filter.tags': 'urn:tag:genre:brand:fashion',
          'filter.popularity.min': 0.5,
          take: 50,
          page,
        },
      });
  if (only.has('media'))
    for (let page = 1; page <= 2; page++)
      out.push({
        id: `movies-p${page}`,
        path: '/v2/insights',
        kind: 'entities',
        params: { 'filter.type': 'urn:entity:movie', 'filter.popularity.min': 0.9, take: 50, page },
      });
  if (only.has('place'))
    for (const ns of ['decor', 'setting', 'ambience'])
      for (let page = 1; page <= (ns === 'decor' ? 3 : 1); page++)
        out.push({
          id: `tags-${ns}-p${page}`,
          path: '/v2/tags',
          kind: 'tags',
          params: { 'filter.tag.types': `urn:tag:${ns}:qloo`, take: 50, page },
        });
  // Tag listing by decor/setting/ambience type returns nothing without a query, so place
  // vocabulary comes from the tags real places carry (restaurants and cafes in four cities).
  if (only.has('places'))
    for (const city of ['New York', 'Los Angeles', 'London', 'Tokyo'])
      out.push({
        id: `places-${city.toLowerCase().replace(/\s+/g, '-')}`,
        path: '/v2/insights',
        kind: 'entities',
        params: { 'filter.type': 'urn:entity:place', 'filter.location.query': city, 'filter.tags': 'urn:tag:genre:place:restaurant', take: 50 },
      });
  if (only.has('food'))
    for (let page = 1; page <= 2; page++)
      out.push({
        id: `tags-restaurant-genre-p${page}`,
        path: '/v2/tags',
        kind: 'tags',
        params: { 'filter.tag.types': 'urn:tag:genre:place', take: 50, page },
      });
  if (only.has('music'))
    out.push({ id: 'tags-music-genre-p1', path: '/v2/tags', kind: 'tags', params: { 'filter.tag.types': 'urn:tag:genre:music', take: 50, page: 1 } });
  return out;
}

interface RawTag {
  tag_id?: string;
  id?: string;
  name?: string;
  type?: string;
  parents?: unknown;
  popularity?: number;
}

/** Reduces one response to the recorded fields; tags are copied verbatim (id, name, type). */
export function reduceResponse(kind: Planned['kind'], body: unknown): unknown {
  const results = (body as { results?: unknown })?.results as Record<string, unknown> | undefined;
  if (!results || typeof results !== 'object') return { results: null };
  if (kind === 'tags') {
    const tags = Array.isArray(results.tags) ? (results.tags as RawTag[]) : [];
    return {
      results: {
        tags: tags
          .filter((t) => (t.id ?? t.tag_id) && t.name && !NEVER_HARVEST_RE.test(t.id ?? t.tag_id ?? ''))
          .map((t) => ({ id: t.id ?? t.tag_id, name: t.name, type: t.type, parents: t.parents, popularity: t.popularity })),
      },
    };
  }
  const entities = Array.isArray(results.entities) ? (results.entities as Record<string, unknown>[]) : [];
  return {
    results: {
      entities: entities.map((e) => ({
        entity_id: e.entity_id,
        name: e.name,
        types: e.types ?? [e.subtype].filter(Boolean),
        popularity: e.popularity,
        tags: ((e.tags as RawTag[] | undefined) ?? [])
          .filter((t) => keepTag(t.type, t.tag_id ?? t.id ?? ''))
          .map((t) => ({ tag_id: t.tag_id ?? t.id, name: t.name, type: t.type })),
      })),
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes('--confirm-paid-requests')) {
    console.error('Refusing: this harvest sends paid Qloo requests. Re-run with --confirm-paid-requests.');
    process.exit(2);
  }
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const max = Number(arg('--max') ?? 40);
  const only = new Set((arg('--only') ?? 'fashion,media,place,food,music').split(','));
  const fashionPages = Number(arg('--fashion-pages') ?? 20);
  const key = process.env.QLOO_API_KEY;
  const base = (process.env.QLOO_API_URL ?? 'https://hackathon.api.qloo.com').replace(/\/+$/, '');
  if (!key) throw new Error('QLOO_API_KEY is not set');
  const outDir = join(process.cwd(), 'fixtures/qloo/style-vocab/raw');
  mkdirSync(outDir, { recursive: true });
  const requests = plan(only, fashionPages);
  let sent = 0;
  let last = 0;
  const log: string[] = [];
  for (const r of requests) {
    if ((r as { done?: boolean }).done) continue;
    if (existsSync(join(outDir, `${r.id}.json`)) && !args.includes('--overwrite')) {
      log.push(`${r.id}\tskipped (recorded)`);
      continue;
    }
    let attempt = 0;
    for (;;) {
      if (sent >= max) {
        console.log(`stopped at --max ${max}`);
        console.log(log.join('\n'));
        return;
      }
      const wait = last + 150 - Date.now();
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      const qs = new URLSearchParams(Object.entries(r.params).map(([k, v]): [string, string] => [k, String(v)]));
      const started = Date.now();
      last = started;
      sent++;
      const res = await fetch(`${base}${r.path}?${qs}`, { headers: { 'X-Api-Key': key, Accept: 'application/json' } });
      const ms = Date.now() - started;
      const text = await res.text();
      if (res.status === 429 && attempt === 0) {
        attempt++;
        log.push(`${r.id}\t429\t${ms}ms (backing off 1100 ms, one retry)`);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        continue;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const reduced = reduceResponse(r.kind, body) as { results: { entities?: unknown[]; tags?: unknown[] } | null };
      const n = reduced.results?.entities?.length ?? reduced.results?.tags?.length ?? 0;
      log.push(`${r.id}\t${res.status}\t${ms}ms\t${n} results`);
      if (res.ok) {
        writeFileSync(
          join(outDir, `${r.id}.json`),
          `${JSON.stringify({ request: { path: r.path, params: r.params }, status: res.status, retrieved_at: new Date().toISOString(), duration_ms: ms, ...reduced })}\n`,
        );
      }
      // An empty page ends a paged series.
      if (res.ok && n === 0 && /-p\d+$/.test(r.id)) {
        const prefix = r.id.replace(/-p\d+$/, '');
        for (const later of requests) if (later.id.startsWith(prefix) && later !== r) (later as { done?: boolean }).done = true;
      }
      break;
    }
  }
  console.log(log.join('\n'));
  console.log(`requests sent: ${sent}`);
}

if (process.argv[1]?.endsWith('harvest-vocab.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
