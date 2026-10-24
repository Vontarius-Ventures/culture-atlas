/**
 * Builds the style vocabulary (svocab-1) from recorded Qloo responses only:
 *   fixtures/qloo/style-vocab/raw/*.json      (scripts/style/harvest-vocab.ts)
 *   fixtures/qloo/probe-2026-10-23/t*.json    (/v2/tags responses from the live style probe)
 * Writes fixtures/qloo/style-vocab/vocab.json and brands.json. No network.
 *
 * Every id written comes verbatim from a recorded response, with the entity
 * and fixture it was seen on (vocabulary.test.ts re-checks this). Labels are
 * the tag's own `name`. target_* and market_archetype tags never enter (R-7d);
 * price_level ids are not unique in Qloo ("urn:tag:price_level:qloo:_" for
 * every level), so price levels are kept on brands by name only.
 *
 * Usage: tsx scripts/style/build-vocab.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { NEVER_HARVEST_RE } from './harvest-vocab';

export const VOCAB_VERSION = 'svocab-1';

/** Namespaces the mapper may use, by the tag type's namespace segment. */
export const VOCAB_NAMESPACES = [
  'fashion_segment',
  'personal_style',
  'aesthetic_property',
  'material',
  'design_inspiration',
  'cultural_relevance',
  'style',
  'theme',
  'subgenre',
  'genre:media',
  'decor',
  'setting',
  'ambience',
  'genre:place',
  'genre:music',
] as const;

/** Brand tag namespaces kept in brands.json for the R-1 exemplar matrix. */
const BRAND_STYLE_NAMESPACES = ['fashion_segment', 'personal_style', 'aesthetic_property', 'material', 'design_inspiration', 'cultural_relevance'];

export function namespaceOf(id: string): string | null {
  // urn:tag:<ns>:qloo:<value>  |  urn:tag:genre:place:restaurant:ramen  |  urn:tag:genre:media:...  |  urn:tag:decor:qloo:japandi
  const m = /^urn:tag:([a-z_]+)(?::([a-z_]+))?/.exec(id);
  if (!m) return null;
  if (m[1] === 'genre' && m[2]) return `genre:${m[2]}`;
  return m[1]!;
}

interface VocabEntry {
  id: string;
  label: string;
  namespace: string;
  entityTypes: string[];
  count: number;
  seenOn: { entityId: string | null; fixture: string };
}

interface BrandRow {
  id: string;
  name: string;
  popularity: number;
  style_tag_ids: string[];
  price_level: string | null;
}

function main(): void {
  const root = process.cwd();
  const vocab = new Map<string, VocabEntry>();
  const brands = new Map<string, BrandRow>();
  const add = (id: string, name: string, entityType: string | null, fixture: string, entityId: string | null) => {
    if (NEVER_HARVEST_RE.test(id)) return;
    const ns = namespaceOf(id);
    if (!ns || !(VOCAB_NAMESPACES as readonly string[]).includes(ns)) return;
    if (ns === 'genre:place' && !id.startsWith('urn:tag:genre:place:restaurant')) return;
    const e = vocab.get(id);
    if (e) {
      e.count++;
      if (entityType && !e.entityTypes.includes(entityType)) e.entityTypes.push(entityType);
      return;
    }
    vocab.set(id, { id, label: name, namespace: ns, entityTypes: entityType ? [entityType] : [], count: 1, seenOn: { entityId, fixture } });
  };

  const rawDir = join(root, 'fixtures/qloo/style-vocab/raw');
  for (const file of readdirSync(rawDir).filter((f) => f.endsWith('.json')).sort()) {
    const fixture = `style-vocab/raw/${file}`;
    const body = JSON.parse(readFileSync(join(rawDir, file), 'utf8')) as {
      results?: { entities?: { entity_id: string; name: string; types?: string[]; popularity?: number; tags: { tag_id: string; name: string; type?: string }[] }[]; tags?: { id: string; name: string; parents?: { type?: string }[] }[] };
    };
    for (const e of body.results?.entities ?? []) {
      const type = e.types?.[0] ?? null;
      for (const t of e.tags) add(t.tag_id, t.name, type, fixture, e.entity_id);
      if (type === 'urn:entity:brand' && file.startsWith('fashion-brands')) {
        const ids = e.tags.filter((t) => BRAND_STYLE_NAMESPACES.includes(namespaceOf(t.tag_id) ?? '')).map((t) => t.tag_id);
        const price = e.tags.find((t) => t.tag_id.startsWith('urn:tag:price_level:'))?.name ?? null;
        if (!brands.has(e.entity_id))
          brands.set(e.entity_id, { id: e.entity_id, name: e.name, popularity: Math.round((e.popularity ?? 0) * 10000) / 10000, style_tag_ids: [...new Set(ids)].sort(), price_level: price });
      }
    }
    for (const t of body.results?.tags ?? []) {
      const parent = Array.isArray(t.parents) ? (t.parents[0]?.type ?? null) : null;
      add(t.id, t.name, parent, fixture, null);
    }
  }
  const probeDir = join(root, 'fixtures/qloo/probe-2026-10-23');
  for (const file of readdirSync(probeDir).filter((f) => /^t\d+_.*\.json$/.test(f)).sort()) {
    const body = JSON.parse(readFileSync(join(probeDir, file), 'utf8')) as { results?: { tags?: { id: string; name: string; parents?: { type?: string }[] }[] } };
    for (const t of body.results?.tags ?? []) add(t.id, t.name, t.parents?.[0]?.type ?? null, `probe-2026-10-23/${basename(file)}`, null);
  }
  const entries = [...vocab.values()].sort((a, b) => a.namespace.localeCompare(b.namespace) || b.count - a.count || a.id.localeCompare(b.id));
  writeFileSync(
    join(root, 'fixtures/qloo/style-vocab/vocab.json'),
    `${JSON.stringify({ version: VOCAB_VERSION, built_from: ['fixtures/qloo/style-vocab/raw', 'fixtures/qloo/probe-2026-10-23/t*.json'], entries }, null, 0)}\n`,
  );
  const brandRows = [...brands.values()].sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name));
  writeFileSync(join(root, 'fixtures/qloo/style-vocab/brands.json'), `${JSON.stringify({ version: VOCAB_VERSION, brands: brandRows })}\n`);
  const byNs = new Map<string, number>();
  for (const e of entries) byNs.set(e.namespace, (byNs.get(e.namespace) ?? 0) + 1);
  console.log(`vocab entries: ${entries.length}`, Object.fromEntries(byNs));
  console.log(`brands: ${brandRows.length}`);
}

if (process.argv[1]?.endsWith('build-vocab.ts')) main();
