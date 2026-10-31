import { describe, expect, it } from 'vitest';
import { discoveryReason, type EvidenceEntity } from './discovery-evidence';
import { admitReferenceDiscovery, referenceFallbackAllowed, referenceProofIsActive, type DiscoveryReference } from './reference-admission';

const movie = 'urn:entity:movie';
const artist = 'urn:entity:artist';
const brand = 'urn:entity:brand';
const styleTag = { id: 'urn:tag:style:qloo:stylized', name: 'Stylized' };
const musicTag = { id: 'urn:tag:genre:music:jazz', name: 'Jazz' };
const fashionTag = { id: 'urn:tag:genre:brand:fashion:clothing', name: 'Clothing' };
const reference: DiscoveryReference = { referenceId: 'real-ref', name: 'Stylized', resolution: 'resolved', qloo: { tagId: styleTag.id } };
const entity = (type = movie, tags = [styleTag]): EvidenceEntity => ({ entity_id: 'candidate', name: 'Fixture Candidate', types: [type], tags });
const request = { queryId: 'actual-query', seedIds: [], tagIds: [styleTag.id] };
const seed = (id: string, type = movie): DiscoveryReference => ({
  referenceId: `real-${id}`, name: `Fixture ${id}`, resolution: 'resolved', qloo: { entityId: id, types: [type] },
});

describe('reference-grounded no-reader admission', () => {
  it.each(['pending', 'running', 'held', 'ready'])('does not publish ahead of an enabled %s style reader', (status) => {
    expect(referenceFallbackAllowed(false, true, status)).toBe(false);
  });
  it('permits disabled, unavailable and failed readers but never replaces a real reading', () => {
    expect(referenceFallbackAllowed(false, false, 'held')).toBe(true);
    expect(referenceFallbackAllowed(false, true, 'failed')).toBe(true);
    expect(referenceFallbackAllowed(false, true, 'unavailable')).toBe(true);
    expect(referenceFallbackAllowed(true, false, 'failed')).toBe(false);
  });
  it('proves only the exact returned request tag, not a visual, topic or history connection', () => {
    const proof = admitReferenceDiscovery([reference], entity(), movie, request)!;
    expect(proof).toMatchObject({ subjectId: null, relation: 'catalogue_facet', sourceQueryId: 'actual-query', referenceEvidence: { kind: 'exact_request_tag', references: [{ referenceId: 'real-ref', signalId: styleTag.id }] } });
    expect(proof.referenceId).toBeUndefined(); // Tag-only affinity does not create an explainability link.
    expect(discoveryReason(proof, movie)).toBe('A film tagged Stylized');
    expect(referenceProofIsActive(proof, [reference])).toBe(true);
    expect(admitReferenceDiscovery([reference], entity(movie, []), movie, request)).toBeNull();
    expect(admitReferenceDiscovery([reference], entity(), movie, { ...request, tagIds: ['another-id'] })).toBeNull();
    expect(admitReferenceDiscovery([{ ...reference, qloo: { tagId: 'another-id' } }], entity(), movie, request)).toBeNull();
  });
  it('does not trust rank, a missing type, a different type or an echoed reference', () => {
    expect(admitReferenceDiscovery([reference], { ...entity(), types: [] }, movie, request)).toBeNull();
    expect(admitReferenceDiscovery([reference], entity(artist), movie, request)).toBeNull();
    expect(admitReferenceDiscovery([reference], { ...entity(), name: reference.name }, movie, request)).toBeNull();
  });
  it('rejects unguarded, held, rejected, unresolved, missing and remapped references at compose', () => {
    const proof = admitReferenceDiscovery([reference], entity(), movie, request)!;
    for (const resolution of ['rejected', 'held', 'unmatched']) {
      const ref = { ...reference, resolution };
      expect(admitReferenceDiscovery([ref], entity(), movie, request)).toBeNull();
      expect(referenceProofIsActive(proof, [ref])).toBe(false);
    }
    expect(referenceProofIsActive(proof, [{ ...reference, textOnly: true }])).toBe(false);
    expect(referenceProofIsActive(proof, [])).toBe(false);
    expect(referenceProofIsActive(proof, [{ ...reference, qloo: { tagId: 'changed' } }])).toBe(false);
  });
  it('requires returned music evidence in addition to the real artist type', () => {
    expect(admitReferenceDiscovery([reference], entity(artist), artist, request)).toBeNull();
    const proof = admitReferenceDiscovery([reference], entity(artist, [styleTag, musicTag]), artist, request)!;
    expect(discoveryReason(proof, artist)).toBe('An artist tagged Stylized');
  });
  it('does not shop for an unknown object by style tag alone', () => {
    expect(admitReferenceDiscovery([reference], entity(brand, [styleTag, fashionTag]), brand, request)).toBeNull();
    expect(admitReferenceDiscovery([{ ...reference, commercialEvidence: 'fashion' }], entity(brand), brand, request)).toBeNull();
    expect(admitReferenceDiscovery([{ ...reference, commercialEvidence: 'fashion' }], entity(brand, [styleTag, fashionTag]), brand, request)).toMatchObject({ subjectId: null, relation: 'catalogue_facet' });
  });
  it('retains single real entity-seed taste and its contributing reference, without shared tags', () => {
    const ref = seed('film');
    const proof = admitReferenceDiscovery([ref], entity(movie, []), movie, { ...request, seedIds: ['film'] })!;
    expect(proof).toMatchObject({ subjectId: null, referenceId: ref.referenceId, relation: 'qloo_taste', provenance: { seedIds: ['film'], attribution: 'single_request_seed' } });
    expect(discoveryReason(proof, movie)).toBe('Explore a Qloo taste connection through Fixture film');
    expect(referenceProofIsActive(proof, [ref])).toBe(true);
    expect(referenceProofIsActive(proof, [{ ...ref, qloo: { entityId: 'changed', types: [movie] } }])).toBe(false);
    expect(referenceProofIsActive(proof, [{ ...ref, resolution: 'rejected' }])).toBe(false);
  });
  it('multi-seed taste needs returned positive finite attribution to supplied legitimate seeds', () => {
    const refs = [seed('film'), seed('other')];
    const multi = { ...request, seedIds: ['film', 'other'] };
    expect(admitReferenceDiscovery(refs, entity(movie, []), movie, multi)).toBeNull();
    for (const score of [0, -1, NaN, Infinity]) {
      expect(admitReferenceDiscovery(refs, { ...entity(), query: { explainability: [{ entity_id: 'film', score }] } }, movie, multi)).toBeNull();
    }
    const proof = admitReferenceDiscovery(refs, { ...entity(movie, []), query: { explainability: [{ entity_id: 'other', score: 0.8 }] } }, movie, multi)!;
    expect(proof.provenance).toMatchObject({ seedIds: ['other'], attribution: 'returned_explainability' });
    expect(proof.referenceId).toBe('real-other');
  });
  it('does not turn a visual artist or unknown-domain brand into a legitimate music or commercial seed', () => {
    expect(admitReferenceDiscovery([seed('sculptor', artist)], entity(movie, []), movie, { ...request, seedIds: ['sculptor'] })).toBeNull();
    expect(admitReferenceDiscovery([seed('bank', brand)], entity(movie, []), movie, { ...request, seedIds: ['bank'] })).toBeNull();
    expect(admitReferenceDiscovery([{ ...seed('bank', brand), commercialEvidence: 'fashion' }], entity(brand, []), brand, { ...request, seedIds: ['bank'] })).toBeNull();
    const ref = { ...seed('fashion', brand), tags: [fashionTag] };
    expect(admitReferenceDiscovery([ref], entity(brand, []), brand, { ...request, seedIds: ['fashion'] })).toMatchObject({ subjectId: null, relation: 'qloo_taste' });
  });
});
