import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError, captures, schemas, setFeatureKill, style, type ServiceContext } from '@culture-atlas/domain';
import { closeTestDb, getTestDb } from '@culture-atlas/domain/testing';
import {
  ProviderError,
  resolveFromWorkspace,
  VlmEnrichment,
  VlmEnrichmentV1,
  VlmQuickRead,
  toVlmAnalysis,
  type CapabilityEntry,
  type QlooEntity,
  type VlmAnalyzeInput,
  type VlmEnricher,
  type VlmEnrichInput,
  type VlmEnrichResult,
  type VlmProvider,
  type VlmResult,
  type VlmStyleInput,
  type VlmStyleReader,
  type VlmStyleReading,
  type VlmStyleResult,
} from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { CATALOG, accountCtx, runJobs, testJpeg, world } from './test-world';

/**
 * The style stage end to end (prp/2026-10-23-style-analysis §H.2) on a real
 * database with the real Worker. The style reading is a deterministic
 * fixture shaped like a vision_style output (never a provider result); Qloo
 * is a fake that returns Fixture-prefixed entities with real tag ids.
 */
const db = getTestDb();
afterAll(closeTestDb);

const AVAILABLE: CapabilityEntry = { status: 'available', provider: 'fake' };
const WORKWEAR = 'urn:tag:fashion_segment:qloo:workwear';
const CANVAS = 'urn:tag:material:qloo:canvas';

function jacketReading(over: Partial<VlmStyleReading['subjects'][number]> = {}): VlmStyleReading {
  return {
    schema: 'atlas_style_reading_v1',
    usable: true,
    unusable_reason: null,
    summary: 'A heavyweight canvas work jacket with a rugged, utilitarian look.',
    subjects: [
      {
        id: 's1',
        category: 'fashion',
        label: 'Canvas work jacket',
        region: { x: 0, y: 0, w: 1, h: 1 },
        aesthetics: [{ name: 'Workwear', certainty: 0.9, defining_features: ['duck canvas shell', 'corduroy collar'], evidence: { basis: 'visible', region: { x: 0.2, y: 0.1, w: 0.5, h: 0.3 } }, tag_query: 'Workwear' }],
        era: { name: '1950s–1970s American', certainty: 0.55, basis: 'visible', cue: 'boxy cut' },
        lineage: [],
        materials: [{ name: 'Canvas', texture: 'stiff, matte', certainty: 0.8, basis: 'visible', tag_query: 'Canvas' }],
        construction: [{ name: 'Boxy, hip-length cut', kind: 'silhouette', certainty: 0.85, basis: 'visible' }],
        palette: [{ swatch: 0, name: 'tobacco brown' }],
        mood: [{ name: 'rugged', certainty: 0.7 }, { name: 'sexy', certainty: 0.9 }],
        details: [{ text: 'metal snap closures at the cuffs', certainty: 0.75, evidence: { basis: 'visible', region: null } }],
        brand: null,
        ...over,
      },
    ],
  };
}

class FakeStyleReader implements VlmStyleReader {
  readonly id = 'vlm-style:fake';
  readonly inputs: VlmStyleInput[] = [];
  constructor(private readonly respond: (n: number) => VlmStyleReading | Error) {}
  capability() {
    return AVAILABLE;
  }
  async readStyle(input: VlmStyleInput): Promise<VlmStyleResult> {
    this.inputs.push(input);
    const out = this.respond(this.inputs.length);
    if (out instanceof Error) throw out;
    return { reading: structuredClone(out), model: 'fake-style', durationMs: 1, image: { width: 640, height: 480 } };
  }
}

const brand = (id: string, name: string, tags: { id: string; name: string }[], affinity: number): QlooEntity => ({
  entity_id: id,
  name,
  types: ['urn:entity:brand'],
  properties: {},
  tags,
  query: { affinity, explainability: [{ entity_id: 'X', score: 1 }] },
});

const SHOES = 'urn:tag:genre:brand:fashion:footwear';
const CASUAL = 'urn:tag:genre:brand:fashion:casual';

/**
 * Fixture Qloo: the fashion rail calls (smatch-1: a taste call signalled by catalogue brands and a
 * pool call that ranks catalogue brands) return on-style and off-style brands.
 */
function styleQloo(): FakeQloo {
  return new FakeQloo(
    {
      search: (query) => CATALOG.search[query.toLowerCase()] ?? [],
      tags: (query) => CATALOG.tags[query.toLowerCase()] ?? [],
      insights: (req) => {
        if (req.filterType === 'urn:entity:brand' && (req.signalEntities?.length || req.filterResultsEntities?.length) && !req.filterTags?.includes(SHOES))
          return {
            entities: [
              brand('FIXTURE-BRAND-0201', 'Fixture Work Co', [{ id: CASUAL, name: 'Casual' }, { id: WORKWEAR, name: 'Workwear' }, { id: CANVAS, name: 'Canvas' }, { id: 'urn:tag:price_level:qloo:_', name: '$$' }], 0.93),
              brand('FIXTURE-BRAND-0202', 'Fixture Duck Goods', [{ id: CASUAL, name: 'Casual' }, { id: WORKWEAR, name: 'Workwear' }], 0.91),
              brand('FIXTURE-BRAND-0203', 'Fixture Off Style', [{ id: CASUAL, name: 'Casual' }], 0.9),
              // A popular co-liked house of another product (eyewear only) is gated off a garment's rail.
              brand('FIXTURE-BRAND-0204', 'Fixture Eyewear House', [{ id: 'urn:tag:genre:brand:fashion:accessories:eyewear', name: 'Eyewear' }, { id: WORKWEAR, name: 'Workwear' }], 0.95),
            ],
            tags: [],
          };
        return { entities: CATALOG.insights[req.filterType] ?? [], tags: [] };
      },
    },
    { live: true },
  );
}

async function submit(ctx: ServiceContext) {
  return captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
}

async function analysisRow(captureId: string) {
  const { rows } = await db.query<{ id: string; section_statuses: Record<string, string>; style_reading: Record<string, unknown> | null; style_reading_version: string | null; experimental: boolean }>(
    `SELECT a.id, a.section_statuses, a.style_reading, a.style_reading_version, a.experimental FROM analyses a JOIN captures c ON c.active_analysis_id = a.id WHERE c.id = $1`,
    [captureId],
  );
  return rows[0]!;
}

describe('style reading and "More like this" (style design §H.2)', () => {
  it('publishes a guarded, worded reading and a rail of real Qloo ids with overlap reasons', async () => {
    const reader = new FakeStyleReader(() => jacketReading());
    const qloo = styleQloo();
    const { providers } = world({ overrides: { vlmStyle: reader, qloo } });
    const ctx = await accountCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);

    // The style call is independent of stage 1: swatches and the closed vocabulary only.
    expect(reader.inputs).toHaveLength(1);
    expect(reader.inputs[0]!.swatches.length).toBeGreaterThan(0);
    expect(reader.inputs[0]!.vocabulary.fashion).toContain('Workwear');

    const a = await analysisRow(capture_id);
    expect(a.section_statuses.style).toBe('ready');
    expect(a.section_statuses['more_like_this:s1']).toBe('ready');
    expect(Object.values(a.section_statuses)).not.toContain('running');
    expect(a.style_reading_version).toBe('atlas_style_reading_v1');
    expect(a.style_reading).toMatchObject({ schema: 'atlas_style_reading_v1', wording_version: 'sw-1', guard_version: 'guard-v18', vocab_version: 'svocab-1', model: { role: 'vision_style', model: 'fake-style', experimental: false } });

    const { rows: rail } = await db.query<{ title: string; rail: string; subject_id: string; display_reason: string | null; style_match: { claims: { name: string; tag_id: string }[] }; provider_query_ids: string[] }>(
      `SELECT title, rail, subject_id, display_reason, style_match, provider_query_ids FROM recommendations WHERE analysis_id = $1 AND rail = 'more_like_this' ORDER BY rank`,
      [a.id],
    );
    // smatch-1: on-style brands only, ranked by their own Qloo tags; the off-style and the eyewear house are left out.
    expect(rail.map((r) => r.title)).toEqual(['Fixture Work Co', 'Fixture Duck Goods']);
    expect(rail[0]).toMatchObject({ subject_id: 's1', display_reason: 'Known for workwear, like your photo' });
    expect(rail[0]!.display_reason).not.toMatch(/palette|tobacco/);
    expect(rail[0]!.style_match.claims.map((c) => c.tag_id)).toEqual([WORKWEAR, CANVAS]);
    for (const r of rail) expect(r.provider_query_ids.length).toBeGreaterThan(0);
    // The taste call is signalled by real catalogue brands (never invented ids) and filtered to fashion brands;
    // the pool call asks Qloo to rank catalogue brands.
    const vocabIds = new Set((JSON.parse(readFileSync(resolveFromWorkspace('fixtures/qloo/style-vocab/brands.json'), 'utf8')) as { brands: { id: string }[] }).brands.map((b) => b.id));
    const taste = qloo.calls.find((c) => c.op === 'insights' && ((c.req as { signalEntities?: string[] }).signalEntities?.length ?? 0) > 0)!;
    expect((taste.req as { signalEntities: string[] }).signalEntities.every((id) => vocabIds.has(id))).toBe(true);
    expect((taste.req as { filterTags: string[] }).filterTags).toEqual(['urn:tag:genre:brand:fashion']);
    const pool = qloo.calls.find((c) => c.op === 'insights' && ((c.req as { filterResultsEntities?: string[] }).filterResultsEntities?.length ?? 0) > 0)!;
    expect((pool.req as { filterResultsEntities: string[] }).filterResultsEntities.every((id) => vocabIds.has(id))).toBe(true);

    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(schemas.CaptureResponse.safeParse(view).success).toBe(true);
    const subject = view.style_reading!.subjects[0]!;
    expect(subject.aesthetics).toEqual([{ name: 'Workwear', wording: 'asserted', display: 'Workwear', strength: 'clear', region: null, features: ['duck canvas shell', 'corduroy collar'] }]);
    expect(subject.mood.map((m) => m.display)).toEqual(['Feels rugged']);
    expect(subject.era).toEqual({ name: '1950s–1970s American', display: 'Suggests the 1950s–1970s American', wording: 'resembles' });
    expect(JSON.stringify(view.style_reading)).not.toContain('certainty');
    const mlt = view.rails!.find((r) => r.key === 'more_like_this:s1')!;
    expect(mlt).toMatchObject({ kind: 'more_like_this', title: 'More like this', subtitle: 'Workwear · Canvas', status: 'ready' });
    expect(mlt.cards.map((c) => [c.title, c.style_match?.attributes])).toEqual([
      ['Fixture Work Co', ['Workwear', 'Canvas']],
      ['Fixture Duck Goods', ['Workwear']],
    ]);
    // Old clients: `recommendations` stays the cross-domain list.
    expect(view.recommendations.some((c) => c.title === 'Fixture Work Co')).toBe(false);
    expect(view.analysis!.experimental).toBeNull();
    // Qloo budget (C.7): never more than 18 requests per job.
    const { rows: spent } = await db.query<{ n: number }>(`SELECT COALESCE(SUM(COALESCE((query_context->>'attempts')::int, 1)), 0)::int AS n FROM provider_queries WHERE analysis_id = $1 AND provider = 'qloo'`, [a.id]);
    expect(spent[0]!.n).toBeLessThanOrEqual(18);
  });

  it('a failed style call fails only the style section; "Try again" works once, then 409', async () => {
    let fail = true;
    const reader = new FakeStyleReader(() => (fail ? new ProviderError('model-gateway', 'timeout', 'Analysis timed out') : jacketReading()));
    const { providers } = world({ overrides: { vlmStyle: reader, qloo: styleQloo() } });
    const ctx = await accountCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    let a = await analysisRow(capture_id);
    expect(a.section_statuses.style).toBe('failed');
    expect(a.style_reading).toBeNull();
    expect(a.section_statuses.observations).toBe('complete');
    expect(Object.values(a.section_statuses)).not.toContain('running');

    fail = false;
    const retry = await style.retryStyle(ctx, { id: capture_id });
    expect(retry.sections).toEqual({ style: 'running' });
    expect((await analysisRow(capture_id)).section_statuses.style).toBe('running');
    await runJobs(ctx, [retry.job_id]);
    a = await analysisRow(capture_id);
    expect(a.section_statuses.style).toBe('ready');
    expect(a.style_reading).not.toBeNull();
    await expect(style.retryStyle(ctx, { id: capture_id })).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === 'conflict' && (e.details as { reason: string }).reason === 'retry_used');
  });

  it('the kill switch pauses an experimental style role (held), the photo is still read', async () => {
    const reader = new FakeStyleReader(() => jacketReading());
    const { providers } = world({ overrides: { vlmStyle: reader, qloo: styleQloo() } });
    const gateway = { experimentalRoles: new Set(['vision_style']), runners: {}, readiness: async () => ({}) } as unknown as NonNullable<typeof providers.modelGateway>;
    const ctx = await accountCtx({ ...providers, modelGateway: gateway });
    await setFeatureKill(db, { flag: 'experimental_analysis_enabled', accountId: (ctx.principal as { accountId: string }).accountId, reason: 'test', actor: 'test' });
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const a = await analysisRow(capture_id);
    expect(a.section_statuses.style).toBe('held');
    expect(reader.inputs).toHaveLength(0);
    expect(a.section_statuses.observations).toBe('complete');
    expect(a.experimental).toBe(true);
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.analysis!.experimental).toEqual({ label: 'Experimental', note: 'Photo and video readings are experimental. They can miss or misread details.' });
  });

  it('food and places use only the user\'s own city (C.6); without one the rail is an honest no_city', async () => {
    const ramen = (): VlmStyleReading => ({
      ...jacketReading(),
      subjects: [
        {
          ...jacketReading().subjects[0]!,
          category: 'food',
          label: 'Tonkotsu ramen bowl',
          aesthetics: [{ name: 'Ramen', certainty: 0.9, defining_features: ['chashu', 'soft eggs'], evidence: { basis: 'visible', region: null }, tag_query: 'Ramen' }],
          materials: [],
          mood: [],
          era: null,
        },
      ],
    });
    const qloo = new FakeQloo(
      {
        search: () => [],
        tags: (query) => (query === 'Ramen' ? [{ id: 'urn:tag:genre:place:restaurant:ramen', name: 'Ramen restaurant', type: 'urn:tag:genre:place', parents: ['urn:entity:place'] }] : []),
        insights: (req) =>
          req.filterType === 'urn:entity:place'
            ? {
                entities: [
                  { entity_id: 'FIXTURE-PLACE-0001', name: 'Fixture Ramen LA', types: ['urn:entity:place'], properties: { address: '1 Main St Los Angeles, CA' }, tags: [{ id: 'urn:tag:genre:place:restaurant:ramen', name: 'Ramen restaurant' }], query: { affinity: 0.9 } },
                  { entity_id: 'FIXTURE-PLACE-0002', name: 'Fixture Ramen SF', types: ['urn:entity:place'], properties: { address: '2 Main St San Francisco, CA' }, tags: [{ id: 'urn:tag:genre:place:restaurant:ramen', name: 'Ramen restaurant' }], query: { affinity: 0.8 } },
                ],
                tags: [],
              }
            : { entities: [], tags: [] },
      },
      { live: true },
    );
    const { providers } = world({ overrides: { vlmStyle: new FakeStyleReader(ramen), qloo } });
    const ctx = await accountCtx(providers);
    const first = await submit(ctx);
    await runJobs(ctx, [first.job_id]);
    const view = await captures.getCapture(ctx, { id: first.capture_id });
    expect(view.analysis!.sections.style, JSON.stringify(view.analysis!.sections)).toBe('ready');
    expect(view.rails!.find((r) => r.key === 'more_like_this:s1')).toMatchObject({ status: 'empty', empty_message: 'Add a city to see places with this style.', cards: [] });
    expect(qloo.calls.some((c) => c.op === 'insights' && (c.req as { filterType: string }).filterType === 'urn:entity:place')).toBe(false);

    await style.setCity(ctx, { body: { city: 'Los Angeles, CA' } });
    const second = await submit(ctx);
    await runJobs(ctx, [second.job_id]);
    const placeCall = qloo.calls.find((c) => c.op === 'insights' && (c.req as { filterType: string }).filterType === 'urn:entity:place')!;
    expect(placeCall.req).toMatchObject({ filterTags: ['urn:tag:genre:place:restaurant:ramen'], filterLocationQuery: 'Los Angeles, CA' });
    const after = await captures.getCapture(ctx, { id: second.capture_id });
    // The San Francisco result is outside the requested city: dropped (C.3 hygiene 3).
    expect(after.rails!.find((r) => r.key === 'more_like_this:s1')!.cards.map((c) => c.title)).toEqual(['Fixture Ramen LA']);
    await style.setCity(ctx, { body: { city: null } });
    const { rows } = await db.query<{ p: Record<string, unknown> }>('SELECT preferences AS p FROM accounts WHERE id = $1', [(ctx.principal as { accountId: string }).accountId]);
    expect(rows[0]!.p.city).toBeUndefined();
  });
});

const QUICK = VlmQuickRead.parse({
  title: 'A canvas work jacket',
  interpretation: 'A rugged canvas jacket stood out.',
  candidates: [{ name: 'Workwear', type: 'style', relation: 'resembles', certainty: 0.7, categories: ['wear'], tag_query: 'workwear' }],
  quality: { usable: true, issue: null },
});

class QuickVlm implements VlmProvider {
  readonly id = 'vlm:fake-quick';
  capability() {
    return AVAILABLE;
  }
  async analyzeImage(_input: VlmAnalyzeInput): Promise<VlmResult> {
    const quick = VlmQuickRead.parse(structuredClone(QUICK));
    return { analysis: toVlmAnalysis(quick), quick, model: 'fake-quick', durationMs: 1 };
  }
}

class VetoEnricher implements VlmEnricher {
  readonly id = 'vlm-enrich:fake';
  capability() {
    return AVAILABLE;
  }
  async enrichImage(_input: VlmEnrichInput): Promise<VlmEnrichResult> {
    const e = VlmEnrichmentV1.parse({
      observations: [],
      visible_text: [],
      confirmed: [{ name: 'Workwear', rationale: 'Plain cotton jacket, not workwear', keep: false }],
      additional_candidates: [],
      regions: [],
      uncertainty: { overall: 'low', notes: [] },
      competing_subjects: [],
    });
    return { enrichment: VlmEnrichment.parse(e), model: 'fake-enrich', durationMs: 1 };
  }
}

class EmptyQuickVlm implements VlmProvider {
  readonly id = 'vlm:fake-empty';
  capability() {
    return AVAILABLE;
  }
  async analyzeImage(_input: VlmAnalyzeInput): Promise<VlmResult> {
    const quick = VlmQuickRead.parse({ title: 'A sunlit room', interpretation: 'A bright room stood out.', candidates: [], quality: { usable: true, issue: null } });
    return { analysis: toVlmAnalysis(quick), quick, model: 'fake-empty', durationMs: 1 };
  }
}

describe('TOPIC-1: a room with nothing else to signal gets films Qloo tags with its topic', () => {
  it('fills Watch from theme-tagged films that share the reading, with a topic reason', async () => {
    const room = (): VlmStyleReading => ({
      ...jacketReading(),
      subjects: [
        {
          ...jacketReading().subjects[0]!,
          category: 'interior',
          label: 'Teak sideboard room',
          aesthetics: [{ name: 'Mid-century modern', certainty: 0.8, defining_features: ['tapered legs', 'teak veneer'], evidence: { basis: 'visible', region: null }, tag_query: null }],
          materials: [],
          mood: [],
          era: null,
        },
      ],
    });
    const film = (id: string, name: string, tags: { id: string; name: string }[]): QlooEntity => ({ entity_id: id, name, types: ['urn:entity:movie'], properties: {}, tags });
    const qloo = new FakeQloo(
      {
        search: () => [],
        tags: () => [],
        insights: (req) =>
          req.filterType === 'urn:entity:movie' && req.filterTags?.includes('urn:tag:theme:qloo:design')
            ? {
                entities: [
                  film('FIXTURE-FILM-0101', 'Fixture Car Design Story', [{ id: 'urn:tag:theme:qloo:design', name: 'Design' }]),
                  film('FIXTURE-FILM-0102', 'Fixture Modern House', [{ id: 'urn:tag:theme:qloo:architecture', name: 'Architecture' }, { id: 'urn:tag:keyword:qloo:fixture_midcentury', name: 'Midcentury modern' }]),
                ],
                tags: [],
              }
            : { entities: [], tags: [] },
      },
      { live: true },
    );
    const { providers } = world({ overrides: { vlm: new EmptyQuickVlm(), vlmStyle: new FakeStyleReader(room), qloo } });
    const ctx = await accountCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const view = await captures.getCapture(ctx, { id: capture_id });
    const call = qloo.calls.find((c) => c.op === 'insights' && (c.req as { filterType: string }).filterType === 'urn:entity:movie')!;
    expect((call.req as { filterTags: string[] }).filterTags).toEqual(['urn:tag:theme:qloo:design', 'urn:tag:theme:qloo:architecture']);
    const watch = view.rails!.find((r) => r.key === 'watch')!;
    // Only a film whose own tags echo the reading ("Midcentury modern") is shown; a film that shares only
    // the topic ("Design") is not a match. The reason names the film's own theme.
    expect(watch.cards.map((c) => [c.title, c.reason])).toEqual([['Fixture Modern House', 'A film about architecture, for the teak sideboard room in your photo']]);
    // A decor style tag is never a Wear card.
    expect(view.recommendations.filter((r) => r.category === 'wear')).toEqual([]);
  });
});

describe('stage-2 corroboration pass (style design §A.6, R-6)', () => {
  it('a stage-2 veto retracts the claim; no card reason names it afterwards and cards that only shared it are hidden', async () => {
    const { providers } = world({ overrides: { vlm: new QuickVlm(), vlmEnrich: new VetoEnricher(), vlmStyle: new FakeStyleReader(() => jacketReading()), qloo: styleQloo() } });
    const ctx = await accountCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const a = await analysisRow(capture_id);
    expect((a.style_reading as { retracted: string[] }).retracted).toEqual(['subjects[s1].aesthetics[0]']);
    const { rows } = await db.query<{ title: string; display_reason: string | null; hidden_at: Date | null }>(
      `SELECT title, display_reason, hidden_at FROM recommendations WHERE analysis_id = $1 AND rail = 'more_like_this' ORDER BY rank`,
      [a.id],
    );
    for (const r of rows) if (!r.hidden_at) expect(r.display_reason ?? '').not.toMatch(/workwear/i);
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.style_reading!.retracted).toEqual(['subjects[s1].aesthetics[0]']);
    expect(view.style_reading!.subjects[0]!.aesthetics).toEqual([]);
    for (const c of view.rails!.find((r) => r.key === 'more_like_this:s1')?.cards ?? []) expect(c.style_match!.attributes).not.toContain('Workwear');
  });
});
