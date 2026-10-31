import { describe, expect, it } from 'vitest';
import { admitDiscovery, discoveryReason, proofIsActive, sameNamedWorkTitle, seedMatchesSubject, type TasteProvenance } from './discovery-evidence';
import { storedAesthetic, storedSubject } from './test-support';
import { homeKindOf } from './home-affinity';
import { candidateAuditRecord } from './candidate-audit';
import type { QlooEntity } from '@culture-atlas/providers';

const movie = 'urn:entity:movie';
const artist = 'urn:entity:artist';
const brand = 'urn:entity:brand';
const tag = (id: string, name: string) => ({ id, name });
const entity = (type = movie, tags: QlooEntity['tags'] = []): QlooEntity => ({
  entity_id: 'candidate', name: 'Fixture candidate', types: [type], properties: {}, tags,
});
const jacket = storedSubject({ label: 'Denim jacket', aesthetics: [storedAesthetic('Workwear')] });
const taste = (ids = ['seed']): TasteProvenance => ({
  queryId: 'query-1', requestSeedIds: ids,
  seeds: ids.map((id) => ({ id, name: `Fixture ${id}`, subjectId: jacket.id })),
});

describe('Qloo-native admission, not visual-product matching', () => {
  it('shared-title admission preserves word order, not unordered name similarity or a partial name', () => {
    expect(sameNamedWorkTitle('The Girl with a Pearl Earring', 'Girl with a Pearl Earring')).toBe(true);
    expect(sameNamedWorkTitle('Pearl Earring Blues', 'Girl with a Pearl Earring')).toBe(false);
    expect(sameNamedWorkTitle('Pearl with a Girl Earring', 'Girl with a Pearl Earring')).toBe(false);
  });

  it('an early film or artist anchor cannot claim a sculpture or garment as its media subject', () => {
    const sculpture = storedSubject({ category: 'media', label: 'Marble sculpture' });
    expect(seedMatchesSubject(sculpture, [movie])).toBe(false);
    expect(seedMatchesSubject(sculpture, [artist])).toBe(false);
    expect(seedMatchesSubject(sculpture, [brand])).toBe(false);
    expect(seedMatchesSubject(jacket, [movie])).toBe(false);
    expect(seedMatchesSubject(jacket, [brand])).toBe(true);
    expect(seedMatchesSubject(storedSubject({ category: 'media', label: 'Film poster' }), [movie])).toBe(true);
    expect(seedMatchesSubject(storedSubject({ category: 'media', label: 'Music record sleeve' }), [artist])).toBe(true);
  });

  it('admits a genuine taste connection without demanding lexical topic/visual overlap', () => {
    const proof = admitDiscovery([jacket], entity(), movie, { origin: 'bridge', taste: taste() })!;
    expect(proof).toMatchObject({ relation: 'qloo_taste', provenance: { queryId: 'query-1', seedIds: ['seed'], attribution: 'single_request_seed' } });
    expect(discoveryReason(proof, movie)).toBe('Explore a Qloo taste connection through Fixture seed');
    expect(discoveryReason(proof, movie)).not.toMatch(/matches|look|topic|influenced|inspired/i);
  });

  it('cannot attribute multi-seed results without actual valid returned influences', () => {
    expect(admitDiscovery([jacket], entity(), movie, { taste: taste(['one', 'two']) })).toBeNull();
    const explained = { ...entity(), query: { explainability: [{ entity_id: 'two', score: 0.4 }, { entity_id: 'not-supplied', score: 0.9 }] } };
    const proof = admitDiscovery([jacket], explained, movie, { taste: taste(['one', 'two']) })!;
    expect(proof.provenance).toMatchObject({ seedIds: ['two'], seedNames: ['Fixture two'], attribution: 'returned_explainability' });
    expect(discoveryReason(proof, movie)).toBe('Explore a Qloo taste connection through Fixture two');
    expect(admitDiscovery([jacket], explained, movie, { taste: taste() })).toBeNull();
    expect(admitDiscovery([jacket], entity(), movie, { taste: { ...taste(), requestSeedIds: [] } })).toBeNull();
    expect(admitDiscovery([jacket], entity(), movie, { taste: { ...taste(), seeds: [] } })).toBeNull();
    expect(admitDiscovery([jacket], { ...entity(), types: [] }, movie, { taste: taste() })).toBeNull();
  });

  it('requires the seed-selected subject and active seed claim, not another convenient subject', () => {
    const claim = { slot: 'aesthetics' as const, name: 'Workwear', wording: 'asserted' as const };
    const provenance = { ...taste(), seeds: [{ ...taste().seeds[0]!, claim }] };
    const proof = admitDiscovery([jacket], entity(), movie, { taste: provenance })!;
    expect(proofIsActive(proof, [jacket])).toBe(true);
    for (const field of ['held', 'retracted'] as const) {
      const hidden = { ...jacket, aesthetics: [storedAesthetic('Workwear', { [field]: true })] };
      expect(admitDiscovery([hidden], entity(), movie, { taste: provenance })).toBeNull();
      expect(proofIsActive(proof, [hidden])).toBe(false);
    }
    expect(admitDiscovery([{ ...jacket, id: 'different' }], entity(), movie, { taste: provenance })).toBeNull();
  });

  it('artist type and affinity are not music evidence; actual music tags preserve legitimate artists', () => {
    expect(admitDiscovery([jacket], entity(artist), artist, { taste: taste() })).toBeNull();
    const music = entity(artist, [tag('urn:tag:genre:music:jazz', 'Jazz')]);
    expect(admitDiscovery([jacket], music, artist, { taste: taste() })?.relation).toBe('qloo_taste');
    expect(admitDiscovery([jacket], entity('urn:entity:book'), 'urn:entity:book', { taste: taste() })).toBeNull();
  });

  it('never turns a sculpture, illustration or generic Stylized style into film preferences', () => {
    for (const label of ['Classical marble sculpture', 'Clay sculpture head', 'Flat vector illustration']) {
      const subject = storedSubject({ category: 'media', label, aesthetics: [storedAesthetic('Stylized')] });
      const candidate = entity(movie, [tag('urn:tag:style:qloo:stylized', 'Stylized')]);
      expect(admitDiscovery([subject], candidate, movie)).toBeNull();
      expect(homeKindOf(subject)).toBeNull();
    }
    const statue = storedSubject({ category: 'media', label: 'Marble sculpture' });
    const tagged = entity(movie, [tag('urn:tag:theme:qloo:sculptor', 'Sculptor')]);
    expect(admitDiscovery([statue], tagged, movie)).toBeNull();
    const focused = { ...tagged, properties: { description: 'The documentary profiles a sculptor and explores sculpture making.' },
      tags: [...tagged.tags, tag('urn:tag:genre:media:documentary', 'Documentary')] };
    expect(admitDiscovery([statue], focused, movie)?.relation).toBe('about_subject');
  });

  it('requires actual commercial scope and form even for strongly explained brand affinity', () => {
    const casual = tag('urn:tag:genre:brand:fashion:casual', 'Casual apparel');
    const eyewear = tag('urn:tag:genre:brand:fashion:accessories:eyewear', 'Eyewear');
    expect(admitDiscovery([jacket], entity(brand, [eyewear]), brand, { taste: taste() })).toBeNull();
    expect(admitDiscovery([jacket], entity(brand), brand, { taste: taste() })).toBeNull();
    expect(admitDiscovery([jacket], entity(brand, [casual]), brand)?.relation).toBe('brand_exploration');
    expect(discoveryReason(admitDiscovery([jacket], entity(brand, [casual]), brand)!, brand)).toContain('A brand to explore');
    const bag = storedSubject({ label: 'Crossbody bag' });
    const tote = entity(brand, [tag('urn:tag:genre:brand:fashion:accessories:bags_and_leather', 'Bags and leather'), tag('urn:tag:signature_piece:qloo:tote', 'Tote bags')]);
    expect(admitDiscovery([bag], tote, brand, { taste: taste() })).toBeNull();
  });

  it('clay artwork and dereliction retain observations, not default tableware/decor shopping intent', () => {
    for (const subject of [
      storedSubject({ category: 'interior', label: 'Ceramic head', materials: [{ ...storedAesthetic('Clay'), texture: 'rough' }] }),
      storedSubject({ category: 'interior', label: 'Abandoned room', aesthetics: [storedAesthetic('Urban decay')] }),
    ]) {
      expect(homeKindOf(subject)).toBeNull();
      expect(admitDiscovery([subject], entity(brand, [tag('urn:tag:industry:qloo:tableware', 'Tableware'), tag('urn:tag:material:qloo:clay', 'Clay')]), brand)).toBeNull();
    }
    const bowl = storedSubject({ category: 'interior', label: 'Glazed ceramic bowl' });
    expect(admitDiscovery([bowl], entity(brand, [tag('urn:tag:industry:qloo:tableware', 'Tableware')]), brand)?.relation).toBe('brand_exploration');
  });

  it('places need actual type, user city request and candidate metadata or attributable taste', () => {
    const subject = storedSubject({ category: 'food', label: 'Ramen bowl' });
    const ramen = tag('urn:tag:genre:place:restaurant:ramen', 'Ramen');
    const place = entity('urn:entity:place', [ramen]);
    const options = { place: { queryId: 'query-city', city: 'Brooklyn, NY', requestType: 'urn:entity:place', filterTagIds: [ramen.id] } };
    expect(admitDiscovery([subject], place, 'urn:entity:place')).toBeNull();
    expect(admitDiscovery([subject], place, 'urn:entity:place', options)?.relation).toBe('place_exploration');
    expect(admitDiscovery([subject], { ...place, types: [brand] }, 'urn:entity:place', options)).toBeNull();
    expect(admitDiscovery([subject], { ...place, properties: { address: 'Manhattan, NY' } }, 'urn:entity:place', options)).toBeNull();
    expect(admitDiscovery([subject], { ...place, tags: [] }, 'urn:entity:place', options)).toBeNull();
  });

  it('records bounded evidence and metadata availability, never image URLs or opaque properties', () => {
    const result = candidateAuditRecord({ ...entity(), tags: Array.from({ length: 200 }, (_, i) => tag(`id-${i}`, `Tag ${i}`)), properties: { image: { url: 'https://private.invalid/signed?secret=1' }, description: 'unpublished text', secret: 'hidden' } }, 0);
    expect(result).toMatchObject({ schema_version: 'qloo_candidate_audit_v1', tagsTotal: 200, tagsTruncated: true, metadataAvailability: { description: true, image: true, imageRole: 'unknown' } });
    expect(result.tags).toHaveLength(160);
    expect(JSON.stringify(result)).not.toMatch(/signed|secret|unpublished text/);
  });
});
