import { describe, expect, it } from 'vitest';
import { activeSubject } from './discovery-concepts';
import { admitDiscovery, discoveryReason, namedWorkProof, planDiscovery, type DiscoveryOrigin } from './discovery-evidence';
import { echoNames } from './affinity';
import { storedAesthetic, storedSubject } from './test-support';
import { selectEvidenceFirst } from './discovery-selection';

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
      { subject: room('Mid-century modern'), topic: 'architecture', description: 'The film explores architecture and the work of architects.' },
      { subject: storedSubject({ category: 'food', label: 'Ramen bowl' }), topic: 'noodles', description: 'The film follows a ramen chef making noodles.' },
      { subject: storedSubject({ category: 'interior', label: 'Glazed ceramic bowls', aesthetics: [storedAesthetic('Persian ceramics', { wording: 'resembles' })] }), topic: 'pottery', description: 'The film profiles potters and their pottery.' },
      { subject: storedSubject({ category: 'media', label: 'Oil portrait painting' }), topic: 'painting', description: 'The film profiles painters and explores painting.' },
    ];
    for (const { subject, topic, description } of cases) {
      const entity = { ...candidate(topic, movie, [tag(topic), tag('Documentary', 'genre:media')]), properties: { description } };
      const proof = admitDiscovery([subject], entity, movie)!;
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
    expect(admitDiscovery([subject], candidate('Design film', movie, [tag('California modern')]), movie)).toBeNull();
    const film = { ...candidate('Design film', movie, [tag('California modern'), tag('Documentary', 'genre:media')]),
      properties: { description: 'The film explores California modern architecture.' } };
    expect(admitDiscovery([subject], film, movie)?.contentEvidence?.topic).toBe('architecture');
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

  it('distinguishes compatible brand exploration from candidate-owned design evidence', () => {
    const subject = storedSubject({ category: 'fashion', label: 'Jacket', aesthetics: [storedAesthetic('Varsity')] });
    const genre = { id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual apparel' };
    expect(admitDiscovery([subject], candidate('Generic label', brand, [genre]), brand)?.relation).toBe('brand_exploration');
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

  it('prefers later permitted direct evidence over first-subject brand exploration', () => {
    const first = storedSubject({ id: 's1', category: 'fashion', label: 'Jacket', aesthetics: [storedAesthetic('Varsity')] });
    const second = storedSubject({ id: 's2', category: 'fashion', label: 'Jacket', aesthetics: [storedAesthetic('Punk')] });
    const entity = candidate('Label', brand, [{ id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual apparel' }, tag('Punk', 'personal_style')]);
    for (const subjects of [[first, second], [second, first]]) {
      const direct = admitDiscovery(subjects, entity, brand)!;
      expect(direct).toMatchObject({ subjectId: 's2', relation: 'shared_design' });
      const fallback = admitDiscovery(subjects, entity, brand, { subjectIds: new Set(['s1']) })!;
      expect(fallback).toMatchObject({ subjectId: 's1', relation: 'brand_exploration' });
      expect(selectEvidenceFirst([fallback, direct], p => p, (pool, n) => pool.slice(0, n), 1, 1)).toEqual([direct]);
    }
    for (const state of ['held', 'retracted'] as const) {
      const hidden = { ...second, aesthetics: [storedAesthetic('Punk', { [state]: true })] };
      expect(admitDiscovery([first, hidden], entity, brand)?.relation).toBe('brand_exploration');
    }
    expect(admitDiscovery([first, second], entity, brand, { tagIds: new Set([entity.tags[0]!.id]) })?.relation).toBe('brand_exploration');
    expect(admitDiscovery([first, second], entity, brand, { excludedIds: new Set([entity.entity_id]) })).toBeNull();
  });

  it('prefers later direct topic evidence over a valid earlier taste fallback', () => {
    const first = storedSubject({ id: 's1', category: 'fashion', label: 'Jacket', aesthetics: [storedAesthetic('Varsity')] });
    const second = storedSubject({ id: 's2', category: 'fashion', label: 'Jacket', aesthetics: [storedAesthetic('Punk')] });
    const entity = candidate('Punk film', movie, [tag('Punk')]);
    const options = { taste: { queryId: 'query', requestSeedIds: ['seed'], seeds: [{ id: 'seed', name: 'Seed brand', subjectId: 's1' }] } };
    for (const subjects of [[first, second], [second, first]]) {
      expect(admitDiscovery(subjects, entity, movie, options)).toMatchObject({ subjectId: 's2', relation: 'shared_subculture' });
      expect(admitDiscovery(subjects, entity, movie, { ...options, subjectIds: new Set(['s1']) })).toMatchObject({ subjectId: 's1', relation: 'qloo_taste' });
    }
    const ambiguous = { taste: { ...options.taste, requestSeedIds: ['seed', 'other'], seeds: [...options.taste.seeds, { id: 'other', name: 'Other seed', subjectId: 's1' }] } };
    expect(admitDiscovery([first], entity, movie, ambiguous)).toBeNull();
    expect(admitDiscovery([first, second], entity, movie, { ...options, tagIds: new Set(['not-requested']) })).toBeNull();
  });

  it('distinguishes direct-design reasons from exploration without promising a visual or product match', () => {
    const subject = storedSubject({ category: 'fashion', label: 'Jacket', aesthetics: [storedAesthetic('Punk', { wording: 'resembles' })] });
    const genre = { id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual apparel' };
    const direct = admitDiscovery([subject], candidate('Label', brand, [genre, tag('Punk', 'personal_style')]), brand)!;
    const exploration = admitDiscovery([subject], candidate('Scope', brand, [genre]), brand)!;
    expect(discoveryReason(direct, brand)).toBe('A brand tagged Punk; connected to Punk, which your photo resembles');
    expect(discoveryReason(exploration, brand)).toBe('A brand to explore; catalogue tag: Casual apparel');
    expect(discoveryReason(direct, brand)).not.toMatch(/visual match|same product|made by|for sale/i);
  });

  it('keeps the photo connection and uncertainty when shortening long topic and content reasons', () => {
    const name = 'California modern architecture with warm natural materials and sculptural furnishings';
    const proof = {
      subjectId: 's1', candidateId: 'film', relation: 'about_subject' as const, origin: 'topic' as const,
      claim: { slot: 'aesthetics' as const, name, wording: 'resembles' as const },
      candidateTags: [{ id: 'topic', label: 'Architecture and interior design throughout the twentieth century' }],
    };
    const reason = discoveryReason(proof, movie);
    expect(reason).toContain('California modern');
    expect(reason).toContain('photo resemblance');
    expect(reason.length).toBeLessThanOrEqual(90);
    const content = discoveryReason({ ...proof, contentEvidence: {
      topic: 'architecture', claim: proof.claim, field: 'description', excerpt: 'Explores architecture.',
      documentaryTag: { id: 'documentary', label: 'Documentary' },
    } }, movie);
    expect(content).toContain('architecture');
    expect(content).toContain('source appearance');
    expect(content).toContain('your photo may suggest');
    expect(content.length).toBeLessThanOrEqual(90);
  });

  it.each(origins)('%s cannot promote material, ordinary fit or generic product scope into shared design', (origin) => {
    const genre = { id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual apparel' };
    for (const name of ['Leather', 'Canvas', 'Cotton', 'Slim fit', 'Relaxed fit', 'Jacket', 'Red', 'Luxury']) {
      const subject = storedSubject({ label: 'Jacket', aesthetics: [storedAesthetic(name)] });
      expect(admitDiscovery([subject], candidate('Scope label', brand, [genre, tag(name, 'personal_style')]), brand, { origin })?.relation).toBe('brand_exploration');
    }
    const material = storedSubject({ label: 'Jacket', materials: [{ ...storedAesthetic('Embroidered leather'), texture: '' }] });
    expect(planDiscovery([material], brand)).toEqual([]);
    expect(admitDiscovery([material], candidate('Material label', brand, [genre, tag('Embroidered leather', 'aesthetic_property')]), brand, { origin })?.relation).toBe('brand_exploration');
    const aesthetic = storedSubject({ label: 'Jacket', aesthetics: [storedAesthetic('Punk')] });
    expect(admitDiscovery([aesthetic], candidate('Material tag label', brand, [genre, tag('Punk', 'material')]), brand, { origin })?.relation).toBe('brand_exploration');
    const culturalMaterial = storedSubject({ materials: [{ ...storedAesthetic('Punk leather'), texture: '' }] });
    expect(admitDiscovery([culturalMaterial], candidate('Punk film', movie, [tag('Punk')]), movie, { origin })).toBeNull();
    expect(admitDiscovery([culturalMaterial], candidate('Taste film', movie, []), movie, { origin,
      taste: { queryId: 'q', requestSeedIds: ['seed'], seeds: [{ id: 'seed', name: 'Material-selected seed', subjectId: culturalMaterial.id,
        claim: { slot: 'materials', name: 'Punk leather', wording: 'asserted' } }] },
    })).toBeNull();
  });

  it('filters invalid high-weight witnesses before selecting a valid lower-weight design tag', () => {
    const genre = { id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual apparel' };
    const subject = storedSubject({ label: 'Jacket', aesthetics: [storedAesthetic('Breton stripes')] });
    const entity = candidate('Striped label', brand, [genre, tag('Breton stripes', 'material'), tag('Breton stripes', 'personal_style')]);
    expect(admitDiscovery([subject], entity, brand)?.candidateTags).toEqual([{ id: tag('Breton stripes', 'personal_style').id, label: 'Breton stripes' }]);
    const construction = storedSubject({ label: 'Skirt', construction: [{ ...storedAesthetic('Pleated'), kind: 'pattern' }] });
    expect(admitDiscovery([construction], candidate('Pleated label', brand, [genre, tag('Pleated skirt', 'signature_piece')]), brand)?.relation).toBe('shared_design');
    expect(admitDiscovery([{ ...subject, aesthetics: [storedAesthetic('Breton stripes', { basis: 'context' })] }], entity, brand)?.relation).toBe('brand_exploration');
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
