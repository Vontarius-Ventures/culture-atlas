import { describe, expect, it } from 'vitest';
import type { QlooEntity, QlooTag } from '@culture-atlas/providers';
import {
  acceptMatch,
  CUISINE_TAG_TYPES,
  definingStyleTag,
  FORBIDDEN_TAG_FAMILIES,
  GROUNDING_VERSION,
  headToken,
  MEDIA_TAG_TYPES,
  MUSIC_TAG_TYPES,
  planLookup,
  STYLE_TAG_TYPES,
  textCorroborates,
  type GuardedCandidate,
  type LookupPlan,
} from './grounding';
import { nameSimilarity } from './text';

/**
 * Qloo grounding rules (docs/quality-plan.md §5). Every result below is a
 * hand-written FIXTURE shaped like a live Qloo failure recorded in the
 * diagnose phase (look-alike places, model -> maker, music genre ranked ahead
 * of decor, dishes and menu items, containment supersets, duplicate places,
 * places without popularity) or like a live success. None is real Qloo data.
 */

const ent = (id: string, name: string, type: string, extra: Partial<QlooEntity> = {}): QlooEntity => ({
  entity_id: `FIXTURE-${id}`,
  name,
  types: [type],
  properties: {},
  tags: [],
  ...extra,
});
const tag = (family: string, slug: string, name: string): QlooTag => ({ id: `${family}:fixture_${slug}`, name, type: family });
const cand = (c: Partial<GuardedCandidate> & Pick<GuardedCandidate, 'name' | 'type'>): GuardedCandidate => ({
  relation: 'resembles',
  certainty: 0.6,
  tag_queries: [],
  suggested_categories: [],
  ...c,
});
const searchPlan = (c: GuardedCandidate) => {
  const plan = planLookup(c);
  if (plan.kind !== 'search') throw new Error(`expected a search plan, got ${JSON.stringify(plan)}`);
  return plan;
};
const tagsPlan = (c: GuardedCandidate) => {
  const plan = planLookup(c);
  if (plan.kind !== 'tags') throw new Error(`expected a tags plan, got ${JSON.stringify(plan)}`);
  return plan;
};

describe('planLookup: what Qloo is asked (Q-TYPE, Q-TAGTYPES, Q-EVIDENCE)', () => {
  it('never sends an object to /search (Basketball, Paper grocery bags, Crystal chandelier)', () => {
    for (const name of ['Basketball', 'Paper grocery bags', 'Crystal chandelier', 'Nissan X-Trail']) {
      expect(planLookup(cand({ name, type: 'object', relation: 'depicted', certainty: 0.95 }))).toEqual({ kind: 'none', reason: 'object_not_searched' });
    }
  });

  it('searches a corroborated brand-like object as a brand, by its maker word only, never a colour (ground-v3)', () => {
    const plan = planLookup(cand({ name: 'Fixturo NBA basketball', type: 'object', corroborated: true }));
    expect(plan).toEqual({ kind: 'search', query: 'fixturo', types: ['urn:entity:brand'] });
    // "Blue Bottle Coffee cup" read from "BLUE MONDAY SALE" was searched as "blue" under ground-v2.
    expect(planLookup(cand({ name: 'Blue Fixture Coffee cup', type: 'object', corroborated: true }))).toEqual({
      kind: 'search',
      query: 'fixture',
      types: ['urn:entity:brand'],
    });
  });

  it('does not search a brand without corroboration (Spalding / Honda Civic guessed from shape)', () => {
    expect(planLookup(cand({ name: 'Fixturo Civic', type: 'brand', relation: 'depicted', certainty: 0.9 }))).toEqual({ kind: 'none', reason: 'brand_not_corroborated' });
    expect(planLookup(cand({ name: 'Fixturo Civic', type: 'brand', corroborated: false }))).toEqual({ kind: 'none', reason: 'brand_not_corroborated' });
    expect(planLookup(cand({ name: 'Fixturedale', type: 'brand', corroborated: true }))).toEqual({ kind: 'search', query: 'Fixturedale', types: ['urn:entity:brand'] });
  });

  it('allows only the entity types of the candidate type', () => {
    expect(searchPlan(cand({ name: 'Fixture Director', type: 'creator' })).types).toEqual(['urn:entity:artist', 'urn:entity:director', 'urn:entity:person', 'urn:entity:author']);
    expect(searchPlan(cand({ name: 'Fixture Album', type: 'work' })).types).toEqual(['urn:entity:movie', 'urn:entity:album', 'urn:entity:book', 'urn:entity:tv_show']);
    expect(searchPlan(cand({ name: 'Fixture City', type: 'place', certainty: 0.7 })).types).toEqual(['urn:entity:destination', 'urn:entity:locality', 'urn:entity:place']);
  });

  it('needs evidence before a place lookup: read text, depicted, or certainty >= 0.5', () => {
    expect(planLookup(cand({ name: 'Fixture Lahore', type: 'place', certainty: 0.3 }))).toEqual({ kind: 'none', reason: 'place_without_evidence' });
    expect(planLookup(cand({ name: 'Fixture Lahore', type: 'place', certainty: 0.49 })).kind).toBe('none');
    expect(planLookup(cand({ name: 'Fixture Lahore', type: 'place', certainty: 0.5 })).kind).toBe('search');
    expect(planLookup(cand({ name: 'Fixture Palais', type: 'place', certainty: 0.2, relation: 'depicted' })).kind).toBe('search');
    expect(planLookup(cand({ name: 'Fixture Palais', type: 'place', certainty: 0.2, evidence: 'read_text', evidence_text: 'FIXTURE PALAIS' })).kind).toBe('search');
  });

  it('needs a depicted dish or certainty >= 0.5 before a cuisine lookup, and strips "cuisine"/"food"', () => {
    expect(planLookup(cand({ name: 'Spanish cuisine', type: 'cuisine', certainty: 0.3 }))).toEqual({ kind: 'none', reason: 'cuisine_without_evidence' });
    expect(planLookup(cand({ name: 'Spanish cuisine', type: 'cuisine', certainty: 0.6 }))).toEqual({ kind: 'tags', query: 'Spanish', tagTypes: [...CUISINE_TAG_TYPES] });
    expect(planLookup(cand({ name: 'Fixture noodles', type: 'cuisine', relation: 'depicted', certainty: 0.3, tag_queries: ['fixture noodle food'] }))).toEqual({ kind: 'tags', query: 'fixture noodle', tagTypes: [...CUISINE_TAG_TYPES] });
  });

  it('every tag lookup carries tag types: style families, plus music or media genres only for that domain', () => {
    expect(tagsPlan(cand({ name: 'Mughal architecture', type: 'style' })).tagTypes).toEqual([...STYLE_TAG_TYPES]);
    expect(tagsPlan(cand({ name: 'Bossa nova', type: 'tradition', domain: 'music' })).tagTypes).toEqual([...MUSIC_TAG_TYPES, ...STYLE_TAG_TYPES]);
    expect(tagsPlan(cand({ name: 'Film noir', type: 'style', domain: 'film' })).tagTypes).toEqual([...MEDIA_TAG_TYPES, ...STYLE_TAG_TYPES]);
    expect(tagsPlan(cand({ name: 'Neoclassicism', type: 'style', domain: 'architecture', suggested_categories: ['play'] })).tagTypes).toEqual([...STYLE_TAG_TYPES]);
    // Legacy readings without a domain: a single derived category stands in for it.
    expect(tagsPlan(cand({ name: 'Bossa nova', type: 'style', suggested_categories: ['play'] })).tagTypes).toEqual([...MUSIC_TAG_TYPES, ...STYLE_TAG_TYPES]);
    expect(tagsPlan(cand({ name: 'Neoclassicism', type: 'style', suggested_categories: ['wear', 'watch'] })).tagTypes).toEqual([...STYLE_TAG_TYPES]);
    // The tag query is the model's tag_query when present.
    expect(tagsPlan(cand({ name: 'Victorian terraced houses', type: 'style', tag_queries: ['Victorian architecture'] })).query).toBe('Victorian architecture');
    expect(tagsPlan(cand({ name: 'Victorian terraced houses', type: 'style', tag_query: 'Victorian' })).query).toBe('Victorian');
    for (const type of ['style', 'tradition', 'cuisine']) {
      const plan = planLookup(cand({ name: 'Fixture', type, certainty: 0.9 }));
      expect(plan.kind === 'tags' && plan.tagTypes.length > 0).toBe(true);
    }
  });

  it('never looks up medium words (still life, painting) unless a labelled work names them', () => {
    expect(planLookup(cand({ name: 'Still life painting', type: 'style', tag_queries: ['still life'] }))).toEqual({ kind: 'none', reason: 'medium_word' });
    expect(planLookup(cand({ name: 'Fixture citrus', type: 'style', tag_queries: ['citrus still life'] }))).toEqual({ kind: 'none', reason: 'medium_word' });
    expect(planLookup(cand({ name: 'Fixture Painting No. 5', type: 'work', evidence: 'read_text', evidence_text: 'Fixture Painting No. 5' })).kind).toBe('search');
  });

  it('a reference the user named is searched without evidence; an untyped one across every type', () => {
    expect(planLookup(cand({ name: 'Fixturo Civic', type: 'brand', userSelected: true }))).toEqual({ kind: 'search', query: 'Fixturo Civic', types: ['urn:entity:brand'] });
    expect(planLookup(cand({ name: 'Fixture Wes', type: 'object', userSelected: true }))).toEqual({ kind: 'search', query: 'Fixture Wes', types: [] });
    expect(planLookup(cand({ name: 'Fixture Lahore', type: 'place', certainty: 0.1, userSelected: true })).kind).toBe('search');
  });
});

describe('acceptMatch: the same thing, or nothing (Q-NAME, Q-SUBSET, Q-PLACE, Q-DOUBT)', () => {
  it('rejects the model-to-maker subset (Honda for "Honda Civic")', () => {
    const c = cand({ name: 'Fixturo Civic', type: 'brand', corroborated: true });
    const results = [ent('B1', 'Fixturo', 'urn:entity:brand'), ent('B2', 'Repsol Fixturo Team', 'urn:entity:brand')];
    expect(acceptMatch(c, searchPlan(c), results)).toEqual({ match: null, rule: 'Q-SUBSET', reason: 'shorter_name' });
  });

  it('accepts a brand that adds only a corporate suffix (Cannondale -> Cannondale Bicycles)', () => {
    const c = cand({ name: 'Fixturedale', type: 'brand', corroborated: true });
    const results = [ent('B3', 'Fixturedale Bicycles', 'urn:entity:brand')];
    expect(acceptMatch(c, searchPlan(c), results)).toMatchObject({ match: { name: 'Fixturedale Bicycles' }, rule: 'Q-NAME', reason: 'exact_brand' });
    const longer = [ent('B4', 'Fixturedale Racing Club', 'urn:entity:brand')];
    expect(acceptMatch(c, searchPlan(c), longer)).toMatchObject({ match: null, rule: 'Q-NAME' });
  });

  it('rejects two different brands of the same name (reject on doubt)', () => {
    const c = cand({ name: 'Fixturedale', type: 'brand', corroborated: true });
    const results = [ent('B5', 'Fixturedale', 'urn:entity:brand'), ent('B6', 'Fixturedale Group', 'urn:entity:brand')];
    expect(acceptMatch(c, searchPlan(c), results)).toEqual({ match: null, rule: 'Q-DOUBT', reason: 'several_exact_matches' });
  });

  it('rejects containment supersets the old similarity accepted (a B&B hotel for "Musée du Louvre")', () => {
    const c = cand({ name: 'Musée du Fixture', type: 'place', relation: 'depicted', certainty: 0.95 });
    const hotel = ent('P1', 'B&B HOTEL Lens Musée du Fixture', 'urn:entity:place', { popularity: 0.88 });
    expect(nameSimilarity(c.name, hotel.name)).toBeGreaterThanOrEqual(0.75); // what the old matcher accepted
    expect(acceptMatch(c, searchPlan(c), [hotel])).toEqual({ match: null, rule: 'Q-NAME', reason: 'no_exact_name' });
  });

  it('rejects an exact-name place look-alike with no popularity (Yuyuan Garden in Xiamen)', () => {
    const c = cand({ name: 'Fixture Garden', type: 'place', relation: 'depicted', certainty: 0.8 });
    const results = [ent('P2', 'Fixture Garden', 'urn:entity:place', { properties: { geocode: { city: 'Fixtureville', country_code: 'CN' } } }), ent('P3', 'Fixture Garden Coffee Shop', 'urn:entity:place', { popularity: 0.9 })];
    expect(acceptMatch(c, searchPlan(c), results)).toEqual({ match: null, rule: 'Q-PLACE', reason: 'no_popularity' });
  });

  it('rejects duplicate exact places in different localities (Palais Royal in Laval and Courbevoie)', () => {
    const c = cand({ name: 'Fixture Palais', type: 'place', relation: 'depicted', certainty: 0.9 });
    const results = [
      ent('P4', 'Fixture Palais', 'urn:entity:place', { popularity: 0.68, properties: { geocode: { city: 'Laval', country_code: 'FR' } } }),
      ent('P5', 'Fixture Palais', 'urn:entity:place', { popularity: 0.44, properties: { geocode: { city: 'Courbevoie', country_code: 'FR' } } }),
    ];
    expect(acceptMatch(c, searchPlan(c), results)).toEqual({ match: null, rule: 'Q-PLACE', reason: 'same_name_in_several_places' });
    // Same name, same locality: one place listed twice is not a doubt.
    const twice = [results[0]!, { ...results[0]!, entity_id: 'FIXTURE-P6', popularity: 0.5 }];
    expect(acceptMatch(c, searchPlan(c), twice)).toMatchObject({ match: { entity_id: 'FIXTURE-P4' }, rule: 'Q-NAME' });
  });

  it('prefers a destination over same-named localities and venues (Madrid, London)', () => {
    const c = cand({ name: 'Fixtureton', type: 'place', certainty: 0.55 });
    const results = [
      ent('L1', 'Fixtureton', 'urn:entity:locality', { popularity: 0.99, disambiguation: 'Fixtureton, Region A, Country A' }),
      ent('L2', 'Fixtureton', 'urn:entity:locality', { popularity: 0.97, disambiguation: 'Fixtureton, Region B, Country B' }),
      ent('D1', 'Fixtureton', 'urn:entity:destination', { popularity: 0.99 }),
      ent('V1', 'Fixtureton', 'urn:entity:place', { popularity: 0.74, properties: { geocode: { city: 'Zurich', country_code: 'CH' } } }),
    ];
    expect(acceptMatch(c, searchPlan(c), results)).toMatchObject({ match: { entity_id: 'FIXTURE-D1' }, rule: 'Q-NAME', reason: 'exact_place' });
    // Without the destination, two same-named localities are a doubt.
    expect(acceptMatch(c, searchPlan(c), results.slice(0, 2))).toMatchObject({ match: null, rule: 'Q-PLACE' });
  });

  it('matches a place by one of its akas', () => {
    const c = cand({ name: 'Fixture-Royal', type: 'place', relation: 'depicted', certainty: 0.9 });
    const quartier = ent('L3', 'Quartier du Fixture Royal', 'urn:entity:locality', { popularity: 0.98, properties: { akas: [{ language: 'fr', value: 'Fixture Royal' }] } });
    expect(acceptMatch(c, searchPlan(c), [quartier])).toMatchObject({ match: { entity_id: 'FIXTURE-L3' } });
  });

  it('rejects a result of a type the candidate does not allow (Basketball VR, an album for a jacket)', () => {
    const c = cand({ name: 'Fixture Racing Jacket', type: 'work', certainty: 0.9 });
    const results = [ent('X1', 'Fixture Racing Jacket', 'urn:entity:videogame'), ent('X2', 'Fixture Racing Jacket', 'urn:entity:place')];
    expect(acceptMatch(c, searchPlan(c), results)).toEqual({ match: null, rule: 'Q-TYPE', reason: 'no_allowed_entity_type' });
  });

  it('rejects two exact works of different types instead of picking one (reject on doubt)', () => {
    const c = cand({ name: 'Fixture Echo', type: 'work', certainty: 0.9 });
    const results = [ent('W1', 'Fixture Echo', 'urn:entity:album'), ent('W2', 'Fixture Echo', 'urn:entity:movie')];
    expect(acceptMatch(c, searchPlan(c), results)).toEqual({ match: null, rule: 'Q-DOUBT', reason: 'exact_matches_of_different_types' });
    expect(acceptMatch(c, searchPlan(c), [results[0]!])).toMatchObject({ match: { entity_id: 'FIXTURE-W1' }, reason: 'exact_name' });
  });

  it('ground-v2: a film work or creator takes the one exact match of its medium, else stays in doubt', () => {
    const film = cand({ name: 'Fixture Echo', type: 'work', certainty: 0.9, domain: 'film' });
    const results = [ent('W1', 'Fixture Echo', 'urn:entity:book'), ent('W2', 'Fixture Echo', 'urn:entity:movie')];
    // ground-v5: a film work is searched among films and TV shows only, so the book is not a rival any more.
    expect(acceptMatch(film, searchPlan(film), results)).toMatchObject({ match: { entity_id: 'FIXTURE-W2' }, rule: 'Q-NAME', reason: 'exact_name' });
    // Two same-named movies: still a doubt.
    const twoMovies = [...results, ent('W3', 'Fixture Echo', 'urn:entity:movie')];
    expect(acceptMatch(film, searchPlan(film), twoMovies)).toMatchObject({ match: null, rule: 'Q-DOUBT' });
    // No medium domain: no preference (the original reject-on-doubt).
    const plain = cand({ name: 'Fixture Echo', type: 'work', certainty: 0.9, domain: 'other' });
    expect(acceptMatch(plain, searchPlan(plain), results)).toMatchObject({ match: null, rule: 'Q-DOUBT', reason: 'exact_matches_of_different_types' });
    const director = cand({ name: 'Fixture Person', type: 'creator', certainty: 0.9, domain: 'film', evidence: 'read_text' });
    const people = [ent('P1', 'Fixture Person', 'urn:entity:person'), ent('P2', 'Fixture Person', 'urn:entity:director')];
    expect(acceptMatch(director, searchPlan(director), people)).toMatchObject({ match: { entity_id: 'FIXTURE-P2' }, reason: 'exact_name_domain_type' });
  });

  it('ground-v2: "painted" on a craft is decoration, so it is looked up; a still life never is', () => {
    expect(planLookup(cand({ name: 'Hand-painted fixture stools', type: 'tradition', domain: 'craft', tag_queries: ['painted folk furniture'] }))).toMatchObject({ kind: 'tags' });
    expect(planLookup(cand({ name: 'Painted fixture scene', type: 'style', domain: 'art', tag_queries: ['painted scene'] }))).toEqual({ kind: 'none', reason: 'medium_word' });
  });

  it('takes decor over a music genre ranked first for a non-music style (Neoclassical)', () => {
    const c = cand({ name: 'Neoclassicism', type: 'style', tag_queries: ['neoclassical'], domain: 'architecture' });
    const results = [
      tag('urn:tag:genre:music', 'neoclassical', 'Neoclassical'),
      tag('urn:tag:decor:qloo', 'neoclassical', 'Neoclassical'),
      tag('urn:tag:setting:qloo', 'neoclassical_building', 'Neoclassical Building'),
    ];
    expect(acceptMatch(c, tagsPlan(c), results)).toMatchObject({ match: { id: 'urn:tag:decor:qloo:fixture_neoclassical' }, rule: 'Q-NAME', reason: 'exact_tag' });
    // For a music candidate the genre is the right tag.
    const music = cand({ name: 'Neoclassical', type: 'tradition', domain: 'music' });
    expect(acceptMatch(music, tagsPlan(music), results)).toMatchObject({ match: { id: 'urn:tag:genre:music:fixture_neoclassical' } });
  });

  it('never accepts dishes, menu items, occupations or place categories (fruit salad, still life painter)', () => {
    const c = cand({ name: 'Fruit salad', type: 'cuisine', relation: 'depicted', certainty: 0.9 });
    const dishes = [tag('urn:tag:specialty_dish:place', 'fruit_salad', 'Fruit Salad'), tag('urn:tag:menu_highlight:qloo', 'fruit_salad', 'Fruit Salad')];
    expect(acceptMatch(c, tagsPlan(c), dishes)).toEqual({ match: null, rule: 'Q-TAGTYPES', reason: 'no_allowed_tag_type' });
    const s = cand({ name: 'Fixture ceramics', type: 'tradition' });
    const forbidden = FORBIDDEN_TAG_FAMILIES.map((f, i) => tag(f, `x${i}`, 'Fixture Ceramics'));
    // Even if Qloo ignored the requested tag types, a forbidden family never matches.
    expect(acceptMatch(s, { kind: 'tags', query: 'fixture ceramics', tagTypes: [...FORBIDDEN_TAG_FAMILIES] }, forbidden)).toEqual({ match: null, rule: 'Q-TAGTYPES', reason: 'no_allowed_tag_type' });
  });

  it('accepts canonical-equal tags and rejects shorter ones (Mughal Architecture yes, Islamic for Islamic ceramics no)', () => {
    const mughal = cand({ name: 'Mughal architecture', type: 'style', tag_queries: ['Mughal architecture'] });
    const r1 = [tag('urn:tag:decor:qloo', 'mughal_architecture', 'Mughal Architecture'), tag('urn:tag:setting:qloo', 'mughal_architecture', 'Mughal Architecture')];
    expect(acceptMatch(mughal, tagsPlan(mughal), r1)).toMatchObject({ match: { type: 'urn:tag:decor:qloo' }, rule: 'Q-NAME' });
    const islamic = cand({ name: 'Islamic ceramic art', type: 'tradition', tag_queries: ['Islamic ceramics'] });
    const r2 = [tag('urn:tag:decor:qloo', 'islamic', 'Islamic'), tag('urn:tag:decor:qloo', 'handmade_ceramics', 'Handmade Ceramics')];
    expect(acceptMatch(islamic, tagsPlan(islamic), r2)).toEqual({ match: null, rule: 'Q-SUBSET', reason: 'shorter_name' });
    // Neither a longer tag ("Mid-Century Modern Furniture Store") nor a fuzzy one.
    const mcm = cand({ name: 'Mid-century modern', type: 'style', tag_queries: ['mid-century modern'] });
    expect(acceptMatch(mcm, tagsPlan(mcm), [tag('urn:tag:setting:qloo', 'mcm_store', 'Mid-Century Modern Furniture Store')])).toMatchObject({ match: null, rule: 'Q-NAME' });
    expect(acceptMatch(mcm, tagsPlan(mcm), [tag('urn:tag:decor:qloo', 'mcm', 'Mid Century Modern')])).toMatchObject({ match: { name: 'Mid Century Modern' } });
  });

  it('matches a cuisine tag on the stripped query (Shanghainese for "Shanghainese cuisine")', () => {
    const c = cand({ name: 'Shanghainese cuisine', type: 'cuisine', relation: 'depicted', certainty: 0.8 });
    const results = [tag('urn:tag:cuisine:qloo', 'shanghainese', 'Shanghainese'), tag('urn:tag:genre:place', 'shanghainese', 'Shanghainese restaurant')];
    expect(acceptMatch(c, tagsPlan(c), results)).toMatchObject({ match: { id: 'urn:tag:cuisine:qloo:fixture_shanghainese' } });
  });

  it('a "none" plan never matches anything, and empty results are a plain miss', () => {
    const c = cand({ name: 'Fixture bag', type: 'object' });
    const plan: LookupPlan = planLookup(c);
    expect(acceptMatch(c, plan, [ent('O1', 'Fixture bag', 'urn:entity:brand')])).toEqual({ match: null, rule: 'Q-EVIDENCE', reason: 'object_not_searched' });
    const s = cand({ name: 'Fixture style', type: 'style' });
    expect(acceptMatch(s, tagsPlan(s), [])).toEqual({ match: null, rule: 'Q-NAME', reason: 'no_results' });
  });

  it('a user-named untyped reference accepts any type, but still only one exact match', () => {
    const c = cand({ name: 'Fixture Wes', type: 'object', userSelected: true });
    expect(acceptMatch(c, searchPlan(c), [ent('U1', 'Fixture Wes', 'urn:entity:director')])).toMatchObject({ match: { entity_id: 'FIXTURE-U1' } });
    expect(acceptMatch(c, searchPlan(c), [ent('U1', 'Fixture Wes', 'urn:entity:director'), ent('U2', 'Fixture Wes', 'urn:entity:album')])).toMatchObject({ match: null, rule: 'Q-DOUBT' });
  });

  it('compares non-Latin names verbatim instead of dropping them', () => {
    const c = cand({ name: '愚园路', type: 'place', relation: 'depicted', certainty: 0.9 });
    const results = [ent('C1', '愚园路', 'urn:entity:locality', { popularity: 0.8 }), ent('C2', '豫园', 'urn:entity:place', { popularity: 0.9 })];
    expect(acceptMatch(c, searchPlan(c), results)).toMatchObject({ match: { entity_id: 'FIXTURE-C1' } });
    expect(acceptMatch(c, searchPlan(c), [results[1]!])).toMatchObject({ match: null });
  });

  it('is versioned', () => {
    expect(GROUNDING_VERSION).toBe('ground-v7');
  });
});

describe('ground-v4 (requalification decisions 2 and 4)', () => {
  it('never searches a text-only reference, whatever its type or evidence', () => {
    for (const type of ['brand', 'creator', 'place', 'object', 'work'])
      expect(planLookup(cand({ name: 'NBA', type, relation: 'depicted', certainty: 0.9, corroborated: true, evidence: 'read_text', text_only: true }))).toEqual({
        kind: 'none',
        reason: 'text_only_reference',
      });
  });

  // FIXTURE shapes of the recorded p13 miss: Qloo lists the league's full name first and several "NBA ..." brands after it.
  const league = ent('league', 'National Basketball Association', 'urn:entity:brand');
  const nbaResults = [league, ent('game', 'NBA 2k23', 'urn:entity:brand'), ent('tv', 'NBA TV', 'urn:entity:brand'), ent('store', 'NBA Store', 'urn:entity:brand')];

  it('Q-ACRONYM: a brand written as an acronym is the one brand whose full name has those initials', () => {
    const nba = cand({ name: 'NBA', type: 'brand', relation: 'depicted', certainty: 0.9, corroborated: true });
    expect(acceptMatch(nba, searchPlan(nba), nbaResults)).toEqual({ match: league, rule: 'Q-NAME', reason: 'exact_brand_acronym' });
    // As a corroborated object, searched by its maker word ("NBA court" -> "nba"), the same.
    const court = cand({ name: 'NBA court', type: 'object', corroborated: true });
    expect(acceptMatch(court, searchPlan(court), nbaResults).match).toBe(league);
  });

  it('Q-ACRONYM never fires on a lower-case word, a one-word name, or when an exact name exists', () => {
    const lower = cand({ name: 'Nba', type: 'brand', corroborated: true });
    expect(acceptMatch(lower, searchPlan(lower), nbaResults)).toMatchObject({ match: null, reason: 'no_exact_name' });
    const fila = cand({ name: 'FILA', type: 'brand', corroborated: true });
    const filaResults = [ent('fila', 'Fila', 'urn:entity:brand'), ent('phl', 'Philadelphia Fixture Lions Association', 'urn:entity:brand')];
    expect(acceptMatch(fila, searchPlan(fila), filaResults)).toMatchObject({ match: { name: 'Fila' }, reason: 'exact_brand' });
    const single = cand({ name: 'EMT', type: 'brand', corroborated: true });
    expect(acceptMatch(single, searchPlan(single), [ent('e', 'Emtek', 'urn:entity:brand')])).toMatchObject({ match: null });
  });

  it('Q-ACRONYM rejects on doubt: two brands with the same initials are neither accepted', () => {
    const nba = cand({ name: 'NBA', type: 'brand', corroborated: true });
    const two = [league, ent('other', 'National Bicycle Alliance', 'urn:entity:brand')];
    expect(acceptMatch(nba, searchPlan(nba), two)).toEqual({ match: null, rule: 'Q-DOUBT', reason: 'several_acronym_expansions' });
    // Only brand searches: a place or creator acronym is never expanded.
    const place = cand({ name: 'EMT', type: 'place', relation: 'depicted', certainty: 0.9 });
    expect(acceptMatch(place, searchPlan(place), [ent('p', 'Estación Madrid Tren', 'urn:entity:place', { popularity: 0.5 })])).toMatchObject({ match: null });
  });
});

describe('brand corroboration by read text (G-BRAND-CORROBORATE (a))', () => {
  it('needs every brand word as a whole word in a transcription, accent- and case-insensitively', () => {
    expect(headToken('Fixturo NBA basketball')).toBe('fixturo');
    expect(headToken('The Fixturedale CAAD8')).toBe('fixturedale');
    expect(textCorroborates('Fixturedale', ['FIXTUREDALE'])).toBe(true);
    expect(textCorroborates('Fixture Denim Co', ['FIXTURE DENIM'])).toBe(true);
    // ground-v3: a make read on a badge does not vouch for a model guessed from the shape.
    expect(textCorroborates('Citroën Fixture', ['CITROEN'])).toBe(false);
    expect(textCorroborates('Citroën Fixture', ['CITROEN', 'FIXTURE'])).toBe(true);
    expect(textCorroborates('Blue Fixture Coffee', ['BLUE MONDAY SALE'])).toBe(false);
    expect(textCorroborates('Fixturo', ['NBA'])).toBe(false);
    expect(textCorroborates('Fixturo', ['FIXTUROS'])).toBe(false);
    expect(textCorroborates('Fixturo', [])).toBe(false);
  });
});

/*
 * ground-v5 (round 4, after iteration 4, docs/quality-plan.md §19.21): an accepted Qloo item must be the
 * candidate's own kind. FIXTURE shapes of the wrong matches judged in the iteration-3 and -4 grounding runs.
 */
describe('ground-v5: acceptance by the candidate\'s kind and domain', () => {
  it('a work in a visual domain is never searched among films, albums or books (h57, h61 shapes); a film or music work keeps its type', () => {
    for (const domain of ['art', 'architecture', 'signage', 'craft'])
      expect(planLookup(cand({ name: 'Fixture stained glass windows', type: 'work', domain, relation: 'depicted', certainty: 0.8 }))).toEqual({
        kind: 'none',
        reason: 'work_without_entity_type',
      });
    expect(planLookup(cand({ name: 'Girl with a Fixture Earring', type: 'work', domain: 'art', certainty: 0.8 }))).toMatchObject({ kind: 'none' });
    expect(searchPlan(cand({ name: 'Fixture Rebecca', type: 'work', domain: 'film', certainty: 0.8 })).types).toEqual(['urn:entity:movie', 'urn:entity:tv_show']);
    expect(searchPlan(cand({ name: 'Fixture LP', type: 'work', domain: 'music', certainty: 0.8 })).types).toEqual(['urn:entity:album']);
    // Unknown domain (legacy readings): every media type, as before.
    expect(searchPlan(cand({ name: 'Fixture Title', type: 'work', certainty: 0.8 })).types).toHaveLength(4);
    // A painter or architect is a person, never a music artist.
    expect(searchPlan(cand({ name: 'Fixture Vermeer', type: 'creator', domain: 'art', certainty: 0.8 })).types).toEqual(['urn:entity:person']);
    const movie = ent('M1', 'Fixture Stained Glass Windows', 'urn:entity:movie');
    const anyWork = cand({ name: 'Fixture Stained Glass Windows', type: 'work', certainty: 0.8 });
    expect(acceptMatch(anyWork, searchPlan(anyWork), [movie]).match).not.toBeNull();
  });

  it('a decor or setting tag never grounds a vehicle, garment, dish or sport claim (h43 shape); an aesthetic style tag may', () => {
    const car = cand({ name: 'Futuristic fixture sports car', type: 'style', domain: 'vehicle', tag_query: 'futuristic design' });
    expect(acceptMatch(car, tagsPlan(car), [tag('urn:tag:decor:qloo', 'fut', 'Futuristic Design')])).toMatchObject({ match: null, reason: 'decor_tag_outside_domain' });
    const sneaker = cand({ name: 'Retro fixture sneaker', type: 'style', domain: 'fashion', tag_query: 'retro' });
    expect(acceptMatch(sneaker, tagsPlan(sneaker), [tag('urn:tag:style:qloo', 'retro', 'Retro')]).match).toMatchObject({ name: 'Retro' });
  });

  it('one defining-style rule for style tags matched through the tag query: the tag adds no word and drops no proper name', () => {
    // Accepted: the tag is the candidate's own defining style.
    for (const [name, t] of [
      ['Rustic wooden table', 'Rustic'],
      ['Minimalist tableware', 'Minimalist'],
      ['Neoclassical chair', 'Neoclassical'],
      ['Dutch Golden Age portraiture', 'Dutch Golden Age Style'],
      ['wood-paneled interior', 'Wood Paneling'],
    ] as const)
      expect(definingStyleTag(name, t), `${name} -> ${t}`).toBe(true);
    // ground-v6: a decor tag grounds only a room, space or building style claim.
    for (const [name, t, domain] of [
      ['wood-paneled interior', 'Wood Paneling', 'interior'],
      ['Exposed brick wall', 'Exposed Brick', 'architecture'],
      ['Neoclassical architecture', 'Neoclassical', 'architecture'],
    ] as const) {
      const c = cand({ name, type: 'style', domain, tag_query: t.toLowerCase() });
      expect(acceptMatch(c, tagsPlan(c), [tag('urn:tag:decor:qloo', 'x', t)]).match).toMatchObject({ name: t });
    }
    // Not accepted: the tag adds a word (h07, h02, a looser upholstery tag) or drops a place (h10).
    for (const [name, t] of [
      ['Rustic painted wooden bar stools', 'Rustic Farmhouse'],
      ['Mid-century automotive design', 'Mid Century Modern'],
      ['striped sofa', 'Striped Upholstery'],
      ['Hong Kong neon signage', 'Neon Signage'],
    ] as const) {
      expect(definingStyleTag(name, t), `${name} -> ${t}`).toBe(false);
      const c = cand({ name, type: 'style', domain: 'design', tag_query: t.toLowerCase() });
      expect(acceptMatch(c, tagsPlan(c), [tag('urn:tag:decor:qloo', 'x', t)]).match).toBeNull();
    }
    // A tag equal to the candidate's own name is accepted as before; cuisine tags are not concerned.
    const loft = cand({ name: 'Industrial loft', type: 'style', domain: 'interior', tag_query: 'industrial' });
    expect(acceptMatch(loft, tagsPlan(loft), [tag('urn:tag:decor:qloo', 'loft', 'Industrial Loft')]).match).toMatchObject({ name: 'Industrial Loft' });
  });
});

describe('ground-v6: decor tags for spaces only, place aliases of the same kind', () => {
  it('a decor or setting tag never grounds an object, street furniture or a non-spatial domain (h79 shape)', () => {
    for (const [name, t, domain] of [
      ['Rustic wooden table', 'Rustic', 'interior'],
      ['Minimalist tableware', 'Minimalist', 'design'],
      ['Dutch Golden Age portraiture', 'Dutch Golden Age Style', 'art'],
      ['Pedestrian bollard street design', 'Pedestrian Street', 'architecture'],
    ] as const) {
      const c = cand({ name, type: 'style', domain, tag_query: t.toLowerCase() });
      const family = name.startsWith('Pedestrian') ? 'urn:tag:setting:qloo' : 'urn:tag:decor:qloo';
      expect(acceptMatch(c, tagsPlan(c), [tag(family, 'x', t)]), name).toMatchObject({ match: null, reason: 'decor_tag_outside_domain' });
    }
    // A room or building style claim still grounds; an aesthetic style tag is not restricted.
    const loft = cand({ name: 'Industrial loft', type: 'style', domain: 'interior', tag_query: 'industrial loft' });
    expect(acceptMatch(loft, tagsPlan(loft), [tag('urn:tag:decor:qloo', 'loft', 'Industrial Loft')]).match).toMatchObject({ name: 'Industrial Loft' });
    const table = cand({ name: 'Rustic wooden table', type: 'style', domain: 'interior', tag_query: 'rustic' });
    expect(acceptMatch(table, tagsPlan(table), [tag('urn:tag:style:qloo', 'rustic', 'Rustic')]).match).toMatchObject({ name: 'Rustic' });
  });

  it('a place reached only through an alias must be the same kind of place (p09 shape)', () => {
    const quarter = ent('L1', 'Quartier du Fixture Royal', 'urn:entity:locality', { popularity: 0.5, properties: { akas: ['Fixture-Royal'] } });
    const palace = cand({ name: 'Palais Fixture-Royal', type: 'place', domain: 'architecture', relation: 'depicted', certainty: 0.8 });
    const aliasOnly = ent('L2', 'Quartier du Palais Fixture-Royal', 'urn:entity:locality', { popularity: 0.5, properties: { akas: ['Palais Fixture-Royal'] } });
    expect(acceptMatch(palace, searchPlan(palace), [aliasOnly]).match).toBeNull();
    // An area named by its alias as an area is accepted; a venue alias for a landmark is accepted.
    const area = cand({ name: 'Fixture-Royal', type: 'place', domain: 'place', relation: 'depicted', certainty: 0.8 });
    expect(acceptMatch(area, searchPlan(area), [quarter]).match).toMatchObject({ entity_id: 'FIXTURE-L1' });
    const venue = ent('V1', 'Fixture Royal Palace Museum', 'urn:entity:place', { popularity: 0.5, properties: { akas: ['Palais Fixture-Royal'] } });
    expect(acceptMatch(palace, searchPlan(palace), [venue]).match).toMatchObject({ entity_id: 'FIXTURE-V1' });
  });
});

describe('ground-v7: a dish or an object is not its region, cuisine or style', () => {
  it('a dish reaching a cuisine tag only through its tag query is not accepted (iteration-6 h05 shape)', () => {
    const dish = cand({ name: 'Fixture tofu', type: 'cuisine', relation: 'depicted', certainty: 0.8, domain: 'food', tag_query: 'fixturese' });
    expect(acceptMatch(dish, tagsPlan(dish), [tag('urn:tag:cuisine:qloo', 'fx', 'Fixturese')]).match).toBeNull();
    // The cuisine named by the claim itself, or a tag that only drops words of the name, still grounds.
    const cuisine = cand({ name: 'Fixturese cuisine', type: 'cuisine', relation: 'depicted', certainty: 0.8, domain: 'food' });
    expect(acceptMatch(cuisine, tagsPlan(cuisine), [tag('urn:tag:cuisine:qloo', 'fx', 'Fixturese')]).match).toMatchObject({ name: 'Fixturese' });
    const home = cand({ name: 'Fixturese home cooking', type: 'cuisine', relation: 'depicted', certainty: 0.8, domain: 'food', tag_query: 'home-style fixturese' });
    expect(acceptMatch(home, tagsPlan(home), [tag('urn:tag:cuisine:qloo', 'hs', 'Home-Style Fixturese')]).match).toMatchObject({ name: 'Home-Style Fixturese' });
  });

  it('an object reaching a region or origin style tag through its query is not accepted', () => {
    const obj = cand({ name: 'Painted wooden fixture stool', type: 'style', domain: 'craft', tag_query: 'fixturese folk' });
    expect(acceptMatch(obj, tagsPlan(obj), [tag('urn:tag:style:qloo', 'ff', 'Fixturese Folk')]).match).toBeNull();
  });
});
