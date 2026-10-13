import { describe, expect, it } from 'vitest';
import { applyExclusions, diversify, reciprocalRankFusion, RRF_K, selectForExploration } from './fusion';

const c = (key: string, group = 'g') => ({ key, group });

describe('reciprocal rank fusion', () => {
  it('combines ranks, not raw scores, and rewards agreement across lists', () => {
    // Raw affinity values are deliberately wildly different and must be ignored.
    const a = { id: 'qA', items: [{ ...c('x'), affinity: 0.99 }, { ...c('y'), affinity: 0.98 }, { ...c('z'), affinity: 0.97 }] };
    const b = { id: 'qB', items: [{ ...c('y'), affinity: 0.01 }, { ...c('w'), affinity: 0.009 }] };
    const fused = reciprocalRankFusion([a, b]);
    expect(fused.map((f) => f.key)).toEqual(['y', 'x', 'w', 'z']);
    const y = fused[0]!;
    expect(y.fused).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
    expect(y.sources).toEqual(['qA', 'qB']);
    expect(y.bestRank).toBe(1);
  });

  it('is stable for ties and counts a key once per list', () => {
    const fused = reciprocalRankFusion([
      { id: 'a', items: [c('p'), c('p'), c('q')] },
      { id: 'b', items: [c('q'), c('p')] },
    ]);
    // p: 1/61 + 1/62 ; q: 1/62 (second slot after dedupe) + 1/61 -> tie, p first by order.
    expect(fused.map((f) => f.key)).toEqual(['p', 'q']);
    expect(fused[0]!.sources).toEqual(['a', 'b']);
  });

  it('applies exclusions before fusion so excluded items never shift ranks', () => {
    const lists = applyExclusions([{ id: 'a', items: [c('hidden'), c('k1'), c('k2')] }], (i) => i.key === 'hidden');
    const fused = reciprocalRankFusion(lists);
    expect(fused.map((f) => f.key)).toEqual(['k1', 'k2']);
    expect(fused[0]!.bestRank).toBe(1);
  });
});

describe('diversity and exploration', () => {
  const fused = reciprocalRankFusion([
    { id: 'q', items: [c('a1', 'A'), c('a2', 'A'), c('a3', 'A'), c('b1', 'B'), c('c1', 'C'), c('b2', 'B'), c('c2', 'C'), c('d1', 'D')] },
  ]);
  const group = (f: { item: { group: string } }) => f.item.group;

  it('diversify spreads picks across groups', () => {
    const picked = diversify(fused, group, 3).map((f) => f.key);
    expect(picked).toEqual(['a1', 'b1', 'c1']);
  });

  it('familiar keeps the strongest connections', () => {
    expect(selectForExploration(fused, 'familiar', 3, group).map((f) => f.key)).toEqual(['a1', 'a2', 'a3']);
  });

  it('balanced diversifies within a moderate window', () => {
    const keys = selectForExploration(fused, 'balanced', 3, group).map((f) => f.key);
    expect(keys[0]).toBe('a1');
    expect(new Set(keys.map((k) => k[0])).size).toBe(3);
  });

  it('adventurous draws deeper but always retains the strongest anchor', () => {
    const keys = selectForExploration(fused, 'adventurous', 3, group).map((f) => f.key);
    expect(keys[0]).toBe('a1');
    expect(keys).toHaveLength(3);
    expect(keys.some((k) => ['b2', 'c2', 'd1', 'c1', 'b1'].includes(k))).toBe(true);
    expect(selectForExploration(fused, 'adventurous', 3, group).every((f) => fused.some((x) => x.key === f.key))).toBe(true);
  });

  it('returns nothing rather than inventing candidates', () => {
    expect(selectForExploration([], 'adventurous', 3)).toEqual([]);
    expect(selectForExploration(fused.slice(0, 2), 'familiar', 5)).toHaveLength(2);
  });
});
