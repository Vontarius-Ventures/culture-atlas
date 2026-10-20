import { describe, expect, it } from 'vitest';
import {
  GUARDRAIL_VERSION,
  MEDIUM_RE,
  NEUTRAL_TITLE,
  PEOPLE_RE,
  ROLE_RE,
  brandCorroboratedIds,
  brandHeadToken,
  categoriesFor,
  domainOf,
  guardEnrichment,
  guardQuickRead,
  hasMediumWord,
  brandResidue,
  isBrandLike,
  looksLikePlate,
  sanitizeObservations,
  sanitizeVisibleText,
  stage2Request,
  type GuardDecision,
  type Stage1Guard,
} from './guardrails';
import {
  VlmAnalysis,
  mergeEnrichmentContext,
  toVlmAnalysis,
  type VlmCandidate,
  type VlmEnrichment,
  type VlmEnrichmentV2,
  type VlmQuickCandidate,
} from './types';

/*
 * One test (or more) per guardrail rule (docs/quality-plan.md §4.2). The
 * recorded phase-4 failure cases appear here rewritten as FIXTURE data: the
 * names describe the failure shape, nothing is a recorded provider output.
 */

type C = Partial<VlmCandidate> & { name: string };
function reading(candidates: C[], over: Partial<VlmAnalysis> = {}): VlmAnalysis {
  return VlmAnalysis.parse({
    title: 'A photo',
    interpretation: 'It resembles a few things.',
    observations: [],
    visible_text: [],
    candidates: candidates.map((c, i) => ({
      id: `c${i + 1}`,
      type: 'style',
      relation: 'resembles',
      rationale: '',
      certainty: 0.7,
      region_ids: [],
      suggested_categories: [],
      tag_queries: [],
      ...c,
    })),
    regions: [],
    uncertainty: { overall: 'medium', notes: [] },
    competing_subjects: [],
    quality: { usable: true, issue: null },
    ...over,
  });
}
const v2 = (c: Partial<VlmQuickCandidate> & { name: string }): VlmQuickCandidate => ({
  type: 'style',
  relation: 'resembles',
  certainty: 0.7,
  domain: 'other',
  evidence: 'context',
  evidence_text: null,
  tag_query: null,
  ...c,
});
function enrichment(over: Partial<VlmEnrichmentV2> = {}): VlmEnrichmentV2 {
  return {
    observations: [],
    visible_text: [],
    illegible_text_present: false,
    confirmed: [],
    additional_candidates: [],
    regions: [],
    uncertainty: { overall: 'medium', notes: [] },
    competing_subjects: [],
    ...over,
  };
}
const decisionFor = (decisions: GuardDecision[], name: string) => decisions.filter((d) => d.name === name).at(-1);
function stage2(g: Stage1Guard, e: VlmEnrichment) {
  const m = mergeEnrichmentContext(g.analysis, e, g.held);
  return guardEnrichment({ published: g.analysis, held: g.held, merged: m.analysis, merge: m.merge });
}
const names = (cs: readonly { name: string }[]) => cs.map((c) => c.name);

describe('guardrails module', () => {
  it('is versioned and pure: same input, same output, input never mutated', () => {
    expect(GUARDRAIL_VERSION).toBe('guard-v7');
    const a = reading([{ name: 'Still life painting' }, { name: 'Mid-century modern', tag_queries: ['mid-century modern'] }]);
    const before = structuredClone(a);
    const one = guardQuickRead(a, { twoStage: true });
    expect(guardQuickRead(a, { twoStage: true })).toEqual(one);
    expect(a).toEqual(before);
  });
});

describe('G-QUAL', () => {
  it('a blurred photo with issue set publishes nothing, even when the model said usable', () => {
    const a = reading([{ name: 'Fixture Motors Civic', type: 'brand', certainty: 0.35 }, { name: 'Fixture Motors', type: 'brand' }], {
      quality: { usable: true, issue: 'blurred' },
    });
    const g = guardQuickRead(a, { twoStage: true });
    expect(g.analysis.quality).toEqual({ usable: false, issue: 'blurred' });
    expect(g.analysis.candidates).toEqual([]);
    expect(g.held).toEqual([]);
    expect(g.demoted).toEqual([]);
    expect(g.decisions.map((d) => [d.action, d.rules])).toEqual([
      ['drop', ['G-QUAL']],
      ['drop', ['G-QUAL']],
    ]);
  });
});

describe('G-VTEXT', () => {
  it('drops descriptions of text and keeps verbatim transcriptions', () => {
    const { kept, dropped } = sanitizeVisibleText([
      'Licence plate characters are illegible due to blur',
      'Small white placards mounted on the walls and columns',
      'Script label cards beside objects on shelves',
      'Text appears to be in a foreign script',
      'NO LITTER',
      '港区 MINATO CITY',
      'Musée du LOUVRE',
      'this is a very long sentence of plain words that keeps going on and on without stopping',
      '"a long quoted motto that the sign really does carry word for word all the way through"',
    ]);
    expect(kept).toEqual(['NO LITTER', '港区 MINATO CITY', 'Musée du LOUVRE', '"a long quoted motto that the sign really does carry word for word all the way through"']);
    expect(dropped).toHaveLength(5);
  });

  it('guard-v5: drops text described as (not) legible, as a transcription note or by its script', () => {
    const { kept, dropped } = sanitizeVisibleText([
      'Fixture-script museum labels beside the objects (not legible enough to transcribe)',
      'Small labels, not legible',
      'transcription unclear',
      'MUSEUM',
      'Manuscripts',
      'Script Fixture Coffee',
    ]);
    expect(dropped).toEqual(['Fixture-script museum labels beside the objects (not legible enough to transcribe)', 'Small labels, not legible', 'transcription unclear']);
    expect(kept).toEqual(['MUSEUM', 'Manuscripts', 'Script Fixture Coffee']);
  });

  it('applies to the published reading', () => {
    const g = guardQuickRead(
      reading([], { visible_text: [{ text: 'Small white placards mounted on the walls', region_id: null }, { text: 'NBA', region_id: null }] }),
      { twoStage: true },
    );
    expect(g.analysis.visible_text.map((t) => t.text)).toEqual(['NBA']);
    expect(g.dropped).toEqual({ visibleText: 1, observations: 0, subjects: 0 });
  });
});

describe('G-PERSON-OBS', () => {
  it('drops hair, face, age, body and expression descriptions, keeps clothing', () => {
    const obs = [
      { id: 'o1', text: 'The man in front has a shaved head and is shouting', kind: 'person_style' as const, region_ids: [] },
      { id: 'o2', text: 'The man behind has gray hair and a serious expression', kind: 'object' as const, region_ids: [] },
      { id: 'o3', text: 'Two men wear dark suits with white collared shirts', kind: 'garment' as const, region_ids: [] },
      { id: 'o4', text: 'The man on the left leans forward and points, with his mouth open mid-gesture.', kind: 'other' as const, region_ids: [] },
    ];
    const { kept, dropped } = sanitizeObservations(obs);
    expect(kept.map((o) => o.id)).toEqual(['o3']);
    expect(dropped.map((o) => o.id)).toEqual(['o1', 'o2', 'o4']);
  });
});

describe('G-MEDIUM', () => {
  it('drops "still life" candidates and rewrites the title and interpretation', () => {
    const a = reading(
      [
        { name: 'Still life painting', tag_queries: ['still life'] },
        { name: 'Fixture fruit tradition', type: 'tradition', tag_queries: ['still life'] },
        { name: 'Citrus market culture', type: 'tradition', tag_queries: ['citrus market'] },
      ],
      {
        title: 'Citrus and kiwi still life',
        interpretation: 'The photo resembles a still life of sliced orange and kiwi.',
      },
    );
    const g = guardQuickRead(a, { twoStage: true });
    expect(names(g.analysis.candidates)).toEqual(['Citrus market culture']);
    expect(decisionFor(g.decisions, 'Still life painting')).toMatchObject({ action: 'drop', rules: ['G-MEDIUM'] });
    expect(decisionFor(g.decisions, 'Fixture fruit tradition')).toMatchObject({ action: 'drop', rules: ['G-MEDIUM'] });
    expect(g.analysis.title).toBe('Citrus and kiwi');
    expect(g.analysis.interpretation).toBe('The photo resembles sliced orange and kiwi.');
    expect(g.titleChanged).toBe(true);
  });

  it('falls back to the top publishable name, then to a neutral title', () => {
    const one = guardQuickRead(reading([{ name: 'Wabi-sabi', tag_queries: ['wabi sabi'] }], { title: 'Still life' }), { twoStage: true });
    expect(one.analysis.title).toBe('Wabi-sabi');
    const none = guardQuickRead(reading([], { title: 'A painting' }), { twoStage: true });
    expect(none.analysis.title).toBe(NEUTRAL_TITLE);
  });

  it('keeps an artwork identified by a legible label', () => {
    const a = reading([
      { name: 'Fixture Harbour Painting', type: 'work', evidence: 'read_text', evidence_text: 'FIXTURE HARBOUR PAINTING 1902', certainty: 0.8 },
    ]);
    const g = guardQuickRead(a, { twoStage: true });
    // Not dropped by G-MEDIUM; a work with a capital word is brand-like, so it waits for stage 2.
    expect(names(g.held)).toEqual(['Fixture Harbour Painting']);
    expect(decisionFor(g.decisions, 'Fixture Harbour Painting')!.rules).not.toContain('G-MEDIUM');
  });
});

describe('G-MEDIUM: "painted" as decoration (guard-v2)', () => {
  it('keeps "painted" on crafts, furniture, buildings, garments and vehicles, still drops it elsewhere', () => {
    const a = reading([
      { name: 'Hand-painted wooden stools', type: 'tradition', domain: 'craft', tag_queries: ['painted wooden folk furniture'], certainty: 0.6 },
      { name: 'Folk painted furniture', type: 'style', domain: 'design', tag_queries: ['folk painted furniture'], certainty: 0.6 },
      { name: 'Painted fixture scene', type: 'style', domain: 'art', tag_queries: ['painted scene'], certainty: 0.6 },
      { name: 'Fixture still life', type: 'style', domain: 'craft', tag_queries: ['still life'], certainty: 0.6 },
    ]);
    const g = guardQuickRead(a, { twoStage: true });
    expect(names(g.analysis.candidates)).toEqual(['Hand-painted wooden stools', 'Folk painted furniture']);
    expect(decisionFor(g.decisions, 'Painted fixture scene')).toMatchObject({ action: 'drop', rules: ['G-MEDIUM'] });
    // Only "painted" is decoration: every other medium word still applies in a decorative domain.
    expect(decisionFor(g.decisions, 'Fixture still life')).toMatchObject({ action: 'drop', rules: ['G-MEDIUM'] });
    expect(hasMediumWord('Painted tiles', 'architecture')).toBe(false);
    expect(hasMediumWord('Painted tiles', null)).toBe(true);
    expect(hasMediumWord('Painted tile drawing', 'craft')).toBe(true);
  });
});

describe('G-PERSON-ROLE', () => {
  it('drops "Football coaching" on a photo of people, keeps it without people', () => {
    const people = reading([{ name: 'Football coaching', tag_queries: ['football'] }, { name: 'Formal menswear', tag_queries: ['formal menswear'] }], {
      title: 'Two men in dark suits',
    });
    const g = guardQuickRead(people, { twoStage: true });
    expect(names(g.analysis.candidates)).toEqual(['Formal menswear']);
    expect(g.decisions[0]).toEqual({ candidateId: 'c1', name: '[withheld]', action: 'drop', rules: ['G-PERSON-ROLE'] });
    const empty = guardQuickRead(reading([{ name: 'Football coaching', tag_queries: ['football'] }], { title: 'An empty pitch' }), { twoStage: true });
    expect(names(empty.analysis.candidates)).toEqual(['Football coaching']);
  });

  it('counts person_style observations as people in the photo', () => {
    const g = guardQuickRead(
      reading([{ name: 'Sideline coaching', tag_queries: ['coaching'] }], {
        observations: [{ id: 'o1', text: 'Dark suit and tie', kind: 'person_style', region_ids: [] }],
      }),
      { twoStage: true },
    );
    expect(g.analysis.candidates).toEqual([]);
  });
});

describe('G-IDENTITY', () => {
  it('drops a creator or person unless the name is read in the photo, and withholds the name', () => {
    const g = guardQuickRead(
      reading([
        { name: 'Fixture Person', type: 'creator', certainty: 0.9 },
        { name: 'Someone', type: 'style', domain: 'people', certainty: 0.9 },
        { name: 'Fixture Author', type: 'creator', certainty: 0.9, evidence: 'read_text', evidence_text: 'by FIXTURE AUTHOR' },
      ]),
      { twoStage: true },
    );
    expect(g.decisions.slice(0, 2).map((d) => [d.name, d.rules])).toEqual([
      ['[withheld]', ['G-IDENTITY']],
      ['[withheld]', ['G-IDENTITY']],
    ]);
    // guard-v3: a name read only in the model's own evidence_text is held for a stage-2 transcription.
    expect(g.analysis.candidates).toEqual([]);
    expect(names(g.held)).toEqual(['Fixture Author']);
  });
});

describe('G-STYLE-OF', () => {
  it('replaces "Eames-style lounge chair" by its tag query as a style, and drops it without one', () => {
    const g = guardQuickRead(
      reading([
        { name: 'Eames-style lounge chair', type: 'object', certainty: 0.6, tag_queries: ['mid-century modern'] },
        { name: 'Shaker-inspired cabinet', type: 'object', certainty: 0.6 },
      ]),
      { twoStage: true },
    );
    expect(g.analysis.candidates.map((c) => [c.name, c.type, c.relation])).toEqual([['mid-century modern', 'style', 'resembles']]);
    expect(g.decisions.map((d) => [d.name, d.action, d.rules])).toEqual([
      ['Eames-style lounge chair', 'drop', ['G-STYLE-OF']],
      ['mid-century modern', 'publish', ['G-CATEGORY']],
      ['Shaker-inspired cabinet', 'drop', ['G-STYLE-OF']],
    ]);
  });
});

describe('G-STYLE-OF keeps bare style names', () => {
  it('"Empire style" is a style, not an "X-style object"', () => {
    const g = guardQuickRead(reading([{ name: 'Empire style', tag_queries: ['empire'] }, { name: 'Eames style chair', type: 'object', tag_queries: ['mid-century modern'] }]), {
      twoStage: true,
    });
    expect(names(g.analysis.candidates)).toEqual(['Empire style', 'mid-century modern']);
  });
});

describe('G-CUISINE-FOOD', () => {
  it('drops "Spanish cuisine" on a street photo with no food', () => {
    const g = guardQuickRead(
      reading([{ name: 'Spanish cuisine', type: 'cuisine', certainty: 0.3 }, { name: 'Jazz Age Fare', type: 'tradition', certainty: 0.6 }], {
        title: 'Blue electric bus on a city street',
        interpretation: 'A city street scene with a bus.',
      }),
      { twoStage: true },
    );
    expect(g.analysis.candidates).toEqual([]);
    expect(g.decisions.map((d) => d.rules)).toEqual([['G-CUISINE-FOOD'], ['G-CUISINE-FOOD']]);
  });

  it('keeps dan dan noodles with Sichuan cuisine when the reading shows food', () => {
    const g = guardQuickRead(
      toVlmAnalysis({
        title: 'Sesame noodle supper',
        interpretation: 'A bowl of noodles that resembles a Sichuan street-food supper.',
        candidates: [
          v2({ name: 'Dan dan noodles', type: 'cuisine', domain: 'food', certainty: 0.8, tag_query: 'Sichuan cuisine' }),
          v2({ name: 'Sichuan cuisine', type: 'cuisine', domain: 'food', certainty: 0.6, tag_query: 'Sichuan' }),
        ],
        quality: { usable: true, issue: null },
      }),
      { twoStage: true },
    );
    expect(g.analysis.candidates.map((c) => [c.name, c.suggested_categories])).toEqual([
      ['Dan dan noodles', ['eat']],
      ['Sichuan cuisine', ['eat']],
    ]);
  });

  it('accepts another candidate showing depicted food as evidence', () => {
    const g = guardQuickRead(
      reading(
        [
          { name: 'Fixture ramen bowl', type: 'object', relation: 'depicted', evidence: 'distinctive_form', domain: 'food', certainty: 0.9 },
          { name: 'Hakata cuisine', type: 'cuisine', certainty: 0.6, tag_queries: ['hakata'] },
        ],
        { title: 'A counter seat', interpretation: 'A quiet counter.' },
      ),
      { twoStage: true },
    );
    expect(names(g.analysis.candidates)).toContain('Hakata cuisine');
  });
});

describe('G-VTEXT plates (guard-v2)', () => {
  it('drops a plate-shaped transcription on a reading that shows a vehicle, and only there', () => {
    expect(['RK 492 AU', 'AB12 CDE', 'B-XY 1234', 'KA01AB1234'].every(looksLikePlate)).toBe(true);
    expect(['CAAD8', 'NBA', 'M-15', 'EMT MADRID', 'M1 Sol-Sevilla', '88', 'HO HUNG KEE', 'PLAY! EAT! DRINK MATE!'].some(looksLikePlate)).toBe(false);
    expect(sanitizeVisibleText(['CITROËN', 'RK 492 AU'], { vehicle: true })).toEqual({ kept: ['CITROËN'], dropped: ['RK 492 AU'] });
    expect(sanitizeVisibleText(['CITROËN', 'RK 492 AU'])).toEqual({ kept: ['CITROËN', 'RK 492 AU'], dropped: [] });
  });

  it('applies at stage 2 when a candidate, the title or an observation shows a vehicle', () => {
    const g = guardQuickRead(reading([{ name: 'Fixture van', type: 'object', domain: 'vehicle', certainty: 0.8 }], { title: 'Green van parked roadside' }), { twoStage: true });
    const s2 = stage2(g, enrichment({ visible_text: ['FIXTURO', 'RK 492 AU'], observations: [{ text: 'A van parked by a kerb', kind: 'object' }] }));
    expect(s2.analysis.visible_text.map((t) => t.text)).toEqual(['FIXTURO']);
    const sign = guardQuickRead(reading([{ name: 'Fixture road sign', type: 'style', certainty: 0.8 }], { title: 'A street sign' }), { twoStage: true });
    expect(stage2(sign, enrichment({ visible_text: ['A1 2BC'] })).analysis.visible_text.map((t) => t.text)).toEqual(['A1 2BC']);
  });
});

describe('G-DEPICTED on a named place or work seen on context only (guard-v2)', () => {
  it('holds it at stage 1 and drops it as a stage-2 addition; a style is only downgraded', () => {
    const g = guardQuickRead(
      reading([
        { name: 'Fixture Road', type: 'place', relation: 'depicted', evidence: 'context', certainty: 0.6, domain: 'place' },
        { name: 'Fixture neon style', type: 'style', relation: 'depicted', evidence: 'context', certainty: 0.7, tag_queries: ['neon'] },
      ]),
      { twoStage: true },
    );
    expect(names(g.held)).toEqual(['Fixture Road']);
    expect(decisionFor(g.decisions, 'Fixture Road')).toMatchObject({ action: 'hold', rules: ['G-DEPICTED'] });
    expect(g.analysis.candidates.map((c) => [c.name, c.relation])).toEqual([['Fixture neon style', 'resembles']]);
    const s2 = stage2(
      g,
      enrichment({
        additional_candidates: [
          { name: 'Fixture Avenue', type: 'place', relation: 'depicted', certainty: 0.5, domain: 'place', evidence: 'context', evidence_text: null, tag_query: null, rationale: 'r' },
          { name: 'Fixture Café', type: 'place', relation: 'depicted', certainty: 0.8, domain: 'signage', evidence: 'read_text', evidence_text: 'Fixture Café', tag_query: null, rationale: 'r' },
        ],
      }),
    );
    expect(decisionFor(s2.decisions, 'Fixture Avenue')).toMatchObject({ action: 'drop', note: 'held_at_stage_2' });
    expect(decisionFor(s2.decisions, 'Fixture Road')).toMatchObject({ action: 'drop' });
    expect(names(s2.analysis.candidates)).toEqual(['Fixture neon style', 'Fixture Café']);
  });
});

describe('G-FLOOR and G-DEPICTED', () => {
  it('drops certainty below 0.25 and downgrades depicted without evidence', () => {
    const g = guardQuickRead(
      reading([
        { name: 'Fixture low', certainty: 0.2 },
        { name: 'Minato City', type: 'place', relation: 'depicted', certainty: 0.9 },
        { name: 'Fixture weak depiction', relation: 'depicted', certainty: 0.45, evidence: 'distinctive_form', tag_queries: ['x'] },
        { name: 'Musee Fixture', type: 'place', relation: 'depicted', certainty: 0.9, evidence: 'read_text', evidence_text: 'Musée FIXTURE' },
      ]),
      { twoStage: true },
    );
    expect(decisionFor(g.decisions, 'Fixture low')).toMatchObject({ action: 'drop', rules: ['G-FLOOR'] });
    expect(g.analysis.candidates.map((c) => [c.name, c.relation])).toEqual([
      ['Minato City', 'resembles'],
      ['Fixture weak depiction', 'resembles'],
      ['Musee Fixture', 'depicted'],
    ]);
  });
});

describe('G-GENERIC', () => {
  it('demotes generic objects to observations, keeps specific ones', () => {
    const g = guardQuickRead(
      reading([
        { name: 'Basketball', type: 'object', relation: 'depicted', certainty: 0.95 },
        { name: 'Paper grocery bags', type: 'object', certainty: 0.8 },
        { name: 'Kiwi fruit', type: 'cuisine', certainty: 0.6 },
        { name: 'Crystal chandelier', type: 'object', certainty: 0.5 },
        { name: 'London red double-decker bus', type: 'object', relation: 'depicted', certainty: 0.9 },
      ], { title: 'Fruit, bags and a bus' }),
      { twoStage: true },
    );
    expect(names(g.demoted)).toEqual(['Basketball', 'Paper grocery bags', 'Kiwi fruit', 'Crystal chandelier']);
    expect(names(g.analysis.candidates)).toEqual(['London red double-decker bus']);
    expect(g.analysis.observations.map((o) => [o.text, o.kind])).toEqual([
      ['Basketball', 'object'],
      ['Paper grocery bags', 'object'],
      ['Kiwi fruit', 'object'],
      ['Crystal chandelier', 'object'],
    ]);
  });
});

describe('G-GENERIC beyond objects', () => {
  it('demotes all-generic styles and traditions ("Kraft paper", "American supermarket shopping"), keeps specific ones', () => {
    const g = guardQuickRead(
      reading([
        { name: 'Kraft paper', certainty: 0.8 },
        { name: 'American supermarket shopping', type: 'tradition', certainty: 0.6 },
        { name: 'Street style', certainty: 0.6, tag_queries: ['street style'] },
        { name: 'Wabi-sabi', certainty: 0.6, tag_queries: ['wabi sabi'] },
      ]),
      { twoStage: true },
    );
    expect(names(g.demoted)).toEqual(['Kraft paper', 'American supermarket shopping']);
    expect(names(g.analysis.candidates)).toEqual(['Street style', 'Wabi-sabi']);
  });

  it('demote beats hold: a low-certainty generic thing is never sent to stage 2', () => {
    const g = guardQuickRead(reading([{ name: 'Citrus fruit', type: 'cuisine', certainty: 0.35 }], { title: 'Citrus and kiwi' }), { twoStage: true });
    expect(g.held).toEqual([]);
    expect(g.decisions[0]).toMatchObject({ action: 'demote', rules: ['G-GENERIC', 'G-LOWCERT'] });
  });
});

describe('G-BRAND', () => {
  it('holds an X-Trail-like object with no text, and drops it when no stage 2 can confirm it', () => {
    const a = reading([{ name: 'Fixturo X-Trail', type: 'object', certainty: 0.45 }]);
    expect(isBrandLike(a.candidates[0]!)).toBe(true);
    const held = guardQuickRead(a, { twoStage: true });
    expect(held.analysis.candidates).toEqual([]);
    expect(names(held.held)).toEqual(['Fixturo X-Trail']);
    expect(held.decisions[0]).toMatchObject({ action: 'hold', rules: ['G-BRAND'] });
    const single = guardQuickRead(a, { twoStage: false });
    expect(single.held).toEqual([]);
    expect(single.decisions[0]).toMatchObject({ action: 'drop', rules: ['G-BRAND'], note: 'no_stage_2' });
  });

  it('recognizes brands by type, logo evidence, maker names and capitalized model words', () => {
    expect(isBrandLike({ name: 'Fixture Brand', type: 'brand' })).toBe(true);
    expect(isBrandLike({ name: 'swoosh mark', type: 'style', evidence: 'logo' })).toBe(true);
    expect(isBrandLike({ name: 'honda sedan', type: 'object' })).toBe(true);
    expect(isBrandLike({ name: 'Spalding NBA basketball', type: 'object' })).toBe(true);
    expect(isBrandLike({ name: 'Fixture CAAD8', type: 'object' })).toBe(true);
    // Capitalized generic words do not make a brand.
    expect(isBrandLike({ name: 'London Red Double-Decker Bus', type: 'object' })).toBe(false);
    expect(isBrandLike({ name: 'Minato City ward emblem', type: 'object' })).toBe(false);
    expect(isBrandLike({ name: 'Mid-century modern', type: 'style' })).toBe(false);
  });

  it('brandHeadToken skips generic nouns and qualifiers', () => {
    expect(brandHeadToken('Spalding NBA basketball')).toBe('spalding');
    expect(brandHeadToken('Cannondale CAAD8')).toBe('cannondale');
    expect(brandHeadToken('Vintage Fixture bicycle')).toBe('fixture');
    // guard-v3: colours and materials never head a brand ("Red bicycle" names no maker).
    expect(brandHeadToken('Red bicycle')).toBeNull();
    expect(brandHeadToken('Blue Fixture Coffee cup')).toBe('fixture');
    expect(brandHeadToken('Bicycle')).toBeNull();
  });
});

describe('G-PLACE, G-TEXT-ECHO, G-LOWCERT', () => {
  it('drops an uncertain resembled place ("Lahore" at 0.3)', () => {
    const g = guardQuickRead(reading([{ name: 'Fixtureabad', type: 'place', certainty: 0.3 }]), { twoStage: true });
    expect(g.decisions[0]).toMatchObject({ action: 'drop', rules: ['G-PLACE'] });
  });

  it('holds a place whose name is not the sign text (CJK echo), then drops it on an unsupported verdict', () => {
    const g = guardQuickRead(
      toVlmAnalysis({
        title: 'Street sign',
        interpretation: 'A blue street sign.',
        candidates: [
          v2({ name: 'Yuyuan Garden', type: 'place', certainty: 0.6, evidence: 'read_text', evidence_text: '愚园路', domain: 'place' }),
          v2({ name: '愚园路', type: 'place', relation: 'depicted', certainty: 0.9, evidence: 'read_text', evidence_text: '愚园路', domain: 'place' }),
        ],
        quality: { usable: true, issue: null },
      }),
      { twoStage: true },
    );
    expect(names(g.held)).toEqual(['Yuyuan Garden']);
    expect(g.decisions[0]).toMatchObject({ action: 'hold', rules: ['G-TEXT-ECHO'] });
    expect(g.analysis.candidates.map((c) => [c.name, c.relation, c.suggested_categories])).toEqual([['愚园路', 'depicted', []]]);
    const s2 = stage2(
      g,
      enrichment({
        visible_text: ['愚园路', 'Yuyuan Rd.'],
        confirmed: [
          { name: 'Yuyuan Garden', rationale: 'The sign names the road, not the garden', verdict: 'unsupported' },
          { name: '愚园路', rationale: 'The sign reads it', verdict: 'supported' },
        ],
      }),
    );
    expect(s2.publishNow).toEqual([]);
    expect(decisionFor(s2.decisions, 'Yuyuan Garden')).toMatchObject({ action: 'drop', rules: ['G-VERDICT'], note: 'unsupported' });
  });

  it('holds a style read off a sign ("Art Deco" from "LES ARTS DECORATIFS") and a low-certainty resemblance', () => {
    const g = guardQuickRead(
      toVlmAnalysis({
        title: 'Paris signs',
        interpretation: 'Directional signs near a museum.',
        candidates: [
          v2({ name: 'Art Deco', type: 'style', certainty: 0.6, evidence: 'read_text', evidence_text: 'LES ARTS DÉCORATIFS', tag_query: 'art deco', domain: 'design' }),
          v2({ name: 'Les Arts Décoratifs', type: 'place', relation: 'depicted', certainty: 0.9, evidence: 'read_text', evidence_text: 'LES ARTS DÉCORATIFS', domain: 'place' }),
          v2({ name: 'Haussmannian architecture', type: 'style', certainty: 0.35, tag_query: 'haussmannian', domain: 'architecture' }),
        ],
        quality: { usable: true, issue: null },
      }),
      { twoStage: true },
    );
    expect(g.decisions.map((d) => [d.name, d.action, d.rules])).toEqual([
      ['Art Deco', 'hold', ['G-TEXT-ECHO']],
      ['Les Arts Décoratifs', 'publish', ['G-CATEGORY']],
      ['Haussmannian architecture', 'hold', ['G-LOWCERT']],
    ]);
  });
});

describe('stage 2: G-VERDICT and G-BRAND-CORROBORATE', () => {
  const quick = (cands: VlmQuickCandidate[]) =>
    guardQuickRead(
      toVlmAnalysis({ title: 'Bike on a porch', interpretation: 'A red road bike beside a dog.', candidates: cands, quality: { usable: true, issue: null } }),
      { twoStage: true },
    );

  it('publishes a held brand when stage 2 reads it (Cannondale with "CANNONDALE"), as read text', () => {
    const g = quick([v2({ name: 'Cannondale', type: 'brand', certainty: 0.6, domain: 'vehicle' })]);
    expect(names(g.held)).toEqual(['Cannondale']);
    const s2 = stage2(g, enrichment({ visible_text: ['CANNONDALE'], confirmed: [{ name: 'Cannondale', rationale: 'Legible frame lettering', verdict: 'supported' }] }));
    expect(s2.publishNow.map((c) => [c.name, c.relation, c.evidence, c.evidence_text, c.suggested_categories])).toEqual([
      ['Cannondale', 'depicted', 'read_text', 'CANNONDALE', []],
    ]);
    expect(decisionFor(s2.decisions, 'Cannondale')).toMatchObject({ action: 'publish', rules: ['G-VERDICT', 'G-BRAND-CORROBORATE', 'G-CATEGORY'] });
    expect(names(s2.analysis.candidates)).toEqual(['Cannondale']);
  });

  it('drops a held brand that stage 2 "supports" without reading it (X-Trail from tail lights)', () => {
    const g = quick([v2({ name: 'Fixturo X-Trail', type: 'object', certainty: 0.45, domain: 'vehicle' })]);
    const s2 = stage2(g, enrichment({ confirmed: [{ name: 'Fixturo X-Trail', rationale: 'Tail light design matches', verdict: 'supported' }] }));
    expect(s2.publishNow).toEqual([]);
    expect(decisionFor(s2.decisions, 'Fixturo X-Trail')).toMatchObject({ action: 'drop', rules: ['G-VERDICT', 'G-BRAND-CORROBORATE'] });
  });

  it('weak verdicts drop strong claims and publish held styles as non-anchor resemblances; no entry drops', () => {
    const g = quick([
      v2({ name: 'Spalding', type: 'brand', certainty: 0.35, domain: 'sport' }),
      v2({ name: 'Streetball', type: 'tradition', certainty: 0.3, tag_query: 'streetball', domain: 'sport' }),
      v2({ name: 'Fixture place', type: 'place', certainty: 0.6, evidence: 'read_text', evidence_text: 'OTHER WORDS', domain: 'place' }),
      v2({ name: 'Road cycling culture', type: 'tradition', certainty: 0.3, tag_query: 'road cycling', domain: 'sport' }),
    ]);
    expect(names(g.held)).toEqual(['Spalding', 'Streetball', 'Fixture place', 'Road cycling culture']);
    const s2 = stage2(
      g,
      enrichment({
        visible_text: ['SPALDING'],
        confirmed: [
          { name: 'Spalding', rationale: 'Partial mark only', verdict: 'weak' },
          { name: 'Streetball', rationale: 'Outdoor hoop', verdict: 'weak' },
          { name: 'Fixture place', rationale: 'Plausible', verdict: 'weak' },
        ],
      }),
    );
    expect(s2.publishNow.map((c) => [c.name, c.relation])).toEqual([['Streetball', 'resembles']]);
    expect(s2.nonAnchorIds).toEqual([s2.publishNow[0]!.id]);
    expect(decisionFor(s2.decisions, 'Spalding')).toMatchObject({ action: 'drop', note: 'weak' });
    expect(decisionFor(s2.decisions, 'Fixture place')).toMatchObject({ action: 'drop', note: 'weak' });
    expect(decisionFor(s2.decisions, 'Road cycling culture')).toMatchObject({ action: 'drop', note: 'no_confirmation' });
  });

  it('additions: certainty floor, brand needs its own read text plus a stage-2 transcription', () => {
    // The stage-1 reading named the maker in its title, so the stage-2 addition is not a single read (guard-v3).
    const g = guardQuickRead(
      toVlmAnalysis({
        title: 'Cannondale bike on a porch',
        interpretation: 'A red road bike beside a dog.',
        candidates: [v2({ name: 'Road cycling', type: 'tradition', certainty: 0.6, tag_query: 'road cycling', domain: 'sport' })],
        quality: { usable: true, issue: null },
      }),
      { twoStage: true },
    );
    const s2 = stage2(
      g,
      enrichment({
        visible_text: ['NBA', 'CANNONDALE'],
        additional_candidates: [
          { ...v2({ name: 'Fixture routemaster', type: 'object', certainty: 0.2 }), rationale: 'loose match' },
          { ...v2({ name: 'Spalding NBA basketball', type: 'object', relation: 'depicted', certainty: 0.6, evidence: 'read_text', evidence_text: 'NBA' }), rationale: 'NBA lettering' },
          { ...v2({ name: 'Cannondale', type: 'brand', relation: 'depicted', certainty: 0.9, evidence: 'read_text', evidence_text: 'CANNONDALE', domain: 'vehicle' }), rationale: 'Frame lettering' },
          { ...v2({ name: 'Bicycle', type: 'object', relation: 'depicted', certainty: 0.9, evidence: 'distinctive_form' }), rationale: 'Drop bars' },
        ],
      }),
    );
    expect(decisionFor(s2.decisions, 'Fixture routemaster')).toMatchObject({ action: 'drop', rules: ['G-FLOOR'] });
    expect(decisionFor(s2.decisions, 'Spalding NBA basketball')).toMatchObject({ action: 'drop', note: 'not_read_at_stage_2' });
    expect(decisionFor(s2.decisions, 'Bicycle')).toMatchObject({ action: 'demote', rules: ['G-GENERIC'] });
    expect(names(s2.publishNow)).toEqual(['Cannondale']);
    expect(names(s2.analysis.candidates)).toEqual(['Road cycling', 'Cannondale']);
    expect(s2.analysis.observations.map((o) => o.text)).toEqual(['Bicycle']);
  });

  it('G-ADDITION-FLOOR drops additions below 0.5', () => {
    const g = quick([]);
    const s2 = stage2(
      g,
      enrichment({ additional_candidates: [{ ...v2({ name: 'Kashan lustreware', type: 'tradition', certainty: 0.4, tag_query: 'kashan' }), rationale: 'glaze' }] }),
    );
    expect(s2.decisions[0]).toMatchObject({ action: 'drop', rules: ['G-ADDITION-FLOOR'] });
  });

  it('guard-v5: a place added at stage 2 on context alone is dropped; read on a sign or by its landmark form it publishes', () => {
    const g = quick([]);
    const add = (over: Partial<VlmQuickCandidate>) => ({
      ...v2({ name: 'Fixture Kok', type: 'place', certainty: 0.5, domain: 'place', evidence: 'context', ...over }),
      rationale: 'Dense neon street',
    });
    const context = stage2(g, enrichment({ additional_candidates: [add({})] }));
    expect(context.publishNow).toEqual([]);
    expect(context.decisions[0]).toMatchObject({ action: 'drop', rules: ['G-PLACE'], note: 'context_addition' });
    const read = stage2(
      g,
      enrichment({ visible_text: ['FIXTURE KOK ROAD'], additional_candidates: [add({ relation: 'depicted', certainty: 0.8, evidence: 'read_text', evidence_text: 'FIXTURE KOK ROAD' })] }),
    );
    expect(names(read.publishNow)).toEqual(['Fixture Kok']);
    const landmark = stage2(g, enrichment({ additional_candidates: [add({ name: 'Fixture Tower', certainty: 0.6, evidence: 'distinctive_form' })] }));
    expect(names(landmark.publishNow)).toEqual(['Fixture Tower']);
  });

  it('a head token shorter than three letters never corroborates', () => {
    const g = quick([v2({ name: 'HP', type: 'brand', certainty: 0.8 })]);
    const s2 = stage2(g, enrichment({ visible_text: ['HP'], confirmed: [{ name: 'HP', rationale: 'Logo', verdict: 'supported' }] }));
    expect(s2.publishNow).toEqual([]);
  });

  it('FAST-02: published candidates stay in order; unsupported ones are advisory vetoes only', () => {
    const g = quick([
      v2({ name: 'Road cycling', type: 'tradition', certainty: 0.6, tag_query: 'road cycling', domain: 'sport' }),
      v2({ name: 'Porch culture', type: 'tradition', certainty: 0.6, tag_query: 'porch', domain: 'other' }),
    ]);
    const s2 = stage2(
      g,
      enrichment({
        confirmed: [
          { name: 'Road cycling', rationale: 'Drop bars', verdict: 'supported' },
          { name: 'Porch culture', rationale: 'Not shown', verdict: 'unsupported' },
        ],
      }),
    );
    expect(names(s2.analysis.candidates)).toEqual(['Road cycling', 'Porch culture']);
    expect(s2.advisoryVetoes).toEqual(['Porch culture']);
    // The merge's advisory certainty factor applies; the card is never removed.
    expect(s2.analysis.candidates[1]!.certainty).toBe(0.3);
  });

  it('nothing held or added publishes when the photo failed G-QUAL', () => {
    const g = guardQuickRead(reading([{ name: 'Fixture', type: 'brand' }], { quality: { usable: false, issue: 'too_dark' } }), { twoStage: true });
    const s2 = stage2(g, enrichment({ additional_candidates: [{ ...v2({ name: 'Wabi-sabi', certainty: 0.9, tag_query: 'wabi sabi' }), rationale: 'x' }] }));
    expect(s2.publishNow).toEqual([]);
    expect(s2.decisions.map((d) => d.rules)).toEqual([['G-QUAL']]);
  });

  it('stage-2 visible text and observations are sanitized too', () => {
    const g = quick([]);
    const s2 = stage2(
      g,
      enrichment({
        visible_text: ['Licence plate characters are illegible due to blur', 'OPEN'],
        observations: [{ text: 'A man with gray hair', kind: 'person_style' }, { text: 'Red road bike', kind: 'object' }],
      }),
    );
    expect(s2.analysis.visible_text.map((t) => t.text)).toEqual(['OPEN']);
    expect(s2.analysis.observations.map((o) => o.text)).toEqual(['Red road bike']);
    expect(s2.dropped).toEqual({ visibleText: 1, observations: 1, subjects: 0 });
  });
});

describe('G-CATEGORY (server-side table)', () => {
  it('maps domains to categories; architecture, crafts, places, vehicles and sport get none', () => {
    // Names whose own words name the domain (guard-v3 requires that, or a reading that shows it).
    const cat = (domain: VlmCandidate['domain'], type: VlmCandidate['type'] = 'style', name = 'x') => categoriesFor({ name, type, tag_queries: [], domain });
    expect(cat('fashion', 'style', 'Denim workwear')).toEqual(['wear']);
    expect(cat('music', 'style', 'Cool jazz')).toEqual(['play']);
    expect(cat('film', 'style', 'Film noir')).toEqual(['watch']);
    expect(cat('food', 'style', 'Dim sum')).toEqual(['eat']);
    expect(cat('other', 'cuisine')).toEqual(['eat']);
    for (const d of ['architecture', 'interior', 'design', 'craft', 'art', 'vehicle', 'sport', 'place', 'signage', 'people', 'other'] as const)
      expect(cat(d)).toEqual([]);
  });

  it('ignores the model categories: Mughal architecture under "watch" gets none', () => {
    const g = guardQuickRead(
      reading([{ name: 'Mughal architecture', certainty: 0.7, suggested_categories: ['watch'], tag_queries: ['Mughal architecture'] }]),
      { twoStage: true },
    );
    expect(g.analysis.candidates[0]!.suggested_categories).toEqual([]);
    expect(g.analysis.candidates[0]!.domain).toBe('other');
  });

  it('infers the domain of legacy candidates from the lexicons (§4.4)', () => {
    const d = (name: string, type: VlmCandidate['type'] = 'style', tag_queries: string[] = []) => domainOf({ name, type, tag_queries });
    expect(d('Shearling coat', 'style', ['shearling outerwear'])).toBe('fashion');
    expect(d('Bossa nova')).toBe('music');
    expect(d('Film noir')).toBe('film');
    expect(d('Italian aperitivo culture', 'tradition')).toBe('food');
    expect(d('Nikkei', 'cuisine')).toBe('food');
    expect(d('Mid-century modern')).toBe('other');
    expect(d('Streetball', 'tradition')).toBe('other');
    expect(d('Fixture Denim Co', 'brand')).toBe('fashion');
  });
});

describe('legacy (v1) compatibility', () => {
  it('infers read_text evidence from the reading\'s visible text', () => {
    const g = guardQuickRead(
      reading([{ name: 'Musée du Louvre', type: 'place', relation: 'depicted', certainty: 0.95 }], {
        visible_text: [{ text: 'Musée du LOUVRE', region_id: null }],
      }),
      { twoStage: false },
    );
    expect(g.analysis.candidates[0]).toMatchObject({ relation: 'depicted', evidence: 'read_text', evidence_text: 'Musée du LOUVRE' });
  });

  it('takes the transcription that names the head word as evidence text', () => {
    const g = guardQuickRead(
      reading([{ name: 'Théâtre du Palais-Royal', type: 'place', relation: 'depicted', certainty: 0.85 }], {
        visible_text: [
          { text: 'Palais du LOUVRE', region_id: null },
          { text: 'Théâtre du PALAIS-ROYAL', region_id: null },
        ],
      }),
      { twoStage: false },
    );
    expect(g.analysis.candidates[0]).toMatchObject({ relation: 'depicted', evidence_text: 'Théâtre du PALAIS-ROYAL' });
  });

  it('maps keep=false to unsupported and a hedged keep=true to weak', () => {
    const g = guardQuickRead(
      toVlmAnalysis({
        title: 'Ball through a hoop',
        interpretation: 'A ball dropping through a hoop.',
        candidates: [
          { name: 'Spalding', type: 'brand', relation: 'resembles', certainty: 0.35, categories: ['wear'], tag_query: null },
          { name: 'Streetball', type: 'tradition', relation: 'resembles', certainty: 0.35, categories: ['play'], tag_query: 'streetball' },
        ],
        quality: { usable: true, issue: null },
      }),
      { twoStage: true },
    );
    const s2 = stage2(g, {
      observations: [],
      visible_text: ['NBA'],
      confirmed: [
        { name: 'Spalding', rationale: 'Partial mark, but it is not clearly legible.', keep: true },
        { name: 'Streetball', rationale: 'Outdoor hoop and backboard.', keep: true },
      ],
      additional_candidates: [],
      regions: [],
      uncertainty: { overall: 'medium', notes: [] },
      competing_subjects: [],
    });
    expect(decisionFor(s2.decisions, 'Spalding')).toMatchObject({ action: 'drop', rules: ['G-VERDICT'], note: 'weak' });
    expect(s2.publishNow.map((c) => [c.name, c.suggested_categories])).toEqual([['Streetball', []]]);
  });
});

describe('shared stage-2 input and brand corroboration (used by the compiler, qualification and eval:live)', () => {
  it('stage 2 is asked about the guarded title, the published names, then the held names; dropped claims never', () => {
    const a = reading(
      [
        { name: 'Mid-century modern', tag_queries: ['mid-century modern'] },
        { name: 'Fixturedale', type: 'brand', relation: 'depicted', certainty: 0.9 },
        { name: 'Still life painting' },
      ],
      { title: 'A still life with a chair' },
    );
    const g = guardQuickRead(a, { twoStage: true });
    const req = stage2Request(g.analysis, g.held);
    expect(req.candidates).toEqual(['Mid-century modern', 'Fixturedale']);
    expect(req.title).toBe(g.analysis.title);
    expect(req.title).not.toMatch(/still life/i);
  });

  it('only a held brand whose own word stage 2 transcribed is corroborated; a shape guess is not', () => {
    const a = reading([
      { name: 'Fixturedale', type: 'brand', relation: 'depicted', certainty: 0.9 },
      { name: 'Fixturo Civic', type: 'brand', certainty: 0.4 },
      { name: 'Mid-century modern', tag_queries: ['mid-century modern'] },
    ]);
    const g = guardQuickRead(a, { twoStage: true });
    expect(brandCorroboratedIds(g.decisions).size).toBe(0);
    const s2 = stage2(
      g,
      enrichment({
        visible_text: ['FIXTUREDALE'],
        confirmed: [
          { name: 'Fixturedale', rationale: 'wordmark', verdict: 'supported' },
          { name: 'Fixturo Civic', rationale: 'shape', verdict: 'supported' },
          { name: 'Mid-century modern', rationale: 'legs', verdict: 'supported' },
        ],
      }),
    );
    const ids = brandCorroboratedIds(s2.decisions);
    const byName = new Map(s2.analysis.candidates.map((c) => [c.name, c.id]));
    expect([...ids]).toEqual([byName.get('Fixturedale')]);
    expect(byName.has('Fixturo Civic')).toBe(false);
  });
});

/*
 * guard-v3: regression tests for the review findings on guard-v2. Each case
 * is the probe from the review, rewritten as FIXTURE data where a real name
 * is not needed to show the shape (brand words are kept where the rule is a
 * word list).
 */
describe('guard-v3: G-CUISINE-FOOD and G-CATEGORY do not take the model domain on trust', () => {
  const cathedral = (cands: VlmQuickCandidate[]) =>
    guardQuickRead(
      toVlmAnalysis({ title: 'Gothic cathedral facade', interpretation: 'A stone church front with pointed arches.', candidates: cands, quality: { usable: true, issue: null } }),
      { twoStage: true },
    );

  it('drops a food-domain tradition or style on a photo with no food, not only type cuisine', () => {
    const g = cathedral([
      v2({ name: 'Mediterranean diet', type: 'tradition', domain: 'food', certainty: 0.6, tag_query: 'mediterranean diet' }),
      v2({ name: 'Fixture tea ceremony', type: 'tradition', domain: 'food', certainty: 0.6, tag_query: 'tea ceremony' }),
    ]);
    expect(g.analysis.candidates).toEqual([]);
    expect(g.decisions.map((d) => d.rules)).toEqual([['G-CUISINE-FOOD'], ['G-CUISINE-FOOD']]);
  });

  it('a domain the name contradicts is replaced by the name\'s own domain ("Bossa Nova" claimed as food plays, never eats)', () => {
    const g = cathedral([
      v2({ name: 'Bossa Nova', type: 'style', domain: 'food', certainty: 0.6, tag_query: 'bossa nova' }),
      v2({ name: 'Gothic Revival', type: 'style', domain: 'fashion', certainty: 0.6, tag_query: 'gothic revival' }),
    ]);
    expect(g.analysis.candidates.map((c) => [c.name, c.domain, c.suggested_categories])).toEqual([
      ['Bossa Nova', 'music', ['play']],
      ['Gothic Revival', 'architecture', []],
    ]);
  });

  it('a category the name does not support needs the reading to show it', () => {
    const style = { name: 'Fixture look', type: 'style' as const, tag_queries: ['fixture look'], domain: 'fashion' as const };
    expect(categoriesFor(style)).toEqual([]);
    expect(categoriesFor(style, { domains: new Set(['fashion']) })).toEqual(['wear']);
    // A coat on a person in the title shows clothing.
    const person = guardQuickRead(
      toVlmAnalysis({ title: 'Woman in a long coat', interpretation: 'A street portrait.', candidates: [v2({ name: 'Fixture look', domain: 'fashion', tag_query: 'fixture look' })], quality: { usable: true, issue: null } }),
      { twoStage: true },
    );
    expect(person.analysis.candidates[0]!.suggested_categories).toEqual(['wear']);
    const building = cathedral([v2({ name: 'Fixture look', domain: 'fashion', tag_query: 'fixture look' })]);
    expect(building.analysis.candidates[0]!.suggested_categories).toEqual([]);
  });

  it('a dish that is itself depicted with real evidence is its own food evidence', () => {
    const g = guardQuickRead(
      toVlmAnalysis({
        title: 'Steamed parcels in a bamboo basket',
        interpretation: 'A close view of a steamer.',
        candidates: [v2({ name: 'Fixturebao', type: 'object', relation: 'depicted', evidence: 'distinctive_form', certainty: 0.8, domain: 'food' })],
        quality: { usable: true, issue: null },
      }),
      { twoStage: true },
    );
    expect(g.analysis.candidates.map((c) => [c.name, c.suggested_categories])).toEqual([['Fixturebao', ['eat']]]);
  });
});

describe('guard-v3: G-BRAND beyond the closed maker list', () => {
  it('holds unlisted and everyday-word makers, model codes and numbered models at stage 1', () => {
    const g = guardQuickRead(
      toVlmAnalysis({
        title: 'A street scene',
        interpretation: 'People and vehicles.',
        candidates: [
          v2({ name: 'Trek road bike', type: 'object', relation: 'depicted', evidence: 'distinctive_form', certainty: 0.7, domain: 'sport' }),
          v2({ name: 'Mitsubishi', type: 'object', certainty: 0.6, domain: 'vehicle' }),
          v2({ name: 'Jordan 1 sneakers', type: 'object', certainty: 0.6, domain: 'fashion' }),
          v2({ name: 'Supreme streetwear', type: 'style', certainty: 0.6, domain: 'fashion', tag_query: 'supreme streetwear' }),
          v2({ name: 'Fixturo trail shoes', type: 'object', certainty: 0.6, domain: 'fashion' }),
        ],
        quality: { usable: true, issue: null },
      }),
      { twoStage: true },
    );
    expect(g.analysis.candidates).toEqual([]);
    expect(names(g.held)).toEqual(['Trek road bike', 'Mitsubishi', 'Jordan 1 sneakers', 'Supreme streetwear', 'Fixturo trail shoes']);
    for (const d of g.decisions) expect(d).toMatchObject({ action: 'hold', rules: expect.arrayContaining(['G-BRAND']) });
  });

  it('does not treat descriptions as makers', () => {
    const notBrand = [
      { name: 'Japanese streetwear', type: 'style' as const, domain: 'fashion' as const },
      { name: 'Teddy coat', type: 'object' as const, domain: 'fashion' as const },
      { name: 'Giant panda', type: 'object' as const, domain: 'other' as const },
      { name: '1950s fashion', type: 'style' as const, domain: 'fashion' as const },
      { name: '35mm film camera', type: 'object' as const, domain: 'design' as const },
      { name: 'London red double-decker bus', type: 'object' as const, domain: 'vehicle' as const },
      { name: 'Bus 88', type: 'object' as const, domain: 'vehicle' as const },
    ];
    for (const c of notBrand) expect(isBrandLike(c), c.name).toBe(false);
    // A place named in the same reading describes the product.
    expect(isBrandLike({ name: 'Fixtureville sneakers', type: 'object', domain: 'fashion' })).toBe(true);
    expect(isBrandLike({ name: 'Fixtureville sneakers', type: 'object', domain: 'fashion' }, { knownWords: new Set(['fixtureville']) })).toBe(false);
  });
});

describe('guard-v3: G-STYLE-OF replacements go through the person rules', () => {
  it('a tag query that repeats the attributed name is an identity claim, never a style', () => {
    const g = guardQuickRead(
      reading([
        { name: 'Fixturo-style outfit', type: 'style', domain: 'fashion', tag_queries: ['Fixturo West'], certainty: 0.7 },
        { name: 'Eames-style lounge chair', type: 'object', tag_queries: ['Eames'], certainty: 0.7 },
        { name: 'Shaker-style cabinet', type: 'object', tag_queries: ['Shaker'], certainty: 0.7 },
      ]),
      { twoStage: true },
    );
    expect(names(g.analysis.candidates)).toEqual(['Shaker']);
    expect(g.decisions.slice(0, 2)).toEqual([
      { candidateId: 'c1', name: '[withheld]', action: 'drop', rules: ['G-IDENTITY'], note: 'style_of_attribution' },
      { candidateId: 'c2', name: '[withheld]', action: 'drop', rules: ['G-IDENTITY'], note: 'style_of_attribution' },
    ]);
  });

  it('re-runs G-PERSON-ROLE and G-MEDIUM on the replacement', () => {
    const g = guardQuickRead(
      reading(
        [
          { name: 'Fixture-style kit', type: 'style', tag_queries: ['football coaching'], certainty: 0.7 },
          { name: 'Fixture-inspired object', type: 'object', tag_queries: ['still life'], certainty: 0.7 },
        ],
        { title: 'Two men on a pitch' },
      ),
      { twoStage: true },
    );
    expect(g.analysis.candidates).toEqual([]);
    // The role is only in the replacement's name; the medium word in a tag query already drops the original.
    expect(g.decisions.filter((d) => d.action === 'drop').map((d) => d.rules.at(-1))).toEqual(['G-STYLE-OF', 'G-PERSON-ROLE', 'G-MEDIUM']);
    expect(g.decisions[1]).toMatchObject({ name: '[withheld]', rules: ['G-PERSON-ROLE'] });
  });
});

describe('guard-v3: a person named at stage 1 waits for a stage-2 transcription', () => {
  const court = () =>
    guardQuickRead(
      toVlmAnalysis({
        title: 'Players on a court',
        interpretation: 'A game in progress.',
        candidates: [v2({ name: 'Fixture Lebrook', type: 'creator', domain: 'people', relation: 'depicted', certainty: 0.9, evidence: 'read_text', evidence_text: 'Fixture Lebrook' })],
        quality: { usable: true, issue: null },
      }),
      { twoStage: true },
    );

  it('is held, never published from its own evidence_text, and dropped without a stage 2', () => {
    const g = court();
    expect(g.analysis.candidates).toEqual([]);
    expect(g.decisions[0]).toMatchObject({ action: 'hold', rules: ['G-IDENTITY'] });
    const single = guardQuickRead(
      toVlmAnalysis({ title: 'Players on a court', interpretation: 'A game.', candidates: [v2({ name: 'Fixture Lebrook', type: 'creator', domain: 'people', certainty: 0.9, evidence: 'read_text', evidence_text: 'Fixture Lebrook' })], quality: { usable: true, issue: null } }),
      { twoStage: false },
    );
    expect(single.decisions[0]).toMatchObject({ action: 'drop', name: '[withheld]', note: 'no_stage_2' });
  });

  it('publishes only when stage 2 transcribed every word of the name', () => {
    const supported = { name: 'Fixture Lebrook', rationale: 'Jersey lettering', verdict: 'supported' as const };
    const notRead = stage2(court(), enrichment({ visible_text: ['LEBROOK'], confirmed: [supported] }));
    expect(notRead.publishNow).toEqual([]);
    expect(notRead.decisions.at(-1)).toMatchObject({ action: 'drop', name: '[withheld]', note: 'not_read_at_stage_2' });
    const read = stage2(court(), enrichment({ visible_text: ['FIXTURE LEBROOK 23'], confirmed: [supported] }));
    expect(read.publishNow.map((c) => [c.name, c.evidence, c.evidence_text])).toEqual([['Fixture Lebrook', 'read_text', 'FIXTURE LEBROOK 23']]);
  });
});

describe('guard-v5: brand residue (a model claim repeated without its maker is still a brand claim)', () => {
  const quickOf = (cands: VlmQuickCandidate[]) =>
    guardQuickRead(
      toVlmAnalysis({ title: 'An orange compact car', interpretation: 'A rounded car parked on a street.', candidates: cands, quality: { usable: true, issue: null } }),
      { twoStage: true },
    );

  it('brandResidue keeps the naming words of brand-like claims, without makers, known words and places', () => {
    const residue = brandResidue([
      { name: 'Volkswagen Fixbug', type: 'object' },
      { name: 'Lisbon tram', type: 'object' },
      { name: 'EMT Fixtura', type: 'place' },
      { name: 'Classic car', type: 'object' },
    ]);
    expect([...residue]).toEqual(['fixbug']);
    expect(isBrandLike({ name: 'Fixbug', type: 'object' })).toBe(false);
    expect(isBrandLike({ name: 'Fixbug', type: 'object' }, { brandResidue: residue })).toBe(true);
    expect(isBrandLike({ name: 'Classic car', type: 'object' }, { brandResidue: residue })).toBe(false);
    // A place is not made brand-like by the residue.
    expect(isBrandLike({ name: 'Fixbug Street', type: 'place' }, { brandResidue: residue })).toBe(false);
  });

  it('h02 shape: a stage-2 "Fixbug" next to a held "Volkswagen Fixbug" with no badge read is dropped, not published', () => {
    const g = quickOf([v2({ name: 'Volkswagen Fixbug', type: 'object', certainty: 0.55, domain: 'vehicle', evidence: 'distinctive_form' })]);
    expect(names(g.held)).toEqual(['Volkswagen Fixbug']);
    const add = { ...v2({ name: 'Fixbug', type: 'object', certainty: 0.5, domain: 'vehicle', evidence: 'distinctive_form' }), rationale: 'Rounded body' };
    const s2 = stage2(
      g,
      enrichment({ confirmed: [{ name: 'Volkswagen Fixbug', rationale: 'Shape only', verdict: 'weak' }], additional_candidates: [add] }),
    );
    expect(s2.publishNow).toEqual([]);
    expect(decisionFor(s2.decisions, 'Fixbug')).toMatchObject({ action: 'drop', rules: expect.arrayContaining(['G-BRAND-CORROBORATE']) });
  });

  it('the same addition publishes when the model name is read in the photo', () => {
    const g = quickOf([v2({ name: 'Volkswagen Fixbug', type: 'object', certainty: 0.55, domain: 'vehicle', evidence: 'distinctive_form' })]);
    const add = {
      ...v2({ name: 'Fixbug', type: 'object', relation: 'depicted', certainty: 0.85, domain: 'vehicle', evidence: 'read_text', evidence_text: 'FIXBUG' }),
      rationale: 'Badge',
    };
    const s2 = stage2(g, enrichment({ visible_text: ['FIXBUG'], confirmed: [{ name: 'Volkswagen Fixbug', rationale: 'Shape', verdict: 'weak' }], additional_candidates: [add] }));
    expect(names(s2.publishNow)).toEqual(['Fixbug']);
  });

  it('at stage 1 the residue holds a bare model name next to its make', () => {
    const g = quickOf([
      v2({ name: 'Volkswagen Fixbug', type: 'object', certainty: 0.55, domain: 'vehicle', evidence: 'distinctive_form' }),
      v2({ name: 'Fixbug styling', type: 'style', certainty: 0.7, domain: 'vehicle', evidence: 'distinctive_form', tag_query: 'rounded compact car' }),
    ]);
    expect(g.analysis.candidates).toEqual([]);
    expect(names(g.held)).toEqual(['Volkswagen Fixbug', 'Fixbug styling']);
    expect(decisionFor(g.decisions, 'Fixbug styling')!.rules).toContain('G-BRAND');
  });
});

describe('guard-v3: G-BRAND-CORROBORATE needs every brand word, from two separate readings', () => {
  const quickOf = (title: string, cands: VlmQuickCandidate[]) =>
    guardQuickRead(toVlmAnalysis({ title, interpretation: 'A shop counter.', candidates: cands, quality: { usable: true, issue: null } }), { twoStage: true });

  it('a colour word on a sign never corroborates a brand ("Blue Fixture Coffee" from "BLUE MONDAY SALE")', () => {
    const g = quickOf('A paper cup', [v2({ name: 'Blue Fixture Coffee cup', type: 'object', certainty: 0.6, domain: 'design' })]);
    expect(names(g.held)).toEqual(['Blue Fixture Coffee cup']);
    const s2 = stage2(g, enrichment({ visible_text: ['BLUE MONDAY SALE'], confirmed: [{ name: 'Blue Fixture Coffee cup', rationale: 'Cup', verdict: 'supported' }] }));
    expect(s2.publishNow).toEqual([]);
    expect(brandCorroboratedIds(s2.decisions).size).toBe(0);
    const ok = stage2(g, enrichment({ visible_text: ['BLUE FIXTURE COFFEE'], confirmed: [{ name: 'Blue Fixture Coffee cup', rationale: 'Cup', verdict: 'supported' }] }));
    expect(names(ok.publishNow)).toEqual(['Blue Fixture Coffee cup']);
  });

  it('a make read on a badge does not vouch for a model guessed from the shape', () => {
    const g = quickOf('A parked SUV', [v2({ name: 'Nissan Fixtrail', type: 'object', certainty: 0.6, domain: 'vehicle' })]);
    const conf = [{ name: 'Nissan Fixtrail', rationale: 'Badge', verdict: 'supported' as const }];
    expect(stage2(g, enrichment({ visible_text: ['NISSAN'], confirmed: conf })).publishNow).toEqual([]);
    expect(names(stage2(g, enrichment({ visible_text: ['NISSAN', 'FIXTRAIL'], confirmed: conf })).publishNow)).toEqual(['Nissan Fixtrail']);
  });

  it('a stage-2 brand addition is not confirmed by its own reply alone (guard-v4: it becomes a text-only reference)', () => {
    const add = { ...v2({ name: 'Nike Fixture Max', type: 'object', relation: 'depicted', certainty: 0.9, evidence: 'read_text', evidence_text: 'NIKE FIXTURE MAX', domain: 'fashion' }), rationale: 'Logo' };
    const alone = stage2(quickOf('Sneakers on a shelf', []), enrichment({ visible_text: ['NIKE FIXTURE MAX'], additional_candidates: [add] }));
    // Not a full reference: never brand-corroborated, so never searched in Qloo.
    expect(alone.decisions[0]).toMatchObject({ action: 'publish', note: 'single_read_text_only' });
    expect(alone.decisions[0]!.rules).toContain('G-TEXT-ONLY');
    expect(alone.textOnlyIds).toEqual([alone.publishNow[0]!.id]);
    expect(brandCorroboratedIds(alone.decisions).size).toBe(0);
    const both = stage2(quickOf('Nike Fixture Max sneakers on a shelf', []), enrichment({ visible_text: ['NIKE FIXTURE MAX'], additional_candidates: [add] }));
    expect(names(both.publishNow)).toEqual(['Nike Fixture Max']);
    expect(both.textOnlyIds).toEqual([]);
    expect(both.publishNow[0]!.text_only).toBeUndefined();
    expect(brandCorroboratedIds(both.decisions).size).toBe(1);
  });
});

/*
 * guard-v4: the text-only reference path (docs/requalification-plan.md
 * decision 2). Brand or person names that only the stage-2 reply contains
 * ("NBA", "EMT Madrid", poster credits) publish as text-only references
 * instead of being dropped as single reads, still evidence-gated.
 */
describe('guard-v4: G-TEXT-ONLY publishes stage-2-only brand and person names as text-only references', () => {
  const court = () =>
    guardQuickRead(
      toVlmAnalysis({
        title: 'An outdoor basketball hoop',
        interpretation: 'A hoop against a clear sky.',
        candidates: [v2({ name: 'Streetball', type: 'tradition', domain: 'sport', certainty: 0.7, tag_query: 'streetball' })],
        quality: { usable: true, issue: null },
      }),
      { twoStage: true },
    );
  const nba = { ...v2({ name: 'NBA', type: 'brand', relation: 'depicted', certainty: 0.8, evidence: 'logo', evidence_text: 'NBA', domain: 'sport' }), rationale: 'Logo on the backboard' };

  it('publishes a brand read only at stage 2 with every word transcribed, with the text it was read from', () => {
    const s2 = stage2(court(), enrichment({ visible_text: ['NBA'], additional_candidates: [nba] }));
    expect(names(s2.publishNow)).toEqual(['NBA']);
    const ref = s2.publishNow[0]!;
    expect(ref).toMatchObject({ text_only: true, evidence: 'read_text', evidence_text: 'NBA', suggested_categories: [], tag_queries: [] });
    expect(s2.textOnlyIds).toEqual([ref.id]);
    expect(decisionFor(s2.decisions, 'NBA')).toMatchObject({ action: 'publish', note: 'single_read_text_only' });
    expect(decisionFor(s2.decisions, 'NBA')!.rules).toEqual(expect.arrayContaining(['G-BRAND-CORROBORATE', 'G-TEXT-ONLY']));
    expect(decisionFor(s2.decisions, 'NBA')!.rules).not.toContain('G-CATEGORY');
    expect(brandCorroboratedIds(s2.decisions).has(ref.id)).toBe(false);
    // The reading itself keeps it, after the published stage-1 candidates (FAST-02).
    expect(names(s2.analysis.candidates)).toEqual(['Streetball', 'NBA']);
  });

  it('stays evidence-gated: every brand word must be in visible_text, and the claim must rest on read text or a logo', () => {
    const emt = { ...v2({ name: 'EMT Madrid', type: 'place', relation: 'depicted', certainty: 0.8, evidence: 'read_text', evidence_text: 'EMT', domain: 'vehicle' }), rationale: 'Bus livery' };
    const partly = stage2(court(), enrichment({ visible_text: ['EMT'], additional_candidates: [emt] }));
    expect(partly.publishNow).toEqual([]);
    expect(decisionFor(partly.decisions, 'EMT Madrid')).toMatchObject({ action: 'drop', note: 'not_read_at_stage_2' });
    const misread = stage2(court(), enrichment({ visible_text: ['RMT MADRID'], additional_candidates: [emt] }));
    expect(misread.publishNow).toEqual([]);
    const read = stage2(court(), enrichment({ visible_text: ['EMT MADRID'], additional_candidates: [{ ...emt, evidence_text: 'EMT MADRID' }] }));
    expect(read.publishNow.map((c) => [c.name, c.text_only, c.evidence_text])).toEqual([['EMT Madrid', true, 'EMT MADRID']]);
    // A brand the reply names on context alone is dropped even when the words appear on a sign.
    const guess = { ...nba, evidence: 'context' as const, evidence_text: null };
    expect(stage2(court(), enrichment({ visible_text: ['NBA'], additional_candidates: [guess] })).publishNow).toEqual([]);
    // Without a usable photo nothing publishes.
    const blurred = guardQuickRead(toVlmAnalysis({ title: 'A blur', interpretation: 'Blurred.', candidates: [], quality: { usable: false, issue: 'blurred' } }), { twoStage: true });
    expect(stage2(blurred, enrichment({ visible_text: ['NBA'], additional_candidates: [nba] })).publishNow).toEqual([]);
  });

  it('a held-at-stage-2 brand addition (low certainty) is still dropped, never text-only', () => {
    const low = { ...nba, relation: 'resembles' as const, certainty: 0.3 };
    const s2 = stage2(court(), enrichment({ visible_text: ['NBA'], additional_candidates: [low] }));
    expect(s2.publishNow).toEqual([]);
    expect(s2.textOnlyIds).toEqual([]);
  });

  it('a person name read only at stage 2 is a text-only reference: resembles, never a subject choice', () => {
    const poster = guardQuickRead(
      toVlmAnalysis({
        title: 'A vintage film poster',
        interpretation: 'A poster for a 1940s film.',
        candidates: [v2({ name: 'Classic Hollywood', type: 'style', domain: 'film', certainty: 0.7, tag_query: 'classic hollywood' })],
        quality: { usable: true, issue: null },
      }),
      { twoStage: true },
    );
    const credit = { ...v2({ name: 'Fixture Lebrook', type: 'creator', relation: 'depicted', certainty: 0.8, evidence: 'read_text', evidence_text: 'FIXTURE LEBROOK', domain: 'film' }), rationale: 'Credit line' };
    const s2 = stage2(
      poster,
      enrichment({
        visible_text: ['A FIXTURE LEBROOK PRODUCTION'],
        additional_candidates: [credit],
        competing_subjects: ['Fixture Lebrook', 'The poster title', 'Lebrook credit'],
      }),
    );
    expect(s2.publishNow.map((c) => [c.name, c.text_only, c.relation, c.evidence_text])).toEqual([
      ['Fixture Lebrook', true, 'resembles', 'A FIXTURE LEBROOK PRODUCTION'],
    ]);
    expect(decisionFor(s2.decisions, 'Fixture Lebrook')!.rules).toEqual(expect.arrayContaining(['G-IDENTITY', 'G-TEXT-ONLY']));
    // Never a "What caught your eye?" choice, although the name was read.
    expect(s2.analysis.competing_subjects.map((s) => s.label)).toEqual(['The poster title']);
    // Not transcribed at stage 2: dropped, and the trace never carries the name.
    const unread = stage2(poster, enrichment({ visible_text: ['A PRODUCTION'], additional_candidates: [credit] }));
    expect(unread.publishNow).toEqual([]);
    expect(unread.decisions.at(-1)).toMatchObject({ action: 'drop', name: '[withheld]', note: 'not_read_at_stage_2' });
  });

  it('a person named by both readings stays a full reference (two reads), as in guard-v3', () => {
    const poster = guardQuickRead(
      toVlmAnalysis({ title: 'A Fixture Lebrook film poster', interpretation: 'A poster.', candidates: [], quality: { usable: true, issue: null } }),
      { twoStage: true },
    );
    const credit = { ...v2({ name: 'Fixture Lebrook', type: 'creator', relation: 'depicted', certainty: 0.8, evidence: 'read_text', evidence_text: 'FIXTURE LEBROOK', domain: 'film' }), rationale: 'Credit line' };
    const s2 = stage2(poster, enrichment({ visible_text: ['FIXTURE LEBROOK'], additional_candidates: [credit] }));
    expect(s2.publishNow.map((c) => [c.name, c.text_only ?? null])).toEqual([['Fixture Lebrook', null]]);
    expect(s2.textOnlyIds).toEqual([]);
  });
});

describe('guard-v3: G-SUBJECT guards competing subjects ("What caught your eye?")', () => {
  it('drops brand guesses, person names and medium words from stage-2 competing subjects', () => {
    const g = guardQuickRead(
      toVlmAnalysis({ title: 'A street', interpretation: 'Cars and people.', candidates: [v2({ name: 'Fixture Harbour', type: 'place', certainty: 0.7, evidence: 'read_text', evidence_text: 'FIXTURE HARBOUR', relation: 'depicted', domain: 'place' })], quality: { usable: true, issue: null } }),
      { twoStage: true },
    );
    const s2 = stage2(
      g,
      enrichment({
        visible_text: ['FIXTURE HARBOUR'],
        competing_subjects: ['Nissan X-Trail', 'Fixture Lebrook', 'Still life painting'],
      }),
    );
    expect(s2.analysis.competing_subjects).toEqual([]);
    expect(s2.dropped.subjects).toBe(3);
    const ok = stage2(g, enrichment({ visible_text: ['FIXTURE HARBOUR'], competing_subjects: ['The red bicycle', 'Fixture Harbour sign', 'Turquoise glazed vessels'] }));
    expect(ok.analysis.competing_subjects.map((s) => s.label)).toEqual(['The red bicycle', 'Fixture Harbour sign', 'Turquoise glazed vessels']);
  });

  it('applies to the stage-1 (full or frame aggregate) reading too', () => {
    const g = guardQuickRead(
      reading([{ name: 'Wabi-sabi', tag_queries: ['wabi sabi'] }], {
        competing_subjects: [
          { id: 's1', label: 'Fixture Lebrook', region_ids: [] },
          { id: 's2', label: 'Ceramic bowl', region_ids: [] },
          { id: 's3', label: 'Honda Fixture', region_ids: [] },
        ],
      }),
      { twoStage: true },
    );
    expect(g.analysis.competing_subjects.map((s) => s.label)).toEqual(['Ceramic bowl']);
    expect(g.dropped.subjects).toBe(2);
  });
});

describe('guard-v3: G-MEDIUM covers artwork, prints, canvas and nature morte', () => {
  it('drops the review probe names and rewrites the title and interpretation', () => {
    const g = guardQuickRead(
      reading(
        [
          { name: 'Dutch Golden Age artwork', domain: 'art', tag_queries: ['dutch golden age'] },
          { name: 'Vanitas print', domain: 'art', tag_queries: ['vanitas'] },
          { name: 'Nature morte', domain: 'art', tag_queries: ['nature morte'] },
          { name: 'Batik print', domain: 'craft', tag_queries: ['batik'] },
        ],
        { title: 'Dutch artwork of a fruit bowl', interpretation: 'A canvas print resembling a fruit bowl on a table.' },
      ),
      { twoStage: true },
    );
    expect(names(g.analysis.candidates)).toEqual(['Batik print']);
    expect(g.analysis.title).toBe('Dutch fruit bowl');
    expect(g.analysis.interpretation).toBe('Resembling a fruit bowl on a table.');
    expect(hasMediumWord('Leopard print coat', 'fashion')).toBe(false);
    expect(hasMediumWord('Canvas sneakers', 'fashion')).toBe(false);
    expect(hasMediumWord('Fixture lithograph', 'art')).toBe(true);
  });
});

describe('guard-v6: people, roles and medium inflections (requalification round 2)', () => {
  // Failure shapes from the golden-v2 blind run (docs/quality-plan.md §16.3), rewritten as fixtures.
  const quick = (title: string, interpretation: string, candidates: VlmQuickCandidate[] = []) =>
    guardQuickRead(toVlmAnalysis({ title, interpretation, candidates, quality: { usable: true, issue: null } }), { twoStage: true });

  it('a player in the reading means people: role subjects ("main player", "background players") are dropped', () => {
    const g = quick('Fixture sport player at the baseline', 'A casual match on an outdoor court.', [
      v2({ name: 'Fixture court sport', type: 'tradition', domain: 'sport', certainty: 0.7 }),
    ]);
    const s2 = stage2(g, enrichment({ competing_subjects: ['main player', 'background players', 'Green hard court'] }));
    expect(s2.analysis.competing_subjects.map((s) => s.label)).toEqual(['Green hard court']);
    expect(s2.dropped.subjects).toBe(2);
  });

  it('athletes, spectators, crowds and other people words in the headline or observations count as people', () => {
    for (const [title, observation] of [
      ['Athletes on a running track', 'A white lane line'],
      ['A stadium stand', 'Spectators fill the upper tier'],
      ['A town square', 'Crowds gather near the fountain'],
      ['An outdoor court', 'Additional players visible in the background'],
      ['A finish line', 'A cyclist crosses the line'],
      ['A referee signals at midfield', 'Floodlights above the stand'],
    ] as const) {
      const g = guardQuickRead(
        reading([{ name: 'Team captains', tag_queries: ['captains'] }, { name: 'Night match atmosphere', tag_queries: ['stadium'] }], {
          title,
          observations: [{ id: 'o1', text: observation, kind: 'object', region_ids: [] }],
        }),
        { twoStage: true },
      );
      expect(names(g.analysis.candidates), title).toEqual(['Night match atmosphere']);
      expect(g.decisions[0], title).toMatchObject({ name: '[withheld]', action: 'drop', rules: ['G-PERSON-ROLE'] });
    }
    // The same role word on a reading without people stays (a role is only inferred about people).
    const empty = guardQuickRead(reading([{ name: 'Team captains', tag_queries: ['captains'] }], { title: 'An empty pitch at night' }), { twoStage: true });
    expect(names(empty.analysis.candidates)).toEqual(['Team captains']);
  });

  it('plural role nouns are roles: "Background players", "Referees", "Sprint coaches", "Rival goalkeepers"', () => {
    const g = guardQuickRead(
      reading(
        [
          { name: 'Background players', tag_queries: ['tennis'] },
          { name: 'Referees', tag_queries: ['refereeing'] },
          { name: 'Sprint coaches', tag_queries: ['sprinting'] },
          { name: 'Rival goalkeepers', tag_queries: ['football'] },
          { name: 'Night match atmosphere', tag_queries: ['stadium'] },
        ],
        { title: 'People playing football in a street' },
      ),
      { twoStage: true },
    );
    expect(names(g.analysis.candidates)).toEqual(['Night match atmosphere']);
    expect(g.decisions.filter((d) => d.action === 'drop').map((d) => d.rules)).toEqual([
      ['G-PERSON-ROLE'],
      ['G-PERSON-ROLE'],
      ['G-PERSON-ROLE'],
      ['G-PERSON-ROLE'],
    ]);
  });

  it('a playback device is neither people nor a role; with people in the photo a device keeps its name', () => {
    const device = guardQuickRead(
      reading([{ name: 'Record player', type: 'object', tag_queries: ['turntable'] }], {
        title: 'Vintage record player on a shelf',
        interpretation: 'A DVD player and a player piano sit beside it.',
        competing_subjects: [{ id: 's1', label: 'Record player', region_ids: [] }],
      }),
      { twoStage: true },
    );
    expect(names(device.analysis.candidates)).toEqual(['Record player']);
    expect(device.analysis.competing_subjects.map((s) => s.label)).toEqual(['Record player']);
    const people = guardQuickRead(
      reading([{ name: 'Record player', type: 'object', tag_queries: ['turntable'] }, { name: 'Bass player', tag_queries: ['bass'] }], {
        title: 'A man beside a record player',
      }),
      { twoStage: true },
    );
    expect(names(people.analysis.candidates)).toEqual(['Record player']);
  });

  it('PEOPLE_RE and ROLE_RE cover singular and plural forms and leave device and object words alone', () => {
    for (const s of ['main player', 'background players', 'athletes', 'spectators', 'a crowd', 'crowds', 'onlookers', 'two cyclists', 'a referee'])
      expect(PEOPLE_RE.test(s) || ROLE_RE.test(s), s).toBe(true);
    for (const s of ['background players', 'referees', 'umpires', 'coaches', 'athletes', 'captains', 'footballers', 'actresses', 'celebrities'])
      expect(ROLE_RE.test(s), s).toBe(true);
    for (const s of ['record player', 'CD players', 'a player piano', 'ceiling fans', 'a couple of bowls', 'kid leather gloves', 'family-style dishes'])
      expect(PEOPLE_RE.test(s) || ROLE_RE.test(s), s).toBe(false);
  });

  it('G-MEDIUM catches inflections ("photographed", "rendered", "sketched", "watercolours", "photography") in the headline', () => {
    const g = guardQuickRead(
      reading([{ name: 'British sports car', type: 'tradition', domain: 'vehicle', tag_queries: ['british sports car'] }], {
        title: 'Red roadster photographed at dusk',
        interpretation: 'It resembles a mid-century sports car photographed in a studio.',
      }),
      { twoStage: true },
    );
    expect(g.analysis.title).toBe('Red roadster at dusk');
    expect(g.analysis.interpretation).toBe('It resembles a mid-century sports car in a studio.');
    expect(g.titleChanged).toBe(true);
    for (const [title, out] of [
      ['A teapot rendered in soft light', 'A teapot in soft light'],
      ['Harbour sketched in ink', 'Harbour in ink'],
      ['Fixture harbour watercolours', 'Fixture harbour'],
      ['Street photography of a market', 'Street market'],
      ['A painterly view of a bridge', 'View of a bridge'],
    ] as const) {
      const out1 = guardQuickRead(reading([{ name: 'Wabi-sabi', tag_queries: ['wabi sabi'] }], { title }), { twoStage: true }).analysis.title;
      expect(out1, title).toBe(out);
      expect(MEDIUM_RE.test(out1), title).toBe(false);
    }
  });

  it('G-MEDIUM catches inflections in candidate names; "painted" on a craft stays decoration', () => {
    for (const name of ['Studio photography', 'Photographic print', 'Architectural renderings', 'Rendered harbour view', 'Fixture watercolours', 'Hand-drawn map', 'Gouache landscape', 'Linocut poster'])
      expect(hasMediumWord(name, 'art'), name).toBe(true);
    expect(hasMediumWord('Hand-painted wooden stools', 'craft')).toBe(false);
    expect(hasMediumWord('Painted tiles', 'architecture')).toBe(false);
    expect(hasMediumWord('Photographed tiles', 'architecture')).toBe(true);
    const g = guardQuickRead(
      reading([
        { name: 'Studio photography', type: 'style', domain: 'art', tag_queries: ['photography'] },
        { name: 'Hand-painted wooden stools', type: 'tradition', domain: 'craft', tag_queries: ['painted wooden folk furniture'] },
      ]),
      { twoStage: true },
    );
    expect(names(g.analysis.candidates)).toEqual(['Hand-painted wooden stools']);
    expect(decisionFor(g.decisions, 'Studio photography')).toMatchObject({ action: 'drop', rules: ['G-MEDIUM'] });
  });
});

describe('guard-v7: role synonyms, people words, stage-1 person observations, medium forms (round-2 review)', () => {
  const quick = (title: string, interpretation: string, candidates: VlmQuickCandidate[] = []) =>
    guardQuickRead(toVlmAnalysis({ title, interpretation, candidates, quality: { usable: true, issue: null } }), { twoStage: true });
  const ruleSets = (g: Stage1Guard) => g.decisions.map((d) => d.rules);

  it('the h28 failure with synonyms: "main striker", "background defenders", "the pitcher", refs and officials are dropped subjects', () => {
    const g = quick('Footballers contest a header', 'A match on a grass pitch.', [v2({ name: 'Fixture football', type: 'tradition', domain: 'sport' })]);
    for (const label of ['main striker', 'background defenders', 'the pitcher', 'two linesmen', 'the ref', 'match officials', 'lead driver', 'the riders', 'trailing racers', 'two boxers', 'a sportsman', 'the batswoman']) {
      const s2 = stage2(g, enrichment({ competing_subjects: [label, 'Green grass pitch'] }));
      expect(s2.analysis.competing_subjects.map((s) => s.label), label).toEqual(['Green grass pitch']);
    }
  });

  it('ROLE_RE covers the synonyms, singular and plural', () => {
    for (const s of ['striker', 'strikers', 'defender', 'defenders', 'pitcher', 'pitchers', 'ref', 'refs', 'linesman', 'linesmen', 'officials', 'match official', 'driver', 'drivers', 'rider', 'riders', 'racer', 'racers', 'boxer', 'boxers', 'sportsman', 'sportsmen', 'sportswoman', 'batswoman', 'batswomen', 'midfielders', 'goaltender', 'champions', 'officers', 'soldiers'])
      expect(ROLE_RE.test(s), s).toBe(true);
  });

  it('people words cover riders, drivers, boxers, fighters, skiers, soldiers, fans, brides and grooms, guests and the always-people roles', () => {
    for (const [title, cand] of [
      ['Riders on a cross-country course', 'Professional athletes'],
      ['Fans in a stadium', 'Team captains'],
      ['A bride and groom at the altar', 'Celebrity couple'],
      ['Skiers on a slope', 'Olympic athletes'],
      ['Two boxers in a ring', 'Heavyweight champions'],
      ['Soldiers marching in a parade', 'Military officers'],
      ['Racing drivers on the grid', 'Formula one drivers'],
      ['Guests at a long table', 'Celebrity chef'],
      ['A referee signals at midfield', 'Team captains'],
    ] as const) {
      const g = quick(title, 'A scene.', [v2({ name: cand, type: 'style', domain: 'other' })]);
      expect(names(g.analysis.candidates), title).toEqual([]);
      expect(ruleSets(g), title).toEqual([['G-PERSON-ROLE']]);
    }
    for (const s of ['riders', 'drivers', 'boxers', 'fighters', 'skiers', 'snowboarders', 'soldiers', 'fans', 'supporters', 'bride', 'groom', 'guests', 'adults', 'referees', 'footballers', 'linesmen', 'sportsmen'])
      expect(PEOPLE_RE.test(s), s).toBe(true);
    // Object forms are not people.
    for (const s of ['ceiling fans', 'a golf driver', 'boxer shorts', 'a fighter jet', 'a rider mower', 'a café racer', 'Jockey briefs'])
      expect(PEOPLE_RE.test(s), s).toBe(false);
  });

  it('a candidate named with a people word means people ("Olympic athletes" on a slope photo with no people word)', () => {
    const g = guardQuickRead(reading([{ name: 'Olympic athletes', tag_queries: ['olympics'] }, { name: 'Team captains', tag_queries: ['captains'] }], { title: 'A snowy slope at noon' }), {
      twoStage: true,
    });
    expect(names(g.analysis.candidates)).toEqual([]);
    expect(ruleSets(g)).toEqual([['G-PERSON-ROLE'], ['G-PERSON-ROLE']]);
  });

  it('stage 1 tests people on the observations before person descriptions are removed (two-stage, single pass and G-QUAL)', () => {
    const cands: C[] = [{ name: 'Team captains', tag_queries: ['captains'] }, { name: 'Celebrity chef', tag_queries: ['chef'] }, { name: 'Night match atmosphere', tag_queries: ['stadium'] }];
    for (const [kind, text] of [
      ['person_style', 'A young man with a beard'],
      ['object', 'A young player with long hair serves'],
    ] as const) {
      for (const twoStage of [true, false]) {
        const g = guardQuickRead(reading(cands, { title: 'A stadium at night', observations: [{ id: 'o1', text, kind, region_ids: [] }] }), { twoStage });
        expect(names(g.analysis.candidates), `${text} ${twoStage}`).toEqual(['Night match atmosphere']);
        expect(g.analysis.observations, text).toEqual([]);
        expect(ruleSets(g).slice(0, 2), text).toEqual([['G-PERSON-ROLE'], ['G-PERSON-ROLE']]);
      }
    }
    // An unusable photo still guards its subjects with the same people test.
    const unusable = guardQuickRead(
      reading([], {
        title: 'A blurred stadium',
        observations: [{ id: 'o1', text: 'A young man with a beard', kind: 'person_style', region_ids: [] }],
        competing_subjects: [{ id: 's1', label: 'team captain', region_ids: [] }, { id: 's2', label: 'stadium floodlights', region_ids: [] }],
        quality: { usable: false, issue: 'blurred' },
      }),
      { twoStage: true },
    );
    expect(unusable.analysis.competing_subjects.map((s) => s.label)).toEqual(['stadium floodlights']);
  });

  it('object forms of role words publish on a reading without people, and with people they are not a role', () => {
    const objects: [string, C][] = [
      ['Vintage Singer sewing machine on a table', { name: 'Singer sewing machine', type: 'object', evidence: 'read_text', evidence_text: 'SINGER', tag_queries: ['sewing machine'] }],
      ['Black bowler hat on a hook', { name: 'Bowler hat', type: 'object', domain: 'fashion', tag_queries: ['bowler hat'] }],
      ['Tempura vegetables in a light batter', { name: 'Tempura batter', type: 'cuisine', domain: 'food', tag_queries: ['tempura'] }],
      ["Wooden captain's chair in a study", { name: "Captain's chair", type: 'object', domain: 'interior', tag_queries: ["captain's chair"] }],
      ['Leather Coach bag on a table', { name: 'Coach bag', type: 'object', domain: 'fashion', tag_queries: ['leather bag'] }],
    ];
    for (const [title, cand] of objects) {
      for (const t of [title, `A woman beside it: ${title}`]) {
        const g = guardQuickRead(reading([cand], { title: t, visible_text: [{ text: 'SINGER', region_id: null }] }), { twoStage: true });
        expect(ruleSets(g).flat(), t).not.toContain('G-PERSON-ROLE');
      }
    }
    for (const s of ['Bowler hat', 'Tempura batter', "Captain's chair", 'Singer sewing machine', 'Coach handbag', 'Glass water pitcher', 'Golf driver', 'Cafe racer', 'Land Rover Defender', 'Boxer shorts', 'Rolex Submariner Ref. 5513', 'UEFA Champions League', 'Champion hoodie', 'Record player'])
      expect(ROLE_RE.test(s), s).toBe(false);
  });

  it('G-MEDIUM: engraved, etched and every hyphenation of watercolour; decoration on a craft; photographic products stay', () => {
    for (const name of ['Engraved silver plate', 'Etched portrait', 'Water-colour landscape', 'Water colour landscape', 'Fixture engraving', 'Etchings of a harbour'])
      expect(hasMediumWord(name, 'art'), name).toBe(true);
    const t = guardQuickRead(reading([{ name: 'Wabi-sabi', tag_queries: ['wabi sabi'] }], { title: 'A harbour engraved in fine lines', interpretation: 'A bridge etched in black ink.' }), {
      twoStage: true,
    });
    expect(t.analysis.title).toBe('A harbour in fine lines');
    expect(t.analysis.interpretation).toBe('A bridge in black ink.');
    expect(hasMediumWord('Engraved silver ring', 'craft')).toBe(false);
    expect(hasMediumWord('Etched glass panel', 'design')).toBe(false);
    for (const name of ['Kodak photographic film', 'Photographic paper', 'Photographic equipment'])
      expect(hasMediumWord(name, 'other'), name).toBe(false);
    // "Photographic" as the photo's medium still matches.
    expect(hasMediumWord('Photographic print', 'art')).toBe(true);
    expect(MEDIUM_RE.test('A photographic study of a harbour')).toBe(true);
    const film = guardQuickRead(
      reading([{ name: 'Kodak photographic film', type: 'object', evidence: 'read_text', evidence_text: 'Kodak', tag_queries: ['photographic film'] }], {
        title: 'Roll of 35mm film on a desk',
        visible_text: [{ text: 'Kodak', region_id: null }],
      }),
      { twoStage: true },
    );
    expect(ruleSets(film).flat()).not.toContain('G-MEDIUM');
  });
});
