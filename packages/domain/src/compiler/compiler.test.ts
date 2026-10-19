import { describe, expect, it } from 'vitest';
import { buildReason, type ResolvedRef } from './analyze';
import { JobBudget } from './budget';
import { interleaveCategories, reciprocalRankFusion, RRF_K, selectDiverse, type RankedCandidate } from './fusion';
import { canonicalTokens, nameSimilarity, nameTokens, normalizeName, sameTokens, slugify, stemmedKey, stemToken, strictSubset } from './text';

const c = (key: string, originRefs: string[] = []): RankedCandidate<string> => ({ key, originRefs, payload: key });

describe('rank fusion', () => {
  it('fuses by rank (not raw scores), merges duplicates and applies exclusions first', () => {
    const fused = reciprocalRankFusion(
      [
        { source: 'a', items: [c('x'), c('hidden'), c('y'), c('z')] },
        { source: 'b', items: [c('y'), c('w')] },
      ],
      { exclude: new Set(['hidden']) },
    );
    // y: rank 2 in a (after exclusion) + rank 1 in b beats x (rank 1 in a only).
    expect(fused.map((f) => f.key)).toEqual(['y', 'x', 'w', 'z']);
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
    expect(fused[0]!.ranks).toEqual([
      { source: 'a', rank: 2 },
      { source: 'b', rank: 1 },
    ]);
    expect(fused.find((f) => f.key === 'hidden')).toBeUndefined();
  });

  it('is stable for ties (first seen wins)', () => {
    const fused = reciprocalRankFusion([
      { source: 'a', items: [c('p')] },
      { source: 'b', items: [c('q')] },
    ]);
    expect(fused.map((f) => f.key)).toEqual(['p', 'q']);
  });

  it('adds diversity by reference origin and widens for adventurous', () => {
    const fused = reciprocalRankFusion([{ source: 'a', items: [c('1', ['r1']), c('2', ['r1']), c('3', ['r2']), c('4', ['r1']), c('5', ['r3']), c('6', ['r1'])] }]);
    expect(selectDiverse(fused, 3).map((f) => f.key)).toEqual(['1', '3', '5']);
    expect(selectDiverse(fused, 3, 'familiar').map((f) => f.key)).toEqual(['1', '3', '2']);
    const adventurous = selectDiverse(fused, 3, 'adventurous').map((f) => f.key);
    expect(adventurous[0]).toBe('1'); // keeps the strongest anchor
    expect(adventurous).toHaveLength(3);
    expect(selectDiverse(fused, 0)).toEqual([]);
  });
});

describe('interleaveCategories', () => {
  it('never shows more than two consecutive cards of a category when alternatives exist', () => {
    const items = (cat: string, n: number) => Array.from({ length: n }, (_, i) => ({ category: cat, id: `${cat}${i}` }));
    const out = interleaveCategories([items('wear', 5), items('play', 1), items('watch', 1)]);
    expect(out).toHaveLength(7);
    let run = 1;
    for (let i = 1; i < out.length; i++) {
      run = out[i]!.category === out[i - 1]!.category ? run + 1 : 1;
      const alternativesLeft = out.slice(i + 1).some((x) => x.category !== out[i]!.category);
      if (alternativesLeft) expect(run).toBeLessThanOrEqual(2);
    }
  });
});

describe('name matching', () => {
  it('requires close names before treating a provider result as the same entity', () => {
    expect(normalizeName('Café  Society & Co.')).toBe('cafe society and co');
    expect(slugify('1960s Motor-Racing Style!')).toBe('1960s-motor-racing-style');
    expect(nameSimilarity('Fixture Denim Co', 'fixture denim co.')).toBe(1);
    expect(nameSimilarity('Levi’s', "Levi's")).toBe(1);
    expect(nameSimilarity('mid-century modern', 'Mid-Century Modern Furniture')).toBeGreaterThanOrEqual(0.75);
    expect(nameSimilarity('Bauhaus', 'Bauhaus Records Ltd')).toBeGreaterThanOrEqual(0.75);
    expect(nameSimilarity('Gucci', 'Prada')).toBe(0);
  });
});

describe('canonical tokens (exact identity for Qloo grounding)', () => {
  const set = (...t: string[]) => new Set(t);
  it('folds case, accents and apostrophes like normalizeName, and drops naming filler', () => {
    expect(canonicalTokens('Musée du Louvre')).toEqual(set('musee', 'louvre'));
    expect(canonicalTokens('Mughal Architecture')).toEqual(set('mughal'));
    expect(canonicalTokens('Spanish cuisine')).toEqual(set('spanish'));
    expect(canonicalTokens('Art Deco')).toEqual(set('deco'));
    expect(canonicalTokens('Levi’s & Co')).toEqual(set('levis', 'co'));
    expect(canonicalTokens('Mid-Century Modern')).toEqual(canonicalTokens('mid century modern'));
  });
  it('keeps letters of every script', () => {
    expect(nameTokens('港区 MINATO CITY')).toEqual(['港区', 'minato', 'city']);
    expect(canonicalTokens('愚园路')).toEqual(set('愚园路'));
    expect(normalizeName('愚园路')).toBe(''); // why canonicalTokens does not reuse it verbatim
  });
  it('compares sets exactly; containment is a separate, rejecting signal', () => {
    expect(sameTokens(canonicalTokens('Neoclassical'), canonicalTokens('neoclassical style'))).toBe(true);
    expect(sameTokens(canonicalTokens('Honda'), canonicalTokens('Honda Civic'))).toBe(false);
    expect(strictSubset(canonicalTokens('Honda'), canonicalTokens('Honda Civic'))).toBe(true);
    expect(strictSubset(canonicalTokens('Honda Civic'), canonicalTokens('Honda'))).toBe(false);
    expect(sameTokens(new Set(), new Set())).toBe(false);
  });
  it('stems plurals for seed dedupe ("Dim Sums", "Dimsum", "Sichuan Noodles")', () => {
    expect(stemToken('noodles')).toBe(stemToken('noodle'));
    expect(stemToken('dishes')).toBe(stemToken('dish'));
    expect(stemToken('glass')).toBe('glass');
    expect(stemmedKey('Dim Sums')).toBe(stemmedKey('Dim Sum'));
    expect(stemmedKey('Dimsum')).toBe(stemmedKey('Dim Sum'));
    expect(stemmedKey('Sichuan Noodles')).toBe(stemmedKey('Sichuan Noodle'));
    expect(stemmedKey('Sichuan Ramen')).not.toBe(stemmedKey('Sichuan Noodle'));
  });
});

describe('reasons', () => {
  const ref = (name: string, relation: ResolvedRef['relation']): ResolvedRef => ({
    referenceId: name,
    name,
    candidateName: name,
    type: 'brand',
    relation,
    certainty: 0.5,
    resolution: 'resolved',
    qloo: null,
    providerQueryId: null,
    isReplay: false,
    isAnchor: true,
    suggestedCategories: [],
    regionIds: [],
    boxes: [],
  });
  it('is plain language without scores or provider names', () => {
    expect(buildReason([ref('Fixture Denim Co', 'depicted'), ref('Vintage Racing', 'resembles')])).toBe('Connected to Fixture Denim Co and Vintage Racing in your photo.');
    expect(buildReason([ref('Vintage Racing', 'resembles')])).toBe('Picked for the Vintage Racing feel of your photo.');
    expect(buildReason([])).toBe('Connected to what stood out in your photo.');
    expect(buildReason([ref('A', 'depicted')])).not.toMatch(/qloo|affinity|score|\d/i);
  });
});

describe('JobBudget', () => {
  it('caps Qloo requests per job and retries per stage, continuing from earlier attempts', () => {
    const budget = new JobBudget({ qlooRequests: 4, researchRefs: 5, retriesPerStage: 2 }, { qloo: 1 });
    const resolve = budget.forStage('resolve');
    expect(resolve.take('qloo', 'request')).toBe(true);
    expect(resolve.take('qloo', 'retry')).toBe(true);
    expect(resolve.take('qloo', 'retry')).toBe(true);
    expect(budget.remaining('qloo')).toBe(0);
    expect(resolve.take('qloo', 'request')).toBe(false);
    expect(budget.wasExhausted('qloo')).toBe(true);

    const vlm = new JobBudget({ qlooRequests: 12, researchRefs: 5, retriesPerStage: 2 }).forStage('observe');
    expect(vlm.take('vlm', 'request')).toBe(true);
    expect(vlm.take('vlm', 'retry')).toBe(true);
    expect(vlm.take('vlm', 'retry')).toBe(true);
    expect(vlm.take('vlm', 'retry')).toBe(false); // two retries per stage
  });

  it('reserves both photo-reading calls together and never more than the per-analysis limit', () => {
    const two = new JobBudget({ qlooRequests: 12, researchRefs: 5, retriesPerStage: 2, visionCalls: 2 });
    expect(two.reserveVisionCalls(3)).toBe(false);
    expect(two.visionCallsReserved()).toBe(0);
    expect(two.reserveVisionCalls(2)).toBe(true);
    expect(two.reserveVisionCalls(1)).toBe(false);
    expect(two.visionCallsReserved()).toBe(2);
    const one = new JobBudget({ qlooRequests: 12, researchRefs: 5, retriesPerStage: 2, visionCalls: 1 });
    expect(one.reserveVisionCalls(2)).toBe(false);
    expect(one.reserveVisionCalls(1)).toBe(true);
    expect(one.reserveVisionCalls(0)).toBe(false);
  });
});
