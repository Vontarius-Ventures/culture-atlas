import { afterAll, describe, expect, it } from 'vitest';
import { captures, isEatReference, type ServiceContext } from '@culture-atlas/domain';
import { closeTestDb, getTestDb } from '@culture-atlas/domain/testing';
import { VlmAnalysis, type QlooEntity, type QlooTag } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { legacyAnonCtx as anonCtx, runJobs, testJpeg, world } from './test-world';

/**
 * Eat dish ideas come only from references G-CATEGORY placed in Eat
 * (review finding: any resolved place or tradition used to drive them, so a
 * basketball hoop produced dishes). The readings and Qloo results are
 * hand-written FIXTURES; nothing here is provider output.
 */
const db = getTestDb();
afterAll(closeTestDb);

const ent = (id: string, name: string, type: string, extra: Partial<QlooEntity> = {}): QlooEntity => ({ entity_id: id, name, types: [type], properties: {}, tags: [], ...extra });

function reading(title: string, candidates: Record<string, unknown>[]): VlmAnalysis {
  return VlmAnalysis.parse({
    title,
    interpretation: `${title}.`,
    observations: [],
    visible_text: [],
    candidates: candidates.map((c, i) => ({
      id: `c${i + 1}`,
      rationale: 'fixture',
      region_ids: [],
      suggested_categories: [],
      tag_queries: [],
      ...c,
    })),
    regions: [],
    uncertainty: { overall: 'low', notes: [] },
    competing_subjects: [],
    quality: { usable: true, issue: null },
  });
}

const qloo = () =>
  new FakeQloo(
    {
      search: (query) =>
        query === 'Fixture Harbour City'
          ? [ent('FIXTURE-PLACE-0901', 'Fixture Harbour City', 'urn:entity:locality', { popularity: 0.7, properties: { geocode: { city: 'Fixture Harbour City', country_code: 'FX' } } })]
          : [],
      tags: (query): QlooTag[] =>
        query === 'streetball'
          ? [{ id: 'urn:tag:style:qloo:fixture_streetball', name: 'Streetball', type: 'urn:tag:style:qloo' }]
          : query === 'Sichuan'
            ? [{ id: 'urn:tag:cuisine:qloo:fixture_sichuan', name: 'Sichuan', type: 'urn:tag:cuisine:qloo' }]
            : [],
      insights: () => ({ entities: [], tags: [] }),
    },
    { live: true },
  );

async function analyse(analysis: VlmAnalysis) {
  const { providers } = world({ vlm: analysis, overrides: { qloo: qloo() } });
  const ctx: ServiceContext = await anonCtx(providers);
  const { capture_id, job_id } = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
  await runJobs(ctx, [job_id]);
  const { rows: refs } = await db.query<{ name: string; resolution_status: string }>(
    `SELECT cr.canonical_name AS name, cref.resolution_status FROM capture_references cref
       JOIN cultural_references cr ON cr.id = cref.reference_id JOIN analyses a ON a.id = cref.analysis_id WHERE a.capture_id = $1`,
    [capture_id],
  );
  const { rows: dish } = await db.query<{ request: { references: string[] } }>(
    `SELECT pq.sanitized_request AS request FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id WHERE a.capture_id = $1 AND pq.operation = 'dish_ideas'`,
    [capture_id],
  );
  const { rows: section } = await db.query<{ status: string }>(
    `SELECT s.value AS status FROM analyses a, jsonb_each_text(a.section_statuses) s WHERE a.capture_id = $1 AND s.key = 'eat'`,
    [capture_id],
  );
  return { refs, dish, eat: section[0]?.status };
}

describe('Eat dish ideas (G-CATEGORY, review finding on supportedFoodReferences)', () => {
  it('a resolved sport tradition and a place read on a sign never drive dish ideas', async () => {
    const out = await analyse(
      reading('Basketball hoop on an outdoor court', [
        { name: 'Streetball', type: 'tradition', relation: 'resembles', certainty: 0.7, domain: 'sport', evidence: 'context', evidence_text: null, tag_queries: ['streetball'] },
        { name: 'Fixture Harbour City', type: 'place', relation: 'depicted', certainty: 0.8, domain: 'place', evidence: 'read_text', evidence_text: 'FIXTURE HARBOUR CITY COURTS' },
      ]),
    );
    // Both resolved through Qloo (the old filter took any resolved place or tradition)...
    expect(out.refs.map((r) => [r.name, r.resolution_status]).sort()).toEqual([
      ['Fixture Harbour City', 'resolved'],
      ['Streetball', 'resolved'],
    ]);
    // ...but neither is an Eat reference, so the composer is never asked for dishes.
    expect(out.dish).toEqual([]);
    expect(out.eat).toBe('skipped');
  });

  it('a cuisine with food in the photo still drives dish ideas', async () => {
    const out = await analyse(
      reading('Bowl of noodles with chili oil', [
        { name: 'Sichuan cuisine', type: 'cuisine', relation: 'resembles', certainty: 0.7, domain: 'food', evidence: 'distinctive_form', evidence_text: null, tag_queries: ['Sichuan'] },
      ]),
    );
    expect(out.dish).toHaveLength(1);
    expect(out.dish[0]!.request.references).toEqual(['Sichuan']);
  });

  it('isEatReference: only the eat category or a cuisine', () => {
    expect(isEatReference({ type: 'tradition', suggestedCategories: [] })).toBe(false);
    expect(isEatReference({ type: 'place', suggestedCategories: [] })).toBe(false);
    expect(isEatReference({ type: 'tradition', suggestedCategories: ['eat'] })).toBe(true);
    expect(isEatReference({ type: 'cuisine', suggestedCategories: [] })).toBe(true);
  });
});
