import { describe, expect, it } from 'vitest';
import { structuredOutputContract } from '../model-gateway/schema';
import { VlmAnalysis, VlmEnrichment, VlmQuickRead } from './types';

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
      [VlmQuickRead, quick],
      [VlmEnrichment, enrichment],
    ] as const) {
      const contract = structuredOutputContract(schema);
      expect(contract.jsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(schema.parse(contract.decode(contract.encode(schema.parse(value))))).toEqual(
        schema.parse(value),
      );
    }
    // Today's full reading is unchanged.
    expect(() => structuredOutputContract(VlmAnalysis)).not.toThrow();
  });
});
