import { describe, expect, it } from 'vitest';
import { auditRecordedHomePool } from './relevance-logic-audit';
import { storedSubject } from '../../packages/domain/src/style/test-support';

describe('offline recorded-home-pool audit', () => {
  it('counts provenance separately from relevance and preserves the retrieved denominator', () => {
    const subject = storedSubject({ category: 'interior', label: 'Carved side chair' });
    const candidate: Parameters<typeof auditRecordedHomePool>[1][number] = {
      entity_id: 'fixture-candidate', name: 'Fixture Generic Maker', types: ['urn:entity:brand'], properties: {},
      tags: [{ id: 'urn:tag:industry:qloo:furniture', name: 'Furniture' }],
      query: { explainability: [{ entity_id: 'fixture-seed', score: 0.8 }] },
    };
    const result = auditRecordedHomePool(subject, [candidate], ['fixture-seed'], 'fixture-query')!;
    expect(result).toMatchObject({ retrieved: 1, provenanceAdmitted: 1, relevanceQualified: [], gated: { evidence: 1 }, seedsUnchanged: false });
    expect(result.requestSeedIds).toEqual(['fixture-seed']);
    expect(result.recomputedSeeds).toEqual([]);
  });

  it('does not treat an artifact pool as a shopping opportunity', () => {
    expect(auditRecordedHomePool(storedSubject({ category: 'interior', label: 'Terracotta head vessel' }), [], [], 'fixture-query')).toBeNull();
  });
});
