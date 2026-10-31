import { describe, expect, it } from 'vitest';
import { discoveryCardStyle } from './discovery-card-style';

describe('public catalogue connection style context', () => {
  it('does not turn catalogue evidence into shared image attributes or colors', () => {
    const match = {
      subject_id: 'subject-fixture',
      claims: [{ name: 'Ceramics' }],
      palette: ['blue'],
      via_entity: 'seed-fixture',
      discovery_proof: { relation: 'shared_design' },
    };
    expect(discoveryCardStyle(match, true)).toEqual({
      subject_id: 'subject-fixture',
      attributes: [],
      palette: [],
      via: 'seed-fixture',
      experimental: true,
    });
    expect(match.claims).toEqual([{ name: 'Ceramics' }]);
    expect(match.palette).toEqual(['blue']);
  });

  it('retains legacy context without a relation proof', () => {
    expect(discoveryCardStyle({
      claims: [{ name: 'Workwear' }, { name: 'Workwear' }],
      palette: ['navy'],
    }, false)).toEqual({
      subject_id: null,
      attributes: ['Workwear'],
      palette: ['navy'],
      via: null,
      experimental: false,
    });
  });

  it('treats every catalogue relation consistently, including future relations', () => {
    for (const relation of ['taste_affinity', 'shared_topic', 'shared_named_work', 'future_relation']) {
      expect(discoveryCardStyle({
        claims: [{ name: 'Sculpture' }],
        discovery_proof: { relation },
      }, false)?.attributes).toEqual([]);
    }
  });

  it('keeps absent style context absent', () => {
    expect(discoveryCardStyle(null, false)).toBeNull();
    expect(discoveryCardStyle(undefined, false)).toBeNull();
  });
});
