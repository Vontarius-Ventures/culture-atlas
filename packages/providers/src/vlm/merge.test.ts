import { describe, expect, it } from 'vitest';
import { validateVision } from '../concentrate/providers';
import { validEnrichment, validQuickRead } from '../concentrate/test-fixtures';
import {
  ENRICHMENT_VETO_CERTAINTY_FACTOR,
  MERGED_CANDIDATES_MAX,
  VlmAnalysis,
  VlmEnrichment,
  VlmEnrichmentV1,
  VlmQuickRead,
  candidateNameKey,
  mergeEnrichment,
  mergeEnrichmentContext,
  toVlmAnalysis,
  vetoedCandidateKeys,
  type VlmEnrichmentV2,
} from './types';

const quick = VlmQuickRead.parse(validQuickRead);
const enrichment = VlmEnrichmentV1.parse(validEnrichment);

describe('toVlmAnalysis: quick read alone', () => {
  it('builds a valid VlmAnalysis with synthetic ids in stage-1 order', () => {
    const a = toVlmAnalysis(quick);
    expect(VlmAnalysis.parse(a)).toEqual(a);
    expect(a.title).toBe(quick.title);
    expect(a.interpretation).toBe(quick.interpretation);
    expect(a.candidates.map((c) => [c.id, c.name])).toEqual([
      ['c1', 'Dan dan noodles'],
      ['c2', 'Sichuan chili oil'],
    ]);
    expect(a.candidates[0]).toMatchObject({
      rationale: '',
      region_ids: [],
      suggested_categories: ['eat'],
      tag_queries: ['Sichuan cuisine'],
      certainty: 0.8,
    });
    expect(a.candidates[1]!.tag_queries).toEqual([]);
    expect(a).toMatchObject({ observations: [], regions: [], visible_text: [], competing_subjects: [] });
    expect(a.quality).toEqual({ usable: true, issue: null });
    // Mean certainty 0.7 -> low uncertainty; derived only from the reading itself.
    expect(a.uncertainty).toEqual({ overall: 'low', notes: [] });
    expect(() => validateVision(a, 5)).not.toThrow();
  });

  it('is deterministic and does not mutate its input', () => {
    const copy = structuredClone(validQuickRead);
    expect(toVlmAnalysis(quick)).toEqual(toVlmAnalysis(quick));
    expect(toVlmAnalysis(quick, enrichment)).toEqual(toVlmAnalysis(quick, enrichment));
    expect(validQuickRead).toEqual(copy);
  });

  it('carries an unusable reading through unchanged and derives high uncertainty with no candidates', () => {
    const a = toVlmAnalysis({ ...quick, candidates: [], quality: { usable: false, issue: 'blurred' } });
    expect(a.quality).toEqual({ usable: false, issue: 'blurred' });
    expect(a.uncertainty.overall).toBe('high');
  });

  it('rejects input that is not a valid quick read', () => {
    expect(() => toVlmAnalysis({ ...quick, title: 'x'.repeat(61) })).toThrow();
  });
});

describe('toVlmAnalysis with an enrichment (merge rules, FAST-02)', () => {
  const merged = toVlmAnalysis(quick, enrichment);

  it('never reorders, renames or drops stage-1 candidates', () => {
    expect(merged.candidates.slice(0, 2).map((c) => [c.id, c.name, c.type])).toEqual([
      ['c1', 'Dan dan noodles', 'cuisine'],
      ['c2', 'Sichuan chili oil', 'object'],
    ]);
  });

  it('turns confirmations into rationales, matching names case-insensitively', () => {
    expect(merged.candidates[0]!.rationale).toBe('Minced topping and chili oil');
    expect(merged.candidates[0]!.certainty).toBe(0.8);
  });

  it('treats keep=false as advisory: certainty is lowered, the candidate stays', () => {
    expect(merged.candidates[1]!.name).toBe('Sichuan chili oil');
    expect(merged.candidates[1]!.certainty).toBe(0.6 * ENRICHMENT_VETO_CERTAINTY_FACTOR);
    expect(vetoedCandidateKeys(toVlmAnalysis(quick), enrichment)).toEqual(
      new Set([candidateNameKey('Sichuan chili oil')]),
    );
  });

  it('appends additional candidates after stage 1 with continuing ids and rationale', () => {
    expect(merged.candidates[2]).toMatchObject({
      id: 'c3',
      name: 'Liangpi',
      rationale: 'Wide cold noodles at the side',
      suggested_categories: ['eat'],
      tag_queries: [],
    });
  });

  it('adds regions, observations and visible text with fresh ids and links evidence by label', () => {
    expect(merged.regions).toEqual([
      { id: 'r1', label: 'Dan dan noodles', box: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } },
    ]);
    expect(merged.candidates[0]!.region_ids).toEqual(['r1']);
    expect(merged.observations).toEqual([
      { id: 'o1', text: 'Red chili oil pooled under the noodles', kind: 'food', region_ids: [] },
    ]);
    expect(merged.visible_text).toEqual([{ text: 'OPEN', region_id: null }]);
    expect(merged.uncertainty).toEqual({ overall: 'medium', notes: ['Noodle type is partly hidden'] });
    expect(merged.title).toBe(quick.title);
    expect(merged.quality).toEqual(quick.quality);
    expect(() => validateVision(merged, MERGED_CANDIDATES_MAX)).not.toThrow();
  });

  it('first confirmation wins; unknown names and duplicate additions are ignored', () => {
    const e = VlmEnrichment.parse({
      ...validEnrichment,
      confirmed: [
        { name: 'DAN DAN NOODLES!', rationale: 'first', keep: true },
        { name: 'dan dan noodles', rationale: 'second', keep: false },
        { name: 'Not a stage-1 candidate', rationale: 'x', keep: false },
      ],
      additional_candidates: [
        { ...validEnrichment.additional_candidates[0], name: 'dan dan noodles' },
        { ...validEnrichment.additional_candidates[0], name: '   ' },
      ],
    });
    const a = toVlmAnalysis(quick, e);
    expect(a.candidates).toHaveLength(2);
    expect(a.candidates[0]).toMatchObject({ rationale: 'first', certainty: 0.8 });
    expect(a.candidates[1]!.certainty).toBe(0.6);
  });

  it('drops regions with invalid geometry instead of failing the reading', () => {
    const e = VlmEnrichment.parse({
      ...validEnrichment,
      regions: [
        { label: 'too wide', box: { x: 0.8, y: 0, w: 0.5, h: 0.5 } },
        { label: 'empty', box: { x: 0.1, y: 0.1, w: 0, h: 0.2 } },
        { label: 'bowl', box: { x: 0, y: 0, w: 1, h: 1 } },
      ],
    });
    const a = toVlmAnalysis(quick, e);
    expect(a.regions).toEqual([{ id: 'r1', label: 'bowl', box: { x: 0, y: 0, w: 1, h: 1 } }]);
    expect(() => validateVision(a, MERGED_CANDIDATES_MAX)).not.toThrow();
  });

  it('keeps an existing reading’s competing subjects, rationale and ids (v2 frame aggregate)', () => {
    const base = VlmAnalysis.parse({
      ...toVlmAnalysis(quick),
      candidates: toVlmAnalysis(quick).candidates.map((c) => ({ ...c, rationale: 'from frames' })),
      competing_subjects: [{ id: 's1', label: 'noodles', region_ids: [] }],
      observations: [{ id: 'o1', text: 'Red chili oil pooled under the noodles', kind: 'food', region_ids: [] }],
    });
    const a = mergeEnrichment(base, {
      ...enrichment,
      competing_subjects: ['table', 'window'],
    });
    expect(a.candidates[0]!.rationale).toBe('from frames');
    expect(a.competing_subjects).toEqual(base.competing_subjects);
    // Duplicate observation is not repeated.
    expect(a.observations).toHaveLength(1);
  });

  it('takes competing subjects from the enrichment when the reading had none', () => {
    const a = toVlmAnalysis(quick, { ...enrichment, competing_subjects: ['noodles', 'tea', 'noodles'] });
    expect(a.competing_subjects).toEqual([
      { id: 's1', label: 'noodles', region_ids: [] },
      { id: 's2', label: 'tea', region_ids: [] },
    ]);
  });

  it('never exceeds the merged candidate cap', () => {
    const five = VlmQuickRead.parse({
      ...validQuickRead,
      candidates: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ ...validQuickRead.candidates[0], name })),
    });
    const four = ['f', 'g', 'h', 'i'].map((name) => ({ ...enrichment.additional_candidates[0]!, name }));
    const a = toVlmAnalysis(five, { ...enrichment, additional_candidates: four });
    expect(a.candidates.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    expect(a.candidates).toHaveLength(MERGED_CANDIDATES_MAX);
    const base = VlmAnalysis.parse({ ...a });
    expect(mergeEnrichment(base, { ...enrichment, additional_candidates: [{ ...four[0]!, name: 'j' }] }).candidates).toHaveLength(
      MERGED_CANDIDATES_MAX,
    );
  });
});

describe('mergeEnrichmentContext: held claims and verdicts (quality plan §3.4)', () => {
  const base = toVlmAnalysis({
    title: 'Bike on a porch',
    interpretation: 'A red road bike beside a dog.',
    candidates: [
      { name: 'Road cycling', type: 'tradition', relation: 'resembles', certainty: 0.6, domain: 'sport', evidence: 'context', evidence_text: null, tag_query: 'road cycling' },
      { name: 'Porch culture', type: 'tradition', relation: 'resembles', certainty: 0.6, domain: 'other', evidence: 'context', evidence_text: null, tag_query: 'porch' },
    ],
    quality: { usable: true, issue: null },
  });
  // As the compiler sees it after stage 1: c1 published, c2 held.
  const published = VlmAnalysis.parse({ ...base, candidates: [base.candidates[0]] });
  const held = [base.candidates[1]!];
  const v2: VlmEnrichmentV2 = {
    observations: [],
    visible_text: ['FIXTURE CYCLES', ''],
    illegible_text_present: true,
    confirmed: [
      { name: 'Road cycling', rationale: 'Drop bars', verdict: 'supported' },
      { name: 'porch culture', rationale: 'Not shown', verdict: 'unsupported' },
      { name: 'Road cycling', rationale: 'second entry', verdict: 'unsupported' },
      { name: 'Bike on a porch', rationale: 'the title', verdict: 'supported' },
    ],
    additional_candidates: [
      { name: 'Porch culture', type: 'tradition', relation: 'resembles', certainty: 0.9, domain: 'other', evidence: 'context', evidence_text: null, tag_query: null, rationale: 'dup of held' },
      { name: 'Fixture Cycles', type: 'brand', relation: 'depicted', certainty: 0.9, domain: 'vehicle', evidence: 'read_text', evidence_text: 'FIXTURE CYCLES', tag_query: null, rationale: 'lettering' },
    ],
    regions: [{ label: 'Porch culture', box: { x: 0, y: 0, w: 0.5, h: 0.5 } }],
    uncertainty: { overall: 'low', notes: [] },
    competing_subjects: [],
  };
  const { analysis, merge } = mergeEnrichmentContext(published, v2, held);

  it('carries held claims after the published ones and never reuses their ids for additions', () => {
    expect(analysis.candidates.map((c) => [c.id, c.name])).toEqual([
      ['c1', 'Road cycling'],
      ['c2', 'Porch culture'],
      ['c3', 'Fixture Cycles'],
    ]);
    expect(merge.heldIds).toEqual(['c2']);
    expect(merge.additionIds).toEqual(['c3']);
    expect(analysis.candidates[1]).toMatchObject({ rationale: 'Not shown', region_ids: ['r1'], certainty: 0.6 });
    expect(analysis.candidates[2]).toMatchObject({ domain: 'vehicle', evidence: 'read_text', evidence_text: 'FIXTURE CYCLES', suggested_categories: [] });
    expect(() => validateVision(analysis, MERGED_CANDIDATES_MAX)).not.toThrow();
  });

  it('reports verdicts for published and held names only, first entry wins', () => {
    expect(merge.verdicts).toEqual({ 'road cycling': 'supported', 'porch culture': 'unsupported' });
    expect(merge.reading).toBe('v2');
    expect(merge.stage2Text).toEqual(['FIXTURE CYCLES']);
    expect(merge.illegibleTextPresent).toBe(true);
    expect(analysis.uncertainty.notes).toContain('Some text in the photo is not legible.');
  });

  it('an unsupported verdict lowers only published candidates (advisory veto)', () => {
    const a = mergeEnrichmentContext(base, v2).analysis;
    expect(a.candidates[1]).toMatchObject({ name: 'Porch culture', certainty: 0.3 });
    expect(vetoedCandidateKeys(base, v2)).toEqual(new Set(['porch culture']));
  });

  it('v2: five evidence boxes (five signs) parse, and the merge keeps the first four valid ones', () => {
    const box = (x: number) => ({ x, y: 0.1, w: 0.1, h: 0.1 });
    const five = VlmEnrichment.parse({ ...v2, regions: [0.1, 0.2, 0.3, 0.4, 0.5].map((x, i) => ({ label: `sign ${i + 1}`, box: box(x) })) });
    const a = mergeEnrichmentContext(published, five, held).analysis;
    expect(a.regions.map((r) => r.label)).toEqual(['sign 1', 'sign 2', 'sign 3', 'sign 4']);
    expect(VlmEnrichment.safeParse({ ...v2, regions: Array.from({ length: 9 }, () => ({ label: 'x', box: box(0.1) })) }).success).toBe(false);
  });

  it('a v1 enrichment maps keep into verdicts', () => {
    const m = mergeEnrichmentContext(toVlmAnalysis(quick), enrichment).merge;
    expect(m.reading).toBe('v1');
    expect(m.verdicts).toEqual({ 'dan dan noodles': 'supported', 'sichuan chili oil': 'unsupported' });
    expect(m.illegibleTextPresent).toBe(false);
  });
});
