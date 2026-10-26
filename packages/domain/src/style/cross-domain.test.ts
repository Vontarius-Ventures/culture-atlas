import { describe, expect, it } from 'vitest';
import { capEchoes, crossDomainScores, dropStylelessFor, rerankCrossDomain, topicFilms, TOPIC_MIN_SCORE } from './cross-domain';
import { echoNames } from './affinity';
import { storedAesthetic, storedSubject } from './test-support';

/**
 * Synthetic readings and entities (shapes only, never model output and never
 * an eval photo's answer): the same tag-word classes the live Qloo responses
 * carry, in different combinations.
 */

const varsity = storedSubject({
  id: 's1',
  category: 'fashion',
  label: 'Varsity bomber jacket',
  aesthetics: [storedAesthetic('Varsity'), storedAesthetic('Campus', { wording: 'resembles' })],
});
const room = storedSubject({
  id: 's1',
  category: 'interior',
  label: 'Disused paneled motel room',
  aesthetics: [storedAesthetic('Abandoned decay', { wording: 'resembles' })],
});
const film = (id: string, name: string, tags: readonly { id: string; name: string }[]) => ({ entity_id: id, name, types: ['urn:entity:movie'], properties: {}, tags: tags.map((t) => ({ ...t })) });
const artist = (id: string, name: string, tags: readonly { id: string; name: string }[]) => ({ entity_id: id, name, types: ['urn:entity:artist'], properties: {}, tags: tags.map((t) => ({ ...t })) });

describe('when a cross-domain card needs its own style evidence (eval r3, audience overlap)', () => {
  it('the reading as the only signal, and a bridged play or watch card, need style evidence; wear and entity-signalled rails do not', () => {
    expect(dropStylelessFor('watch', 0, 0)).toBe(true);
    expect(dropStylelessFor('play', 0, 0)).toBe(true);
    expect(dropStylelessFor('wear', 0, 0)).toBe(true);
    // A garment's co-liked brand pulled music and film cards in: only style-shared cards stay.
    expect(dropStylelessFor('play', 3, 2)).toBe(true);
    expect(dropStylelessFor('watch', 3, 2)).toBe(true);
    // Wear keeps Qloo's product-filtered order; an entity-signalled rail (no bridge) re-ranks without dropping.
    expect(dropStylelessFor('wear', 3, 2)).toBe(false);
    expect(dropStylelessFor('watch', 3, 0)).toBe(false);
  });

  it('a bridged rail keeps only cards whose own tags share a style word with the reading', () => {
    const onStyle = film('A', 'Fixture Campus Film', [{ id: 'urn:tag:theme:qloo:campus', name: 'Campus Life' }]);
    const audience = film('B', 'Fixture Generic Comedy', [{ id: 'urn:tag:genre:media:comedy', name: 'Comedy' }]);
    const out = rerankCrossDomain([varsity], [audience, onStyle], 0.5, { dropStyleless: true });
    expect(out.map((e) => e.entity_id)).toEqual(['A']);
    // Without the policy flag the audience-overlap card stays (the reading only re-ranks).
    expect(rerankCrossDomain([varsity], [audience, onStyle], 0.5, {}).map((e) => e.entity_id)).toContain('B');
  });

  it('a card sharing the reading style outranks Qloo\'s own order; echoes are capped, not removed', () => {
    const first = film('A', 'Fixture Varsity Story', [{ id: 'urn:tag:theme:qloo:varsity', name: 'Varsity' }]);
    const also = film('B', 'Fixture Campus Film', [{ id: 'urn:tag:theme:qloo:campus', name: 'Campus Life' }]);
    const out = rerankCrossDomain([varsity], [first, also], 0.5, {});
    expect(out.map((e) => e.name)).toEqual(['Fixture Varsity Story', 'Fixture Campus Film']);
    const echoNamesSet = echoNames(['Fixture Varsity Story']);
    expect(capEchoes([first, { ...first, entity_id: 'A2' }, also], echoNamesSet).map((e) => e.entity_id)).toEqual(['A', 'B']);
  });
});

describe('TOPIC-1 films: only films whose own tags share a style claim (honest empty otherwise)', () => {
  it('keeps the style-overlapping film and drops the popular film about something else', () => {
    const onStyle = film('A', 'Fixture Decay Film', [{ id: 'urn:tag:theme:qloo:decay', name: 'Decay' }, { id: 'urn:tag:genre:media:documentary', name: 'Documentary' }]);
    const offStyle = film('B', 'Fixture Blockbuster', [{ id: 'urn:tag:genre:media:action', name: 'Action' }]);
    const scored = crossDomainScores([room], [onStyle, offStyle]);
    expect(scored.find((x) => x.e.entity_id === 'A')!.styleHit).toBe(true);
    expect(scored.find((x) => x.e.entity_id === 'B')!.style).toBe(0);
    const out = topicFilms([room], [offStyle, onStyle]);
    expect(out.map((e) => e.entity_id)).toEqual(['A']);
  });

  it('a film sharing none of the reading\'s words stays out: the rail keeps its honest empty', () => {
    const offStyle = film('A', 'Fixture Blockbuster', [{ id: 'urn:tag:genre:media:action', name: 'Action' }, { id: 'urn:tag:theme:qloo:design', name: 'Design' }]);
    expect(topicFilms([room], [offStyle])).toEqual([]);
    expect(TOPIC_MIN_SCORE).toBeGreaterThan(0);
  });
});

/**
 * Eval r4 (h71): a mint floral dress, style "sweet romantic", was given Beethoven/Schubert/Brahms
 * because the composers' own tags say "Romantic" — the classical period, not a garment style.
 */
describe('a genre or period word is not fashion style evidence (eval r4, h71)', () => {
  const dress = storedSubject({
    id: 's1',
    category: 'fashion',
    label: 'Mint floral dress',
    aesthetics: [storedAesthetic('Sweet romantic', { wording: 'resembles' }), storedAesthetic('Ditsy floral', { wording: 'resembles' })],
  });

  it('a music card whose only shared word is a period term carries no style claim and is dropped', () => {
    const romantic = artist('A', 'Fixture Composer', [
      { id: 'urn:tag:genre:music:qloo:romantic', name: 'Romantic' },
      { id: 'urn:tag:genre:music:qloo:classical', name: 'Classical' },
    ]);
    const orchestra = artist('B', 'Fixture Orchestra', [{ id: 'urn:tag:genre:music:qloo:classical', name: 'Classical' }]);
    expect(crossDomainScores([dress], [romantic], { periodGuard: true })[0]).toMatchObject({ style: 0, styleHit: false });
    expect(rerankCrossDomain([dress], [romantic, orchestra], 0.5, { dropStyleless: true })).toEqual([]);
  });

  it('the collision is the word, not the tag family: a personal_style "Romantic" is struck too', () => {
    const crooner = artist('A', 'Fixture Crooner', [{ id: 'urn:tag:personal_style:qloo:romantic', name: 'Romantic' }]);
    expect(crossDomainScores([dress], [crooner], { periodGuard: true })[0]).toMatchObject({ style: 0, styleHit: false });
    // Without the guard (a wear rail's brand cards) the same tag is real garment style.
    expect(crossDomainScores([dress], [crooner], { periodGuard: false })[0]!.styleHit).toBe(true);
  });

  it('keeps a genuinely shared visual subculture word', () => {
    const punk = storedSubject({ id: 's1', category: 'fashion', label: 'Leather biker jacket', aesthetics: [storedAesthetic('Punk')] });
    const band = artist('A', 'Fixture Punk Band', [{ id: 'urn:tag:genre:music:qloo:punk', name: 'Punk' }]);
    expect(crossDomainScores([punk], [band], { periodGuard: true })[0]!.styleHit).toBe(true);
    expect(rerankCrossDomain([punk], [band], 0.5, { dropStyleless: true }).map((e) => e.entity_id)).toEqual(['A']);
  });

  it('keeps the genuine style words of a card that also carries a period word', () => {
    const mixed = film('A', 'Fixture Floral Film', [
      { id: 'urn:tag:subgenre:qloo:romantic_drama', name: 'Romantic drama' },
      { id: 'urn:tag:theme:qloo:ditsy_floral', name: 'Ditsy Floral' },
    ]);
    const out = crossDomainScores([dress], [mixed], { periodGuard: true })[0]!;
    expect(out.styleHit).toBe(true);
    expect(out.style).toBeGreaterThan(0);
    expect(rerankCrossDomain([dress], [mixed], 0.5, { dropStyleless: true }).map((e) => e.entity_id)).toEqual(['A']);
  });

  it('a non-garment reading keeps a period word: the guard is scoped to fashion subjects', () => {
    const salon = storedSubject({ id: 's1', category: 'interior', label: 'Baroque paneled salon', aesthetics: [storedAesthetic('Baroque')] });
    const ensemble = artist('A', 'Fixture Baroque Ensemble', [{ id: 'urn:tag:genre:music:qloo:baroque', name: 'Baroque' }]);
    expect(crossDomainScores([salon], [ensemble], { periodGuard: true })[0]!.styleHit).toBe(true);
  });
});
