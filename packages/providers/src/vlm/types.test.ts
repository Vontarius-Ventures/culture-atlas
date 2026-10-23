import { describe, expect, it } from 'vitest';
import { structuredOutputContract } from '../model-gateway/schema';
import {
  VlmAnalysis,
  VlmEnrichment,
  VlmEnrichmentV1,
  VlmEnrichmentV2,
  VlmFullReading,
  VlmQuickRead,
  VlmQuickReadV1,
  VlmQuickReadV2,
  V2_LIMITS,
  candidateNameKey,
  confirmationVerdict,
  isEnrichmentV2,
  mergeEnrichmentContext,
  normalizeEnrichment,
  normalizeQuickRead,
  toVlmAnalysis,
} from './types';

// Shapes follow the measured stage-1/stage-2 outputs in docs/analysis-latency-plan.md.
const quick = {
  title: 'Sichuan noodle supper',
  interpretation: 'A bowl of sesame noodles that resembles a Sichuan street-food supper.',
  candidates: [
    {
      name: 'dan dan noodles',
      type: 'cuisine',
      relation: 'resembles',
      certainty: 0.8,
      categories: ['eat'],
      tag_query: 'Sichuan cuisine',
    },
    {
      name: 'Sichuan chili oil',
      type: 'object',
      relation: 'resembles',
      certainty: 0.6,
      categories: ['eat'],
      tag_query: null,
    },
  ],
  quality: { usable: true, issue: null },
};

const enrichment = {
  observations: [{ text: 'Red chili oil pooled under the noodles', kind: 'food' }],
  visible_text: [],
  confirmed: [{ name: 'dan dan noodles', rationale: 'Minced pork and chili oil topping', keep: true }],
  additional_candidates: [
    {
      name: 'liangpi',
      type: 'cuisine',
      relation: 'resembles',
      certainty: 0.4,
      categories: ['eat'],
      tag_query: 'Chinese cuisine',
      rationale: 'Cold noodle texture',
    },
  ],
  regions: [{ label: 'bowl', box: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } }],
  uncertainty: { overall: 'medium', notes: ['Illustrated reference'] },
  competing_subjects: [],
};

describe('two-stage reading schemas', () => {
  it('VlmQuickRead accepts the measured stage-1 shape and enforces its limits', () => {
    expect(VlmQuickRead.parse(quick).candidates).toHaveLength(2);
    const six = Array.from({ length: 6 }, () => quick.candidates[0]);
    expect(VlmQuickRead.safeParse({ ...quick, candidates: six }).success).toBe(false);
    expect(VlmQuickRead.safeParse({ ...quick, title: 'x'.repeat(61) }).success).toBe(false);
    expect(VlmQuickRead.safeParse({ ...quick, interpretation: 'x'.repeat(161) }).success).toBe(false);
    const badCategory = { ...quick.candidates[0], categories: ['listen'] };
    expect(VlmQuickRead.safeParse({ ...quick, candidates: [badCategory] }).success).toBe(false);
    // tag_query and quality.issue are required-nullable, never omitted.
    const { tag_query: _t, ...noTag } = quick.candidates[0]!;
    expect(VlmQuickRead.safeParse({ ...quick, candidates: [noTag] }).success).toBe(false);
  });

  it('VlmEnrichment accepts the stage-2 shape and caps additions and regions', () => {
    expect(VlmEnrichment.parse(enrichment).additional_candidates[0]!.rationale).toBe(
      'Cold noodle texture',
    );
    const five = Array.from({ length: 5 }, () => enrichment.additional_candidates[0]);
    expect(VlmEnrichment.safeParse({ ...enrichment, additional_candidates: five }).success).toBe(false);
    const regions = Array.from({ length: 5 }, () => enrichment.regions[0]);
    expect(VlmEnrichment.safeParse({ ...enrichment, regions }).success).toBe(false);
    expect(
      VlmEnrichment.safeParse({
        ...enrichment,
        observations: [{ text: 'x', kind: 'sensitive_attribute' }],
      }).success,
    ).toBe(false);
  });

  it('both compile to strict structured-output contracts that round-trip', () => {
    for (const [schema, value] of [
      [VlmQuickReadV1, quick],
      [VlmEnrichmentV1, enrichment],
      [VlmQuickReadV2, quickV2],
      [VlmEnrichmentV2, enrichmentV2],
    ] as const) {
      const contract = structuredOutputContract(schema);
      expect(contract.jsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(schema.parse(contract.decode(contract.encode(schema.parse(value))))).toEqual(
        schema.parse(value),
      );
    }
    // The full reading's model schema is unchanged: no v2 fields are asked of that model.
    const full = structuredOutputContract(VlmFullReading).jsonSchema as {
      properties: { candidates: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    expect(Object.keys(full.properties.candidates.items.properties).sort()).toEqual(
      ['certainty', 'id', 'name', 'rationale', 'region_ids', 'relation', 'suggested_categories', 'tag_queries', 'type'],
    );
  });
});

// Reading v2 (docs/quality-plan.md §3).
const quickV2 = {
  title: 'Bike on a porch',
  interpretation: 'A red road bike beside a dog on a porch.',
  candidates: [
    {
      name: 'Fixture Cycles',
      type: 'brand',
      relation: 'depicted',
      certainty: 0.9,
      domain: 'vehicle',
      evidence: 'read_text',
      evidence_text: 'FIXTURE CYCLES',
      tag_query: null,
    },
    {
      name: 'Road cycling',
      type: 'tradition',
      relation: 'resembles',
      certainty: 0.6,
      domain: 'sport',
      evidence: 'distinctive_form',
      evidence_text: null,
      tag_query: 'road cycling',
    },
  ],
  quality: { usable: true, issue: null },
};
const enrichmentV2 = {
  observations: [{ text: 'Red frame with drop bars', kind: 'object' }],
  visible_text: ['FIXTURE CYCLES'],
  illegible_text_present: true,
  confirmed: [{ name: 'Fixture Cycles', rationale: 'Legible top-tube lettering', verdict: 'supported' }],
  additional_candidates: [
    {
      name: 'Randonneuring',
      type: 'tradition',
      relation: 'resembles',
      certainty: 0.5,
      domain: 'sport',
      evidence: 'context',
      evidence_text: null,
      tag_query: 'randonneuring',
      rationale: 'Mudguards and a front rack',
    },
  ],
  regions: [{ label: 'Fixture Cycles', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }],
  uncertainty: { overall: 'low', notes: [] },
  competing_subjects: [],
};

describe('reading v2 schemas', () => {
  it('the quick read carries domain and evidence instead of categories, and allows zero candidates', () => {
    expect(VlmQuickReadV2.parse(quickV2).candidates[0]).toMatchObject({ domain: 'vehicle', evidence: 'read_text' });
    expect(VlmQuickReadV2.safeParse({ ...quickV2, candidates: [] }).success).toBe(true);
    const { domain: _d, ...noDomain } = quickV2.candidates[0]!;
    expect(VlmQuickReadV2.safeParse({ ...quickV2, candidates: [noDomain] }).success).toBe(false);
    // Over the 60-char limit is tolerated and clipped by normalization; over the tolerance still fails.
    const longText = { ...quickV2.candidates[0]!, evidence_text: 'x'.repeat(61) };
    expect(normalizeQuickRead(VlmQuickReadV2.parse({ ...quickV2, candidates: [longText] })).candidates[0]!.evidence_text).toHaveLength(60);
    const tooLong = { ...quickV2.candidates[0]!, evidence_text: 'x'.repeat(201) };
    expect(VlmQuickReadV2.safeParse({ ...quickV2, candidates: [tooLong] }).success).toBe(false);
    const badDomain = { ...quickV2.candidates[0]!, domain: 'wear' };
    expect(VlmQuickReadV2.safeParse({ ...quickV2, candidates: [badDomain] }).success).toBe(false);
  });

  it('the enrichment carries a verdict and the illegible-text flag instead of keep', () => {
    const e = VlmEnrichmentV2.parse(enrichmentV2);
    expect(e.illegible_text_present).toBe(true);
    expect(VlmEnrichmentV2.safeParse({ ...enrichmentV2, confirmed: [{ name: 'x', rationale: 'y', keep: true }] }).success).toBe(false);
    const { illegible_text_present: _i, ...noFlag } = enrichmentV2;
    expect(VlmEnrichmentV2.safeParse(noFlag).success).toBe(false);
  });

  it('VlmQuickRead and VlmEnrichment accept either version (recorded v1 outputs keep parsing)', () => {
    expect(VlmQuickRead.parse(quick).candidates[0]).toHaveProperty('categories');
    expect(VlmQuickRead.parse(quickV2).candidates[0]).toHaveProperty('domain');
    expect(isEnrichmentV2(VlmEnrichment.parse(enrichment))).toBe(false);
    expect(isEnrichmentV2(VlmEnrichment.parse(enrichmentV2))).toBe(true);
  });

  it('confirmationVerdict: v2 verbatim; v1 keep=false is unsupported, a hedged keep=true is weak', () => {
    expect(confirmationVerdict({ name: 'a', rationale: 'r', verdict: 'weak' })).toBe('weak');
    expect(confirmationVerdict({ name: 'a', rationale: 'Clearly visible', keep: false })).toBe('unsupported');
    expect(confirmationVerdict({ name: 'a', rationale: 'Clearly visible', keep: true })).toBe('supported');
    for (const hedge of [
      'Ball shows a partial mark, but it is not clearly legible.',
      'Specific attribution cannot be confirmed visually.',
      'The style looks more Victorian than Georgian.',
      'There is no legible badge on the car.',
      'It is unclear whether the bowl is lustreware.',
      'Hard to tell at this size.',
    ])
      expect(confirmationVerdict({ name: 'a', rationale: hedge, keep: true }), hedge).toBe('weak');
  });

  it('stored analyses without v2 fields still parse', () => {
    const legacy = VlmAnalysis.parse({
      title: 'T',
      interpretation: 'I',
      observations: [],
      visible_text: [],
      candidates: [{ id: 'c1', name: 'n', type: 'style', relation: 'resembles', rationale: '', certainty: 0.5 }],
      regions: [],
      uncertainty: { overall: 'low' },
      quality: { usable: true },
    });
    expect(legacy.candidates[0]!.domain).toBeUndefined();
    expect(legacy.candidates[0]!.suggested_categories).toEqual([]);
  });
});

describe('reading v2 tolerates cap overflow (the strict wire schema cannot carry caps)', () => {
  const cand = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    type: 'style',
    relation: 'resembles',
    certainty: 0.6,
    domain: 'design',
    evidence: 'context',
    evidence_text: null,
    tag_query: name,
    ...extra,
  });

  it('a quick read with too many, duplicate or over-long candidates is cut back, never failed', () => {
    const raw = VlmQuickReadV2.parse({
      title: 'FIXTURE title that runs far past the sixty character prompt limit for titles',
      interpretation: 'A short sentence.',
      candidates: [cand('Fixture A'), cand('fixture a'), cand('x'.repeat(81)), cand('Fixture B'), cand('Fixture C'), cand('Fixture D'), cand('Fixture E'), cand('Fixture F')],
      quality: { usable: true, issue: null },
    });
    const q = normalizeQuickRead(raw);
    expect(q.candidates.map((c) => c.name)).toEqual(['Fixture A', 'Fixture B', 'Fixture C', 'Fixture D', 'Fixture E']);
    expect(q.title.length).toBeLessThanOrEqual(V2_LIMITS.titleChars);
    expect(q.title).toBe('FIXTURE title that runs far past the sixty character prompt');
    expect(normalizeQuickRead(q)).toEqual(q);
    expect(normalizeQuickRead(raw, 2).candidates).toHaveLength(2);
    expect(toVlmAnalysis(raw).candidates.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('an enrichment over its limits parses and merges to the documented limits', () => {
    const e = VlmEnrichmentV2.parse({
      ...enrichmentV2,
      observations: Array.from({ length: 9 }, (_, i) => ({ text: `FIXTURE observation ${i}`, kind: 'object' })),
      visible_text: [...Array.from({ length: 14 }, (_, i) => `LINE ${i}`), 'LINE 0', ' '],
      additional_candidates: Array.from({ length: 7 }, (_, i) => ({ ...cand(`Fixture extra ${i}`), rationale: 'r' })),
      uncertainty: { overall: 'medium', notes: ['a', 'b', 'c', 'd', 'e'] },
      competing_subjects: ['s1', 's2', 's3', 's4', 's5'],
    });
    const n = normalizeEnrichment(e);
    expect(n.observations).toHaveLength(V2_LIMITS.observations);
    expect(n.visible_text).toEqual(Array.from({ length: 8 }, (_, i) => `LINE ${i}`));
    expect(n.additional_candidates).toHaveLength(V2_LIMITS.additionalCandidates);
    expect(n.uncertainty.notes).toHaveLength(3);
    expect(n.competing_subjects).toHaveLength(3);
    const base = toVlmAnalysis({ title: 't', interpretation: 'i', candidates: [], quality: { usable: true, issue: null } });
    const { analysis, merge } = mergeEnrichmentContext(base, e);
    expect(analysis.visible_text).toHaveLength(8);
    expect(analysis.observations).toHaveLength(5);
    expect(merge.stage2Text).toHaveLength(8);
    expect(merge.additionIds).toHaveLength(4);
  });

  it('names in any script have a key of their own (CJK no longer reads as an empty name)', () => {
    expect(candidateNameKey('愚园路')).toBe('愚园路');
    expect(candidateNameKey('愚园路')).not.toBe(candidateNameKey('豫园'));
    expect(candidateNameKey('Café  Flore')).toBe('cafe flore');
    const q = normalizeQuickRead(
      VlmQuickReadV2.parse({ title: 't', interpretation: 'i', candidates: [cand('愚园路', { type: 'place', domain: 'place' }), cand('豫园', { type: 'place', domain: 'place' })], quality: { usable: true, issue: null } }),
    );
    expect(q.candidates.map((c) => c.name)).toEqual(['愚园路', '豫园']);
  });
});
