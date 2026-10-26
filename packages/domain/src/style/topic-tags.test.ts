import { describe, expect, it } from 'vitest';
import type { QlooTag } from '@culture-atlas/providers';
import {
  AMBIGUOUS_TOPIC_TERMS,
  ART_TOPIC_QUERIES,
  GENERIC_TOPIC_TAGS,
  resolveTopicTags,
  taggedTopicReason,
  TOPIC_TAG_QUERIES_MAX,
  TOPIC_TAGS_MAX,
  topicTagPlan,
} from './topic-tags';
import { storedAesthetic, storedSubject } from './test-support';

/**
 * Synthetic readings (shapes only, never model output and never an eval photo's
 * answer): the same claim-word classes the live readings use, in different
 * combinations. Qloo tags below are hand-written fixtures shaped like the
 * recorded /v2/tags responses (fixtures/qloo/probe-2026-10-24-tune/s6, s7), or
 * ids recorded in fixtures/qloo/style-vocab/vocab.json (urn:tag:theme:qloo:
 * urban_decay, urn:tag:subgenre:qloo:city_portrait).
 */

const lineage = (name: string) => ({ name, certainty: 0.7, wording: 'resembles' as const, display: name, strength: null as never, corroborated_by: [], held: false, basis: 'visible' as const, region: null, qloo: null });

describe('topic source sense survives lookup', () => {
  it('permits an explicitly typed ceramics-to-pottery topic without asserting historical identity', () => {
    const subject = storedSubject({ category: 'interior', label: 'Glazed ceramic bowls', aesthetics: [storedAesthetic('Persian ceramics', { wording: 'resembles' })] });
    const plan = topicTagPlan([subject]);
    const tag: QlooTag = { id: 'urn:tag:theme:qloo:pottery', name: 'Pottery', type: 'urn:tag:theme', parents: ['urn:entity:movie'] };
    const results = new Map(plan.map((q) => [q.query, [tag]]));
    expect(resolveTopicTags(plan, results, 'urn:entity:movie')).toMatchObject([{ subjectId: subject.id, name: 'Pottery' }]);
    expect(resolveTopicTags(plan, results, 'urn:entity:artist')).toEqual([]);
  });
  const resolve = (name: string, sound: string) => {
    const subject = storedSubject({ category: 'interior', label: 'Furnished room', aesthetics: [storedAesthetic(name)] });
    const plan = topicTagPlan([subject]);
    const tag: QlooTag = { id: `urn:tag:genre:music:qloo:${sound.toLowerCase()}`, name: sound, type: 'urn:tag:genre', parents: ['urn:entity:artist'] };
    return resolveTopicTags(plan, new Map(plan.map((q) => [q.query, [tag]])), 'urn:entity:artist');
  };
  it('rejects real but unrelated music tags reached through visual words', () => {
    expect(resolve('California modern', 'California')).toEqual([]);
    expect(resolve('Warm minimalism', 'Minimalism')).toEqual([]);
    expect(resolve('Rustic', 'Rustic')).toEqual([]);
    expect(resolve('Playful eclectic', 'Eclectic')).toEqual([]);
  });
  it('keeps a real shared subculture tag and removes hidden reading words', () => {
    const subject = storedSubject({
      category: 'fashion', label: 'Denim jacket',
      aesthetics: [storedAesthetic('Grunge'), storedAesthetic('Baroque', { held: true }), storedAesthetic('Romantic', { retracted: true })],
    });
    const plan = topicTagPlan([subject]);
    expect(plan.every((q) => !q.reading.includes('baroque') && !q.reading.includes('romantic'))).toBe(true);
    const tag: QlooTag = { id: 'urn:tag:genre:music:grunge', name: 'Grunge', type: 'urn:tag:genre', parents: ['urn:entity:artist'] };
    expect(resolveTopicTags(plan, new Map([['grunge', [tag]]]), 'urn:entity:artist').map((t) => t.name)).toEqual(['Grunge']);
  });
});

describe('TOPIC-1 fill: the reading\'s own words as /v2/tags queries', () => {
  it('preserves compound concepts before bounded head-word fallbacks', () => {
    const motel = storedSubject({
      id: 's1',
      category: 'interior',
      label: 'Disused paneled motel room',
      aesthetics: [storedAesthetic('Abandoned decay', { wording: 'resembles' }), storedAesthetic('Roadside motel', { wording: 'resembles' })],
    });
    // Compounds retain the source sense, rather than losing it to a shared word.
    expect(topicTagPlan([motel]).map((q) => q.query)).toEqual(['Abandoned decay', 'Roadside motel']);
    expect(topicTagPlan([motel], 4).map((q) => q.query)).toEqual(['Abandoned decay', 'Roadside motel', 'decay', 'motel']);
    expect(TOPIC_TAG_QUERIES_MAX).toBeLessThanOrEqual(2);
  });

  it('drops generic qualifiers, colours, garment nouns and feeling-words; keeps the topic word', () => {
    const drink = storedSubject({
      id: 's1',
      category: 'food',
      label: 'Espresso in a ceramic cup',
      aesthetics: [storedAesthetic('Italian espresso', { wording: 'resembles' }), storedAesthetic('Classic cafe', { wording: 'resembles' })],
      lineage: [lineage('Italian coffee bar')],
    });
    expect(topicTagPlan([drink]).map((q) => q.query)).toEqual(['Italian espresso', 'Italian coffee bar']);
    const varsity = storedSubject({
      id: 's1',
      category: 'fashion',
      label: 'Varsity bomber jacket',
      aesthetics: [storedAesthetic('Varsity'), storedAesthetic('Athletic', { wording: 'resembles' })],
    });
    expect(topicTagPlan([varsity]).map((q) => q.query)).toEqual(['varsity', 'athletic']);
    // Only generic words: nothing honest to search, no fill.
    const plain = storedSubject({ id: 's1', category: 'interior', label: 'Casual room', aesthetics: [storedAesthetic('Classic modern')] });
    expect(topicTagPlan([plain])).toEqual([]);
    // A stopped head word is not the topic: "tennis whites" asks for tennis.
    const tennis = storedSubject({ id: 's1', category: 'fashion', label: 'Tennis skirt and top set', aesthetics: [storedAesthetic('Tennis whites', { wording: 'resembles' })] });
    expect(topicTagPlan([tennis]).map((q) => q.query)).toEqual(['tennis']);
  });

  it('a fine-art subject asks for art itself first (artist-biopic themes for a painting)', () => {
    const painting = storedSubject({
      id: 's1',
      category: 'media',
      label: 'Baroque oil portrait painting',
      aesthetics: [storedAesthetic('Baroque', { wording: 'resembles' })],
      lineage: [lineage('Dutch Golden Age portraiture')],
    });
    expect(ART_TOPIC_QUERIES).toEqual(['painting', 'portrait']);
    expect(topicTagPlan([painting]).map((q) => q.query)).toEqual(['painting', 'portrait']);
  });

  it('held claims never become queries; the second subject is asked after the first', () => {
    const two = [
      storedSubject({ id: 's1', category: 'fashion', label: 'Sweet romantic dress', aesthetics: [storedAesthetic('Sweet romantic', { wording: 'resembles', held: true }), storedAesthetic('Ditsy floral')] }),
      storedSubject({ id: 's2', category: 'fashion', label: 'Classic leather bag', aesthetics: [storedAesthetic('Timeless')] }),
    ];
    expect(topicTagPlan(two).map((q) => q.query)).toEqual(['Ditsy floral', 'floral']);
    expect(topicTagPlan(two).map((q) => q.label)).toEqual(['Sweet romantic dress', 'Sweet romantic dress']);
  });

  it('TOPIC-2: a period or school of another art form is not the reading\'s own topic (h71)', () => {
    // A "romantic" dress is a soft silhouette; Qloo's "Romantic" is the classical period, and
    // searching it put Beethoven, Schubert and Brahms on the Play rail (iteration-4 judges:
    // relevance 5.25/10). "Sweet" names a feeling, so the claim leaves nothing to search at all.
    expect(AMBIGUOUS_TOPIC_TERMS.has('romantic')).toBe(true);
    const dress = storedSubject({ id: 's1', category: 'fashion', label: 'Sweet romantic dress', aesthetics: [storedAesthetic('Sweet romantic', { wording: 'resembles' })] });
    expect(topicTagPlan([dress])).toEqual([]);
    // The art form's own sense IS the reading's topic: a music or film subject keeps the word.
    const record = storedSubject({ id: 's1', category: 'media', label: 'Classical music record sleeve', aesthetics: [storedAesthetic('Classical', { wording: 'resembles' })] });
    expect(topicTagPlan([record]).map((q) => q.query)).toEqual(['classical']);
  });
});

describe('TOPIC-1 fill: resolved tags', () => {
  const tag = (id: string, name: string, parents: string[] = [], popularity?: number): QlooTag => ({ id, name, type: id.split(':').slice(0, 3).join(':'), parents, popularity });
  const label = 'Disused paneled motel room';
  // The words the reading itself used: a tag resolved through them may add none (TOPIC-2).
  const reading = ['disused', 'paneled', 'motel', 'room', 'abandoned', 'decay', 'roadside'];
  const plan = [
    { query: 'motel', label, reading },
    { query: 'decay', label, reading },
  ];

  it('keeps only topical tags the target entity type carries', () => {
    const results = new Map<string, QlooTag[]>([
      ['motel', [tag('urn:tag:decor:qloo:motel', 'Motel', ['urn:entity:place']), tag('urn:tag:theme:qloo:roadside_motel', 'Roadside Motel', ['urn:entity:movie', 'urn:entity:tv_show'], 0.5)]],
      ['decay', [tag('urn:tag:theme:qloo:decay', 'Decay', ['urn:entity:movie'], 0.9)]],
    ]);
    const resolved = resolveTopicTags(plan, results, 'urn:entity:movie');
    // Qloo's own popularity orders the filter (Decay 0.9 over Roadside Motel 0.5).
    expect(resolved.map((t) => t.name)).toEqual(['Decay', 'Roadside Motel']);
    // A tag Qloo never types is kept (the insights filter.type says who carries it); the fill
    // never steers places: a decor tag is the wrong namespace, a movie-only theme the wrong type.
    const untyped = resolveTopicTags(plan, new Map([['motel', [tag('urn:tag:subgenre:qloo:motel', 'Motel')]]]), 'urn:entity:movie');
    expect(untyped.map((t) => t.tagId)).toEqual(['urn:tag:subgenre:qloo:motel']);
    const placeOnly = resolveTopicTags(plan, results, 'urn:entity:place');
    expect(placeOnly).toEqual([]);
  });

  it('ranks by Qloo popularity, de-duplicates across queries and caps the filter', () => {
    const noir = [{ query: 'motel', label, reading: [...reading, 'noir'] }, { query: 'decay', label, reading: [...reading, 'noir'] }];
    const results = new Map<string, QlooTag[]>([
      ['motel', [tag('urn:tag:theme:qloo:motel', 'Motel', [], 0.2), tag('urn:tag:genre:media:motel_noir', 'Motel Noir', [], 0.8)]],
      ['decay', [tag('urn:tag:theme:qloo:decay', 'Decay', [], 0.9), tag('urn:tag:theme:qloo:motel', 'Motel', [], 0.2)]],
    ]);
    const resolved = resolveTopicTags(noir, results, 'urn:entity:movie', 10);
    expect(resolved.map((t) => t.name)).toEqual(['Decay', 'Motel Noir', 'Motel']);
    expect(resolveTopicTags(noir, results, 'urn:entity:movie')).toHaveLength(TOPIC_TAGS_MAX);
    expect(resolved.every((t) => t.label === label)).toBe(true);
  });
});

describe('TOPIC-2 fill: only the reading\'s own words, and only evidence', () => {
  const tag = (id: string, name: string, parents: string[] = [], popularity?: number): QlooTag => ({ id, name, type: id.split(':').slice(0, 3).join(':'), parents, popularity });
  const label = 'Disused paneled motel room';
  const reading = ['disused', 'paneled', 'motel', 'room', 'abandoned', 'decay', 'roadside'];
  const plan = [
    { query: 'motel', label, reading },
    { query: 'decay', label, reading },
  ];
  const portrait = [{ query: 'portrait', label: 'Baroque oil portrait painting', reading: ['baroque', 'oil', 'portrait', 'painting', 'dutch', 'golden', 'age', 'portraiture'] }];

  it('drops a tag that adds a word the reading never used (h56 "Urban Decay", h61 "City portrait")', () => {
    const results = new Map<string, QlooTag[]>([
      ['decay', [tag('urn:tag:theme:qloo:urban_decay', 'Urban Decay', ['urn:entity:movie'], 0.9)]],
      ['motel', [tag('urn:tag:theme:qloo:roadside_motel', 'Roadside Motel', ['urn:entity:movie'], 0.5)]],
    ]);
    // "Urban Decay" adds "urban": Qloo's sense of the word, not the photo's. "Roadside Motel" adds
    // nothing the reading did not say.
    expect(resolveTopicTags(plan, results, 'urn:entity:movie').map((t) => t.name)).toEqual(['Roadside Motel']);
    // A portrait painting is not a "City portrait" (the reading never said city).
    const city = new Map([['portrait', [tag('urn:tag:subgenre:qloo:city_portrait', 'City portrait', ['urn:entity:movie'], 0.9)]]]);
    expect(resolveTopicTags(portrait, city, 'urn:entity:movie')).toEqual([]);
  });

  it('drops a bare domain or medium tag, keeps a tag that names the art itself (h61)', () => {
    expect(GENERIC_TOPIC_TAGS.has('painting')).toBe(true);
    const results = new Map<string, QlooTag[]>([
      ['painting', [tag('urn:tag:genre:media:painting', 'Painting', ['urn:entity:movie'], 0.9), tag('urn:tag:theme:qloo:dutch_golden_age_painting', 'Dutch Golden Age painting', ['urn:entity:movie'], 0.5)]],
    ]);
    const art = [{ query: 'painting', label: 'Baroque oil portrait painting', reading: ['baroque', 'oil', 'portrait', 'painting', 'dutch', 'golden', 'age', 'portraiture'] }];
    expect(resolveTopicTags(art, results, 'urn:entity:movie').map((t) => t.name)).toEqual(['Dutch Golden Age painting']);
  });

  it('fills a rail of people only from a tag that names a sound (h56 "Urban Decay" artists)', () => {
    const theme = new Map([['decay', [tag('urn:tag:theme:qloo:urban_decay', 'Urban Decay', ['urn:entity:movie', 'urn:entity:artist'], 0.9)]]]);
    expect(resolveTopicTags(plan, theme, 'urn:entity:artist')).toEqual([]);
    const music = new Map([['grunge', [tag('urn:tag:genre:music:grunge', 'Grunge', ['urn:entity:artist', 'urn:entity:album'], 0.99)]]]);
    const outfit = [{ query: 'grunge', label: 'Grunge denim jacket', reading: ['grunge', 'denim', 'jacket'] }];
    expect(resolveTopicTags(outfit, music, 'urn:entity:artist').map((t) => t.name)).toEqual(['Grunge']);
    // The same tag never steers a film rail (a music genre is not a film's own topic).
    expect(resolveTopicTags(outfit, music, 'urn:entity:movie')).toEqual([]);
  });
});

describe('TOPIC-1 fill: the card reason names the tag the result carries', () => {
  it('plain words, the reading\'s own subject, at most 90 characters', () => {
    expect(taggedTopicReason('urn:entity:movie', 'Roadside Motel', 'Disused paneled motel room')).toBe(
      'A film tagged Roadside Motel, like the disused paneled motel room in your photo',
    );
    expect(taggedTopicReason('urn:entity:artist', 'Baroque', 'Baroque oil portrait painting')).toBe(
      'An artist tagged Baroque, like the baroque oil portrait painting in your photo',
    );
    const long = taggedTopicReason('urn:entity:movie', 'Roadside Motel', 'A very long subject label that would push the reason over the line length limit for sure');
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long).toMatch(/^A film tagged Roadside Motel/);
    for (const text of [taggedTopicReason('urn:entity:movie', 'Painting', 'X')]) expect(text).not.toMatch(/culture atlas|qloo|score/i);
  });
});

describe('TOPIC-1 fill: Qloo\'s keyword namespace (eval r5, h56)', () => {
  const tag = (id: string, name: string, parents: string[] = [], popularity?: number): QlooTag => ({ id, name, type: id.split(':').slice(0, 3).join(':'), parents, popularity });
  const label = 'Disused paneled motel room';
  const reading = ['disused', 'paneled', 'motel', 'room', 'abandoned', 'decay', 'roadside'];
  const plan = [{ query: 'decay', label, reading }];

  it('the movie-side home of a topical word fills ("Decay" lives in keyword; no genre/subgenre/theme tag exists)', () => {
    const results = new Map<string, QlooTag[]>([['decay', [tag('urn:tag:keyword:qloo:decay', 'Decay', ['urn:entity:tv_show', 'urn:entity:movie'])]]]);
    expect(resolveTopicTags(plan, results, 'urn:entity:movie').map((t) => t.tagId)).toEqual(['urn:tag:keyword:qloo:decay']);
    // A rail of people still needs a tag that names a sound.
    expect(resolveTopicTags(plan, results, 'urn:entity:artist')).toEqual([]);
  });
});
