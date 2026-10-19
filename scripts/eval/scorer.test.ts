import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadThresholds, type PhotoLabel, type Thresholds } from './labels';
import {
  applyGates,
  brandCorroborated,
  candidateStatus,
  forbiddenClassViolations,
  gatesFor,
  headToken,
  runKind,
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
    expect(brandCorroborated(c('Citroën Berlingo'), ['CITROËN'])).toBe(false);
    expect(brandCorroborated(c('Citroën Berlingo'), ['CITROËN', 'BERLINGO'])).toBe(true);
    expect(brandCorroborated(c('Cannondale'), ['NBA'])).toBe(false);
    expect(brandCorroborated(c('태양의 마테차'), ['태양의 마테차'])).toBe(true);
  });
});

describe('scorer: forbidden-class claims (M1) and person safety (M11)', () => {
  it('flags a brand without legible text, and passes the same brand once its name is read', () => {
    const l = label('p02');
    const brand = c('Nissan X-Trail', { type: 'brand' });
    expect(forbiddenClassViolations(l, run('p02', { candidates: [brand] })).map((v) => v.class)).toEqual(['brand_without_text']);
    // score-v3: the model word must be read too; a make on the badge does not vouch for a model guessed from the shape.
    expect(forbiddenClassViolations(l, run('p02', { candidates: [brand], visible_text: ['NISSAN'] })).map((v) => v.class)).toEqual(['brand_without_text']);
    expect(forbiddenClassViolations(l, run('p02', { candidates: [brand], visible_text: ['NISSAN', 'X-TRAIL'] }))).toEqual([]);
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

  it('score-v5: plural role nouns are roles, and players, athletes or spectators in the reading show people', () => {
    // The label says no people: only the reading can show them.
    const l = label('h40', { people: { present: false } });
    const subjects = { candidates: [], competing_subjects: ['main player', 'background players', 'Green hard court'] };
    const tennis = forbiddenClassViolations(l, run('h40', { title: 'Fixture sport player at the baseline', interpretation: 'A match on a court.', ...subjects }));
    expect(tennis.map((v) => v.detail)).toEqual(['subject: main player', 'subject: background players']);
    expect(tennis.every((v) => v.class === 'role_inference')).toBe(true);
    // People words in an observation count too; plural roles in candidate names are counted.
    const stand = forbiddenClassViolations(
      l,
      run('h40', {
        title: 'A stadium stand',
        interpretation: 'Floodlights over a pitch.',
        observations: [{ text: 'Spectators fill the upper tier', kind: 'object' }],
        candidates: [c('Referees', { type: 'tradition' }), c('Rival goalkeepers', { type: 'tradition' })],
      }),
    );
    expect(stand.map((v) => v.detail)).toEqual(['Referees', 'Rival goalkeepers']);
    // Without people in the reading the same names are not a role inference.
    expect(forbiddenClassViolations(l, run('h40', { title: 'An empty pitch', candidates: [c('Referees', { type: 'tradition' })] }))).toEqual([]);
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

describe('score-v3 (review findings: the yardstick must not move with the guard)', () => {
  it('matches brand words as whole words, never as substrings', () => {
    expect(brandCorroborated(c('Audi A4'), ['AUDITORIUM'])).toBe(false);
    expect(brandCorroborated(c('Ford Focus'), ['STRATFORD'])).toBe(false);
    expect(brandCorroborated(c('Asics Gel'), ['BASICS'])).toBe(false);
    expect(brandCorroborated(c('Vans Old Skool'), ['CARAVANS'])).toBe(false);
    expect(brandCorroborated(c('Audi A4'), ['AUDI', 'A4 TDI'])).toBe(true);
  });

  it('heads a brand with its naming word, not a qualifier', () => {
    expect(headToken('Vintage Nissan')).toBe('nissan');
    expect(headToken('Red Ferrari')).toBe('ferrari');
  });

  it('counts unlisted makers and model codes as brand-like, so they reach M1 and M7', () => {
    const l = label('p02');
    for (const name of ['Trek road bike', 'Mitsubishi', 'Fixture GT3 coupe']) {
      const v = forbiddenClassViolations(l, run('p02', { candidates: [c(name, { type: 'object' })] }));
      expect(v.map((x) => x.class), name).toEqual(['brand_without_text']);
    }
    const row = scoreRun(l, run('p02', { candidates: [c('Trek road bike', { type: 'object' })] }));
    expect([row.brandLike, row.brandCorroborated]).toEqual([1, 0]);
  });

  it('never accepts the claim\'s own evidence_text as proof of a person\'s name', () => {
    const l = label('p11', { forbidden_classes: ['person_identity'] });
    const person = c('Fixture Lebrook', { type: 'creator', domain: 'people', evidence: 'read_text', evidence_text: 'Fixture Lebrook' });
    expect(forbiddenClassViolations(l, run('p11', { candidates: [person] })).map((v) => v.class)).toEqual(['person_identity']);
    expect(forbiddenClassViolations(l, run('p11', { candidates: [person], visible_text: ['FIXTURE LEBROOK 23'] }))).toEqual([]);
  });

  it('knows the medium words the guard missed (artwork, prints, canvas, engraving, nature morte)', () => {
    const l = label('p03');
    for (const name of ['Dutch Golden Age artwork', 'Vanitas print', 'Nature morte', 'Fixture engravings']) {
      expect(forbiddenClassViolations(l, run('p03', { candidates: [c(name, { domain: 'art' })] })).map((v) => v.class), name).toEqual(['medium']);
    }
    expect(forbiddenClassViolations(l, run('p03', { candidates: [c('Batik print', { domain: 'craft' })] }))).toEqual([]);
    expect(forbiddenClassViolations(l, run('p03', { candidates: [], title: 'Dutch artwork of a fruit bowl' })).map((v) => v.class)).toEqual(['medium']);
  });

  it('scores competing subjects ("What caught your eye?") like published names', () => {
    const l = label('p11', { forbidden_classes: ['brand_without_text', 'medium', 'person_identity'], people: { present: true } });
    const v = forbiddenClassViolations(
      l,
      run('p11', { candidates: [], competing_subjects: ['Nissan X-Trail', 'Fixture Lebrook James', 'Still life painting', 'The red bicycle'] }),
    );
    expect(v.map((x) => [x.class, x.detail])).toEqual([
      ['brand_without_text', 'subject: Nissan X-Trail'],
      ['person_identity', 'subject: Nissan X-Trail'],
      ['person_identity', 'subject: Fixture Lebrook James'],
      ['medium', 'subject: Still life painting'],
    ]);
  });
});

describe('score-v4 (requalification decisions 3, 2 and the verifier)', () => {
  const labels = new Map<string, PhotoLabel>([
    ['p03', label('p03', { expected: [{ name: 'Mid-century modern', aliases: [], generic: false }], must_read_text: ['TEAK'] })],
    ['p04', label('p04', { expected: [{ name: 'Neoclassical', aliases: [], generic: false }] })],
  ]);
  const stage1 = (photoId: string, candidates: CandidateView[]) => run(photoId, { candidates }, { twoStage: false });

  it('classifies a split as two-stage, stage 1 alone, or mixed', () => {
    expect(runKind([{ twoStage: true }, { twoStage: true }])).toBe('two_stage');
    expect(runKind([{ twoStage: false }])).toBe('stage1');
    expect(runKind([{ twoStage: true }, { twoStage: false }])).toBe('mixed');
  });

  it('thr-v2 gates M5 and M9 on the two-stage run only; the stage-1 run keeps M15 >= 0.60 as its coverage gate', async () => {
    const { thresholds } = await loadThresholds(thresholdsFile);
    expect(thresholds.version).toBe('thr-v2');
    expect(thresholds.two_stage_only).toEqual(['M5', 'M9']);
    // No gate value differs by run kind: the stage-1 gates are the live gates minus the two-stage-only metrics.
    const s1 = gatesFor({ ...thresholds.live, ...thresholds.live_tune }, 'stage1', thresholds.two_stage_only);
    expect(s1.scopedOut.sort()).toEqual(['M5', 'M9']);
    expect(s1.gates.M15).toEqual({ op: '>=', value: 0.6 });
    expect(s1.gates.M3).toEqual(thresholds.live_tune.M3);
    expect(gatesFor(thresholds.live, 'two_stage', thresholds.two_stage_only).gates).toEqual(thresholds.live);
    expect(gatesFor(thresholds.live, 'mixed', thresholds.two_stage_only).gates).toEqual(thresholds.live);

    // One of two photos covered: M5 0.5, below the gate. Stage 1 alone is not gated on it ...
    const covered = c('Mid-century modern');
    const s1card = scoreRuns(labels, [stage1('p03', [covered]), stage1('p04', [c('Gilded mirror')])], thresholds, 'live');
    expect(s1card.splits.tune!.runKind).toBe('stage1');
    expect(s1card.splits.tune!.metrics.M5).toBe(0.5);
    expect(s1card.splits.tune!.scopedOut.sort()).toEqual(['M5', 'M9']);
    expect(s1card.splits.tune!.gates.map((g) => g.metric)).not.toContain('M5');
    expect(s1card.splits.tune!.failures.some((f) => f.startsWith('M5 '))).toBe(false);
    // ... but its own coverage gate still applies: M15 0.5 < 0.60 fails the stage-1 run.
    expect(s1card.splits.tune!.failures).toEqual(expect.arrayContaining([expect.stringMatching(/^M15 0.5 /)]));

    // The same readings as a two-stage run are gated on M5 (and M9).
    const card = scoreRuns(labels, [run('p03', { candidates: [covered] }), run('p04', { candidates: [c('Gilded mirror')] })], thresholds, 'live');
    expect(card.splits.tune!.runKind).toBe('two_stage');
    expect(card.splits.tune!.failures).toEqual(expect.arrayContaining([expect.stringMatching(/^M5 0.5 /), expect.stringMatching(/^M9 0 /)]));
    // A failed enrichment makes the split mixed, which is gated as strictly as two-stage.
    const mixed = scoreRuns(labels, [run('p03', { candidates: [covered] }), stage1('p04', [c('Gilded mirror')])], thresholds, 'live');
    expect(mixed.splits.tune!.runKind).toBe('mixed');
    expect(mixed.splits.tune!.gates.map((g) => g.metric)).toContain('M5');
  });

  it('reports what the verifier contested without removing anything (report only, no gate)', async () => {
    const { thresholds } = await loadThresholds(thresholdsFile);
    const l = new Map<string, PhotoLabel>([
      [
        'p05',
        label('p05', {
          expected: [{ name: 'Persian ceramics', aliases: [], generic: false }],
          forbidden: [{ pattern: 'iznik', field: 'candidate', why: 'the labels name Nishapur' }],
        }),
      ],
    ]);
    const before = scoreRuns(l, [run('p05', { candidates: [c('Persian ceramics'), c('Iznik pottery')] })], thresholds, 'live');
    expect(before.splits.tune!.metrics.forbidden_published).toBe(1);
    expect(before.splits.tune!.metrics.verifier_checked).toBe(0);
    expect(before.splits.tune!.metrics.forbidden_uncontested).toBeNull();
    const after = scoreRuns(
      l,
      [run('p05', { candidates: [c('Persian ceramics', { verifier: 'yes' }), c('Iznik pottery', { verifier: 'no', certainty: 0.35 })] })],
      thresholds,
      'live',
    );
    const m = after.splits.tune!.metrics;
    // Still published (the verifier never removes a claim), so M2 does not move ...
    expect(m.M2).toBe(before.splits.tune!.metrics.M2);
    expect(m.forbidden_published).toBe(1);
    // ... but it is contested, and the expected claim it confirmed still covers the photo.
    expect(m.verifier_checked).toBe(2);
    expect(m.forbidden_uncontested).toBe(0);
    expect(m.M5_uncontested).toBe(1);
    const denied = scoreRuns(l, [run('p05', { candidates: [c('Persian ceramics', { verifier: 'no' })] })], thresholds, 'live');
    expect(denied.splits.tune!.metrics.M5).toBe(1);
    expect(denied.splits.tune!.metrics.M5_uncontested).toBe(0);
    for (const k of ['forbidden_published', 'verifier_checked', 'forbidden_uncontested', 'M5_uncontested', 'text_only'])
      expect(Object.keys(thresholds.live)).not.toContain(k);
  });

  it('counts text-only references and scores them like any published name', async () => {
    const { thresholds } = await loadThresholds(thresholdsFile);
    const l = new Map<string, PhotoLabel>([
      ['p13', label('p13', { acceptable: [{ name: 'NBA', aliases: [], pattern: '^nba$', type: 'brand', requires_text: 'NBA', generic: false }] })],
    ]);
    const nba = c('NBA', { type: 'brand', evidence: 'read_text', evidence_text: 'NBA', text_only: true });
    const card = scoreRuns(l, [run('p13', { candidates: [nba], visible_text: ['NBA'] })], thresholds, 'live');
    expect(card.splits.tune!.metrics.text_only).toBe(1);
    expect(card.rows[0]!.statuses.acceptable).toBe(1);
    expect(card.splits.tune!.metrics.M7).toBe(1);
    // Without the text, a text-only brand is a brand without text like any other (M1).
    expect(scoreRuns(l, [run('p13', { candidates: [nba] })], thresholds, 'live').splits.tune!.metrics.M1).toBe(1);
  });
});
