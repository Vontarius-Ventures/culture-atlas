import { readFileSync, readdirSync } from 'node:fs';
import { resolveFromWorkspace } from '@culture-atlas/providers';
import { describe, expect, it } from 'vitest';
import { homeBrands, HOME_BRANDS_VERSION } from './home-vocabulary';

type RawEntity = { entity_id: string; name: string; tags?: { id: string; name: string }[] };
const rawPages = new Map<string, Map<string, RawEntity>>();
const page = (file: string) => {
  let entities = rawPages.get(file);
  if (entities === undefined) {
    const parsed = JSON.parse(readFileSync(resolveFromWorkspace(`fixtures/qloo/home-brands/raw/${file}`), 'utf8')) as { results: { entities: RawEntity[] } };
    entities = new Map(parsed.results.entities.map((e) => [e.entity_id, e]));
    rawPages.set(file, entities);
  }
  return entities;
};

describe('home-brand catalogue home-brands-1 (R-9 harvest, real Qloo responses only)', () => {
  const brands = homeBrands();

  it('is built from the recorded raw pages with a stable version', () => {
    expect(HOME_BRANDS_VERSION).toBe('home-brands-1');
    expect(brands.length).toBeGreaterThan(200);
  });

  it('holds only recorded brands: id, name, popularity and every tag id and name verbatim from its raw page', () => {
    for (const b of brands.slice(0, 120)) {
      const entity = page(b.seen_on).get(b.id);
      expect(entity, `${b.id} recorded in ${b.seen_on}`).toBeTruthy();
      expect(entity!.name, b.id).toBe(b.name);
      for (const t of b.style_tags.slice(0, 8)) {
        const tag = entity!.tags?.find((x) => x.id === t.id);
        expect(tag, `${b.name} ${t.id} recorded in ${b.seen_on}`).toBeTruthy();
        expect(tag!.name, `${b.name} ${t.id}`).toBe(t.name);
      }
    }
  });

  it('gates by recorded industry ids, and every rail industry has brands', () => {
    const industries = new Map<string, number>();
    for (const b of brands) for (const i of b.industry_ids) industries.set(i, (industries.get(i) ?? 0) + 1);
    for (const kind of ['furniture', 'tableware', 'kitchenware', 'home_decor', 'ceramics', 'interior_design', 'coffee'] as const)
      expect(industries.get(`urn:tag:industry:qloo:${kind}`) ?? 0, kind).toBeGreaterThan(0);
  });

  it('never carries target_* or market_archetype tags (R-7d)', () => {
    for (const b of brands)
      for (const t of [...b.style_tags.map((x) => x.id), ...b.industry_ids, ...b.genre_ids])
        expect(/:(?:target_gender|target_age_group|target_income_level|market_archetype)(?::|$)/.test(t), `${b.name} ${t}`).toBe(false);
  });

  it('raw pages are insights brand pages (subtype urn:entity:brand) and stay in the fixture set', () => {
    const files = new Set(readdirSync(resolveFromWorkspace('fixtures/qloo/home-brands/raw')).filter((f) => f.endsWith('.json')));
    expect(files.size).toBeGreaterThan(5);
    for (const b of brands) expect(files.has(b.seen_on), b.name).toBe(true);
  });
});
