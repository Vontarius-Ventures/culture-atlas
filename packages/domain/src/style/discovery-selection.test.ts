import { describe, expect, it } from 'vitest';
import { connectionEvidenceClass, exploratoryProof, selectEvidenceFirst } from './discovery-selection';
import type { CandidateProof, DiscoveryRelation } from './discovery-evidence';

const proof = (relation: DiscoveryRelation): CandidateProof => ({
  candidateId: relation, subjectId: 's1', relation, origin: 'style',
  claim: { slot: 'aesthetics', name: 'Punk', wording: 'resembles' },
  candidateTags: [{ id: 'urn:tag:personal_style:qloo:punk', label: 'Punk' }],
  ...(relation === 'about_subject' ? { contentEvidence: {
    topic: 'tennis', claim: { slot: 'label' as const, name: 'Tennis racket', wording: 'asserted' as const },
    field: 'description' as const, excerpt: 'The film follows a tennis player.', kind: 'topic_film' as const,
  } } : {}),
  ...(relation === 'qloo_taste' ? { provenance: { queryId: 'q', seedIds: ['seed'], seedNames: ['Seed'], attribution: 'single_request_seed' as const } } : {}),
});
const candidate = (id: string, relation: DiscoveryRelation) => ({ id, proof: proof(relation) });
const first = <T>(pool: readonly T[], slots: number) => pool.slice(0, slots);

describe('discovery evidence selection', () => {
  it('prioritizes candidate-specific evidence even when audience candidates ranked first', () => {
    const pool = [candidate('taste', 'qloo_taste'), candidate('scope', 'brand_exploration'), candidate('design', 'shared_design'), candidate('topic', 'about_subject')];
    const original = [...pool];
    expect(selectEvidenceFirst(pool, (c) => c.proof, first, 3, 1).map((c) => c.id)).toEqual(['design', 'topic', 'taste']);
    expect(pool).toEqual(original);
  });

  it('retains one genuine cross-domain taste connection, not three to fill the category', () => {
    const pool = Array.from({ length: 8 }, (_, i) => candidate(`${i}`, 'qloo_taste'));
    expect(selectEvidenceFirst(pool, (c) => c.proof, first, 3, 1)).toEqual(pool.slice(0, 1));
    expect(selectEvidenceFirst(pool, (c) => c.proof, first, 8, 4)).toEqual(pool.slice(0, 1));
  });

  it('does not cap direct evidence at the exploratory allowance', () => {
    const pool = Array.from({ length: 8 }, (_, i) => candidate(`${i}`, 'shared_design'));
    expect(selectEvidenceFirst(pool, (c) => c.proof, first, 8, 4)).toEqual(pool);
  });

  it('preserves the supplied selector and ranking within each tier', () => {
    const pool = [candidate('d1', 'shared_design'), candidate('t1', 'qloo_taste'), candidate('d2', 'shared_topic'), candidate('t2', 'qloo_taste')];
    const last = <T>(items: readonly T[], slots: number) => [...items].reverse().slice(0, slots);
    expect(selectEvidenceFirst(pool, (c) => c.proof, last, 3, 1).map((c) => c.id)).toEqual(['d2', 'd1', 't2']);
  });

  it('never admits missing proof, exceeds capacity or adds exploratory append filler', () => {
    const pool = [{ id: 'missing', proof: null }, candidate('taste', 'qloo_taste'), candidate('design', 'shared_design')];
    expect(selectEvidenceFirst(pool, (c) => c.proof, first, 1, 1).map((c) => c.id)).toEqual(['design']);
    expect(selectEvidenceFirst(pool, (c) => c.proof, first, 3, 0).map((c) => c.id)).toEqual(['design']);
    expect(selectEvidenceFirst(pool, (c) => c.proof, first, 0, 1)).toEqual([]);
  });

  it('does not equate a verified title/topic/catalogue facet with an audience relationship', () => {
    for (const relation of ['shared_named_work', 'shared_topic', 'catalogue_facet', 'about_subject', 'place_exploration', 'shared_design', 'shared_subculture'] as const)
      expect(exploratoryProof(proof(relation))).toBe(false);
    expect(exploratoryProof(proof('qloo_taste'))).toBe(true);
    expect(exploratoryProof(proof('brand_exploration'))).toBe(true);
  });

  it('classifies source slot and candidate-owned meaning, with no ordinary scope filler', () => {
    const design = proof('shared_design');
    expect(connectionEvidenceClass(design)).toBe('distinctive_design');
    expect(connectionEvidenceClass(proof('about_subject'))).toBe('substantive_content');
    expect(connectionEvidenceClass(proof('qloo_taste'))).toBe('taste_exploration');
    expect(connectionEvidenceClass(proof('brand_exploration'))).toBe('catalogue_scope');
    expect(connectionEvidenceClass({ ...design, claim: { ...design.claim, slot: 'materials' } })).toBe('catalogue_scope');
    expect(connectionEvidenceClass({ ...design, candidateTags: [{ id: 'urn:tag:material:qloo:punk', label: 'Punk' }] })).toBe('catalogue_scope');
    expect(connectionEvidenceClass({ ...design, relation: 'about_subject' })).toBe('unsupported');
    const scopes = [proof('brand_exploration'), { ...design, claim: { ...design.claim, slot: 'materials' as const } }];
    expect(selectEvidenceFirst(scopes, (p) => p, first, 5, 5)).toEqual([]);
    expect(selectEvidenceFirst([proof('catalogue_facet')], (p) => p, first, 5, 5)).toEqual([]);
  });

  it('preserves a genuine named work and exact reference facet, not a bare catalogue label', () => {
    const title = { ...proof('shared_named_work'), referenceId: 'work' };
    const facet = { ...proof('catalogue_facet'), referenceEvidence: {
      kind: 'exact_request_tag' as const, references: [{ referenceId: 'reference', signalId: 'urn:tag:personal_style:qloo:punk' }],
    } };
    expect(connectionEvidenceClass(title)).toBe('substantive_content');
    expect(connectionEvidenceClass(facet)).toBe('substantive_content');
    expect(selectEvidenceFirst([proof('brand_exploration'), title, facet], (p) => p, first, 3, 1)).toEqual([title, facet]);
    expect(connectionEvidenceClass({ ...proof('shared_subculture'), claim: { slot: 'materials', name: 'Punk leather', wording: 'asserted' } })).toBe('unsupported');
  });
});
