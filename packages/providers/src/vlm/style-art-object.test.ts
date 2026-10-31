import { describe, expect, it } from 'vitest';
import { guardStyleReading, STYLE_GUARD_VERSION, styleTextAboutPerson, thingLabel, type VlmStyleReading } from './style';

function fixture(label = 'Terracotta face vessel fragment'): VlmStyleReading {
  return {
    schema: 'atlas_style_reading_v1', usable: true, unusable_reason: null,
    summary: 'A hand-modeled clay face vessel with closed eyes.',
    subjects: [{
      id: 's1', category: 'interior', label, region: { x: 0, y: 0, w: 1, h: 1 },
      observations: [
        { id: 'o1', kind: 'form', text: 'Modeled face with closed eyes', region: null, certainty: 0.9 },
        { id: 'o2', kind: 'surface', text: 'Rough unglazed clay', region: null, certainty: 0.9 },
      ],
      aesthetics: [{
        name: 'Rustic', certainty: 0.7, defining_features: [], tag_query: null,
        evidence: { basis: 'visible', region: null }, evidence_ids: ['o1', 'o2'],
      }],
      era: null, lineage: [], materials: [], construction: [], palette: [], mood: [],
      details: [{ text: 'Modeled face with closed eyes', certainty: 0.8, evidence: { basis: 'visible', region: null }, evidence_ids: ['o1'] }],
      brand: null,
    }],
  };
}
const context = { stage1: { usable: true, peopleShown: false, visibleText: [] } };

describe('figurative art is an object, not a person identification', () => {
  it('keeps a clay face vessel and its evidence-linked modeled form', () => {
    const out = guardStyleReading(fixture(), context);
    expect(STYLE_GUARD_VERSION).toBe('guard-v20');
    expect(out.reading.usable).toBe(true);
    expect(out.reading.summary).toBe(fixture().summary);
    const subject = out.reading.subjects[0]!;
    expect(subject.label).toBe('Terracotta face vessel fragment');
    expect(subject.observations).toHaveLength(2);
    expect(subject.aesthetics[0]?.defining_features).toEqual(['Modeled face with closed eyes', 'Rough unglazed clay']);
    expect(subject.details).toHaveLength(1);
  });

  it('does not change the general person detector or allow unscoped body descriptions', () => {
    expect(styleTextAboutPerson('Face with closed eyes')).toBe(true);
    expect(thingLabel('Face with closed eyes')).toBeNull();
    const input = fixture('Decorative object');
    const out = guardStyleReading(input, context);
    expect(out.reading.subjects[0]?.observations?.map((o) => o.id)).toEqual(['o2']);
    expect(out.reading.subjects[0]?.aesthetics).toEqual([]);
  });

  it.each(['young woman', 'elderly man', 'her face', 'doctor', 'dark skin', 'curly hair'])('never exempts %s because art is mentioned', (person) => {
    expect(thingLabel(`Terracotta face vessel with ${person}`)).toBeNull();
  });

  it('still removes skin, hair, expression and identity claims within an art object', () => {
    const input = fixture();
    input.subjects[0]!.observations!.push(
      { id: 'o3', kind: 'surface', text: 'Dark skin and curly hair', region: null, certainty: 0.9 },
      { id: 'o4', kind: 'form', text: 'Smiling expression', region: null, certainty: 0.9 },
    );
    input.subjects[0]!.details.push({
      text: 'Young woman with dark skin', certainty: 0.9, evidence: { basis: 'visible', region: null }, evidence_ids: ['o3'],
    });
    const out = guardStyleReading(input, context);
    expect(out.reading.subjects[0]?.observations?.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(out.reading.subjects[0]?.details).toHaveLength(1);
  });
});
