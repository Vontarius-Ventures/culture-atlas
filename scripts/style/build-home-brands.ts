/**
 * Builds the home-brand catalogue (home-brands-1) from recorded Qloo responses only:
 *   fixtures/qloo/home-brands/raw/*.json   (/v2/insights brand pages, industry and genre filtered,
 *                                           recorded live by the style probe; see prp/2026-10-23-style-analysis)
 * Writes fixtures/qloo/home-brands/home-brands.json. No network.
 *
 * Every id and name comes verbatim from a recorded response (home-brands.test.ts re-checks
 * this). The same brand on two pages is merged (union of tags, max popularity).
 * target_* and market_archetype tags never enter; audience, channel and packaging tags
 * are not style and are left out. Nothing is renamed or invented.
 *
 * Usage: tsx scripts/style/build-home-brands.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEVER_HARVEST_RE } from './harvest-vocab';

export const HOME_BRANDS_VERSION = 'home-brands-1';

/** Tag families kept on a home brand: matchable style words, gates and market ties.
 * Qloo tag `type`s carry a namespace suffix (e.g. "urn:tag:industry:qloo"), so these are prefixes. */
const KEEP_TYPES = [
  'urn:tag:aesthetic_property',
  'urn:tag:material',
  'urn:tag:design_inspiration',
  'urn:tag:cultural_relevance',
  'urn:tag:lifestyle',
  'urn:tag:emotional_tone',
  'urn:tag:consumption_context',
  'urn:tag:core_value',
  'urn:tag:interest_adjacency',
  'urn:tag:keyword',
  'urn:tag:product_service',
  'urn:tag:product_line',
  'urn:tag:signature_product',
  'urn:tag:industry',
  'urn:tag:genre:brand',
  'urn:tag:price_level',
  'urn:tag:wikipedia_category',
  'urn:tag:style',
  'urn:tag:theme',
  'urn:tag:subgenre',
  'urn:tag:decor',
  'urn:tag:setting',
  'urn:tag:ambience',
] as const;

const isKeep = (t: RawTag) => !NEVER_HARVEST_RE.test(t.id) && KEEP_TYPES.some((p) => t.type === p || t.type.startsWith(`${p}:`));

interface RawTag {
  id: string;
  name: string;
  type: string;
}

interface RawEntity {
  entity_id: string;
  name: string;
  subtype: string;
  popularity?: number;
  tags: RawTag[];
}

interface BrandRow {
  id: string;
  name: string;
  popularity: number;
  price_level: string | null;
  industry_ids: string[];
  genre_ids: string[];
  style_tags: { id: string; name: string }[];
  /** The raw file the brand was first seen on (provenance). */
  seen_on: string;
}

function main(): void {
  const root = process.cwd();
  const rawDir = join(root, 'fixtures/qloo/home-brands/raw');
  const brands = new Map<string, BrandRow>();
  for (const file of readdirSync(rawDir).filter((f) => f.endsWith('.json')).sort()) {
    const body = JSON.parse(readFileSync(join(rawDir, file), 'utf8')) as { results?: { entities?: RawEntity[] } };
    for (const e of body.results?.entities ?? []) {
      if (e.subtype !== 'urn:entity:brand') continue;
      const tags = (e.tags ?? []).filter(isKeep);
      const price = tags.find((t) => t.type.startsWith('urn:tag:price_level'))?.name ?? null;
      const row = brands.get(e.entity_id);
      if (row) {
        row.popularity = Math.max(row.popularity, Math.round((e.popularity ?? 0) * 10000) / 10000);
        if (price && !row.price_level) row.price_level = price;
        for (const t of tags) {
          if (t.type.startsWith('urn:tag:industry')) {
            if (!row.industry_ids.includes(t.id)) row.industry_ids.push(t.id);
          } else if (t.type.startsWith('urn:tag:genre:brand')) {
            if (!row.genre_ids.includes(t.id)) row.genre_ids.push(t.id);
          } else if (!t.type.startsWith('urn:tag:price_level') && !row.style_tags.some((s) => s.id === t.id)) {
            row.style_tags.push({ id: t.id, name: t.name });
          }
        }
      } else {
        brands.set(e.entity_id, {
          id: e.entity_id,
          name: e.name,
          popularity: Math.round((e.popularity ?? 0) * 10000) / 10000,
          price_level: price,
          industry_ids: tags.filter((t) => t.type.startsWith('urn:tag:industry')).map((t) => t.id),
          genre_ids: tags.filter((t) => t.type.startsWith('urn:tag:genre:brand')).map((t) => t.id),
          style_tags: tags
            .filter((t) => !t.type.startsWith('urn:tag:industry') && !t.type.startsWith('urn:tag:genre:brand') && !t.type.startsWith('urn:tag:price_level'))
            .map((t) => ({ id: t.id, name: t.name })),
          seen_on: file,
        });
      }
    }
  }
  for (const row of brands.values()) {
    row.industry_ids.sort();
    row.genre_ids.sort();
    row.style_tags.sort((a, b) => a.id.localeCompare(b.id));
  }
  const rows = [...brands.values()].sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name));
  writeFileSync(
    join(root, 'fixtures/qloo/home-brands/home-brands.json'),
    `${JSON.stringify({ version: HOME_BRANDS_VERSION, built_from: 'fixtures/qloo/home-brands/raw', brands: rows }, null, 0)}\n`,
  );
  const byIndustry = new Map<string, number>();
  for (const r of rows) for (const i of r.industry_ids) byIndustry.set(i, (byIndustry.get(i) ?? 0) + 1);
  console.log(`home brands: ${rows.length}`, Object.fromEntries([...byIndustry.entries()].sort()));
}

if (process.argv[1]?.endsWith('build-home-brands.ts')) main();
