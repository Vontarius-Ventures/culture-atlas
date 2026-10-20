import { afterAll, describe, expect, it } from 'vitest';
import { captures, type ServiceContext } from '@culture-atlas/domain';
import { closeTestDb, getTestDb } from '@culture-atlas/domain/testing';
import {
  VlmEnrichment,
  VlmQuickRead,
  toVlmAnalysis,
  type CapabilityEntry,
  type QlooEntity,
  type QlooInsightsRequest,
  type QlooTag,
  type VlmEnricher,
  type VlmEnrichInput,
  type VlmEnrichResult,
  type VlmProvider,
  type VlmResult,
} from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { anonCtx, runJobs, testJpeg, world } from './test-world';

/**
 * Qloo grounding in the compiler (docs/quality-plan.md §5) on the real Worker
 * and database, behind the reading guardrails (§4) exactly as production runs
 * them: a two-stage reading, brand claims held at stage 1 and searched in Qloo
 * only after stage 2 transcribed their name (G-BRAND-CORROBORATE). Covers
 * which candidates reach Qloo, which results are accepted, what a doubtful
 * match is stored as, and what is recorded. The readings and every Qloo
 * result are hand-written FIXTURES shaped like the recorded live failures;
 * nothing here is provider output.
 */
const db = getTestDb();
afterAll(closeTestDb);

const AVAILABLE: CapabilityEntry = { status: 'available', provider: 'fake' };
const ent = (id: string, name: string, type: string, extra: Partial<QlooEntity> = {}): QlooEntity => ({ entity_id: id, name, types: [type], properties: {}, tags: [], ...extra });

const QUICK = VlmQuickRead.parse({
  title: 'A bicycle by a palace',
  interpretation: 'A bicycle leans on railings in front of a neoclassical palace.',
  candidates: [
    // Read on the frame: held at stage 1, searched once stage 2 transcribes it, suffix accepted.
    { name: 'Fixturedale', type: 'brand', relation: 'depicted', certainty: 0.9, domain: 'sport', evidence: 'logo', evidence_text: 'FIXTUREDALE', tag_query: null },
    // Two same-named places: doubt.
    { name: 'Fixture Palais', type: 'place', relation: 'resembles', certainty: 0.9, domain: 'place', evidence: 'distinctive_form', evidence_text: null, tag_query: null },
    // Decor, not the music genre.
    { name: 'Neoclassicism', type: 'style', relation: 'resembles', certainty: 0.8, domain: 'architecture', evidence: 'distinctive_form', evidence_text: null, tag_query: 'neoclassical' },
    // A generic object: an observation, never a reference, never searched.
    { name: 'Road bicycle', type: 'object', relation: 'depicted', certainty: 0.95, domain: 'sport', evidence: 'distinctive_form', evidence_text: null, tag_query: null },
    // A make guessed from shape: held, "supported" by stage 2 but never transcribed, so dropped and never searched.
    { name: 'Fixturo Civic', type: 'brand', relation: 'resembles', certainty: 0.4, domain: 'vehicle', evidence: 'context', evidence_text: null, tag_query: null },
  ],
  quality: { usable: true, issue: null },
});

const ENRICHMENT = VlmEnrichment.parse({
  observations: [{ text: 'White frame with thin tubes', kind: 'object' }],
  visible_text: ['FIXTUREDALE'],
  illegible_text_present: false,
  confirmed: [
    { name: 'Fixture Palais', rationale: 'Colonnaded facade', verdict: 'supported' },
    { name: 'Neoclassicism', rationale: 'Columns and pediment', verdict: 'supported' },
    { name: 'Fixturedale', rationale: 'Wordmark on the down tube', verdict: 'supported' },
    { name: 'Fixturo Civic', rationale: 'The car behind has that shape', verdict: 'supported' },
  ],
  additional_candidates: [],
  regions: [],
  uncertainty: { overall: 'low', notes: [] },
  competing_subjects: [],
});

class QuickVlm implements VlmProvider {
  readonly id = 'vlm:fake-quick-v2';
  capability() {
    return AVAILABLE;
  }
  async analyzeImage(): Promise<VlmResult> {
    const quick = VlmQuickRead.parse(structuredClone(QUICK));
    return { analysis: toVlmAnalysis(quick), quick, model: 'fake-quick-v2', durationMs: 1 };
  }
}

class FixedEnricher implements VlmEnricher {
  readonly id = 'vlm-enrich:fake-v2';
  readonly calls: VlmEnrichInput[] = [];
  capability() {
    return AVAILABLE;
  }
  async enrichImage(input: VlmEnrichInput): Promise<VlmEnrichResult> {
    this.calls.push(input);
    return { enrichment: VlmEnrichment.parse(structuredClone(ENRICHMENT)), model: 'fake-enrich-v2', durationMs: 1 };
  }
}

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
    const enricher = new FixedEnricher();
    const { providers } = world({ overrides: { vlm: new QuickVlm(), vlmEnrich: enricher, qloo } });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);

    // Stage 2 was asked about the published candidates and both held brand claims.
    expect(enricher.calls).toHaveLength(1);
    expect(enricher.calls[0]!.stage1.candidates).toEqual(['Fixture Palais', 'Neoclassicism', 'Fixturedale', 'Fixturo Civic']);

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
    // Accepted: the brand with a corporate suffix (appended after stage 2, so not a stage-1 anchor),
    // and the decor tag (not the music genre).
    expect(byName.get('Fixturedale Bicycles')).toMatchObject({ resolution_status: 'resolved', is_anchor: false, canonical_key: 'qloo:FIXTURE-BRAND-0201' });
    expect(byName.get('Neoclassical')).toMatchObject({ resolution_status: 'resolved', is_anchor: true, canonical_key: 'qloo_tag:urn:tag:decor:qloo:fixture_neoclassical' });
    // Q-PLACE doubt: stored under the candidate's own name, no Qloo id, never an anchor.
    expect(byName.get('Fixture Palais')).toMatchObject({ resolution_status: 'unmatched', is_anchor: false, canonical_key: 'place:fixture-palais', external_ids: {} });
    // Never references: the generic object is an observation, the shape-guessed make was dropped.
    expect(byName.has('Road bicycle')).toBe(false);
    expect(byName.has('Fixturo Civic')).toBe(false);
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
    expect(accept['Fixturedale']).toEqual({ matched: true, rule: 'Q-NAME', reason: 'exact_brand', grounding_version: 'ground-v6' });
    expect(accept['Fixture Palais']).toEqual({ matched: false, rule: 'Q-PLACE', reason: 'same_name_in_several_places', grounding_version: 'ground-v6' });
    expect(accept['Neoclassicism']).toMatchObject({ matched: true, rule: 'Q-NAME' });

    // The resolve trace records each grounding decision; the guard trace says why the others never got there.
    const { rows: trace } = await db.query<{ data: { grounding: { candidate: string; lookup: string; rule: string; reason: string; doubt: boolean }[] } }>(
      `SELECT data FROM trace_events WHERE job_id = $1 AND name = 'resolve' ORDER BY created_at DESC LIMIT 1`,
      [job_id],
    );
    const g = Object.fromEntries(trace[0]!.data.grounding.map((x) => [x.candidate, x]));
    expect(g['Fixture Palais']).toMatchObject({ lookup: 'search', rule: 'Q-PLACE', doubt: true });
    expect(g['Road bicycle']).toBeUndefined();
    const { rows: guard } = await db.query<{ data: { stage: number; decisions: { name: string; action: string; rules: string[] }[] } }>(
      `SELECT data FROM trace_events WHERE job_id = $1 AND name = 'guard' ORDER BY created_at, id`,
      [job_id],
    );
    const decided = (stage: number, name: string) => guard.find((t) => t.data.stage === stage)!.data.decisions.find((d) => d.name === name);
    expect(decided(1, 'Road bicycle')).toMatchObject({ action: 'demote' });
    expect(decided(1, 'Fixturedale')).toMatchObject({ action: 'hold' });
    expect(decided(2, 'Fixturedale')).toMatchObject({ action: 'publish', rules: expect.arrayContaining(['G-BRAND-CORROBORATE']) });
    expect(decided(2, 'Fixturo Civic')).toMatchObject({ action: 'drop', rules: expect.arrayContaining(['G-BRAND-CORROBORATE']) });

    // Wear insights ask for fashion brands only; the other categories are unfiltered. Stage 1 signals
    // with the decor tag; the stage-2 fill of thin categories signals with the corroborated brand.
    const wear = insightCalls.filter((r) => r.filterType === 'urn:entity:brand');
    expect(wear.length).toBeGreaterThan(0);
    for (const r of wear) expect(r.filterTags).toEqual(['urn:tag:genre:brand:fashion']);
    expect(wear[0]!.signalTags).toEqual([{ id: 'urn:tag:decor:qloo:fixture_neoclassical' }]);
    expect(wear.some((r) => r.signalEntities?.includes('FIXTURE-BRAND-0201'))).toBe(true);
    for (const r of insightCalls.filter((x) => x.filterType !== 'urn:entity:brand')) expect(r.filterTags).toBeUndefined();
  });
});
