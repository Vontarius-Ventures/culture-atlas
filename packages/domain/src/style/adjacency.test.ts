import { describe, expect, it } from 'vitest';
import type { QlooEntity } from '@culture-atlas/providers';
import {
  artworkEvidence,
  bridgeTargets,
  entityAdjacency,
  isArtworkSubject,
  isFineArtSubject,
  mediaArtworkGate,
  referenceKeywords,
  subjectKeywords,
  suppressWearForArtwork,
} from './adjacency';
import { storedAesthetic, storedSubject } from './test-support';

/** Synthetic readings and entities (shapes only, never model output and never an eval photo's answer). */
const painting = storedSubject({
  category: 'media',
  label: 'Baroque oil portrait painting',
  aesthetics: [storedAesthetic('Baroque', { wording: 'resembles' })],
  lineage: [],
  era: { name: '17th century', certainty: 0.8, wording: 'resembles', display: '17th century', strength: 'likely', corroborated_by: [], held: false, basis: 'visible', region: null, qloo: null, cue: 'costume' },
  mood: [{ name: 'serene', certainty: 0.7, wording: 'resembles', display: 'serene', strength: null, corroborated_by: [], held: false, basis: 'visible', region: null, qloo: null }],
});
const film = (name: string, tagNames: readonly string[] = []): QlooEntity => ({
  entity_id: name,
  name,
  types: ['urn:entity:movie'],
  properties: {},
  tags: tagNames.map((n) => ({ id: `urn:tag:style:qloo:${n.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, name: n })),
});

describe('artwork detection (eval r3, relevance cause 3)', () => {
  it('a painting, an illustration or a poster of a person is an artwork whatever the reading filed it under', () => {
    expect(isArtworkSubject(painting)).toBe(true);
    expect(isArtworkSubject(storedSubject({ category: 'fashion', label: 'Head wrap and pearl earring illustration' }))).toBe(true);
    expect(isArtworkSubject(storedSubject({ category: 'fashion', label: 'Pearl earring poster' }))).toBe(true);
    // A real garment is not (its material canvas is not the medium).
    expect(isArtworkSubject(storedSubject({ category: 'fashion', label: 'Canvas work jacket' }))).toBe(false);
    expect(isArtworkSubject(storedSubject({ category: 'fashion', label: 'Ditsy floral print dress' }))).toBe(false);
  });

  it('wear never fires for an artwork primary subject — the reference/media surface carries it', () => {
    expect(suppressWearForArtwork([painting])).toBe(true);
    expect(suppressWearForArtwork([storedSubject({ category: 'fashion', label: 'Milkmaid portrait painting' })])).toBe(true);
    expect(suppressWearForArtwork([storedSubject({ category: 'fashion', label: 'Colour-block cropped logo tee' })])).toBe(false);
    expect(suppressWearForArtwork([])).toBe(false);
  });

  it('a reproduction of media (a film poster) is an artwork for wear but keeps its own film rail', () => {
    const poster = storedSubject({ category: 'media', label: 'Film poster' });
    expect(isArtworkSubject(poster)).toBe(true);
    expect(isFineArtSubject(poster)).toBe(false);
    expect(isFineArtSubject(painting)).toBe(true);
    expect(mediaArtworkGate(poster)).toBeNull();
    expect(mediaArtworkGate(painting)).not.toBeNull();
    expect(mediaArtworkGate(storedSubject({ category: 'fashion', label: 'Colour-block cropped logo tee' }))).toBeNull();
  });
});

describe('cross-domain bridge adjacency (eval r3, relevance cause 1)', () => {
  it('interior, craft, food and place rails bridge nowhere; fashion bridges everywhere it scored well; media bridges to watch', () => {
    expect(bridgeTargets('interior')).toEqual([]);
    expect(bridgeTargets('food')).toEqual([]);
    expect(bridgeTargets('place')).toEqual([]);
    expect(bridgeTargets('other')).toEqual([]);
    expect(bridgeTargets('fashion')).toEqual(['wear', 'play', 'watch']);
    expect(bridgeTargets('media')).toEqual(['watch']);
  });

  it('a fine-art subject keeps only entertainment that references it or is about art (no Dark Knight for a Vermeer)', () => {
    const evidence = artworkEvidence([painting])!;
    expect(evidence.keywords).toContain('baroque');
    expect(evidence.keywords).toContain('portrait');
    // The Dark Knight shares nothing with the reading: not adjacency.
    expect(entityAdjacency(film('The Dark Knight', ['Neo-noir', 'Action']), evidence)).toBe(false);
    // The film of the painting itself: its name carries the artwork's identity words.
    expect(entityAdjacency(film('Girl with a Pearl Earring', ['Drama']), evidence)).toBe(false); // only "painting" words — the title is not in the reading
    // ...but the analysis's own references are the artwork's identity too:
    const withRefs = { ...evidence, keywords: [...evidence.keywords, ...referenceKeywords(['Girl with a Pearl Earring', 'Dutch Golden Age portraiture'])] };
    expect(entityAdjacency(film('Girl with a Pearl Earring', ['Drama']), withRefs)).toBe(true);
    // One common word is a coincidence, not adjacency ("Pearl Harbor" for a pearl-earring painting).
    expect(entityAdjacency(film('Pearl Harbor', ['War']), withRefs)).toBe(false);
    // A film about art itself is real adjacency for an artwork subject.
    const about = (name: string, themes: readonly string[]): QlooEntity => ({
      ...film(name),
      tags: themes.map((n) => ({ id: `urn:tag:theme:qloo:${n.toLowerCase()}`, name: n })),
    });
    expect(entityAdjacency(about('Cezanne et Moi', ['Painting', 'Artists']), evidence)).toBe(true);
    // One art word among a blockbuster's plot keyword tags is not a topic ("art therapist" in Parasite).
    const keyworded: QlooEntity = { ...film('Parasite'), tags: [{ id: 'urn:tag:keyword:media:artist', name: 'Artist' }, { id: 'urn:tag:genre:media:thriller', name: 'Thriller' }] };
    expect(entityAdjacency(keyworded, evidence)).toBe(false);
    // Non-artwork subjects never gate their entertainment this way.
    expect(artworkEvidence([storedSubject({ category: 'fashion', label: 'Colour-block cropped logo tee' })])).toBeNull();
  });

  it('subject keywords fold the reading\'s own words, dropping fillers', () => {
    expect(subjectKeywords(painting)).toContain('baroque');
    expect(subjectKeywords(painting)).toContain('17th');
    expect(subjectKeywords(painting)).not.toContain('the');
    expect(subjectKeywords(painting)).not.toContain('century');
    // Mood words are not subject evidence: a rail built from the "Moody" tag shares it with every result.
    expect(subjectKeywords(painting)).not.toContain('serene');
  });

  it('a mood-tagged blockbuster with an era word in its tags is not adjacent to a painting', () => {
    const evidence = artworkEvidence([painting])!;
    expect(entityAdjacency(film('Fight Club', ['Serene', '20th century', 'Dark']), evidence)).toBe(false);
    expect(referenceKeywords(['Girl with a Pearl Earring'])).toEqual(['girl', 'pearl', 'earring']);
  });
});
