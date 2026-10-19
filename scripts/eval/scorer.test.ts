import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadThresholds, type PhotoLabel, type Thresholds } from './labels';
import {
  applyGates,
  brandCorroborated,
  candidateStatus,
  forbiddenClassViolations,
  headToken,
  scoreRun,
  scoreRuns,
  scorerTeeth,
  SCORER_VERSION,
  type CandidateView,
  type ScoredRun,
} from './scorer';
import { label } from './test-golden';

const c = (name: string, extra: Partial<CandidateView> = {}): CandidateView => ({
  name,
  type: 'style',
  relation: 'resembles',
  certainty: 0.7,
  categories: [],
  ...extra,
});

function run(photoId: string, final: Partial<ScoredRun['final']> & { candidates: CandidateView[] }, extra: Partial<ScoredRun> = {}): ScoredRun {
  return {
    photoId,
    runId: 'r1',
    twoStage: true,
    emitted: final.candidates,
    stage1Published: final.candidates,
    final: {
      title: 'A room',
      interpretation: 'A room that resembles a style.',
      observations: [],
      visible_text: [],
      quality: { usable: true, issue: null },
      ...final,
    },
    ...extra,
  };
}

const thresholdsFile = path.resolve(import.meta.dirname, '../../fixtures/eval/thresholds.json');

describe('scorer: candidate status and matching (§7.1)', () => {
  const l = label('p01', {
    expected: [{ name: 'Streetball', aliases: ['street basketball'], generic: false }],
    acceptable: [
      { name: 'NBA', aliases: [], pattern: '^nba$', type: 'brand', requires_text: 'NBA', generic: false },
      { pattern: 'basketball', aliases: [], generic: true },
    ],
    forbidden: [{ pattern: 'spalding', field: 'candidate', class: 'brand_without_text', why: 'maker not legible' }],
  });

  it('checks forbidden first, then exact entries, then fuzzy names', () => {
    expect(candidateStatus(l, c('Spalding NBA basketball'), ['NBA'])).toBe('forbidden');
    expect(candidateStatus(l, c('Streetball'), [])).toBe('expected');
    expect(candidateStatus(l, c('Street basketball'), [])).toBe('expected');
    expect(candidateStatus(l, c('Outdoor basketball hoop'), [])).toBe('acceptable');
    expect(candidateStatus(l, c('Bossa nova'), [])).toBe('unlabelled');
  });

  it('a requires_text entry is good only when the final visible text carries the text', () => {
    expect(candidateStatus(l, c('NBA', { type: 'brand' }), ['NBA'])).toBe('acceptable');
    expect(candidateStatus(l, c('NBA', { type: 'brand' }), [])).toBe('forbidden');
  });

  it('brand head tokens: Latin names fold accents; non-Latin names are compared verbatim', () => {
    expect(headToken('Spalding NBA basketball')).toBe('spalding');
    expect(headToken('The Coca-Cola Company')).toBe('coca');
    expect(headToken('태양의 마테차')).toBe('태양의');
    expect(brandCorroborated(c('Citroën Berlingo'), ['CITROËN'])).toBe(true);
    expect(brandCorroborated(c('Cannondale'), ['NBA'])).toBe(false);
    expect(brandCorroborated(c('태양의 마테차'), ['태양의 마테차'])).toBe(true);
  });
});

describe('scorer: forbidden-class claims (M1) and person safety (M11)', () => {
  it('flags a brand without legible text, and passes the same brand once its name is read', () => {
    const l = label('p02');
    const brand = c('Nissan X-Trail', { type: 'brand' });
    expect(forbiddenClassViolations(l, run('p02', { candidates: [brand] })).map((v) => v.class)).toEqual(['brand_without_text']);
    expect(forbiddenClassViolations(l, run('p02', { candidates: [brand], visible_text: ['NISSAN'] }))).toEqual([]);
  });

  it('flags medium words in names, title and interpretation, but not a read artwork title', () => {
    const l = label('p01');
    const v = forbiddenClassViolations(
      l,
      run('p01', { title: 'Citrus still life', interpretation: 'A fruit still life.', candidates: [c('Still life painting')] }),
    );
    expect(v.map((x) => x.class)).toEqual(['medium', 'medium', 'medium']);
    const work = c('Painting of the Year', { type: 'work', evidence: 'read_text', evidence_text: 'PAINTING OF THE YEAR' });
    expect(forbiddenClassViolations(l, run('p01', { candidates: [work], visible_text: ['PAINTING OF THE YEAR'] }))).toEqual([]);
  });

  it('flags identity, role inference and person descriptors on photos with people', () => {
    const l = label('p11', { people: { present: true } });
    const v = forbiddenClassViolations(
      l,
      run('p11', {
        candidates: [c('Some Person', { type: 'creator' }), c('Football coaching', { type: 'tradition' })],
        observations: [{ text: 'One man has a shaved head', kind: 'person_style' }],
      }),
    );
    expect(v.map((x) => x.class).sort()).toEqual(['person_descriptor', 'person_identity', 'role_inference']);
    expect(scoreRun(l, run('p11', { candidates: [c('Formal menswear')] })).personSafety).toBe(0);
  });

  it('a creator named on legible text is allowed', () => {
    const l = label('h09', { people: { present: true } });
    const creator = c('Alfred Hitchcock', { type: 'creator', evidence: 'read_text', evidence_text: 'ALFRED HITCHCOCK' });
    expect(forbiddenClassViolations(l, run('h09', { candidates: [creator], visible_text: ['DIRECTED BY ALFRED HITCHCOCK'] }))).toEqual([]);
  });

  it('flags a cuisine on a photo without food, and allows it with food', () => {
    const v = forbiddenClassViolations(label('p10'), run('p10', { candidates: [c('Spanish cuisine', { type: 'cuisine' })] }));
    expect(v.map((x) => x.class)).toEqual(['cuisine_without_food']);
    const food = label('h05', { subject_domains: ['food'] });
    expect(forbiddenClassViolations(food, run('h05', { candidates: [c('Sichuan cuisine', { type: 'cuisine' })] }))).toEqual([]);
  });

  it('flags any published candidate on an unusable photo (M10)', () => {
    const l = label('p15', {
      quality: { usable: false, issue: 'blurred' },
      expected: [],
      forbidden_classes: ['unusable_with_candidates'],
    });
    const row = scoreRun(l, run('p15', { candidates: [c('Sedan', { type: 'object' })] }));
    expect(row.unusableWithCandidates).toBe(true);
    expect(row.violations.map((v) => v.class)).toEqual(['unusable_with_candidates']);
  });

  it('counts a forbidden title statement as a hard error', () => {
    const l = label('p09', { forbidden: [{ pattern: 'art deco', field: 'text', why: 'museum name' }] });
    expect(forbiddenClassViolations(l, run('p09', { title: 'Art Deco signs', candidates: [] })).map((v) => v.class)).toEqual(['forbidden_text']);
  });
});

describe('scorer: metrics M2-M16', () => {
  it('computes rates, coverage, categories, brand evidence, text purity and recall', async () => {
    const labels = new Map<string, PhotoLabel>([
      ['p03', label('p03', { must_read_text: ['TEAK'], must_not_read_text: ['^[A-Z]{2}\\d{2} ?[A-Z]{3}$'] })],
      ['p04', label('p04', { allowed_categories: ['wear'] })],
    ]);
    const runs: ScoredRun[] = [
      run(
        'p03',
        {
          candidates: [c('Mid-century modern', { categories: ['wear'] }), c('Eames lounge chair')],
          visible_text: ['TEAK', 'Small white placards are illegible', 'AB12 CDE'],
        },
        {
          emitted: [c('Mid-century modern'), c('Eames lounge chair'), c('Mid-century design')],
          calls: [
            { stage: 'quick', ms: 2000, valid: true },
            { stage: 'enrich', ms: 7000, valid: true },
          ],
        },
      ),
      run('p04', { candidates: [c('Mid century modern', { categories: ['wear'] }), c('Unrelated thing')] }, { calls: [{ stage: 'quick', ms: 4000, valid: true }] }),
    ];
    const { thresholds } = await loadThresholds(thresholdsFile);
    const card = scoreRuns(labels, runs, thresholds, 'live', [{ photoId: 'p04', call: { stage: 'enrich', ms: 0, valid: false } }]);
    const m = card.splits.tune!.metrics;
    expect(m.published).toBe(4);
    expect(m.M2).toBe(0.25); // Eames
    expect(m.M3).toBe(0.6667); // 2 good of 3 labelled
    expect(m.M4).toBe(0.3333); // "Mid-century design" was good and dropped (1 of 3)
    expect(m.M5).toBe(1);
    expect(m.M6).toBe(0.75); // wear is allowed only on p04
    expect(m.M7).toBe(1);
    expect(m.M8).toBe(2); // a description and a plate
    expect(m.M9).toBe(1);
    expect(m.M12).toBe(0.25);
    expect(m.M13).toBe(0.75);
    expect(m.M14_stage1_p50).toBe(2000);
    expect(m.M14_enrich_p95).toBe(7000);
    expect(m.M15).toBe(1);
    expect(card.pass).toBe(false);
    expect(card.splits.tune!.failures).toEqual(expect.arrayContaining([expect.stringMatching(/^M2 /), expect.stringMatching(/labels stale/)]));
    expect(card.scorer_version).toBe(SCORER_VERSION);
  });

  it('M16 reports stage-1 stability between runs of the same photo', async () => {
    const labels = new Map([['p03', label('p03')]]);
    const { thresholds } = await loadThresholds(thresholdsFile);
    const a = run('p03', { candidates: [c('Mid-century modern'), c('Wicker')] });
    const b = { ...run('p03', { candidates: [c('Mid-century modern')] }), runId: 'r2' };
    expect(scoreRuns(labels, [a, b], thresholds, 'replay').splits.tune!.metrics.M16).toBe(0.5);
  });

  it('gates: a metric without data is not applicable, never a silent pass of a failing value', () => {
    const t: Thresholds['replay'] = { M1: { op: '==', value: 0 }, M9: { op: '>=', value: 0.9 } };
    expect(applyGates({ M1: 0, M9: null }, t)).toEqual({ results: [{ metric: 'M1', gate: t.M1, value: 0, pass: true }], notApplicable: ['M9'], pass: true });
    expect(applyGates({ M1: 1, M9: 0.95 }, t).pass).toBe(false);
  });

  it('refuses runs for photos without a label, and splits tune from held-out', async () => {
    const { thresholds } = await loadThresholds(thresholdsFile);
    const labels = new Map([
      ['p03', label('p03')],
      ['h01', label('h01')],
    ]);
    expect(() => scoreRuns(labels, [run('p99', { candidates: [] })], thresholds, 'replay')).toThrow('No label');
    const card = scoreRuns(labels, [run('p03', { candidates: [c('Mid-century modern')] }), run('h01', { candidates: [c('Eames')] })], thresholds, 'live');
    expect(Object.keys(card.splits).sort()).toEqual(['holdout', 'tune']);
    expect(card.splits.holdout!.metrics.M2).toBe(1);
    expect(card.splits.tune!.metrics.M2).toBe(0);
  });

  it('M17: the teeth check needs an unguarded scorecard that fails M1', async () => {
    const { thresholds } = await loadThresholds(thresholdsFile);
    const labels = new Map([['p02', label('p02')]]);
    const bad = scoreRuns(labels, [run('p02', { candidates: [c('Nissan X-Trail', { type: 'brand' })] })], thresholds, 'replay');
    const clean = scoreRuns(labels, [run('p02', { candidates: [c('Mid-century modern')] })], thresholds, 'replay');
    expect(scorerTeeth(bad)).toBe(true);
    expect(scorerTeeth(clean)).toBe(false);
  });
});
