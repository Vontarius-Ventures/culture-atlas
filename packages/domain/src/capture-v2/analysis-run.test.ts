import { describe, expect, it } from 'vitest';
import { checkContractEquivalence } from '@culture-atlas/providers/testing';
import {
  ArtistIdeas,
  DishIdeas as PlanDishIdeas,
  FilmIdeas,
  PlanProse,
} from '../composer/creative';
import { DishIdeas } from '../compiler/dishes';
import { verifierOptedIn } from '../config';
import { aggregateFrameReadings, publishableCitations, type FrameReading } from './analysis-run';

function reading(
  frameKey: string,
  timestampMs: number | null,
  candidates: Array<{
    name: string;
    type?: 'style' | 'brand' | 'object' | 'creator';
    evidence?: 'read_text' | 'logo' | 'distinctive_form' | 'context';
    domain?: 'design' | 'craft' | 'other';
    relation?: 'depicted' | 'resembles';
    certainty?: number;
  }>,
  extra: Partial<FrameReading['analysis']> = {},
): FrameReading {
  return {
    frameKey,
    derivativeId: timestampMs === null ? null : `d-${frameKey}`,
    timestampMs,
    model: 'fixture/model-1',
    analysis: {
      title: `Title ${frameKey}`,
      interpretation: 'Resembles something.',
      observations: [{ id: 'o1', text: `Seen in ${frameKey}`, kind: 'object', region_ids: ['r1'] }],
      visible_text: [],
      candidates: candidates.map((c, i) => ({
        id: `c${i + 1}`,
        name: c.name,
        type: c.type ?? 'style',
        relation: c.relation ?? 'resembles',
        rationale: `r-${frameKey}`,
        certainty: c.certainty ?? 0.5,
        region_ids: ['r1'],
        suggested_categories: ['wear'],
        tag_queries: [],
        ...(c.evidence ? { evidence: c.evidence, evidence_text: null } : {}),
        ...(c.domain ? { domain: c.domain } : {}),
      })),
      regions: [{ id: 'r1', label: 'x', box: { x: 0, y: 0, w: 0.5, h: 0.5 } }],
      uncertainty: { overall: 'medium', notes: [] },
      competing_subjects: [],
      quality: { usable: true, issue: null },
      ...extra,
    },
  };
}

describe('frame aggregation (sampled video)', () => {
  it('keeps a single photo reading intact, including its own regions', () => {
    const out = aggregateFrameReadings([reading('photo', null, [{ name: 'Bauhaus' }])]);
    expect(out.observation.regions).toHaveLength(1);
    expect(out.citations).toEqual([
      { name: 'Bauhaus', type: 'style', relation: 'resembles', cited_frames: [] },
    ]);
  });

  it('merges duplicates by normalized name+type, cites every frame, ranks by frames then certainty, caps candidates', () => {
    const out = aggregateFrameReadings(
      [
        reading('b', 2000, [
          { name: 'Art Deco', certainty: 0.9 },
          { name: 'Levi’s', type: 'brand' },
        ]),
        reading('a', 1000, [
          { name: 'art  deco', certainty: 0.4 },
          { name: 'Bauhaus', certainty: 0.95 },
        ]),
        reading('c', 3000, [
          { name: 'Art-Deco', relation: 'depicted', certainty: 0.2 },
          { name: 'Levi’s', type: 'style' },
        ]),
      ],
      { maxCandidates: 3 },
    );
    expect(
      out.citations.map((c) => [c.name, c.relation, c.cited_frames.map((f) => f.timestamp_ms)]),
    ).toEqual([
      ['Art Deco', 'depicted', [1000, 2000, 3000]],
      ['Bauhaus', 'resembles', [1000]],
      ['Levi’s', 'resembles', [2000]],
    ]);
    expect(out.observation.candidates.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    // Highest-certainty rationale wins; boxes are never transplanted between frames.
    expect(out.observation.candidates[0]).toMatchObject({
      certainty: 0.9,
      rationale: 'r-b',
      region_ids: [],
    });
    expect(out.observation.regions).toEqual([]);
    expect(out.observation.observations.map((o) => o.text)).toEqual([
      'Seen in a',
      'Seen in b',
      'Seen in c',
    ]);
  });

  it('is usable when any frame is usable and reports the most cautious uncertainty', () => {
    const out = aggregateFrameReadings([
      reading('a', 1000, [], {
        quality: { usable: false, issue: 'blurred' },
        uncertainty: { overall: 'high', notes: ['dark'] },
      }),
      reading('b', 2000, [{ name: 'Bauhaus' }], { uncertainty: { overall: 'low', notes: [] } }),
      reading('c', 3000, [{ name: 'Bauhaus' }], { uncertainty: { overall: 'medium', notes: [] } }),
    ]);
    expect(out.observation.quality).toEqual({ usable: true, issue: null });
    expect(out.observation.uncertainty.overall).toBe('medium');
    expect(out.displayFrameKey).toBe('b');
    expect(out.observation.title).toBe('Title b');
  });

  it('reports unusable when no frame is usable', () => {
    const out = aggregateFrameReadings([
      reading('a', 1000, [], { quality: { usable: false, issue: 'too_dark' } }),
      reading('b', 2000, [], { quality: { usable: false, issue: 'blurred' } }),
    ]);
    expect(out.observation.quality).toEqual({ usable: false, issue: 'too_dark' });
  });
});

describe('Atlas text schemas sent through the strict Concentrate transform', () => {
  it.each([
    ['film_ideas', FilmIdeas],
    ['artist_ideas', ArtistIdeas],
    ['dish_ideas (plans)', PlanDishIdeas],
    ['plan_prose', PlanProse],
    ['dish_ideas (eat)', DishIdeas],
  ])('%s: zod-valid outputs round-trip; unknown and missing keys are rejected', (_, schema) => {
    const report = checkContractEquivalence(schema, { samples: 120, seed: 11 });
    expect(report.failures).toEqual([]);
    expect(report.roundTrips).toBe(120);
  });
});

describe('media result citations (review finding: unguarded candidate names reached the owner API)', () => {
  it('lists only what the stage-1 guardrails publish; brand guesses and person names never appear', () => {
    const aggregate = aggregateFrameReadings([
      reading('a', 1000, [
        { name: 'Nissan X-Trail', type: 'object', relation: 'depicted', certainty: 0.8 },
        { name: 'Fixture Racer', type: 'creator', relation: 'depicted', certainty: 0.9 },
        { name: 'Bauhaus', certainty: 0.7 },
      ]),
      reading('b', 2000, [{ name: 'Nissan X-Trail', type: 'object', relation: 'depicted', certainty: 0.8 }]),
    ]);
    // The raw aggregate still carries every model proposal...
    expect(aggregate.citations.map((c) => c.name).sort()).toEqual(['Bauhaus', 'Fixture Racer', 'Nissan X-Trail']);
    // ...the published result only the guarded set.
    expect(publishableCitations(aggregate)).toEqual([
      { name: 'Bauhaus', type: 'style', relation: 'resembles', cited_frames: [{ frame_id: 'd-a', timestamp_ms: 1000 }] },
    ]);
  });
  it('with the verifier opted in, its targets (styles, places, traditions, context-only claims) wait for the compile job (round-3 review)', () => {
    const aggregate = aggregateFrameReadings([
      reading('a', 1000, [
        // A distinctive form: guard-v11 holds a style resting on context alone for stage 2 (asserted below).
        { name: 'Scandinavian minimalist design', type: 'style', certainty: 0.6, evidence: 'distinctive_form', domain: 'design' },
        { name: 'Fixture stoneware mug', type: 'object', relation: 'depicted', certainty: 0.8, evidence: 'distinctive_form', domain: 'craft' },
      ]),
    ]);
    const off = publishableCitations(aggregate).map((c) => c.name);
    expect(off).toEqual(['Scandinavian minimalist design', 'Fixture stoneware mug']);
    // The compiler publishes a style only on the verifier's "yes", later: the media result leaves it out.
    expect(publishableCitations(aggregate, { verifierEnabled: true }).map((c) => c.name)).toEqual(['Fixture stoneware mug']);
    expect(verifierOptedIn('true') && verifierOptedIn('1') && !verifierOptedIn(undefined) && !verifierOptedIn('false')).toBe(true);
    // guard-v11 (round 4): a style on context alone is held at stage 1, so the media result never lists it.
    const context = aggregateFrameReadings([
      reading('a', 1000, [
        { name: 'Scandinavian minimalist design', type: 'style', certainty: 0.6, evidence: 'context', domain: 'design' },
        { name: 'Fixture stoneware mug', type: 'object', relation: 'depicted', certainty: 0.8, evidence: 'distinctive_form', domain: 'craft' },
      ]),
    ]);
    expect(publishableCitations(context).map((c) => c.name)).toEqual(['Fixture stoneware mug']);
  });
});
