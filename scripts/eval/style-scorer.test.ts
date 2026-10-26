import { describe, expect, it } from 'vitest';
import { scoreStyle, wilson, type CaptureView } from './style-scorer';

const claim = (name: string) => ({ name, display: name, wording: 'asserted' });
const view = (over: Partial<NonNullable<CaptureView['style_reading']>['subjects'][number]> = {}, cards: { title: string; style_match?: { attributes: string[] } }[] = []): CaptureView => ({
  style_reading: {
    summary: 'A rugged canvas jacket.',
    subjects: [{ id: 's1', category: 'fashion', label: 'Canvas jacket', aesthetics: [claim('Workwear')], materials: [claim('canvas')], lineage: [], construction: [], details: [], mood: [], palette: [], era: null, ...over }],
  },
  rails: [{ key: 'more_like_this:s1', kind: 'more_like_this', cards }],
});

describe('score-style-v1 (automatic metrics)', () => {
  it('counts people violations, faithfulness, coverage and fashion rail fill', () => {
    const cards = ['A', 'B', 'C', 'D'].map((t) => ({ title: t, style_match: { attributes: ['Workwear'] } }));
    const out = scoreStyle([
      { id: 'ok', view: view({}, cards), milestones: { style_ready: 9000 } },
      { id: 'bad', view: view({ label: "Man's jacket" }, [{ title: 'X', style_match: { attributes: ['Invented'] } }]), milestones: { style_ready: 15000 } },
    ]);
    expect(out.metrics['M-S4_people_violations']).toBe(1);
    expect(out.metrics['M-R3_reason_faithfulness'].rate).toBeCloseTo(4 / 5);
    expect(out.metrics['M-C1_coverage'].rate).toBe(1);
    expect(out.metrics['M-C2_rail_fill_fashion'].rate).toBe(0.5);
    expect(out.metrics['M-T_ms'].style_ready).toEqual({ p50: 9000, p90: 15000, n: 2 });
  });

  it('auto-verdicts claims against labels and measures recall', () => {
    const out = scoreStyle([
      {
        id: 'h29',
        view: view({ aesthetics: [claim('Workwear'), claim('Streetwear')], materials: [claim('duck canvas')] }),
        label: { id: 'h29', photo: 'h29.jpg', split: 'tune', forbidden_people_claims: true, subjects: [{ category: 'fashion', label_any: [], aesthetics: { expected: ['workwear', 'utilitarian'], acceptable: [], forbidden: ['streetwear'] }, materials: { expected: ['canvas'], acceptable: [], forbidden: [] }, construction_any: [], palette_names_any: [], era_acceptable: [] }] },
      },
    ]);
    expect(out.metrics.label_auto_verdicts).toEqual({ supported: 2, unsupported: 1, unjudged: 0 });
    expect(out.metrics['M-S3_recall'].rate).toBeCloseTo(2 / 3);
  });

  it('reports Wilson 95% intervals', () => {
    const w = wilson(8, 10);
    expect(w.rate).toBe(0.8);
    expect(w.low).toBeGreaterThan(0.44);
    expect(w.high).toBeLessThan(0.97);
    expect(wilson(0, 0).rate).toBeNull();
  });
});
