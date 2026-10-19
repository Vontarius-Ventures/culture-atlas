import { afterAll, describe, expect, it } from 'vitest';
import { captures, type ServiceContext } from '@culture-atlas/domain';
import { closeTestDb, getTestDb } from '@culture-atlas/domain/testing';
import { VlmAnalysis, type QlooEntity, type QlooInsightsRequest, type QlooTag } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { anonCtx, runJobs, testJpeg, world } from './test-world';

/**
 * Qloo grounding in the compiler (docs/quality-plan.md §5) on the real Worker
 * and database: which candidates reach Qloo, which results are accepted, what
 * a doubtful match is stored as, and what is recorded. The reading and every
 * Qloo result are hand-written FIXTURES shaped like the recorded live
 * failures; nothing here is provider output.
 */
const db = getTestDb();
afterAll(closeTestDb);

const ent = (id: string, name: string, type: string, extra: Partial<QlooEntity> = {}): QlooEntity => ({ entity_id: id, name, types: [type], properties: {}, tags: [], ...extra });
const candidate = (id: string, name: string, type: string, relation: 'depicted' | 'resembles', certainty: number, categories: string[], tagQueries: string[] = []) => ({
  id,
  name,
  type,
  relation,
  rationale: 'fixture',
  certainty,
  region_ids: [],
  suggested_categories: categories,
  tag_queries: tagQueries,
});

const READING = VlmAnalysis.parse({
  title: 'A bicycle by a palace',
  interpretation: 'A bicycle leans on railings in front of a neoclassical palace.',
  observations: [{ id: 'o1', text: 'Road bicycle with a white frame', kind: 'object', region_ids: [] }],
  visible_text: [{ text: 'FIXTUREDALE', region_id: null }],
  candidates: [
    candidate('c1', 'Fixturedale', 'brand', 'depicted', 0.9, ['play']), // read on the frame: searched, suffix accepted
    candidate('c2', 'Fixture Palais', 'place', 'depicted', 0.9, ['watch']), // two same-named places: doubt
    candidate('c3', 'Neoclassicism', 'style', 'resembles', 0.8, ['wear', 'watch'], ['neoclassical']), // decor, not the music genre
    candidate('c4', 'Road bicycle', 'object', 'depicted', 0.95, ['play']), // objects never reach /search
    candidate('c5', 'Fixturo Civic', 'brand', 'resembles', 0.35, ['wear']), // a make guessed from shape: not searched
  ],
  regions: [],
  uncertainty: { overall: 'medium', notes: [] },
  competing_subjects: [],
  quality: { usable: true, issue: null },
});

function groundingQloo(insightCalls: QlooInsightsRequest[]) {
  return new FakeQloo(
    {
      search: (query) => {
        if (query === 'Fixturedale') return [ent('FIXTURE-BRAND-0201', 'Fixturedale Bicycles', 'urn:entity:brand'), ent('FIXTURE-BRAND-0202', 'Fixturedale Racing Club', 'urn:entity:brand')];
        if (query === 'Fixture Palais')
          return [
            ent('FIXTURE-PLACE-0001', 'Fixture Palais', 'urn:entity:place', { popularity: 0.68, properties: { geocode: { city: 'Laval', country_code: 'FR' } } }),
            ent('FIXTURE-PLACE-0002', 'Fixture Palais', 'urn:entity:place', { popularity: 0.44, properties: { geocode: { city: 'Courbevoie', country_code: 'FR' } } }),
          ];
        // Anything else would be a look-alike: an album for a bicycle.
        return [ent('FIXTURE-ALBUM-0001', `${query} Sessions`, 'urn:entity:album')];
      },
      tags: (query, tagTypes): QlooTag[] => {
        const all: QlooTag[] = [
          { id: 'urn:tag:genre:music:fixture_neoclassical', name: 'Neoclassical', type: 'urn:tag:genre:music' },
          { id: 'urn:tag:decor:qloo:fixture_neoclassical', name: 'Neoclassical', type: 'urn:tag:decor:qloo' },
        ];
        // Like Qloo, honour filter.tag.types when it is sent.
        return query === 'neoclassical' ? all.filter((t) => !tagTypes || tagTypes.includes(t.type)) : [];
      },
      insights: (req) => {
        insightCalls.push(req);
        return req.filterType === 'urn:entity:brand'
          ? { entities: [ent('FIXTURE-BRAND-0301', 'Fixture Atelier', 'urn:entity:brand')], tags: [] }
          : { entities: [], tags: [] };
      },
    },
    { live: true },
  );
}

async function submit(ctx: ServiceContext) {
  return captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
}

describe('Qloo grounding in the compiler (quality plan §5)', () => {
  it('asks Qloo only about evidenced, type-compatible candidates and accepts only exact names', async () => {
    const insightCalls: QlooInsightsRequest[] = [];
    const qloo = groundingQloo(insightCalls);
    const { providers } = world({ vlm: READING, overrides: { qloo } });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);

    // Q-TYPE / Q-EVIDENCE: the object and the uncorroborated make were never sent.
    const lookups = qloo.calls.filter((c) => c.op === 'search' || c.op === 'tags').map((c) => c.req as { query: string; types?: string[]; tagTypes?: string[] });
    expect(lookups.map((l) => l.query).sort()).toEqual(['Fixture Palais', 'Fixturedale', 'neoclassical']);
    // Every lookup is typed; the tag lookup carries the style families only (no music genres for architecture).
    expect(lookups.find((l) => l.query === 'Fixturedale')!.types).toEqual(['urn:entity:brand']);
    expect(lookups.find((l) => l.query === 'Fixture Palais')!.types).toEqual(['urn:entity:destination', 'urn:entity:locality', 'urn:entity:place']);
    expect(lookups.find((l) => l.query === 'neoclassical')!.tagTypes).toEqual(['urn:tag:decor:qloo', 'urn:tag:style:qloo', 'urn:tag:setting:qloo']);

    const { rows: refs } = await db.query<{ name: string; canonical_key: string; resolution_status: string; is_anchor: boolean; external_ids: Record<string, unknown> }>(
      `SELECT cr.canonical_name AS name, cr.canonical_key, cref.resolution_status, cref.is_anchor, cr.external_ids
         FROM capture_references cref JOIN cultural_references cr ON cr.id = cref.reference_id
         JOIN analyses a ON a.id = cref.analysis_id WHERE a.capture_id = $1`,
      [capture_id],
    );
    const byName = new Map(refs.map((r) => [r.name, r]));
    // Accepted: the brand with a corporate suffix, and the decor tag (not the music genre).
    expect(byName.get('Fixturedale Bicycles')).toMatchObject({ resolution_status: 'resolved', is_anchor: true, canonical_key: 'qloo:FIXTURE-BRAND-0201' });
    expect(byName.get('Neoclassical')).toMatchObject({ resolution_status: 'resolved', is_anchor: true, canonical_key: 'qloo_tag:urn:tag:decor:qloo:fixture_neoclassical' });
    // Q-PLACE doubt: stored under the candidate's own name, no Qloo id, never an anchor.
    expect(byName.get('Fixture Palais')).toMatchObject({ resolution_status: 'unmatched', is_anchor: false, canonical_key: 'place:fixture-palais', external_ids: {} });
    // Not searched: kept as the candidate's own reference.
    expect(byName.get('Road bicycle')).toMatchObject({ resolution_status: 'unmatched', is_anchor: false });
    expect(byName.get('Fixturo Civic')).toMatchObject({ resolution_status: 'unmatched', is_anchor: false });
    // No look-alike name was ever stored.
    expect(refs.some((r) => /Sessions|Racing Club/.test(r.name))).toBe(false);

    // Q-RECORD: every resolve query records its acceptance decision and the rule version.
    const { rows: pq } = await db.query<{ operation: string; query_context: { candidate_name: string; accept: { matched: boolean; rule: string; reason: string; grounding_version: string } } }>(
      `SELECT pq.operation, pq.query_context FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id
        WHERE a.capture_id = $1 AND pq.query_context->>'stage' = 'resolve'`,
      [capture_id],
    );
    const accept = Object.fromEntries(pq.map((r) => [r.query_context.candidate_name, r.query_context.accept]));
    expect(Object.keys(accept).sort()).toEqual(['Fixture Palais', 'Fixturedale', 'Neoclassicism']);
    expect(accept['Fixturedale']).toEqual({ matched: true, rule: 'Q-NAME', reason: 'exact_brand', grounding_version: 'ground-v1' });
    expect(accept['Fixture Palais']).toEqual({ matched: false, rule: 'Q-PLACE', reason: 'same_name_in_several_places', grounding_version: 'ground-v1' });
    expect(accept['Neoclassicism']).toMatchObject({ matched: true, rule: 'Q-NAME' });

    // Skipped lookups write no provider query; their reason is in the resolve trace.
    const { rows: trace } = await db.query<{ data: { grounding: { candidate: string; lookup: string; rule: string; reason: string; doubt: boolean }[] } }>(
      `SELECT data FROM trace_events WHERE job_id = $1 AND name = 'resolve' ORDER BY created_at DESC LIMIT 1`,
      [job_id],
    );
    const g = Object.fromEntries(trace[0]!.data.grounding.map((x) => [x.candidate, x]));
    expect(g['Road bicycle']).toMatchObject({ lookup: 'none', rule: 'Q-EVIDENCE', reason: 'object_not_searched', doubt: false });
    expect(g['Fixturo Civic']).toMatchObject({ lookup: 'none', reason: 'brand_not_corroborated' });
    expect(g['Fixture Palais']).toMatchObject({ lookup: 'search', rule: 'Q-PLACE', doubt: true });

    // Wear insights ask for fashion brands only; the other categories are unfiltered.
    const wear = insightCalls.find((r) => r.filterType === 'urn:entity:brand')!;
    expect(wear.filterTags).toEqual(['urn:tag:genre:brand:fashion']);
    expect(wear.signalEntities).toEqual(['FIXTURE-BRAND-0201']);
    for (const r of insightCalls.filter((x) => x.filterType !== 'urn:entity:brand')) expect(r.filterTags).toBeUndefined();
  });
});
