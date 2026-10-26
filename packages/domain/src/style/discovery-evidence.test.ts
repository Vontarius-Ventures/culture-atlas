import { describe, expect, it } from 'vitest';
import { activeSubject } from './discovery-concepts';
import { admitDiscovery, discoveryReason, namedWorkProof, planDiscovery, type DiscoveryOrigin } from './discovery-evidence';
import { echoNames } from './affinity';
import { storedAesthetic, storedSubject } from './test-support';

const movie = 'urn:entity:movie';
const artist = 'urn:entity:artist';
const brand = 'urn:entity:brand';
const tag = (name: string, ns = 'theme') => ({ id: `urn:tag:${ns}:qloo:${name.toLowerCase().replace(/\W+/g, '_')}`, name });
const candidate = (name: string, type: string, tags: ReturnType<typeof tag>[]) => ({ entity_id: `candidate-${name}`, name, types: [type], tags });
const room = (aesthetic: string) => storedSubject({ category: 'interior', label: 'A furnished room', aesthetics: [storedAesthetic(aesthetic, { wording: 'resembles' })] });
const origins: DiscoveryOrigin[] = ['anchor', 'bridge', 'topic'];

describe('route-independent evidence-chain admission', () => {
  it.each(origins)('%s cannot turn an audience-only brand connection into topic relevance', (origin) => {
    const subject = storedSubject({ category: 'fashion', label: 'Bomber jacket', aesthetics: [storedAesthetic('Varsity')] });
    expect(admitDiscovery([subject], candidate('Comedy', movie, [tag('Comedy', 'genre:media')]), movie, { origin })).toBeNull();
    const proof = admitDiscovery([subject], candidate('Campus story', movie, [tag('Varsity')]), movie, { origin, readingRev: 2 });
    expect(proof).toMatchObject({ subjectId: subject.id, origin, readingRev: 2, relation: 'shared_subculture', claim: { slot: 'aesthetics', name: 'Varsity' } });
    expect(proof!.candidateTags).toEqual([{ id: tag('Varsity').id, label: 'Varsity' }]);
  });

  it.each(origins)('%s rejects region/style/sound homonyms but preserves genuine shared subcultures', (origin) => {
    for (const [visual, sound] of [['California modern', 'California'], ['Warm minimalism', 'Minimalism'], ['Rustic', 'Rustic'], ['Playful eclectic', 'Eclectic']]) {
      expect(admitDiscovery([room(visual!)], candidate(sound!, artist, [tag(sound!, 'genre:music')]), artist, { origin })).toBeNull();
    }
    const outfit = storedSubject({ category: 'fashion', label: 'Denim jacket', aesthetics: [storedAesthetic('Grunge')] });
    expect(admitDiscovery([outfit], candidate('Band', artist, [tag('Grunge', 'genre:music')]), artist, { origin })?.relation).toBe('shared_subculture');
  });

  it('music Minimalism is valid when the observed subject is explicitly music, not an interior', () => {
    const record = storedSubject({ category: 'media', label: 'Music record sleeve', aesthetics: [storedAesthetic('Minimalism')] });
    expect(admitDiscovery([record], candidate('Composer', artist, [tag('Minimalism', 'genre:music')]), artist)).not.toBeNull();
    expect(planDiscovery([room('Warm minimalism')], artist)).toEqual([]);
    expect(planDiscovery([record], artist).length).toBeGreaterThan(0);
  });

  it('requires the actual fill tag to prove the relation, not an unrelated tag on the candidate', () => {
    const subject = storedSubject({ category: 'fashion', label: 'Jacket', aesthetics: [storedAesthetic('Punk')] });
    const sound = tag('Punk', 'genre:music');
    const region = tag('California', 'genre:music');
    const entity = candidate('Band', artist, [region, sound]);
    expect(admitDiscovery([subject], entity, artist, { origin: 'topic', tagIds: new Set([region.id]) })).toBeNull();
    expect(admitDiscovery([subject], entity, artist, { origin: 'topic', tagIds: new Set([sound.id]) })).not.toBeNull();
  });

  it('retains architectural, culinary, ceramics and art topic relations without invented identities', () => {
    const cases = [
      { subject: room('Mid-century modern'), topic: 'Architecture' },
      { subject: storedSubject({ category: 'food', label: 'Ramen bowl' }), topic: 'Culinary cinema' },
      { subject: storedSubject({ category: 'interior', label: 'Glazed ceramic bowls', aesthetics: [storedAesthetic('Persian ceramics', { wording: 'resembles' })] }), topic: 'Pottery' },
      { subject: storedSubject({ category: 'media', label: 'Oil portrait painting' }), topic: 'Artists' },
    ];
    for (const { subject, topic } of cases) {
      const proof = admitDiscovery([subject], candidate(topic, movie, [tag(topic)]), movie)!;
      expect(proof).not.toBeNull();
      expect(proof.relation).toBe('about_subject');
      const reason = discoveryReason(proof, movie);
      expect(reason).toContain(topic);
      expect(reason.length).toBeLessThanOrEqual(90);
      expect(reason).not.toMatch(/identified as|shares a taste|this is/i);
    }
  });

  it('does not promote a generic plot keyword into an about-art or architecture topic', () => {
    expect(admitDiscovery([room('Classic')], candidate('Plot', movie, [tag('Architecture', 'keyword')]), movie)).toBeNull();
    const painting = storedSubject({ category: 'media', label: 'Oil painting' });
    expect(admitDiscovery([painting], candidate('Plot', movie, [tag('Artist', 'keyword')]), movie)).toBeNull();
  });

  it('retains compound design concepts but not their region or abstract qualifier alone', () => {
    const subject = room('California modern');
    expect(admitDiscovery([subject], candidate('Region', movie, [tag('California')]), movie)).toBeNull();
    expect(admitDiscovery([subject], candidate('Design film', movie, [tag('California modern')]), movie)?.claim.name).toBe('California modern');
    expect(admitDiscovery([room('Warm minimalism')], candidate('Style film', movie, [tag('Minimalism')]), movie)).toBeNull();
  });

  it('never matches held/retracted claims or borrows a different origin subject', () => {
    const hidden = storedSubject({
      id: 'hidden', category: 'fashion', label: 'Jacket',
      aesthetics: [storedAesthetic('Punk', { held: true }), storedAesthetic('Grunge', { retracted: true })],
    });
    const active = storedSubject({ id: 'active', category: 'fashion', label: 'Jacket', aesthetics: [storedAesthetic('Punk')] });
    const entity = candidate('Band', artist, [tag('Punk', 'genre:music')]);
    expect(activeSubject(hidden).aesthetics).toEqual([]);
    expect(admitDiscovery([hidden], entity, artist)).toBeNull();
    expect(admitDiscovery([hidden, active], entity, artist, { subjectIds: new Set(['hidden']) })).toBeNull();
    expect(admitDiscovery([hidden, active], entity, artist)?.subjectId).toBe('active');
  });

  it('requires meaningful same-domain design proof rather than generic co-liked labels', () => {
    const subject = storedSubject({ category: 'fashion', label: 'Jacket', aesthetics: [storedAesthetic('Varsity')] });
    const genre = { id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual apparel' };
    expect(admitDiscovery([subject], candidate('Generic label', brand, [genre]), brand)).toBeNull();
    const proof = admitDiscovery([subject], candidate('Collegiate label', brand, [genre, tag('Varsity', 'personal_style')]), brand);
    expect(proof?.relation).toBe('shared_design');
  });

  it('gates against the subject that supplies proof, not the first garment in the image', () => {
    const subjects = [
      storedSubject({ id: 'shoe', category: 'fashion', label: 'Sneakers', aesthetics: [storedAesthetic('Athletic')] }),
      storedSubject({ id: 'bag', category: 'fashion', label: 'Leather bag', aesthetics: [storedAesthetic('Sculptural')] }),
    ];
    const entity = candidate('Bag label', brand, [
      { id: 'urn:tag:genre:brand:fashion:accessories:bags_and_leather', name: 'Bags and leather' },
      tag('Sculptural', 'personal_style'),
    ]);
    expect(admitDiscovery(subjects, entity, brand)?.subjectId).toBe('bag');
    expect(admitDiscovery(subjects, entity, brand, { subjectIds: new Set(['shoe']) })).toBeNull();
  });

  it('does not rediscover anchors by id or duplicate name, but names shared-title as a separate relation', () => {
    const subject = storedSubject({ category: 'fashion', label: 'Jacket', aesthetics: [storedAesthetic('Punk')], brand: { name: 'Visible label', read_text: 'Visible label' } });
    const entity = candidate('Visible label', brand, [tag('Punk', 'personal_style')]);
    expect(admitDiscovery([subject], entity, brand)).toBeNull();
    const other = candidate('Another label', brand, [tag('Punk', 'personal_style')]);
    expect(admitDiscovery([subject], other, brand, { excludedIds: new Set([other.entity_id]) })).toBeNull();
    expect(admitDiscovery([subject], other, brand, { excludedNames: echoNames(['Another label']) })).toBeNull();
    const proof = namedWorkProof('painting', 'film-id', 'A Named Portrait', 'reference-id', 'resembles', 3);
    expect(proof).toMatchObject({ relation: 'shared_named_work', referenceId: 'reference-id', candidateTags: [] });
    expect(discoveryReason(proof, movie)).toBe('A film sharing its title with A Named Portrait, the work your photo resembles');
  });
});
