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
  it('anchor, bridge and tag-only routes all need candidate evidence, including Wear', () => {
    expect(dropStylelessFor('watch', 0, 0)).toBe(true);
    expect(dropStylelessFor('play', 0, 0)).toBe(true);
    expect(dropStylelessFor('wear', 0, 0)).toBe(true);
    // A garment's co-liked brand pulled music and film cards in: only style-shared cards stay.
    expect(dropStylelessFor('play', 3, 2)).toBe(true);
    expect(dropStylelessFor('watch', 3, 2)).toBe(true);
    // Anchor-only signals and Wear are not admission exemptions.
    expect(dropStylelessFor('wear', 3, 2)).toBe(true);
    expect(dropStylelessFor('watch', 3, 0)).toBe(true);
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

describe('TOPIC-1 films: candidate-owned content, not broad topic tags (honest empty otherwise)', () => {
  it('also keeps an explicit about-subject relation without pretending it is a style match', () => {
    const interior = storedSubject({ category: 'interior', label: 'A furnished room' });
    const tagged = film('A', 'Fixture Architecture Film', [{ id: 'urn:tag:theme:qloo:architecture', name: 'Architecture' }]);
    expect(topicFilms([interior], [tagged])).toEqual([]);
    const architecture = { ...tagged, properties: { description: 'The documentary explores architecture and interior design through the work of architects.' },
      tags: [...tagged.tags, { id: 'urn:tag:genre:media:documentary', name: 'Documentary' }] };
    const comedy = film('B', 'Fixture Comedy', [{ id: 'urn:tag:genre:media:comedy', name: 'Comedy' }]);
    expect(topicFilms([interior], [comedy, architecture])).toEqual([architecture]);
    expect(rerankCrossDomain([interior], [comedy, architecture], 0.5, { dropStyleless: true })).toEqual([architecture]);
  });
  it('requires substantive source-specific content in addition to lexical style overlap', () => {
    const tagged = film('A', 'Fixture Decay Film', [{ id: 'urn:tag:theme:qloo:decay', name: 'Decay' }, { id: 'urn:tag:genre:media:documentary', name: 'Documentary' }]);
    expect(topicFilms([room], [tagged])).toEqual([]);
    const onStyle = { ...tagged, properties: { description: 'The documentary explores abandoned buildings and ruined motels.' } };
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

  it('retains lexical style signal but does not admit a film without substantive content', () => {
    const mixed = film('A', 'Fixture Floral Film', [
      { id: 'urn:tag:subgenre:qloo:romantic_drama', name: 'Romantic drama' },
      { id: 'urn:tag:theme:qloo:ditsy_floral', name: 'Ditsy Floral' },
    ]);
    const out = crossDomainScores([dress], [mixed], { periodGuard: true })[0]!;
    expect(out.styleHit).toBe(true);
    expect(out.style).toBeGreaterThan(0);
    expect(rerankCrossDomain([dress], [mixed], 0.5, { dropStyleless: true })).toEqual([]);
    const focused = { ...mixed, properties: { description: 'The documentary profiles fashion designers and explores couture garment making.' },
      tags: [...mixed.tags, { id: 'urn:tag:genre:media:documentary', name: 'Documentary' }] };
    expect(rerankCrossDomain([dress], [focused], 0.5, { dropStyleless: true }).map((e) => e.entity_id)).toEqual(['A']);
  });

  it('a non-garment reading keeps a period word: the guard is scoped to fashion subjects', () => {
    const salon = storedSubject({ id: 's1', category: 'interior', label: 'Baroque paneled salon', aesthetics: [storedAesthetic('Baroque')] });
    const ensemble = artist('A', 'Fixture Baroque Ensemble', [{ id: 'urn:tag:genre:music:qloo:baroque', name: 'Baroque' }]);
    expect(crossDomainScores([salon], [ensemble], { periodGuard: true })[0]!.styleHit).toBe(true);
  });
});

describe('a gated card needs a real style claim, and one name shows once (eval r5)', () => {
  it('a feature word alone ("ribbed" of a trim) scores but claims nothing, and is dropped', () => {
    const dress = storedSubject({
      id: 's1',
      category: 'fashion',
      label: 'Midi dress',
      aesthetics: [storedAesthetic('Sweet romantic', { wording: 'resembles', defining_features: ['contrast ribbed trim'] })],
    });
    const trim = film('B', 'Fixture Trim Film', [{ id: 'urn:tag:keyword:qloo:ribbed', name: 'Ribbed' }]);
    const scored = crossDomainScores([dress], [trim], { periodGuard: true })[0]!;
    expect(scored.style).toBeGreaterThan(0);
    expect(scored.styleHit).toBe(false);
    expect(rerankCrossDomain([dress], [trim], 0.5, { dropStyleless: true })).toEqual([]);
  });

  it('two Qloo entities of one name show once (eval r5: two "Dunhill" ids on one wear rail)', () => {
    const suit = storedSubject({ id: 's1', category: 'fashion', label: 'Navy suit', aesthetics: [storedAesthetic('Tailored')] });
    const a = film('A1', 'Fixture Dunhill', [{ id: 'urn:tag:genre:brand:fashion:formalwear', name: 'Formalwear' }]);
    const b = film('A2', 'Fixture Dunhill', [{ id: 'urn:tag:genre:brand:fashion:formalwear', name: 'Formalwear' }]);
    expect(rerankCrossDomain([suit], [a, b], 0.5, { gateFashion: true }).map((e) => e.name)).toEqual(['Fixture Dunhill']);
  });
});

/**
 * Eval r6: on a garment reading, a film or music card's plot and sound keywords share words with
 * the reading in another sense. Tag labels mirror the measured classes (nationality, nightclub,
 * black-and-white, release decade, mood, garment-noun keywords, a folded synonym, a place name).
 */
describe('a film or music keyword in another sense is not garment style evidence (eval r6)', () => {
  const claim = (name: string) => storedAesthetic(name, { wording: 'resembles' });
  const jacket = storedSubject({
    id: 's1',
    category: 'fashion',
    label: 'Leather varsity bomber jacket',
    aesthetics: [storedAesthetic('Varsity')],
    lineage: [claim('American collegiate sportswear')],
    mood: [claim('polished')],
  });
  const tennis = storedSubject({
    id: 's1',
    category: 'fashion',
    label: 'Tennis skort outfit',
    aesthetics: [storedAesthetic('Tennis whites'), storedAesthetic('Athletic')],
    lineage: [claim('Club tennis dress')],
    era: { ...claim('2010s'), cue: 'cut' },
  });
  const sneaker = storedSubject({ id: 's1', category: 'fashion', label: 'Black slip-on sneakers', aesthetics: [storedAesthetic('Smart-casual sneaker')] });
  const tee = storedSubject({ id: 's1', category: 'fashion', label: 'Cropped tee', materials: [{ ...claim('Jersey'), texture: 'soft knit' }] });
  const kept = (s: ReturnType<typeof storedSubject>, cards: ReturnType<typeof film>[]) => rerankCrossDomain([s], cards, 0.5, { dropStyleless: true }).map((e) => e.entity_id);

  it('drops nationality, nightclub, palette, decade and mood collisions from a bridged rail', () => {
    expect(kept(jacket, [artist('A', 'Fixture Pop Singer', [{ id: 'urn:tag:keyword:qloo:american', name: 'American' }])])).toEqual([]);
    expect(kept(jacket, [film('B', 'Fixture Abroad Film', [{ id: 'urn:tag:keyword:qloo:american_abroad', name: 'American abroad' }])])).toEqual([]);
    expect(kept(jacket, [artist('C', 'Fixture Polished Pop', [{ id: 'urn:tag:style:qloo:polished', name: 'Polished' }])])).toEqual([]);
    expect(kept(tennis, [artist('D', 'Fixture Club Rapper', [{ id: 'urn:tag:keyword:qloo:club_ready', name: 'Club-Ready Rap Anthems' }])])).toEqual([]);
    expect(kept(tennis, [film('E', 'Fixture Monochrome Film', [{ id: 'urn:tag:keyword:qloo:bw_scene', name: 'Black and white scene' }])])).toEqual([]);
    expect(kept(tennis, [film('F', 'Fixture Recent Film', [{ id: 'urn:tag:keyword:qloo:2010s', name: '2010s' }])])).toEqual([]);
  });

  it('drops a match reached only by folding, or by a place of the same spelling', () => {
    expect(kept(sneaker, [film('A', 'Fixture Family Drama', [{ id: 'urn:tag:keyword:qloo:kicked_out', name: 'Mother kicks her son out of the house' }])])).toEqual([]);
    expect(kept(tee, [film('B', 'Fixture Crime Film', [{ id: 'urn:tag:keyword:qloo:new_jersey', name: 'New jersey' }])])).toEqual([]);
  });

  it('requires content for generic garment/activity tags while retaining distinctive cultural evidence', () => {
    const skate = film('A', 'Fixture Skate Film', [{ id: 'urn:tag:keyword:qloo:sneakers', name: 'Sneakers' }]);
    const sport = film('B', 'Fixture Sports Film', [{ id: 'urn:tag:keyword:qloo:athletic_training', name: 'Athletic training' }]);
    const campus = film('C', 'Fixture Campus Film', [{ id: 'urn:tag:theme:qloo:varsity', name: 'Varsity' }]);
    expect(kept(sneaker, [skate])).toEqual([]);
    expect(kept(tennis, [sport])).toEqual([]);
    expect(kept(jacket, [campus])).toEqual(['C']);
    const sneakerDocumentary = { ...skate, properties: { description: 'The documentary follows sneaker collectors and explores the history of sneaker culture.' },
      tags: [...skate.tags, { id: 'urn:tag:genre:media:documentary', name: 'Documentary' }] };
    const tennisFilm = { ...sport, properties: { description: 'The film follows two tennis players through training and their careers.' },
      tags: [...sport.tags, { id: 'urn:tag:keyword:qloo:tennis', name: 'Tennis' }] };
    expect(kept(sneaker, [sneakerDocumentary])).toEqual(['A']);
    expect(kept(tennis, [tennisFilm])).toEqual(['B']);
  });

  it('is scoped to cross-domain cards: a wear rail\'s brand tags still match by these words', () => {
    const brand = film('A', 'Fixture Heritage Brand', [{ id: 'urn:tag:style:qloo:american', name: 'American' }]);
    expect(crossDomainScores([jacket], [brand], { periodGuard: false })[0]!.styleHit).toBe(true);
  });
});
