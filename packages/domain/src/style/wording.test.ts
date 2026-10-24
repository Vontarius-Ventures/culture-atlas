import { describe, expect, it } from 'vitest';
import { aesthetic, guardedSubject } from './test-support';
import {
  NO_CORROBORATION,
  aestheticWording,
  constructionWording,
  corroboratedBy,
  eraLineageWording,
  materialWording,
  moodWording,
  rewordAfterStage2,
  strengthFor,
  wordSubject,
  type CorroborationEvidence,
} from './wording';

const word = (s = guardedSubject(), ev: CorroborationEvidence = NO_CORROBORATION) => {
  const dropped: { path: string; rule: string }[] = [];
  const out = wordSubject({ subject: s, swatches: [{ index: 0, hex: '#7B5A3A', share: 0.4 }], presentSwatches: new Set([0]), corroboration: ev, keepClaimRegions: false }, dropped);
  return { out, dropped };
};

describe('server-decided wording sw-1 (style design §A.2, R-8)', () => {
  it('asserts an aesthetic only with >= 0.85, visible basis and two defining features', () => {
    expect(aestheticWording({ certainty: 0.86, basis: 'visible', features: 2 }, [], true)).toBe('asserted');
    expect(aestheticWording({ certainty: 0.84, basis: 'visible', features: 2 }, [], true)).toBe('resembles');
    expect(aestheticWording({ certainty: 0.95, basis: 'visible', features: 1 }, [], true)).toBe('resembles');
    expect(aestheticWording({ certainty: 0.95, basis: 'context', features: 3 }, [], true)).toBe('resembles');
    expect(aestheticWording({ certainty: 0.39, basis: 'visible', features: 3 }, [], true)).toBeNull();
  });

  it('corroboration lifts the bar: 0.80 from a same-family stage, 0.75 from a Qloo entity or another family', () => {
    expect(aestheticWording({ certainty: 0.8, basis: 'visible', features: 2 }, ['stage1'], true)).toBe('asserted');
    expect(aestheticWording({ certainty: 0.78, basis: 'visible', features: 2 }, ['stage1'], true)).toBe('resembles');
    expect(aestheticWording({ certainty: 0.76, basis: 'visible', features: 2 }, ['stage1'], false)).toBe('asserted');
    expect(aestheticWording({ certainty: 0.76, basis: 'visible', features: 2 }, ['qloo_entity'], true)).toBe('asserted');
  });

  it('a "-inspired" or culture-coded aesthetic is never asserted', () => {
    expect(aestheticWording({ certainty: 0.99, basis: 'visible', features: 4, resemblesOnly: true }, ['qloo_entity'], false)).toBe('resembles');
  });

  it('never asserts era or lineage without read text, and drops them under 0.45', () => {
    expect(eraLineageWording({ certainty: 0.99, basis: 'visible' })).toBe('resembles');
    expect(eraLineageWording({ certainty: 0.44, basis: 'visible' })).toBeNull();
    expect(eraLineageWording({ certainty: 0.3, basis: 'read_text' })).toBe('asserted');
  });

  it('words materials, construction and details by their own bars', () => {
    expect(materialWording({ certainty: 0.7, basis: 'visible' })).toBe('asserted');
    expect(materialWording({ certainty: 0.69, basis: 'visible' })).toBe('resembles');
    expect(materialWording({ certainty: 0.9, basis: 'context' })).toBe('resembles');
    expect(materialWording({ certainty: 0.39, basis: 'visible' })).toBeNull();
    expect(constructionWording({ certainty: 0.65, basis: 'visible' })).toBe('asserted');
    expect(constructionWording({ certainty: 0.64, basis: 'visible' })).toBe('resembles');
    expect(constructionWording({ certainty: 0.39, basis: 'visible' })).toBeNull();
  });

  it('never asserts mood; it reads "Feels …" from 0.5', () => {
    expect(moodWording({ certainty: 1 })).toBe('resembles');
    expect(moodWording({ certainty: 0.49 })).toBeNull();
    const { out } = word(guardedSubject({ mood: [{ name: 'rugged', certainty: 0.7 }] }));
    expect(out.mood[0]).toMatchObject({ display: 'Feels rugged', strength: null });
  });

  it('derives strength after wording (R-16a)', () => {
    expect(strengthFor('asserted', 0.9)).toBe('clear');
    expect(strengthFor('asserted', 0.7)).toBe('likely');
    expect(strengthFor('resembles', 0.9)).toBe('likely');
    expect(strengthFor('resembles', 0.5)).toBe('possible');
  });

  it('composes the display copy the clients render verbatim', () => {
    const { out } = word(
      guardedSubject({
        aesthetics: [aesthetic('Workwear', 0.9), aesthetic('Mid-century modern', 0.6)],
        era: { name: '1950s–1970s American', certainty: 0.6, basis: 'visible', cue: 'boxy cut' },
        lineage: [{ name: 'American heritage workwear', certainty: 0.6, basis: 'visible' }],
        materials: [{ name: 'duck canvas', texture: 'stiff', certainty: 0.8, basis: 'visible', tag_query: null }, { name: 'linen', texture: 'soft', certainty: 0.5, basis: 'visible', tag_query: null }],
        palette: [{ swatch: 0, name: 'tobacco brown' }, { swatch: 3, name: 'black' }],
      }),
    );
    expect(out.aesthetics.map((a) => a.display)).toEqual(['Workwear', 'Resembles mid-century modern']);
    expect(out.era?.display).toBe('Suggests the 1950s–1970s American');
    expect(out.lineage[0]!.display).toBe('Resembles American heritage workwear');
    expect(out.materials.map((m) => m.display)).toEqual(['Duck canvas', 'Looks like linen']);
    // Swatch 3 does not exist: dropped (G-STYLE-PALETTE); the kept one carries the measured hex.
    expect(out.palette).toEqual([{ swatch: 0, name: 'tobacco brown', hex: '#7B5A3A', display: 'Tobacco brown', wording: 'asserted' }]);
  });

  it('drops claims under their floors with G-LOWCERT and records the path', () => {
    const { out, dropped } = word(guardedSubject({ aesthetics: [aesthetic('Workwear', 0.3)], details: [{ text: 'snaps', certainty: 0.2, evidence: { basis: 'visible', region: null } }] }));
    expect(out.aesthetics).toEqual([]);
    expect(dropped.map((d) => d.rule)).toEqual(['G-LOWCERT', 'G-LOWCERT']);
  });

  it('matches corroboration after normalizing case, punctuation and a trailing style word', () => {
    const ev: CorroborationEvidence = { ...NO_CORROBORATION, stage1: new Set(['mid century modern']), qlooEntity: new Set(['workwear']) };
    expect(corroboratedBy('Mid-Century Modern style', null, ev)).toEqual(['stage1']);
    expect(corroboratedBy('Utility', 'workwear', ev)).toEqual(['qloo_entity']);
  });

  it('stage 2 only raises wording, releases holds and retracts a vetoed claim (never removes it)', () => {
    const { out } = word(guardedSubject({ aesthetics: [aesthetic('Workwear', 0.8), aesthetic('Skate', 0.9, { held: 'G-STYLE-CULTURE' }), aesthetic('Grunge', 0.9)] }));
    expect(out.aesthetics.map((a) => [a.wording, a.held])).toEqual([
      ['resembles', false],
      ['asserted', true],
      ['asserted', false],
    ]);
    const r = rewordAfterStage2(out, { ...NO_CORROBORATION, stage2: new Set(['workwear', 'skate']), vetoed: new Set(['grunge']) });
    expect(r).toEqual({ upgraded: ['subjects[s1].aesthetics[0]'], released: ['subjects[s1].aesthetics[1]'], retracted: ['subjects[s1].aesthetics[2]'] });
    expect(out.aesthetics.map((a) => [a.wording, a.held, !!a.retracted])).toEqual([
      ['asserted', false, false],
      ['asserted', false, false],
      ['asserted', false, true],
    ]);
  });

  it('keeps nationalities capitalized mid-sentence', () => {
    const { out } = word(guardedSubject({ category: 'food', aesthetics: [aesthetic('Japanese ramen-ya', 0.6)] }));
    expect(out.aesthetics[0]!.display).toBe('Resembles Japanese ramen-ya');
  });
});
