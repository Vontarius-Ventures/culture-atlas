import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { captures, schemas } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, testConfig } from '@culture-atlas/domain/testing';
import {
  CONNECTION_ASSET_CHECKER_VERSION, toVlmAnalysis, VlmEnrichment, VlmEnrichmentV1, VlmQuickRead,
  type ConnectionAssetProvider, type ProviderOverrides, type QlooEntity, type QlooInsightsRequest, type QlooTag,
  type VlmProvider, type VlmStyleReading, type VlmStyleReader,
} from '@culture-atlas/providers';
import { FakeQloo, FakeVlm } from '@culture-atlas/providers/testing';
import { accountCtx, fakeComposer, fakeQloo, legacyTestConfig, runJobs, testJpeg, vlmFixture, world } from './test-world';

// Real Worker -> compiler -> isolated PostgreSQL -> getCapture. ONLY mechanism
// fixtures: all observations, Qloo entities, images/hashes and asset verdicts are
// declared synthetic. The injected checker NEVER fetches an image or runs a model.
// Provider-worker SQL tests separately cover durable asset slots across retries.
const db = getTestDb();
afterAll(closeTestDb);
const V10 = 'compiler-2026-10-27-intent-quality-v10';
const V9 = 'compiler-2026-10-27-intent-quality-v9';
const BRAND = 'urn:entity:brand';
const MOVIE = 'urn:entity:movie';
const BOX = { x: 0, y: 0, w: 1, h: 1 };
type Subject = VlmStyleReading['subjects'][number];
const observation = (id: string, text: string, kind: NonNullable<Subject['observations']>[number]['kind'] = 'form') =>
  ({ id, text, kind, certainty: 0.9, region: { ...BOX } });
const subject = (id: string, category: Subject['category'], label: string): Subject => ({
  id, category, label, region: { ...BOX }, aesthetics: [], lineage: [], materials: [], construction: [],
  details: [], palette: [], mood: [], era: null, brand: null, observations: [],
});
const shirt = (): Subject => ({
  ...subject('s1', 'fashion', 'Striped cotton shirt'),
  observations: [observation('o1', 'Short-sleeved shirt with crew neck'), observation('o2', 'Horizontal stripes across the fabric', 'pattern')],
});
const coffeeSource = (): Subject => ({
  ...subject('s1', 'food', 'Coffee in a cup'),
  observations: [observation('o1', 'Cup filled with coffee')],
});
const typedTag = (name: string, target = BRAND, family = 'aesthetic_property:qloo'): QlooTag => ({
  id: `urn:tag:${family}:synthetic_${name.replaceAll(' ', '_')}`, name, type: `urn:tag:${family}`, parents: [target],
});
const striped = typedTag('striped');
const documentary = typedTag('documentary', MOVIE, 'genre:media');
const coffee = typedTag('coffee', MOVIE, 'keyword:qloo');
const imageUrl = (id: string) => `https://images.qloo.com/synthetic-worker-v10/${id}.jpg`;
const stripedBrand = (id = 'SYNTHETIC-STRIPED-BRAND'): QlooEntity => ({
  entity_id: id, name: `Synthetic ${id}`, types: [BRAND], properties: { image: { url: imageUrl(id) } },
  tags: [striped, { id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual' },
    { id: 'urn:tag:signature_piece:qloo:synthetic_striped_shirts', name: 'Striped shirts' }],
});
const coffeeFilm = (id = 'SYNTHETIC-COFFEE-FILM', description = 'The documentary follows baristas and explores coffee making.'): QlooEntity => ({
  entity_id: id, name: `Synthetic ${id}`, types: [MOVIE], tags: [coffee, documentary],
  properties: { description, image: { url: imageUrl(id) } },
});
const emptyQuick: VlmProvider = {
  id: 'vlm:synthetic-v10-empty-quick', capability: () => ({ status: 'available', provider: 'fake' }),
  analyzeImage: async () => {
    const quick = VlmQuickRead.parse({ title: 'Synthetic object fixture', interpretation: 'Visible object form.',
      candidates: [], quality: { usable: true, issue: null } });
    return { analysis: toVlmAnalysis(quick), quick, model: 'synthetic-fixture', durationMs: 1 };
  },
};
const reader = (subjects: Subject[]): VlmStyleReader => ({
  id: 'vlm-style:synthetic-v10-observations', capability: () => ({ status: 'available', provider: 'fake' }),
  readStyle: async () => ({
    reading: { schema: 'atlas_style_reading_v1', usable: true, unusable_reason: null,
      summary: 'Synthetic retained observation fixture.', subjects: structuredClone(subjects) },
    model: 'synthetic-fixture', durationMs: 1, image: { width: 640, height: 480 },
  }),
});
function syntheticAssets(failure: 'none' | 'unknown' | 'throw' = 'none') {
  const check = vi.fn<ConnectionAssetProvider['checkConnectionAsset']>(async (metadata, url, context) => {
    await context.ensureActive();
    if (failure === 'throw') throw new Error('Synthetic failed asset attempt');
    return {
      version: 'connection_asset_evidence_v1', candidateId: metadata.candidateId, imageUrl: url,
      originalSha256: createHash('sha256').update(`synthetic-original:${metadata.candidateId}`).digest('hex'),
      modelInputSha256: createHash('sha256').update(`synthetic-model-input:${metadata.candidateId}`).digest('hex'),
      identity: failure === 'unknown' ? 'unknown' : 'corroborated', image: 'available', checkerVersion: CONNECTION_ASSET_CHECKER_VERSION,
    };
  });
  return { check, provider: { isConfigured: () => true, checkConnectionAsset: check } satisfies ConnectionAssetProvider };
}
const stripeQloo = (entities = [stripedBrand()]) => new FakeQloo({
  tags: (query) => query === 'striped' ? [striped] : [],
  insights: (req) => ({ entities: req.filterType === BRAND ? entities : [], tags: [] }),
}, { live: true }); // Simulates live-origin metadata only; no HTTP transport exists here.

async function prepare(subjects: Subject[], qloo: FakeQloo, options: {
  assets?: ConnectionAssetProvider; assetChecks?: number | 'default'; config?: Record<string, string>; overrides?: ProviderOverrides;
} = {}) {
  const { providers } = world({ overrides: {
    qloo, vlm: emptyQuick, vlmStyle: reader(subjects),
    ...(options.assets ? { connectionAsset: options.assets } : {}), ...options.overrides,
  } });
  const ctx = await accountCtx(providers, testConfig({
    COMPILER_VERSION: V10, STYLE_INTERIOR_BRANDS: 'false',
    ...(options.assetChecks === 'default' ? {} : { CONNECTION_MAX_ASSET_CHECKS_PER_CAPTURE: String(options.assetChecks ?? 3) }),
    ...options.config,
  }));
  const capture = await captures.createCapture(ctx, {
    kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined },
  });
  return { ctx, capture };
}
type State = Awaited<ReturnType<typeof prepare>>;
type View = Awaited<ReturnType<typeof captures.getCapture>>;
function connections(view: View) {
  expect(view.discovery_intents?.version).toBe('atlas_discovery_intents_v1');
  return view.discovery_intents!.connections.rails.flatMap((rail) => rail.cards);
}
interface Recommendation {
  id: string; title: string; rail: string; origin: string; reading_rev: number; hidden_at: Date | null; provider_query_ids: string[];
  style_match: { actual_candidate_types: string[]; discovery_proof: {
    candidateId: string; subjectId: string; readingRev: number; sourceQueryId: string; relation: string;
    claim: { slot: string; name: string }; candidateTags: { id: string; label: string }[];
    sourceEvidence: { readingRev: number; observationIds: string[]; featureIds: string[] };
    assetEvidence: { identity: string; imageUrl: string; originalSha256: string; modelInputSha256: string };
    contentEvidence?: { focus: string; excerpt: string; field: string; range: { start: number; end: number }; context: Record<string, string>;
      topicPlanKey: string; topicTag: { id: string }; documentaryTag: { id: string } };
  } };
}
async function rows(state: State) {
  const result = await db.query<Recommendation>(`SELECT r.* FROM recommendations r
    JOIN captures c ON c.active_analysis_id = r.analysis_id WHERE c.id = $1 ORDER BY r.rank,r.id`, [state.capture.capture_id]);
  return result.rows;
}
async function finish(state: State) {
  await runJobs(state.ctx, [state.capture.job_id]);
  const view = await captures.getCapture(state.ctx, { id: state.capture.capture_id });
  expect(schemas.CaptureResponse.safeParse(view).success).toBe(true);
  const job = await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [state.capture.job_id]);
  expect(job.rows[0]?.state).toBe('complete');
  return { view, recommendations: await rows(state) };
}
async function currentReading(state: State) {
  const result = await db.query<{ compiler_version: string; style_reading: {
    rev: number; retracted: string[]; subjects: { id: string; observations: { id: string; text: string }[];
      aesthetics: { name: string; wording: string; retracted?: boolean }[] }[];
  } }>('SELECT compiler_version,style_reading FROM analyses WHERE id=(SELECT active_analysis_id FROM captures WHERE id=$1)', [state.capture.capture_id]);
  expect(result.rows[0]?.compiler_version).toBe(V10);
  return result.rows[0]!.style_reading;
}
async function diagnostics(state: State, qloo: FakeQloo) {
  const traces = await db.query(`SELECT name,data FROM trace_events WHERE job_id=$1
    AND (name LIKE 'connections:%' OR name IN ('style:admission','style','style:rail','style:retrieval_admission')) ORDER BY created_at`, [state.capture.job_id]);
  return JSON.stringify({ calls: qloo.calls, reading: await currentReading(state), traces: traces.rows });
}

describe('v10 real worker/compiler/DB/getCapture with synthetic asset-provider injection', () => {
  it('recovers a grounded observed stripe, preserves actual tags and persists the exact source/query/image binding', async () => {
    const assets = syntheticAssets();
    const qloo = stripeQloo();
    const state = await prepare([shirt()], qloo, { assets: assets.provider });
    const { view, recommendations } = await finish(state);
    expect(connections(view).map((card) => card.title)).toEqual([stripedBrand().name]);
    expect(recommendations).toHaveLength(1);
    const row = recommendations[0]!, proof = row.style_match.discovery_proof;
    expect(row).toMatchObject({ rail: 'more_like_this', origin: 'qloo', reading_rev: 1 });
    expect(proof).toMatchObject({ relation: 'shared_design', subjectId: 's1', candidateId: stripedBrand().entity_id,
      readingRev: 1, claim: { slot: 'construction', name: 'Stripes' },
      sourceEvidence: { readingRev: 1, observationIds: ['o2'] },
      assetEvidence: { identity: 'corroborated', imageUrl: imageUrl(stripedBrand().entity_id) } });
    expect(proof.sourceEvidence.featureIds).toHaveLength(1);
    expect(proof.candidateTags).toContainEqual({ id: stripedBrand().tags[2]!.id, label: 'Striped shirts' });
    expect(row.style_match.actual_candidate_types).toEqual([BRAND]);
    expect(row.provider_query_ids).toEqual([proof.sourceQueryId]);
    const providerQuery = await db.query<{ query_context: { subject_id: string; source_feature_ids: string[] }; results: { entity_id: string }[] }>(
      'SELECT query_context,results FROM provider_queries WHERE id=$1', [proof.sourceQueryId]);
    expect(providerQuery.rows[0]!.query_context).toMatchObject({ subject_id: 's1', source_feature_ids: proof.sourceEvidence.featureIds });
    expect(providerQuery.rows[0]!.results.some((candidate) => candidate.entity_id === proof.candidateId)).toBe(true);
    expect((await currentReading(state)).subjects[0]!.observations).toEqual(shirt().observations);
    expect(assets.check).toHaveBeenCalledTimes(1);
    expect(assets.check.mock.calls[0]![2]).toMatchObject({ captureId: state.capture.capture_id, jobId: state.capture.job_id });
    expect(qloo.calls.filter((call) => call.op === 'insights').map((call) => call.req)).toContainEqual({
      filterType: BRAND, filterTags: [striped.id], filterTagsOperator: 'intersection', take: 20, explainability: false,
    });
  });

  it('publishes only the centrally supported coffee film and stores its original exact excerpt/range', async () => {
    const assets = syntheticAssets(), supported = coffeeFilm();
    const incidental = coffeeFilm('SYNTHETIC-INCIDENTAL', 'A man drinks coffee before joining a bank robbery.');
    const qloo = new FakeQloo({
      tags: (query) => [coffee, documentary].filter((tag) => tag.name === query),
      insights: () => ({ entities: [incidental, { ...supported, entity_id: 'SYNTHETIC-WRONG-TYPE', types: [BRAND] }, supported], tags: [] }),
    }, { live: true });
    const state = await prepare([coffeeSource()], qloo, { assets: assets.provider });
    const { view, recommendations } = await finish(state);
    expect(connections(view).map((card) => card.title), await diagnostics(state, qloo)).toEqual([supported.name]);
    expect(view.recommendations.map((card) => card.title)).toEqual([supported.name]);
    expect(recommendations).toHaveLength(1);
    const content = recommendations[0]!.style_match.discovery_proof.contentEvidence!;
    expect(content).toMatchObject({ focus: 'central', topicPlanKey: 'coffee', excerpt: supported.properties.description,
      topicTag: { id: coffee.id }, documentaryTag: { id: documentary.id } });
    expect(content.context[content.field]!.slice(content.range.start, content.range.end)).toBe(content.excerpt);
    expect(qloo.calls.filter((call) => call.op === 'tags' && (call.req as { query: string }).query === 'documentary')).toHaveLength(1);
    expect(qloo.calls.filter((call) => call.op === 'insights').map((call) => call.req)).toEqual([{
      filterType: MOVIE, filterTags: [coffee.id, documentary.id], filterTagsOperator: 'intersection', take: 20, explainability: false,
    }]);
    expect(assets.check.mock.calls.map(([metadata]) => metadata.candidateId)).toEqual([supported.entity_id]);
  });

  it.each(['absent', 'text-only', 'low-certainty'] as const)('does not upgrade an old %s source into grounded v10 evidence', async (mode) => {
    const assets = syntheticAssets(), ungrounded = shirt();
    if (mode === 'absent') delete ungrounded.observations;
    else ungrounded.observations = ungrounded.observations!.map((obs) => ({
      ...obs, ...(mode === 'text-only' ? { kind: 'text' as const } : { certainty: 0.49 }),
    }));
    const state = await prepare([ungrounded], stripeQloo(), { assets: assets.provider });
    const { view, recommendations } = await finish(state);
    expect(connections(view)).toEqual([]);
    expect(recommendations).toEqual([]);
    expect(assets.check).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'throw'] as const)('allocates at most three compiler-wide asset attempts, including %s failures, not three successes', async (failure) => {
    const assets = syntheticAssets(failure);
    const state = await prepare([shirt()], stripeQloo(Array.from({ length: 7 }, (_, i) => stripedBrand(`SYNTHETIC-BRAND-${i}`))), { assets: assets.provider });
    const { view, recommendations } = await finish(state);
    expect(assets.check).toHaveBeenCalledTimes(3);
    expect(new Set(assets.check.mock.calls.map(([metadata]) => metadata.candidateId)).size).toBe(3);
    expect(connections(view)).toEqual([]);
    expect(recommendations).toEqual([]);
    const traces = await db.query<{ data: { allocated_attempts_this_run: number } }>(
      `SELECT data FROM trace_events WHERE job_id=$1 AND name='connections:publication_gate'`, [state.capture.job_id]);
    expect(traces.rows.length).toBeGreaterThan(0);
    expect(Math.max(...traces.rows.map((trace) => trace.data.allocated_attempts_this_run))).toBe(3);
  });

  it.each(['default-off', 'unconfigured'] as const)('fails closed when asset checking is %s despite a grounded source and real DB retrieval', async (mode) => {
    const assets = syntheticAssets(), qloo = stripeQloo();
    const state = await prepare([shirt()], qloo, {
      ...(mode === 'default-off' ? { assets: assets.provider, assetChecks: 'default' as const } : {}),
    });
    expect(state.ctx.config.CONNECTION_MAX_ASSET_CHECKS_PER_CAPTURE).toBe(mode === 'default-off' ? 0 : 3);
    const { view, recommendations } = await finish(state);
    expect(qloo.calls.some((call) => call.op === 'insights')).toBe(true);
    expect(connections(view)).toEqual([]);
    expect(recommendations).toEqual([]);
    expect(assets.check).not.toHaveBeenCalled();
  });

  it('shares one transactional capture-wide taste slot across two original subject rails', async () => {
    const assets = syntheticAssets();
    let next = 0;
    const qloo = new FakeQloo({
      tags: () => [],
      insights: (req) => {
        if (req.filterType !== BRAND) return { entities: [], tags: [] };
        const id = `SYNTHETIC-TASTE-${next++}`;
        return { entities: [{ entity_id: id, name: `Synthetic furniture taste ${id}`, types: [BRAND],
          properties: { image: { url: imageUrl(id) } },
          tags: [{ id: 'urn:tag:industry:qloo:furniture', name: 'Furniture' }, { id: 'urn:tag:signature_product:qloo:walnut', name: 'Walnut' }],
          query: { explainability: (req.signalEntities ?? []).slice(0, 1).map((entity_id) => ({ entity_id, score: 0.8 })) },
        }], tags: [] };
      },
    }, { live: true });
    const chairs = ['s1', 's2'].map((id, i) => {
      const region = { x: i * 0.55, y: 0, w: 0.45, h: 1 };
      return { ...subject(id, 'interior', 'Walnut wooden chair'), region,
        observations: [{ ...observation('o1', 'Chair with a wooden back and legs'), region }] };
    });
    const state = await prepare(chairs, qloo, { assets: assets.provider, config: { STYLE_INTERIOR_BRANDS: 'true' } });
    const { view, recommendations } = await finish(state);
    expect(qloo.calls.filter((call) => call.op === 'insights' && (call.req as QlooInsightsRequest).filterType === BRAND)).toHaveLength(2);
    expect(assets.check, await diagnostics(state, qloo)).toHaveBeenCalledTimes(2); // Both candidates qualified before the shared SQL taste cap.
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.style_match.discovery_proof.relation).toBe('qloo_taste');
    expect(connections(view)).toHaveLength(1);
    expect(connections(view)[0]!.recommendation_id).toBe(recommendations[0]!.id);
  });

  it('shares the same SQL taste allowance between a More-like-this card and a cross-domain artist candidate', async () => {
    const assets = syntheticAssets();
    const chair = { ...subject('s1', 'interior', 'Walnut wooden chair'),
      observations: [observation('o1', 'Chair with wooden back and legs')] };
    const stripedSource = { ...shirt(), id: 's2' };
    const direct = stripedBrand('SYNTHETIC-STRIPED-BRIDGE');
    const qloo = new FakeQloo({
      tags: (query) => query === striped.name ? [striped] : [],
      insights: (req) => {
        const id = req.filterType === 'urn:entity:artist' ? 'SYNTHETIC-CROSS-TASTE' : 'SYNTHETIC-MLT-TASTE';
        return { entities: req.filterType === BRAND && req.filterTags?.includes(striped.id) ? [direct]
          : req.filterType === BRAND ? [{
            entity_id: id, name: 'Synthetic furniture taste', types: [BRAND], properties: { image: { url: imageUrl(id) } },
            tags: [{ id: 'urn:tag:industry:qloo:furniture', name: 'Furniture' },
              { id: 'urn:tag:signature_product:qloo:walnut', name: 'Walnut' }],
            query: { explainability: (req.signalEntities ?? []).slice(0, 1).map((entity_id) => ({ entity_id, score: 0.9 })) },
          }] : req.filterType === 'urn:entity:artist' ? [{
            entity_id: id, name: 'Synthetic jazz taste', types: ['urn:entity:artist'], properties: { image: { url: imageUrl(id) } },
            tags: [{ id: 'urn:tag:genre:music:jazz', name: 'Jazz' }],
            query: { explainability: [{ entity_id: direct.entity_id, score: 0.8 }] },
          }] : [], tags: [] };
      },
    }, { live: true });
    const state = await prepare([chair, stripedSource], qloo, { assets: assets.provider, config: { STYLE_INTERIOR_BRANDS: 'true' } });
    const { view, recommendations } = await finish(state);
    expect(qloo.calls.some((call) => call.op === 'insights' &&
      (call.req as QlooInsightsRequest).filterType === 'urn:entity:artist' &&
      (call.req as QlooInsightsRequest).signalEntities?.includes(direct.entity_id)), await diagnostics(state, qloo)).toBe(true);
    expect(assets.check.mock.calls.map(([metadata]) => metadata.candidateId), await diagnostics(state, qloo))
      .toContain('SYNTHETIC-CROSS-TASTE');
    expect(recommendations.filter((row) => row.style_match.discovery_proof.relation === 'qloo_taste')).toHaveLength(1);
    expect(recommendations.filter((row) => row.style_match.discovery_proof.relation === 'shared_design')).toHaveLength(1);
    expect(recommendations.find((row) => row.style_match.discovery_proof.relation === 'qloo_taste')?.rail).toBe('more_like_this');
    expect(connections(view)).toHaveLength(2);
    expect(assets.check.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('stage two retracts a published bound style-family card rather than silently relabeling its source/revision', async () => {
    const assets = syntheticAssets(), design = typedTag('mid-century modern');
    const chair: Subject = { ...subject('s1', 'interior', 'Wooden chair'),
      observations: [observation('o1', 'Chair with splayed tapered legs'), observation('o2', 'Open rail backrest', 'construction')],
      aesthetics: [{ name: 'Mid-century modern', certainty: 0.9, defining_features: ['splayed tapered legs', 'open rail backrest'],
        evidence_ids: ['o1', 'o2'], evidence: { basis: 'visible', region: BOX }, tag_query: null }] };
    const candidate: QlooEntity = { entity_id: 'SYNTHETIC-MCM-BRAND', name: 'Synthetic furniture design brand', types: [BRAND],
      tags: [design, { id: 'urn:tag:industry:qloo:furniture', name: 'Furniture' }],
      properties: { image: { url: imageUrl('SYNTHETIC-MCM-BRAND') } } };
    const qloo = new FakeQloo({ tags: (query) => query === design.name ? [design] : [],
      insights: (req) => ({ entities: req.filterType === BRAND ? [candidate] : [], tags: [] }) }, { live: true });
    let before: View | undefined;
    let beforeRev = 0;
    const quick = VlmQuickRead.parse({ title: 'A wooden chair', interpretation: 'Tapered legs and an open backrest.',
      candidates: [{ name: 'Mid-century modern', type: 'style', relation: 'resembles', certainty: 0.8, categories: ['wear'], tag_query: null }],
      quality: { usable: true, issue: null } });
    const state: State = await prepare([chair], qloo, { assets: assets.provider, overrides: {
      vlm: { ...emptyQuick, analyzeImage: async () => ({ analysis: toVlmAnalysis(quick), quick, model: 'synthetic-fixture', durationMs: 1 }) },
      vlmEnrich: { id: 'vlm-enrich:synthetic-v10-veto', capability: () => ({ status: 'available', provider: 'fake' }),
        enrichImage: async () => {
          before = await captures.getCapture(state.ctx, { id: state.capture.capture_id });
          beforeRev = (await currentReading(state)).rev;
          return { enrichment: VlmEnrichment.parse(VlmEnrichmentV1.parse({ observations: [], visible_text: [],
            confirmed: [{ name: 'Mid-century modern', rationale: 'Synthetic stage-two veto of the style claim.', keep: false }],
            additional_candidates: [], regions: [], uncertainty: { overall: 'low', notes: [] }, competing_subjects: [] })),
          model: 'synthetic-fixture', durationMs: 1 };
        } },
    } });
    const { view, recommendations } = await finish(state);
    expect(connections(before!).map((card) => card.title)).toEqual([candidate.name]);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.hidden_at).not.toBeNull();
    expect(recommendations[0]!.style_match.discovery_proof.claim).toMatchObject({ slot: 'aesthetics', name: 'Mid-century modern' });
    const reading = await currentReading(state);
    expect(reading.rev).toBe(beforeRev + 1);
    expect(reading.subjects[0]!.aesthetics[0]!.retracted).toBe(true);
    expect(reading.retracted).toEqual(['subjects[s1].aesthetics[0]']);
    expect(connections(view)).toEqual([]);
    expect(assets.check).toHaveBeenCalledTimes(1);
  });

  it('rematches a persisted unchanged observed feature after an unrelated stage-two style veto, updating both proof and row revision', async () => {
    const assets = syntheticAssets(), source = shirt(), qloo = stripeQloo();
    source.observations![0]!.text = 'Loose shirt with dropped shoulders';
    source.aesthetics = [{ name: 'Streetwear', certainty: 0.9, defining_features: ['loose torso', 'dropped shoulders'],
      evidence_ids: ['o1', 'o2'], evidence: { basis: 'visible', region: BOX }, tag_query: null }];
    const quick = VlmQuickRead.parse({ title: 'A striped shirt', interpretation: 'A loose striped shirt.',
      candidates: [{ name: 'Streetwear', type: 'style', relation: 'resembles', certainty: 0.8, categories: ['wear'], tag_query: null }],
      quality: { usable: true, issue: null } });
    let before: Recommendation[] = [];
    let beforeRev = 0;
    const state: State = await prepare([source], qloo, { assets: assets.provider, overrides: {
      vlm: { ...emptyQuick, analyzeImage: async () => ({ analysis: toVlmAnalysis(quick), quick, model: 'synthetic-fixture', durationMs: 1 }) },
      vlmEnrich: { id: 'vlm-enrich:synthetic-unrelated-veto', capability: () => ({ status: 'available', provider: 'fake' }),
        enrichImage: async () => {
          before = await rows(state);
          beforeRev = (await currentReading(state)).rev;
          return { enrichment: VlmEnrichment.parse(VlmEnrichmentV1.parse({ observations: [], visible_text: [],
            confirmed: [{ name: 'Streetwear', rationale: 'Synthetic veto of the style, not the visible stripes.', keep: false }],
            additional_candidates: [], regions: [], uncertainty: { overall: 'low', notes: [] }, competing_subjects: [] })),
          model: 'synthetic-fixture', durationMs: 1 };
        } },
    } });
    const { view, recommendations } = await finish(state);
    expect(before).toHaveLength(1);
    expect(before[0]!.style_match.discovery_proof.claim.name).toBe('Stripes');
    const reading = await currentReading(state);
    expect(reading.rev).toBe(beforeRev + 1);
    expect(reading.subjects[0]!.aesthetics[0]!.retracted).toBe(true);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.id).toBe(before[0]!.id);
    expect(recommendations[0]!.hidden_at).toBeNull();
    const proof = recommendations[0]!.style_match.discovery_proof;
    expect(proof.sourceEvidence.featureIds).toEqual(before[0]!.style_match.discovery_proof.sourceEvidence.featureIds);
    expect([recommendations[0]!.reading_rev, proof.readingRev, proof.sourceEvidence.readingRev]).toEqual([reading.rev, reading.rev, reading.rev]);
    expect(connections(view)).toHaveLength(1);
    expect(assets.check).toHaveBeenCalledTimes(1);
  });

  it('does not invoke creative Eat in v10 even for a supported food reference; v9 retains the old creative contract', async () => {
    for (const version of [V10, V9]) {
      const composer = fakeComposer(), assets = syntheticAssets();
      const food = { ...vlmFixture('clear-outfit.json'),
        interpretation: 'A few vintage racing references stood out beside an aperitivo spritz.' };
      const state = await prepare([coffeeSource()], fakeQloo(), {
        assets: assets.provider, config: { COMPILER_VERSION: version },
        overrides: { vlm: new FakeVlm(() => structuredClone(food)), composer },
      });
      const { view } = await finish(state);
      expect(view.references.some((ref) => /aperitivo/i.test(ref.name))).toBe(true);
      const queries = await db.query(`SELECT id FROM provider_queries WHERE analysis_id=(SELECT active_analysis_id FROM captures WHERE id=$1)
        AND operation='dish_ideas'`, [state.capture.capture_id]);
      const creative = (await rows(state)).filter((row) => row.origin === 'vlm_creative');
      expect(queries.rows).toHaveLength(version === V10 ? 0 : 1);
      expect(composer.calls).toHaveLength(version === V10 ? 0 : 1);
      expect(creative).toHaveLength(version === V10 ? 0 : 1);
      if (version === V10) expect(connections(view).some((card) => card.category === 'eat')).toBe(false);
      else {
        expect(view.recommendations.some((card) => card.title === 'Fixture Spritz Bites')).toBe(true);
        expect(assets.check).not.toHaveBeenCalled();
      }
    }
    expect(legacyTestConfig().COMPILER_VERSION).toBe(V9);
    expect(testConfig().COMPILER_VERSION).toBe(V10);
  });
});
