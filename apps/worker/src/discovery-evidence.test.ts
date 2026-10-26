import { afterAll, describe, expect, it } from 'vitest';
import { captures, schemas } from '@culture-atlas/domain';
import { closeTestDb, getTestDb } from '@culture-atlas/domain/testing';
import type { QlooEntity, VlmStyleReader, VlmStyleReading } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { accountCtx, CATALOG, runJobs, testJpeg, world } from './test-world';

const db = getTestDb();
afterAll(closeTestDb);

function reader(name: string, category: 'fashion' | 'interior' = 'fashion'): VlmStyleReader {
  const reading: VlmStyleReading = {
    schema: 'atlas_style_reading_v1', usable: true, unusable_reason: null, summary: 'A visible design.',
    subjects: [{
      id: 's1', category, label: category === 'fashion' ? 'Studded denim jacket' : 'Furnished room',
      region: { x: 0, y: 0, w: 1, h: 1 },
      aesthetics: [{ name, certainty: 0.8, defining_features: ['metal studs', 'torn denim'], evidence: { basis: 'visible', region: null }, tag_query: null }],
      lineage: [], materials: [], construction: [], details: [], palette: [], mood: [], era: null, brand: null,
    }],
  };
  return {
    id: 'vlm-style:discovery-fixture',
    capability: () => ({ status: 'available', provider: 'fake' }),
    readStyle: async () => ({ reading: structuredClone(reading), model: 'fake-style', durationMs: 1, image: { width: 640, height: 480 } }),
  };
}

const musicTag = { id: 'urn:tag:genre:music:punk', name: 'Punk', type: 'urn:tag:genre', parents: ['urn:entity:artist'] };
const musician = (id: string, name: string, tags: QlooEntity['tags']): QlooEntity => ({ entity_id: id, name, types: ['urn:entity:artist'], properties: {}, tags });

describe('discovery evidence through the real compiler and database', () => {
  it('anchor-only retrieval keeps a supported subculture, rejects audience-only fill, and never invents contributors', async () => {
    const qloo = new FakeQloo({
      search: (query) => CATALOG.search[query.toLowerCase()] ?? [],
      tags: (query) => query.toLowerCase() === 'punk' ? [musicTag] : CATALOG.tags[query.toLowerCase()] ?? [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:artist' ? [
          musician('FIXTURE-EVIDENCE-POP', 'Fixture Audience Artist', [{ id: 'urn:tag:genre:music:pop', name: 'Pop' }]),
          musician('FIXTURE-EVIDENCE-PUNK', 'Fixture Punk Artist', [musicTag]),
        ] : [], tags: [],
      }),
    }, { live: true });
    const { providers } = world({ overrides: { qloo, vlmStyle: reader('Punk') } });
    const ctx = await accountCtx(providers);
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    const view = await captures.getCapture(ctx, { id: capture.capture_id });
    expect(schemas.CaptureResponse.safeParse(view).success).toBe(true);
    const artistCall = qloo.calls.find((call) => call.op === 'insights' && (call.req as { filterType: string }).filterType === 'urn:entity:artist')!;
    expect(artistCall.req).toMatchObject({ signalEntities: [], signalTags: [{ id: CATALOG.tags['vintage racing']![0]!.id }] });
    const { rows } = await db.query<{ title: string; contributing_reference_ids: string[]; style_match: { discovery_proof: { subjectId: string; origin: string; relation: string; candidateTags: { id: string }[] } }; display_reason: string }>(
      `SELECT r.title, r.contributing_reference_ids, r.style_match, r.display_reason FROM recommendations r JOIN captures c ON c.active_analysis_id = r.analysis_id WHERE c.id = $1 AND r.category = 'play'`, [capture.capture_id],
    );
    expect(rows.map((r) => r.title)).toEqual(['Fixture Punk Artist']);
    expect(rows[0]!.contributing_reference_ids).toEqual([]);
    expect(rows[0]!.style_match.discovery_proof).toMatchObject({
      subjectId: 's1', origin: 'anchor', relation: 'shared_subculture', candidateTags: [{ id: musicTag.id }],
    });
    expect(rows[0]!.display_reason).toContain('tagged Punk');
    expect(rows[0]!.display_reason).not.toMatch(/shares a taste|Fixture Denim/i);
  });

  it('does not even query music audience overlap for an interior adjective', async () => {
    const qloo = new FakeQloo({
      search: (query) => CATALOG.search[query.toLowerCase()] ?? [],
      tags: () => [{ id: 'urn:tag:genre:music:minimalism', name: 'Minimalism', type: 'urn:tag:genre', parents: ['urn:entity:artist'] }],
      insights: () => ({ entities: [musician('FIXTURE-EVIDENCE-MINIMAL', 'Fixture Composer', [{ id: 'urn:tag:genre:music:minimalism', name: 'Minimalism' }])], tags: [] }),
    }, { live: true });
    const { providers } = world({ overrides: { qloo, vlmStyle: reader('Warm minimalism', 'interior') } });
    const ctx = await accountCtx(providers);
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    expect(qloo.calls.some((call) => call.op === 'insights' && (call.req as { filterType: string }).filterType === 'urn:entity:artist')).toBe(false);
    const view = await captures.getCapture(ctx, { id: capture.capture_id });
    expect(view.recommendations.filter((r) => r.category === 'play')).toEqual([]);
  });
});
