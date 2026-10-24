import { readFileSync } from 'node:fs';
import { resolveFromWorkspace, type QlooTag } from '@culture-atlas/providers';
import { describe, expect, it } from 'vitest';
import { acceptedTags, bestFilterTag, mapClaim, mapSubjectTags, primaryStyleTag, tagLookupQueries } from './map-tags';
import { storedAesthetic, storedSubject } from './test-support';
import type { StoredClaim } from './types';
import { styleVocabulary } from './vocabulary';

/** Recorded /v2/tags responses from the live style probe (fixtures/qloo/probe-2026-10-23). */
function probeTags(name: string): QlooTag[] {
  const body = JSON.parse(readFileSync(resolveFromWorkspace(`fixtures/qloo/probe-2026-10-23/${name}.json`), 'utf8')) as {
    results: { tags: { id: string; name: string; type: string; parents?: { type: string }[] }[] };
  };
  return body.results.tags.map((t) => ({ id: t.id, name: t.name, type: t.type, parents: (t.parents ?? []).map((p) => p.type) }));
}

const claim = (name: string, over: Partial<StoredClaim> & { tag_query?: string | null } = {}) => ({ name, wording: 'asserted' as const, corroborated_by: [], held: false, tag_query: null, ...over });
const v = styleVocabulary();
const none = new Map<string, QlooTag[]>();

describe('attribute -> Qloo tag ids (style design §C.2)', () => {
  const fashion = storedSubject({ category: 'fashion' });
  const interior = storedSubject({ category: 'interior', label: 'Low walnut sideboard' });

  it('accepts an exact vocabulary label for a fashion aesthetic, highest-priority namespace first', () => {
    const q = mapClaim(fashion, 'aesthetics', claim('Workwear'), v, none)!;
    expect(q.tag_ids).toEqual(['urn:tag:fashion_segment:qloo:workwear']);
    expect(q.acceptance).toBe('vocab_exact');
    expect(q.use).toBe('filter');
    expect(q.alt_ids.length).toBeGreaterThan(0);
  });

  it('maps a tag_query chosen from the closed list, including design_inspiration labels', () => {
    const q = mapClaim(fashion, 'aesthetics', claim('Varsity bomber', { tag_query: 'Vintage Americana' }), v, none)!;
    expect(q.tag_ids).toEqual(['urn:tag:design_inspiration:qloo:vintage_americana']);
  });

  it('"quiet luxury" never accepts ambience:quiet or amenity:luxury (exact only)', () => {
    const tags = new Map([['quiet luxury', probeTags('t22_quiet_luxury')]]);
    const q = mapClaim(interior, 'aesthetics', claim('Quiet luxury'), v, tags)!;
    expect(q.tag_ids).toEqual(['urn:tag:decor:qloo:quiet_luxury']);
    expect([...q.tag_ids, ...q.alt_ids]).not.toContain('urn:tag:ambience:qloo:quiet');
    expect([...q.tag_ids, ...q.alt_ids]).not.toContain('urn:tag:amenity:place:luxury');
  });

  it('"denim" on a fashion subject is only material:qloo:denim, never decor:denim_themed', () => {
    const tags = new Map([['denim', probeTags('t25_denim')]]);
    const q = mapClaim(fashion, 'materials', claim('Denim'), v, tags)!;
    expect(q.tag_ids).toEqual(['urn:tag:material:qloo:denim']);
    expect(q.alt_ids).toEqual([]);
    expect(q.use).toBe('signal');
  });

  it('routes food to restaurant genres and rejects other place genres (Q-STYLE-NS)', () => {
    const food = storedSubject({ category: 'food', label: 'Tonkotsu ramen bowl' });
    const tags = new Map([['Ramen', probeTags('t26_ramen')]]);
    const q = mapClaim(food, 'aesthetics', claim('Ramen'), v, tags)!;
    expect(q.tag_ids).toEqual(['urn:tag:genre:place:restaurant:ramen']);
    expect(q.alt_ids).not.toContain('urn:tag:genre:place:hotel:ramen');
    expect(q.alt_ids).not.toContain('urn:tag:category:place:ramen_restaurant');
    // specialty_dish is a food-only namespace.
    expect(mapClaim(interior, 'aesthetics', claim('Ramen'), v, tags)).toBeNull();
  });

  it('a type-incompatible tag drives reasons only, never filter.tags (Q-STYLE-TYPE)', () => {
    // decor tags are on places; a media subject's rail returns movies.
    const media = storedSubject({ category: 'media', label: 'Film poster' });
    const tags = new Map([['Japandi', probeTags('t01_japandi')]]);
    expect(mapClaim(media, 'aesthetics', claim('Japandi'), v, tags)).toBeNull();
    const q = mapClaim(interior, 'aesthetics', claim('Japandi'), v, tags)!;
    expect(q.tag_ids).toEqual(['urn:tag:decor:qloo:japandi']);
    expect(q.entity_types).toContain('urn:entity:place');
  });

  it('resembles claims never become filter tags; era and lineage are 0.3 signals', () => {
    expect(mapClaim(fashion, 'aesthetics', claim('Workwear', { wording: 'resembles' }), v, none)).toMatchObject({ use: 'signal', weight: 0.5 });
    expect(mapClaim(fashion, 'aesthetics', claim('Workwear', { wording: 'resembles', corroborated_by: ['qloo_entity'] }), v, none)).toMatchObject({ use: 'filter' });
    expect(mapClaim(fashion, 'lineage', claim('Workwear', { wording: 'resembles' }), v, none)).toMatchObject({ use: 'signal', weight: 0.3 });
  });

  it('no hit, no invention: qloo is null and held or retracted claims never map', () => {
    expect(mapClaim(fashion, 'aesthetics', claim('Rugged frontier utility'), v, none)).toBeNull();
    expect(mapClaim(fashion, 'aesthetics', claim('Workwear', { held: true }), v, none)).toBeNull();
    expect(mapClaim(fashion, 'aesthetics', claim('Workwear', { retracted: true }), v, none)).toBeNull();
    expect(mapClaim(storedSubject({ category: 'other' }), 'aesthetics', claim('Workwear'), v, none)).toBeNull();
  });

  it('fashion needs no tag lookups; other categories ask /v2/tags with the claim words (de-duplicated)', () => {
    expect(tagLookupQueries(storedSubject({ aesthetics: [storedAesthetic('Workwear')] }))).toEqual([]);
    expect(tagLookupQueries(storedSubject({ category: 'interior', aesthetics: [storedAesthetic('Japandi', { tag_query: 'Japandi' }), storedAesthetic('Japandi')] }))).toEqual(['Japandi']);
  });

  it('F is the strongest filterable aesthetic; the primary style tag falls back to the strongest mapped one', () => {
    const s = storedSubject({ aesthetics: [storedAesthetic('Workwear', { certainty: 0.9 }), storedAesthetic('Streetwear', { certainty: 0.6, wording: 'resembles' })] });
    mapSubjectTags(s, v, none);
    expect(bestFilterTag(s)).toEqual({ id: 'urn:tag:fashion_segment:qloo:workwear', claimName: 'Workwear' });
    const r = storedSubject({ aesthetics: [storedAesthetic('Streetwear', { certainty: 0.6, wording: 'resembles' })] });
    mapSubjectTags(r, v, none);
    expect(bestFilterTag(r)).toBeNull();
    expect(primaryStyleTag(r)).toEqual({ id: 'urn:tag:fashion_segment:qloo:streetwear', claimName: 'Streetwear' });
    expect(acceptedTags(r).some((t) => t.id === 'urn:tag:fashion_segment:qloo:streetwear' && t.primary)).toBe(true);
  });
});
