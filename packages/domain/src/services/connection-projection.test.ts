import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryCard } from '../schemas/common';
import type { StoredStyleReading } from '../style/types';
import { validateConnectionPublication } from '../style/connection-publication';
import { connectionCardEligible, validatedConnectionRows, type ConnectionProjectionRow } from './connection-projection';

// These tests isolate projection wiring. Real evidence acceptance is tested by the shared validator.
vi.mock('../style/connection-publication', () => ({ validateConnectionPublication: vi.fn() }));
const validate = vi.mocked(validateConnectionPublication);
const reading: StoredStyleReading = {
  schema: 'atlas_style_reading_v1', wording_version: 'synthetic', guard_version: 'synthetic', vocab_version: 'synthetic', rev: 2,
  model: { role: 'vision_style', profile: null, model: 'synthetic', experimental: true, ms: 1 },
  image: { width: 100, height: 100, frame_index: null }, summary: 'Synthetic fixture', swatches: [], dropped: [], held: [], retracted: [],
  subjects: [{ id: 's1', category: 'fashion', label: 'Shirt', region: { x: 0, y: 0, w: 1, h: 1 }, aesthetics: [], materials: [], construction: [], details: [], lineage: [], mood: [], palette: [], era: null, brand: null, entity: null, qloo_links: [] }],
};
const card: DiscoveryCard = { id: 'item', kind: 'brand', category: 'wear', title: 'Synthetic brand', subtitle: null,
  image: { url: 'https://images.qloo.com/synthetic.jpg', width: 100, height: 100, alt: 'Synthetic' }, is_example: true,
  saved: false, saved_item_id: null, recommendation_id: null, evidence_available: false };
function row(id = 'rec', rank = 1): ConnectionProjectionRow {
  return { id, rank, discovery_item_id: card.id, origin: 'qloo', rail: 'cross_domain', subject_id: null, external_ids: { qloo: 'candidate' },
    style_match: { subject_id: 's1', claims: [], palette: [], via_entity: null, via: 'overlap', rail: 'cross_domain', actual_candidate_types: ['urn:entity:brand'],
      discovery_proof: { candidateId: 'candidate', subjectId: 's1', readingRev: 2, targetType: 'urn:entity:brand', origin: 'style', relation: 'shared_design', claim: { slot: 'construction', name: 'Striped pattern', wording: 'asserted' }, candidateTags: [] } } };
}
beforeEach(() => { validate.mockReset(); validate.mockReturnValue({ eligible: true, reasons: [] }); });

describe('authoritative Connections projection', () => {
  it('delegates actual source, revision, candidate type/id, origin and image binding', () => {
    const r = row();
    expect(connectionCardEligible(r, card, reading)).toBe(true);
    expect(validate).toHaveBeenCalledWith({ proof: r.style_match!.discovery_proof, subject: reading.subjects[0], readingRev: 2,
      candidateId: 'candidate', targetType: 'urn:entity:brand', imageUrl: card.image!.url, origin: 'qloo' });
  });
  it('does not turn a generated food reason into evidence, including a null rail', () => {
    const creative = { ...row(), origin: 'vlm_creative', rail: null, style_match: null, external_ids: {} };
    expect(connectionCardEligible(creative, { ...card, kind: 'food', category: 'eat', evidence_available: true }, reading)).toBe(false);
    expect(validate).not.toHaveBeenCalled();
  });
  it('rejects missing proof, source, image, real candidate binding and incompatible type', () => {
    expect(connectionCardEligible({ ...row(), style_match: null }, card, reading)).toBe(false);
    expect(connectionCardEligible(row(), card, null)).toBe(false);
    expect(connectionCardEligible(row(), { ...card, image: null }, reading)).toBe(false);
    expect(connectionCardEligible({ ...row(), external_ids: { qloo: 'different' } }, card, reading)).toBe(false);
    expect(connectionCardEligible(row(), { ...card, kind: 'film' }, reading)).toBe(false);
    expect(connectionCardEligible({ ...row(), subject_id: 's2' }, card, reading)).toBe(false);
    const missingActualType = row();
    delete missingActualType.style_match!.actual_candidate_types;
    expect(connectionCardEligible(missingActualType, card, reading)).toBe(false);
    const wrongActualType = row();
    wrongActualType.style_match!.actual_candidate_types = ['urn:entity:movie'];
    expect(connectionCardEligible(wrongActualType, card, reading)).toBe(false);
  });
  it('honors shared evidence rejection and fails closed on malformed persisted proof', () => {
    validate.mockReturnValueOnce({ eligible: false, reasons: ['asset_identity_unknown'] });
    expect(connectionCardEligible(row(), card, reading)).toBe(false);
    validate.mockImplementationOnce(() => { throw new Error('malformed'); });
    expect(connectionCardEligible(row(), card, reading)).toBe(false);
  });
  it('validates before duplicate selection, so a creative duplicate cannot hide a valid row', () => {
    const bad = { ...row('bad', 1), origin: 'vlm_creative', rail: 'more_like_this' as const };
    const good = row('good', 20);
    expect(validatedConnectionRows([bad, good], new Map([[card.id, card]]), reading)).toEqual([good]);
  });
  it('prefers validated direct evidence over taste for the same item', () => {
    const taste = row('taste', 1); taste.style_match!.discovery_proof!.relation = 'qloo_taste';
    const direct = row('direct', 10);
    expect(validatedConnectionRows([taste, direct], new Map([[card.id, card]]), reading)).toEqual([direct]);
  });
  it('allows at most one taste card across rails without changing ordinary rank order', () => {
    const a = row('a', 2), b = { ...row('b', 1), discovery_item_id: 'second' };
    a.style_match!.discovery_proof!.relation = 'qloo_taste'; b.style_match!.discovery_proof!.relation = 'qloo_taste';
    const cards = new Map([[card.id, card], ['second', { ...card, id: 'second' }]]);
    expect(validatedConnectionRows([a, b], cards, reading)).toEqual([b]);
  });
});
