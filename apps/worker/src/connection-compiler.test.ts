import { afterAll, describe, expect, it } from 'vitest';
import { captures, schemas } from '@culture-atlas/domain';
import { closeTestDb, getTestDb } from '@culture-atlas/domain/testing';
import {
  ProviderError, toVlmAnalysis, VlmEnrichment, VlmEnrichmentV1, VlmQuickRead,
  type ProviderOverrides,
  type QlooEntity, type QlooInsightsRequest, type QlooTag, type VlmProvider,
  type VlmStyleReader, type VlmStyleReading,
} from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { legacyAccountCtx as accountCtx, legacyTestConfig as testConfig, runJobs, testJpeg, world } from './test-world';

// Historical v9 worker/compiler/public projection (no v10 observation/asset waiver), isolated per-run DB.
// Every provider below is an in-memory fixture, including "live" origin simulation.
const db = getTestDb();
afterAll(closeTestDb);
const movie = 'urn:entity:movie';
const tag = (query: string, family = 'keyword:qloo'): QlooTag => ({
  id: `urn:tag:${family}:${query.replaceAll(' ', '_')}`, name: query,
  type: `urn:tag:${family}`, parents: [movie],
});
const sculpture = tag('sculpture');
const coffee = tag('coffee');
const documentary = tag('documentary', 'genre:media');
const tennis = tag('tennis');
const subject = (id: string, category: VlmStyleReading['subjects'][number]['category'], label: string): VlmStyleReading['subjects'][number] => ({
  id, category, label, region: { x: 0, y: 0, w: 1, h: 1 },
  aesthetics: [], lineage: [], materials: [], construction: [], details: [], palette: [], mood: [], era: null, brand: null,
});
const emptyQuick: VlmProvider = {
  id: 'vlm:fixture-no-references',
  capability: () => ({ status: 'available', provider: 'fake' }),
  analyzeImage: async () => {
    const quick = VlmQuickRead.parse({ title: 'Visible objects', interpretation: 'Visible forms.', candidates: [], quality: { usable: true, issue: null } });
    return { analysis: toVlmAnalysis(quick), quick, model: 'fixture', durationMs: 1 };
  },
};
const styleReader = (subjects: VlmStyleReading['subjects']): VlmStyleReader => ({
  id: 'vlm-style:fixture-source-plans',
  capability: () => ({ status: 'available', provider: 'fake' }),
  readStyle: async () => ({
    reading: { schema: 'atlas_style_reading_v1', usable: true, unusable_reason: null, summary: 'Visible forms.', subjects: structuredClone(subjects) },
    model: 'fixture', durationMs: 1, image: { width: 640, height: 480 },
  }),
});
const film = (id: string, topic: QlooTag, description: string, doc = true): QlooEntity => ({
  entity_id: id, name: `Fixture ${id}`, types: [movie], tags: [topic, ...(doc ? [documentary] : [])], properties: { description },
});
const sculptureFilm = film('Sculpture Process', sculpture, 'The film profiles a sculptor and explores sculpture making.');
const coffeeFilm = film('Coffee Practice', coffee, 'The documentary follows baristas and explores coffee making.');
const twoSources = () => [subject('s1', 'other', 'Stone sculpture'), subject('s2', 'food', 'Espresso coffee drink')];
const actualTags = (query: string) => [sculpture, coffee, documentary, tennis].filter((t) => t.name === query);
const requested = (qloo: FakeQloo) => qloo.calls.filter((c) => c.op === 'insights').map((c) => c.req as QlooInsightsRequest);

async function compile(qloo: FakeQloo, subjects = twoSources(), config: Record<string, string> = {}, overrides: ProviderOverrides = {}) {
  const { providers } = world({ overrides: { qloo, vlm: emptyQuick, vlmStyle: styleReader(subjects), ...overrides } });
  const ctx = await accountCtx(providers, testConfig({ STYLE_INTERIOR_BRANDS: 'false', ...config }));
  const capture = await captures.createCapture(ctx, {
    kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined },
  });
  await runJobs(ctx, [capture.job_id]);
  const view = await captures.getCapture(ctx, { id: capture.capture_id });
  expect(schemas.CaptureResponse.safeParse(view).success).toBe(true);
  const { rows } = await db.query<{
    title: string; provider_query_ids: string[]; contributing_reference_ids: string[];
    style_match: { discovery_proof: { subjectId: string; sourceQueryId: string; relation: string; contentEvidence: { topicPlanKey: string; kind: string; excerpt: string; documentaryTag?: unknown; topicTag?: { id: string } } } };
  }>(
    `SELECT r.title, r.provider_query_ids, r.contributing_reference_ids, r.style_match
       FROM recommendations r JOIN captures c ON c.active_analysis_id = r.analysis_id
       WHERE c.id = $1 AND r.hidden_at IS NULL ORDER BY r.rank`, [capture.capture_id],
  );
  return { capture, view, rows };
}

describe('source-bound Connection plans through the compiler', () => {
  it('retrieves both sources with one shared documentary lookup and five cold calls, retaining exact request binding', async () => {
    const qloo = new FakeQloo({
      tags: actualTags,
      insights: (req) => ({ entities: req.filterTags?.includes(sculpture.id) ? [sculptureFilm] : req.filterTags?.includes(coffee.id) ? [coffeeFilm] : [], tags: [] }),
    }, { live: true });
    const { capture, rows } = await compile(qloo);
    // The shared evidence policy now puts a specific practice before a broad art topic.
    expect(rows.map((r) => r.title)).toEqual([coffeeFilm.name, sculptureFilm.name]);
    expect(rows.map((r) => r.style_match.discovery_proof.subjectId)).toEqual(['s2', 's1']);
    expect(qloo.calls, JSON.stringify(qloo.calls)).toHaveLength(5);
    expect(qloo.calls.filter((c) => c.op === 'tags' && (c.req as { query: string }).query === 'documentary')).toHaveLength(1);
    expect(requested(qloo)).toEqual([
      { filterType: movie, filterTags: [sculpture.id, documentary.id], filterTagsOperator: 'intersection', explainability: false, take: 20 },
      { filterType: movie, filterTags: [coffee.id, documentary.id], filterTagsOperator: 'intersection', explainability: false, take: 20 },
    ]);
    for (const row of rows) {
      const proof = row.style_match.discovery_proof;
      expect(row.provider_query_ids).toEqual([proof.sourceQueryId]);
      expect(row.contributing_reference_ids).toEqual([]);
      const { rows: logs } = await db.query<{ query_context: { subject_id: string; request_binding: QlooInsightsRequest } }>(
        'SELECT query_context FROM provider_queries WHERE id = $1', [proof.sourceQueryId],
      );
      expect(logs[0]!.query_context.subject_id).toBe(proof.subjectId);
      expect(logs[0]!.query_context.request_binding).toMatchObject({
        filterType: movie, filterTags: [proof.subjectId === 's1' ? sculpture.id : coffee.id, documentary.id], filterTagsOperator: 'intersection', take: 20,
      });
    }
    const { rows: charges } = await db.query<{ attempts: number }>(
      `SELECT sum((p.query_context->>'attempts')::int)::int AS attempts FROM provider_queries p
       JOIN captures c ON c.active_analysis_id = p.analysis_id WHERE c.id = $1 AND p.provider = 'qloo'`, [capture.capture_id],
    );
    expect(charges[0]!.attempts).toBe(5);
  });

  it.each(['empty_tag', 'tag_error', 'insights_error'] as const)('a first-plan %s does not suppress the second source', async (failure) => {
    const qloo = new FakeQloo({
      tags: (query) => query === 'sculpture' && failure !== 'insights_error'
        ? failure === 'tag_error' ? new ProviderError('qloo', 'timeout', 'Fixture tag failure') : []
        : actualTags(query),
      insights: (req) => req.filterTags?.includes(sculpture.id)
        ? new ProviderError('qloo', 'timeout', 'Fixture insights failure')
        : { entities: req.filterTags?.includes(coffee.id) ? [coffeeFilm] : [], tags: [] },
    }, { live: true });
    const { rows } = await compile(qloo);
    expect(rows.map((r) => r.title)).toEqual([coffeeFilm.name]);
    expect(rows[0]!.style_match.discovery_proof.subjectId).toBe('s2');
    expect(qloo.calls.length).toBeLessThanOrEqual(5);
    expect(qloo.calls.filter((c) => c.op === 'tags' && (c.req as { query: string }).query === 'documentary')).toHaveLength(1);
  });

  it('admits a substantive narrative tennis film without inventing documentary typing', async () => {
    const narrative = film('Tennis Career', tennis, 'The drama follows a tennis player through her professional tennis career.', false);
    const qloo = new FakeQloo({
      tags: actualTags,
      insights: () => ({ entities: [
        narrative,
        film('Tennis Background', tennis, 'A tennis court appears briefly in the background.', false),
        { ...narrative, entity_id: 'wrong-type', types: ['urn:entity:brand'] },
        { ...narrative, entity_id: 'wrong-topic-id', tags: [tag('other tennis')] },
      ], tags: [] }),
    }, { live: true });
    const { rows } = await compile(qloo, [subject('s1', 'other', 'Tennis racket')]);
    expect(rows.map((r) => r.title)).toEqual([narrative.name]);
    expect(rows[0]!.style_match.discovery_proof.contentEvidence).toMatchObject({ kind: 'topic_film', topicPlanKey: 'tennis', topicTag: { id: tennis.id } });
    expect(rows[0]!.style_match.discovery_proof.contentEvidence.documentaryTag).toBeUndefined();
    expect(requested(qloo)).toEqual([{ filterType: movie, filterTags: [tennis.id], filterTagsOperator: 'intersection', explainability: false, take: 20 }]);
    expect(qloo.calls.some((c) => c.op === 'tags' && (c.req as { query: string }).query === 'documentary')).toBe(false);
  });

  it('prioritizes specific practice evidence, retains source diversity and preserves provider order within the broad sculpture tier', async () => {
    const copies = Array.from({ length: 5 }, (_, i) => ({ ...sculptureFilm, entity_id: `sculpture-${i}`, name: `Fixture sculpture ${i}` }));
    const qloo = new FakeQloo({
      tags: actualTags,
      insights: (req) => ({ entities: req.filterTags?.includes(sculpture.id) ? copies : [coffeeFilm], tags: [] }),
    }, { live: true });
    const { rows } = await compile(qloo);
    expect(rows.map((r) => r.title)).toEqual([coffeeFilm.name, 'Fixture sculpture 0', 'Fixture sculpture 1']);
    expect(rows.every((r) => r.contributing_reference_ids.length === 0)).toBe(true);
  });

  it('does not replace a missing specific abandoned-building topic with broad architecture', async () => {
    const qloo = new FakeQloo({
      tags: (query) => query === 'architecture' ? [tag('architecture')] : query === 'documentary' ? [documentary] : [],
      insights: () => ({ entities: [film('Broad Architecture', tag('architecture'), 'The film explores architecture.')], tags: [] }),
    }, { live: true });
    // "bedroom" now independently opens a legitimate architecture plan; isolate the missing abandoned-motel plan.
    const { rows } = await compile(qloo, [subject('s1', 'interior', 'Abandoned motel')]);
    expect(rows).toEqual([]);
    expect(requested(qloo)).toEqual([]);
    expect(qloo.calls.some((c) => c.op === 'tags' && (c.req as { query: string }).query === 'abandoned buildings')).toBe(true);
  });

  it.each(['keyword_documentary', 'wrong_movie_parent'] as const)('rejects %s lookup typing instead of manufacturing a valid genre/topic', async (failure) => {
    const qloo = new FakeQloo({
      tags: (query) => query === 'documentary' ? [failure === 'keyword_documentary' ? tag('documentary') : documentary]
        : query === 'sculpture' ? [{ ...sculpture, ...(failure === 'wrong_movie_parent' ? { parents: ['urn:entity:brand'] } : {}) }] : [],
      insights: () => ({ entities: [sculptureFilm], tags: [] }),
    }, { live: true });
    const { rows } = await compile(qloo, [subject('s1', 'other', 'Stone sculpture')]);
    expect(rows).toEqual([]);
    expect(requested(qloo)).toEqual([]);
  });

  it('requires the exact requested topic and documentary IDs, original type, and substantive per-source content', async () => {
    const exactWithIncidentalTags = { ...sculptureFilm, tags: [
      { ...documentary, id: 'urn:tag:genre:media:incidental_documentary' },
      { ...sculpture, id: 'urn:tag:keyword:qloo:incidental_sculpture' },
      sculpture, documentary,
    ] };
    const qloo = new FakeQloo({
      tags: actualTags,
      insights: () => ({ entities: [
        exactWithIncidentalTags,
        { ...sculptureFilm, entity_id: 'wrong-doc-id', tags: [sculpture, { ...documentary, id: 'urn:tag:genre:media:other_documentary' }] },
        { ...sculptureFilm, entity_id: 'wrong-topic-id', tags: [{ ...sculpture, id: 'urn:tag:keyword:qloo:other_sculpture' }, documentary] },
        { ...sculptureFilm, entity_id: 'wrong-type', types: ['urn:entity:tv_show'] },
        { ...sculptureFilm, entity_id: 'other-subject-content', properties: coffeeFilm.properties },
        { ...sculptureFilm, entity_id: 'missing-content', properties: {} },
      ], tags: [] }),
    }, { live: true });
    const { rows } = await compile(qloo, [subject('s1', 'other', 'Stone sculpture')]);
    expect(rows.map((r) => r.title)).toEqual([sculptureFilm.name]);
    expect(rows[0]!.style_match.discovery_proof.contentEvidence.excerpt).toBe(sculptureFilm.properties.description);
    expect(rows[0]!.style_match.discovery_proof.contentEvidence).toMatchObject({
      documentaryTag: { id: documentary.id }, topicTag: { id: sculpture.id },
    });
  });

  it.each([1, 3, 4, 5])('honors an existing %i-request allowance without adding a new allocation or fabricated fallback', async (limit) => {
    const qloo = new FakeQloo({
      tags: actualTags,
      insights: (req) => ({ entities: req.filterTags?.includes(sculpture.id) ? [sculptureFilm] : [coffeeFilm], tags: [] }),
    }, { live: true });
    const { rows } = await compile(qloo, twoSources(), { JOB_MAX_QLOO_REQUESTS: String(limit) });
    expect(qloo.calls.length).toBeLessThanOrEqual(limit);
    expect(rows.length).toBe(limit <= 3 ? 0 : limit === 4 ? 1 : 2);
    expect(rows.every((r) => [sculptureFilm.name, coffeeFilm.name].includes(r.title))).toBe(true);
  });

  it('prefers the two bounded content plans to a weak home-brand request under the same five-request budget', async () => {
    const qloo = new FakeQloo({
      tags: actualTags,
      insights: (req) => ({ entities: req.filterTags?.includes(sculpture.id) ? [sculptureFilm] : req.filterTags?.includes(coffee.id) ? [coffeeFilm] : [], tags: [] }),
    }, { live: true });
    const { rows } = await compile(qloo, twoSources(), { JOB_MAX_QLOO_REQUESTS: '5', STYLE_INTERIOR_BRANDS: 'true' });
    expect(rows).toHaveLength(2);
    expect(qloo.calls).toHaveLength(5);
    expect(requested(qloo).every((req) => req.filterType === movie)).toBe(true);
  });

  it('caps attributable taste across multiple subject rails, not once per rail, and never bridges material-only evidence', async () => {
    let index = 0;
    const materialIds: string[] = [];
    const qloo = new FakeQloo({
      tags: () => [],
      insights: (req) => {
        if (req.filterType !== 'urn:entity:brand') return { entities: [], tags: [] };
        const id = `FIXTURE-TIMBER-${index++}`;
        materialIds.push(id);
        return { entities: [{
          entity_id: id, name: `Fixture Timber Maker ${index}`, types: ['urn:entity:brand'],
          properties: {}, tags: [{ id: 'urn:tag:industry:qloo:furniture', name: 'Furniture' }, { id: 'urn:tag:signature_product:qloo:walnut', name: 'Walnut' }],
          query: { explainability: (req.signalEntities ?? []).slice(0, 1).map((entity_id) => ({ entity_id, score: 0.8 })) },
        }], tags: [] };
      },
    }, { live: true });
    const { rows, view } = await compile(qloo, [
      { ...subject('s1', 'interior', 'Walnut wooden chair'), region: { x: 0, y: 0, w: 0.45, h: 1 } },
      { ...subject('s2', 'interior', 'Walnut wooden chair'), region: { x: 0.55, y: 0, w: 0.45, h: 1 } },
    ], { STYLE_INTERIOR_BRANDS: 'true' });
    expect(requested(qloo).filter((req) => req.filterType === 'urn:entity:brand')).toHaveLength(2);
    expect(rows).toHaveLength(1);
    expect(view.rails?.filter((r) => r.key.startsWith('more_like_this')).flatMap((r) => r.cards)).toHaveLength(1);
    expect(rows[0]!.style_match.discovery_proof).toMatchObject({ relation: 'qloo_taste' });
    expect(requested(qloo).some((req) => req.signalEntities?.some((id) => materialIds.includes(id)))).toBe(false);
  });

  it('shares the one-taste limit between More-like-this and cross-domain cards', async () => {
    const workwear = { id: 'urn:tag:fashion_segment:qloo:workwear', name: 'Workwear' };
    const qloo = new FakeQloo({
      tags: () => [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:brand' ? [
          { entity_id: 'FIXTURE-WORKWEAR-BRIDGE', name: 'Fixture Workwear Bridge', types: ['urn:entity:brand'], properties: {},
            tags: [{ id: 'urn:tag:genre:brand:fashion:jeans', name: 'Jeans' }, workwear] },
          { entity_id: 'FIXTURE-MLT-TASTE', name: 'Fixture Apparel Taste', types: ['urn:entity:brand'], properties: {},
            tags: [{ id: 'urn:tag:genre:brand:fashion:jeans', name: 'Jeans' }],
            query: { explainability: (req.signalEntities ?? []).slice(0, 1).map((entity_id) => ({ entity_id, score: 0.9 })) } },
        ] : req.filterType === 'urn:entity:artist' ? [
          { entity_id: 'FIXTURE-CROSS-TASTE', name: 'Fixture Jazz Taste', types: ['urn:entity:artist'], properties: {},
            tags: [{ id: 'urn:tag:genre:music:jazz', name: 'Jazz' }],
            query: { explainability: [{ entity_id: 'FIXTURE-WORKWEAR-BRIDGE', score: 0.8 }] } },
        ] : [], tags: [],
      }),
    }, { live: true });
    const garment = subject('s1', 'fashion', 'Denim work jacket');
    garment.aesthetics = [{ name: 'Workwear', certainty: 0.9, defining_features: ['metal snaps', 'patch pockets'], evidence: { basis: 'visible', region: null }, tag_query: null }];
    const { rows } = await compile(qloo, [garment]);
    expect(requested(qloo).some((req) => req.filterType === 'urn:entity:artist' && req.signalEntities?.includes('FIXTURE-WORKWEAR-BRIDGE'))).toBe(true);
    const proofs = rows.map((r) => r.style_match.discovery_proof);
    expect(proofs.filter((p) => p.relation === 'qloo_taste')).toHaveLength(1);
    expect(proofs.filter((p) => p.relation === 'shared_design')).toHaveLength(1);
  });

  it('keeps an exhausted soft deadline honest and makes no content requests', async () => {
    const qloo = new FakeQloo({
      tags: actualTags,
      insights: () => ({ entities: [sculptureFilm, coffeeFilm], tags: [] }),
    }, { live: true });
    const { rows } = await compile(qloo, twoSources(), { ANALYSIS_DEADLINE_MS: '1' });
    expect(rows).toEqual([]);
    expect(qloo.calls).toEqual([]);
  });

  it('retracts a published content card when stage two vetoes its original source claim', async () => {
    const pottery = tag('pottery');
    const potteryFilm = film('Pottery Process', pottery, 'The documentary profiles potters and explores pottery making.');
    const qloo = new FakeQloo({
      search: () => [],
      tags: (query) => query.toLowerCase() === 'pottery' ? [pottery] : query === 'documentary' ? [documentary] : [],
      insights: () => ({ entities: [potteryFilm], tags: [] }),
    }, { live: true });
    // A real vessel noun is needed to distinguish pottery from arbitrary room objects.
    const object = subject('s1', 'interior', 'Handcrafted mug');
    object.aesthetics = [{ name: 'Pottery', certainty: 0.9, defining_features: ['hand-formed rim', 'glazed surface'], evidence: { basis: 'visible', region: null }, tag_query: null }];
    const { capture, rows, view } = await compile(qloo, [object], {}, {
      vlm: {
        ...emptyQuick,
        analyzeImage: async () => {
          const quick = VlmQuickRead.parse({ title: 'Handcrafted object', interpretation: 'A formed object.', candidates: [{ name: 'Pottery', type: 'style', relation: 'resembles', certainty: 0.7, categories: ['watch'], tag_query: 'pottery' }], quality: { usable: true, issue: null } });
          return { analysis: toVlmAnalysis(quick), quick, model: 'fixture', durationMs: 1 };
        },
      },
      vlmEnrich: {
        id: 'vlm-enrich:fixture-content-veto', capability: () => ({ status: 'available', provider: 'fake' }),
        enrichImage: async () => ({
          enrichment: VlmEnrichment.parse(VlmEnrichmentV1.parse({
            observations: [], visible_text: [], confirmed: [{ name: 'Pottery', rationale: 'The source claim is not supported.', keep: false }],
            additional_candidates: [], regions: [], uncertainty: { overall: 'low', notes: [] }, competing_subjects: [],
          })), model: 'fixture', durationMs: 1,
        }),
      },
    });
    expect(rows).toEqual([]);
    expect(view.recommendations).toEqual([]);
    const { rows: hidden } = await db.query<{ hidden_at: Date | null; style_match: { discovery_proof: { claim: { slot: string; name: string } } } }>(
      `SELECT r.hidden_at, r.style_match FROM recommendations r JOIN captures c ON c.active_analysis_id = r.analysis_id
       WHERE c.id = $1 AND r.external_ids->>'qloo' = $2`, [capture.capture_id, potteryFilm.entity_id],
    );
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.hidden_at).not.toBeNull();
    expect(hidden[0]!.style_match.discovery_proof.claim).toMatchObject({ slot: 'aesthetics', name: 'Pottery' });
  });
});
