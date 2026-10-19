import { describe, expect, it } from 'vitest';
import {
  GUARDRAIL_VERSION,
  NEUTRAL_TITLE,
  brandCorroboratedIds,
  brandHeadToken,
  categoriesFor,
  domainOf,
  guardEnrichment,
  guardQuickRead,
  isBrandLike,
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
    expect(GUARDRAIL_VERSION).toBe('guard-v1');
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

  it('applies to the published reading', () => {
    const g = guardQuickRead(
      reading([], { visible_text: [{ text: 'Small white placards mounted on the walls', region_id: null }, { text: 'NBA', region_id: null }] }),
      { twoStage: true },
    );
    expect(g.analysis.visible_text.map((t) => t.text)).toEqual(['NBA']);
    expect(g.dropped).toEqual({ visibleText: 1, observations: 0 });
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
    expect(names(g.analysis.candidates)).toEqual(['Fixture Author']);
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
    expect(brandHeadToken('Red bicycle')).toBe('red');
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
    const g = quick([v2({ name: 'Road cycling', type: 'tradition', certainty: 0.6, tag_query: 'road cycling', domain: 'sport' })]);
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
    expect(s2.dropped).toEqual({ visibleText: 1, observations: 1 });
  });
});

describe('G-CATEGORY (server-side table)', () => {
  it('maps domains to categories; architecture, crafts, places, vehicles and sport get none', () => {
    const cat = (domain: VlmCandidate['domain'], type: VlmCandidate['type'] = 'style') => categoriesFor({ name: 'x', type, tag_queries: [], domain });
    expect(cat('fashion')).toEqual(['wear']);
    expect(cat('music')).toEqual(['play']);
    expect(cat('film')).toEqual(['watch']);
    expect(cat('food')).toEqual(['eat']);
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
