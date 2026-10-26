import { readFileSync } from 'node:fs';
import { parseInsights, resolveFromWorkspace, type QlooEntity } from '@culture-atlas/providers';
import { describe, expect, it } from 'vitest';
import type { AcceptedTag } from '../style/map-tags';
import { echoNames } from '../style/affinity';
import { storedAesthetic, storedSubject } from '../style/test-support';
import { dedupeByName } from './style-stage';
import { flatVerdict, fuseRail, outsideCity, planMoreLikeThis, priceLevel, qlooLinks, selectRail, type PlanInput } from './style-rails';

/** Recorded insights responses from the live style probe (fixtures/qloo/probe-2026-10-23). */
const probe = (name: string): QlooEntity[] =>
  parseInsights(JSON.parse(readFileSync(resolveFromWorkspace(`fixtures/qloo/probe-2026-10-23/${name}.json`), 'utf8'))).entities;
const tag = (id: string, over: Partial<AcceptedTag> = {}): AcceptedTag => ({ id, slot: 'aesthetics', claimName: id.split(':').pop()!, wording: 'asserted', weight: 1, primary: true, use: 'filter', ...over });
const plan = (over: Partial<PlanInput>) => planMoreLikeThis({ subject: storedSubject(), entity: null, filterTag: null, accepted: [], exemplars: [], city: null, ...over });
const F = 'urn:tag:fashion_segment:qloo:workwear';
const PS = 'urn:tag:personal_style:qloo:rugged';
const BRAND = { id: 'E-1', name: 'Carhartt', types: ['urn:entity:brand'] };

describe('"More like this" recipes (style design §C.3, R-1, R-4, R-9)', () => {
  it('fashion with an identified brand: filter F, entity signal, personal_style at 0.5; secondary drops F', () => {
    const p = plan({ entity: BRAND, filterTag: F, accepted: [tag(F), tag(PS, { use: 'signal', wording: 'resembles' })] });
    expect(p.recipe).toBe('fashion_entity');
    expect(p.primary).toEqual({ filterType: 'urn:entity:brand', explainability: true, take: 20, filterTags: [F], signalEntities: ['E-1'], signalTags: [{ id: PS, weight: 0.5 }] });
    expect(p.secondary).toEqual({ ...p.primary, filterTags: ['urn:tag:genre:brand:fashion'] });
    expect(p.bridgeable).toBe(true);
  });

  it('fashion with no brand: the exemplar call (i04 recipe) when >= 2 exemplars qualify', () => {
    const exemplars = [{ id: 'X1', name: 'a', score: 2, popularity: 0.9, shared: [F] }, { id: 'X2', name: 'b', score: 2, popularity: 0.9, shared: [F] }];
    const p = plan({ filterTag: F, accepted: [tag(F)], exemplars });
    expect(p.recipe).toBe('fashion_exemplar');
    expect(p.primary).toEqual({ filterType: 'urn:entity:brand', explainability: true, take: 20, filterTags: [F], signalEntities: ['X1', 'X2'] });
    expect(p.entity).toBeNull();
  });

  it('fashion with < 2 exemplars: the tag-only call, never a bridge', () => {
    const p = plan({ accepted: [tag(PS, { use: 'signal', wording: 'resembles' })] });
    expect(p.recipe).toBe('fashion_tag_only');
    expect(p.tagOnly).toBe(true);
    expect(p.bridgeable).toBe(false);
    expect(p.primary).toMatchObject({ filterTags: ['urn:tag:genre:brand:fashion'], signalTags: [{ id: PS, weight: 0.5 }], filterPopularityMin: 0.7 });
    expect(plan({ accepted: [] }).emptyReason).toBe('no_signal');
  });

  it('a painting or poster the reading filed under fashion never becomes a wear rail (eval r3, cause 3)', () => {
    const painting = storedSubject({ category: 'fashion', label: 'Renaissance dress in oil painting', aesthetics: [storedAesthetic('Baroque portraiture')] });
    expect(plan({ subject: painting, accepted: [tag(F)] })).toMatchObject({ recipe: null, primary: null, emptyReason: 'unsupported' });
    const poster = storedSubject({ category: 'fashion', label: 'Illustration of a woman in a head wrap' });
    expect(plan({ subject: poster, accepted: [tag(F)] })).toMatchObject({ primary: null, emptyReason: 'unsupported' });
    // A real garment keeps its brand rail.
    const tee = storedSubject({ category: 'fashion', label: 'Colour-block cropped logo tee', aesthetics: [storedAesthetic('Retro sportswear')] });
    expect(plan({ subject: tee, accepted: [tag(F)] }).recipe).toBe('fashion_tag_only');
  });

  it('interior: places with the decor tag in the user city; with brand rails off, an honest no_city', () => {
    const interior = storedSubject({ category: 'interior' });
    const decor = 'urn:tag:decor:qloo:japandi';
    expect(plan({ subject: interior, accepted: [tag(decor, { use: 'signal' })], city: 'Brooklyn, NY' }).primary).toEqual({ filterType: 'urn:entity:place', explainability: true, take: 20, filterTags: [decor], filterLocationQuery: 'Brooklyn, NY' });
    expect(plan({ subject: interior, accepted: [tag(decor)] })).toMatchObject({ primary: null, emptyReason: 'no_city' });
  });

  it('interior brand rails (home-brands-1): an object is a brand question even with a city; a room keeps places', () => {
    const decor = 'urn:tag:decor:qloo:japandi';
    const room = storedSubject({ category: 'interior', label: 'Quiet living room' });
    const chair = storedSubject({ category: 'interior', label: 'Walnut lounge chair' });
    const exemplars = [{ id: 'X1', name: 'a', score: 2, popularity: 1, shared: [] }];
    // A room with a city and a decor tag still looks for places.
    expect(plan({ subject: room, accepted: [tag(decor)], city: 'Brooklyn, NY', interiorBrandsEnabled: true, homeKind: 'interior' }).recipe).toBe('interior_city');
    // A room without a city reaches home brands of its industry.
    expect(plan({ subject: room, accepted: [], interiorBrandsEnabled: true, homeKind: 'interior', exemplars }).primary).toEqual({
      filterType: 'urn:entity:brand',
      explainability: true,
      take: 20,
      filterTags: ['urn:tag:industry:qloo:interior_design'],
      signalEntities: ['X1'],
    });
    // An object (a chair) is a brand question even with a city and a decor tag.
    expect(plan({ subject: chair, accepted: [tag(decor)], city: 'Brooklyn, NY', interiorBrandsEnabled: true, homeKind: 'furniture', exemplars }).recipe).toBe('interior_brand');
    // No style signal the catalogue shares: an object's honest state is no brand matches;
    // a room's honest state is its real question needs a city.
    expect(plan({ subject: chair, accepted: [tag(decor)], interiorBrandsEnabled: true, homeKind: 'furniture' })).toMatchObject({ primary: null, emptyReason: 'no_signal' });
    expect(plan({ subject: chair, accepted: [tag(decor)], city: 'Brooklyn, NY', interiorBrandsEnabled: true, homeKind: 'furniture' })).toMatchObject({ primary: null, emptyReason: 'no_signal' });
    expect(plan({ subject: chair, accepted: [tag(decor)], interiorBrandsEnabled: true, homeKind: null })).toMatchObject({ primary: null, emptyReason: 'no_city' });
    expect(plan({ subject: room, accepted: [], interiorBrandsEnabled: true, homeKind: 'interior' })).toMatchObject({ primary: null, emptyReason: 'no_city' });
    expect(plan({ subject: room, accepted: [], city: 'Brooklyn, NY', interiorBrandsEnabled: true, homeKind: 'interior' })).toMatchObject({ primary: null, emptyReason: 'no_signal' });
  });

  it('food: restaurant-genre places in the city; a coffee drink without a city is a brand question, a dish keeps no_city', () => {
    const food = storedSubject({ category: 'food' });
    const genre = 'urn:tag:genre:place:restaurant:ramen';
    expect(plan({ subject: food, accepted: [tag(genre)], city: 'Los Angeles, CA' }).primary).toEqual({ filterType: 'urn:entity:place', explainability: true, take: 20, filterTags: [genre], filterLocationQuery: 'Los Angeles, CA' });
    expect(plan({ subject: food, accepted: [tag(genre)] })).toMatchObject({ primary: null, emptyReason: 'no_city' });
    const espresso = storedSubject({ category: 'food', label: 'Espresso in a ceramic cup' });
    const exemplars = [{ id: 'C1', name: 'a', score: 2, popularity: 1, shared: [] }];
    expect(plan({ subject: espresso, interiorBrandsEnabled: true, homeKind: 'coffee', exemplars }).primary).toEqual({
      filterType: 'urn:entity:brand',
      explainability: true,
      take: 20,
      filterTags: ['urn:tag:industry:qloo:coffee'],
      signalEntities: ['C1'],
    });
    expect(plan({ subject: espresso, interiorBrandsEnabled: true, homeKind: 'coffee' })).toMatchObject({ primary: null, emptyReason: 'no_signal' });
    // A dish with brand rails on still needs a city: its places are the honest answer.
    expect(plan({ subject: food, accepted: [tag(genre)], interiorBrandsEnabled: true, homeKind: null })).toMatchObject({ primary: null, emptyReason: 'no_city' });
  });

  it('media: the same type with the entity signal; without one, a style-tag movie filter at popularity 0.9', () => {
    const media = storedSubject({ category: 'media', label: 'Film poster' });
    const style = 'urn:tag:style:qloo:moody';
    expect(plan({ subject: media, entity: { id: 'M-1', name: 'Chungking Express', types: ['urn:entity:movie'] }, accepted: [tag(style, { use: 'signal' })] }).primary).toEqual({
      filterType: 'urn:entity:movie',
      explainability: true,
      take: 20,
      signalEntities: ['M-1'],
      signalTags: [{ id: style, weight: 0.5 }],
    });
    expect(plan({ subject: media, accepted: [tag(style, { use: 'signal' })] }).primary).toEqual({ filterType: 'urn:entity:movie', explainability: true, take: 20, filterTags: [style], filterPopularityMin: 0.9 });
  });

  it('other subjects get no "More like this"', () => {
    expect(plan({ subject: storedSubject({ category: 'other' }) })).toMatchObject({ primary: null, emptyReason: 'unsupported' });
  });
});

describe('result hygiene on recorded probe responses (C.3, R-10)', () => {
  const japandi = [tag('urn:tag:decor:qloo:japandi')];

  it('discards a flat tag-only list (i06/i07: 0.765 everywhere, no explainability, no overlap)', () => {
    expect(flatVerdict({}, probe('i06_place_japandi_noloc'), japandi)).toBe('flat_discarded');
    expect(flatVerdict({}, probe('i07_place_japandi_bk'), japandi)).toBe('flat_discarded');
  });

  it('keeps a flat list that carried filter.tags (i08: every result is ramen) at weight 0', () => {
    expect(flatVerdict({ filterTags: ['urn:tag:genre:place:restaurant:ramen'] }, probe('i08_ramen_la_japandi'), japandi)).toBe('flat_kept');
  });

  it('keeps a normal entity-backed list (i04: explainable, spread affinity)', () => {
    expect(flatVerdict({ filterTags: ['urn:tag:fashion_segment:qloo:streetwear'] }, probe('i04_fash_filterstyle'), [tag('urn:tag:fashion_segment:qloo:streetwear')])).toBe('ok');
  });

  it('drops places outside the requested city (the Brooklyn -> Manhattan leak, i07)', () => {
    const results = probe('i07_place_japandi_bk');
    expect(results.filter((e) => outsideCity(e, 'Brooklyn, NY')).length).toBe(results.filter((e) => !String(e.properties.address ?? '').includes('Brooklyn')).length);
    expect(probe('i18_place_filter_japandi_bk').every((e) => !outsideCity(e, 'Brooklyn, NY'))).toBe(true);
    expect(outsideCity({ properties: {} }, 'Brooklyn, NY')).toBe(false);
  });

  it('fuses primary, secondary (0.6) and the style-overlap re-rank; ties keep first-seen order', () => {
    const e = (id: string, tags: string[] = []): QlooEntity => ({ entity_id: id, name: id, types: ['urn:entity:brand'], properties: {}, tags: tags.map((t) => ({ id: t, name: t })) });
    const fused = fuseRail([e('A'), e('B', [F]), e('C')], [e('C', [F]), e('D')], [tag(F)]);
    expect(fused.map((c) => c.entity.entity_id)).toEqual(['B', 'C', 'A', 'D']);
    expect(fused.find((c) => c.entity.entity_id === 'C')!.sources).toEqual(['primary', 'secondary']);
    // A flat-but-filtered list at weight 0: only the overlap re-rank orders it.
    expect(fuseRail([e('A'), e('B', [F])], [], [tag(F)], { primary: 0, secondary: 0.6 }).map((c) => c.entity.entity_id)).toEqual(['B', 'A']);
  });

  it('caps one price level at 3 cards unless fewer than the slots remain (R-20)', () => {
    const e = (id: string, price: string): QlooEntity => ({ entity_id: id, name: id, types: ['urn:entity:brand'], properties: {}, tags: [{ id: 'urn:tag:price_level:qloo:_', name: price }] });
    const pool = fuseRail([e('1', '$$'), e('2', '$$'), e('3', '$$'), e('4', '$$'), e('5', '$$$'), e('6', '$$'), e('7', '$$$$'), e('8', '$'), e('9', '$$$'), e('10', '$')], [], []);
    const picked = selectRail(pool, 8);
    expect(picked).toHaveLength(8);
    expect(picked.filter((c) => priceLevel(c.entity) === '$$').length).toBe(3);
    expect(selectRail(pool.slice(0, 4), 8)).toHaveLength(4);
  });

  it('caps anchor-brand echoes at one card per rail, keeping the best echo (eval r3, cause 4)', () => {
    const e = (id: string, name: string): QlooEntity => ({ entity_id: id, name, types: ['urn:entity:brand'], properties: {}, tags: [] });
    const pool = fuseRail([e('1', 'Fila'), e('2', 'Solid Brand'), e('3', 'Wilson'), e('4', 'Fourth Brand'), e('5', 'Fifth Brand')], [], []);
    const echo = { names: echoNames(['Fila', 'Wilson']) };
    // The strongest echo may still show once (it was down-ranked before selection); repeats are cut.
    expect(selectRail(pool, 3, echo).map((c) => c.entity.name)).toEqual(['Fila', 'Solid Brand', 'Fourth Brand']);
    // The cap holds even when the rail is short (a shorter, honest rail beats repeats).
    expect(selectRail(pool, 8, echo).map((c) => c.entity.name)).toEqual(['Fila', 'Solid Brand', 'Fourth Brand', 'Fifth Brand']);
    // Without echo names the selection is unchanged.
    expect(selectRail(pool, 8).map((c) => c.entity.name)).toEqual(['Fila', 'Solid Brand', 'Wilson', 'Fourth Brand', 'Fifth Brand']);
  });

  it('"Qloo also links" uses the similar_brand tags\' own names only', () => {
    const e = probe('i04_fash_filterstyle')[0]!;
    expect(qlooLinks(e)).toEqual(['Stan Ray', 'Patagonia', 'Filson', 'Timberland', 'Champion']);
    expect(qlooLinks(null)).toEqual([]);
  });

  it('collapses one brand Qloo lists twice ("Ikrush", "Ikrush.")', () => {
    const e = (id: string, name: string) => ({ entity: { entity_id: id, name } });
    expect(dedupeByName([e('1', 'Ikrush'), e('2', 'Ikrush.'), e('3', 'Tobi')]).map((c) => c.entity.entity_id)).toEqual(['1', '3']);
  });
});
