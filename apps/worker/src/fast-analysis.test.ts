import { afterAll, describe, expect, it } from 'vitest';
import { CATEGORIES, captures, LIMITS, setFeatureKill, type ServiceContext } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, testConfig } from '@culture-atlas/domain/testing';
import {
  ProviderError,
  VlmEnrichment,
  VlmEnrichmentV1,
  VlmQuickRead,
  toVlmAnalysis,
  type CapabilityEntry,
  type QlooProvider,
  type VlmAnalyzeInput,
  type VlmEnricher,
  type VlmEnrichInput,
  type VlmEnrichResult,
  type VlmProvider,
  type VlmResult,
} from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { CATALOG, accountCtx, anonCtx, fakeQloo, runJobs, testJpeg, vlmFixture, world } from './test-world';

/**
 * Two-stage photo reading in the compiler (amendment 2.2, FAST-02) on a real
 * database with the real Worker. Model outputs are deterministic fixtures
 * shaped like the measured stage-1/stage-2 readings; nothing is a provider
 * result, and Qloo is the fixture-backed fake.
 */
const db = getTestDb();
afterAll(closeTestDb);

const AVAILABLE: CapabilityEntry = { status: 'available', provider: 'fake' };
const MCM_TAG = CATALOG.tags['mid-century modern']![0]!.id;

const QUICK = VlmQuickRead.parse({
  title: 'Vintage racing references',
  // Food in the reading: the aperitivo resemblance needs it (G-CUISINE-FOOD covers every food-domain claim).
  interpretation: 'A few vintage racing references stood out beside a spritz on the table.',
  candidates: [
    { name: 'Fixture Denim Co', type: 'brand', relation: 'depicted', certainty: 0.9, categories: ['wear'], tag_query: null },
    {
      name: '1960s motor racing style',
      type: 'style',
      relation: 'resembles',
      certainty: 0.6,
      categories: ['wear', 'watch', 'play'],
      tag_query: 'vintage racing',
    },
    { name: 'Italian aperitivo culture', type: 'tradition', relation: 'resembles', certainty: 0.4, categories: ['eat'], tag_query: null },
  ],
  quality: { usable: true, issue: null },
});

const ENRICHMENT = VlmEnrichmentV1.parse({
  observations: [{ text: 'Leather driving gloves', kind: 'garment' }],
  visible_text: ['FIXTURE DENIM'],
  confirmed: [
    { name: 'Fixture Denim Co', rationale: 'Legible chest wordmark', keep: true },
    { name: '1960s motor racing style', rationale: 'Gloves may be ordinary winter gloves', keep: false },
    { name: 'Italian aperitivo culture', rationale: 'Spritz glass on the table', keep: true },
  ],
  additional_candidates: [
    {
      name: 'Mid-Century Modern',
      type: 'style',
      relation: 'resembles',
      certainty: 0.5,
      categories: ['watch'],
      tag_query: 'mid-century modern',
      rationale: 'Teak side table behind the chair',
    },
  ],
  regions: [{ label: 'Fixture Denim Co', box: { x: 0.45, y: 0.3, w: 0.1, h: 0.05 } }],
  uncertainty: { overall: 'medium', notes: ['Gloves are partly hidden'] },
  competing_subjects: [],
});

/** Stage 1 as the Concentrate quick read returns it: merged analysis plus the quick read. */
class QuickVlm implements VlmProvider {
  readonly id = 'vlm:fake-quick';
  readonly calls: VlmAnalyzeInput[] = [];
  constructor(private readonly quick: VlmQuickRead = QUICK) {}
  capability() {
    return AVAILABLE;
  }
  async analyzeImage(input: VlmAnalyzeInput): Promise<VlmResult> {
    this.calls.push(input);
    const quick = VlmQuickRead.parse(structuredClone(this.quick));
    return { analysis: toVlmAnalysis(quick), quick, model: 'fake-quick', durationMs: 1 };
  }
}

class ScriptedEnricher implements VlmEnricher {
  readonly id = 'vlm-enrich:fake';
  readonly calls: VlmEnrichInput[] = [];
  constructor(private readonly respond: (input: VlmEnrichInput) => Promise<VlmEnrichment | Error>) {}
  capability() {
    return AVAILABLE;
  }
  async enrichImage(input: VlmEnrichInput): Promise<VlmEnrichResult> {
    this.calls.push(input);
    const out = await this.respond(input);
    if (out instanceof Error) throw out;
    return { enrichment: VlmEnrichment.parse(out), model: 'fake-enrich', durationMs: 1 };
  }
}

/** The fixture Qloo, plus one extra film that only a mid-century signal returns. */
function qlooWithEnrichmentFilm(): FakeQloo {
  return new FakeQloo(
    {
      search: (query) => CATALOG.search[query.toLowerCase()] ?? [],
      tags: (query) => CATALOG.tags[query.toLowerCase()] ?? [],
      insights: (req) => {
        if (req.filterType === 'urn:entity:movie' && (req.signalTags ?? []).some((t) => t.id === MCM_TAG))
          return {
            entities: [
              { entity_id: 'FIXTURE-MOVIE-0003', name: 'Fixture Film Three', types: ['urn:entity:movie'], properties: { release_year: 1958 }, tags: [] },
              ...(CATALOG.insights['urn:entity:movie'] ?? []),
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

async function recRows(captureId: string) {
  const { rows } = await db.query<{ id: string; category: string; title: string; rank: number }>(
    `SELECT r.id, r.category, r.title, r.rank FROM recommendations r JOIN analyses a ON a.id = r.analysis_id
      WHERE a.capture_id = $1 ORDER BY r.rank, r.id`,
    [captureId],
  );
  return rows;
}

async function stageTrace(jobId: string, name: string) {
  const { rows } = await db.query<{ data: Record<string, unknown> }>(
    `SELECT data FROM trace_events WHERE job_id = $1 AND name = $2 ORDER BY created_at DESC LIMIT 1`,
    [jobId, name],
  );
  return rows[0]?.data;
}

describe('two-stage photo reading (FAST-02)', () => {
  it('stage 2 adds reasons, evidence and references without reordering or removing published cards', async () => {
    let captureId = '';
    let before: Awaited<ReturnType<typeof recRows>> = [];
    let beforeRefs: string[] = [];
    let ownerCtx: ServiceContext | null = null;
    const enricher = new ScriptedEnricher(async () => {
      // Everything stage 1 published is visible before stage 2 lands.
      before = await recRows(captureId);
      beforeRefs = (await captures.getCapture(ownerCtx!, { id: captureId })).references.map((r) => r.name);
      return ENRICHMENT;
    });
    const vlm = new QuickVlm();
    const { providers } = world({ overrides: { vlm, vlmEnrich: enricher, qloo: qlooWithEnrichmentFilm() } });
    const ctx = await accountCtx(providers);
    ownerCtx = ctx;
    const { capture_id, job_id } = await submit(ctx);
    captureId = capture_id;
    await runJobs(ctx, [job_id]);

    expect(vlm.calls).toHaveLength(1);
    expect(vlm.calls[0]!.maxCandidates).toBe(5);
    expect(enricher.calls).toHaveLength(1);
    // Stage 2 checks the published candidates, then the held claim (guardrails: a brand
    // never publishes from stage 1 alone).
    expect(enricher.calls[0]!.stage1).toEqual({
      title: 'Vintage racing references',
      candidates: ['1960s motor racing style', 'Italian aperitivo culture', 'Fixture Denim Co'],
    });
    expect(beforeRefs).not.toContain('Fixture Denim Co');
    expect(enricher.calls[0]!.image.mediaType).toBe('image/jpeg');

    // FAST-02: every card published before stage 2 is still there, same row, same rank, same order.
    expect(before.length).toBeGreaterThan(0);
    const after = await recRows(capture_id);
    for (const b of before) expect(after.find((a) => a.id === b.id)).toEqual(b);
    const kept = after.filter((a) => before.some((b) => b.id === a.id)).map((a) => a.id);
    expect(kept).toEqual(before.map((b) => b.id));
    // ...and they keep their displayed positions: a card stage 2 appends ranks after every card
    // already published in ANY category (not interleaved by category), so it cannot push a shown card
    // out of the first rendered cards.
    // A thin category (two films) was filled after its published cards from the new reference.
    const films = after.filter((a) => a.category === 'watch');
    expect(films.map((f) => f.title)).toEqual(['Fixture Film One', 'Fixture Film Two', 'Fixture Film Three']);
    expect(films[2]!.rank).toBeGreaterThan(Math.max(...before.map((b) => b.rank)));
    // Beyond every rank stage 1 can give, so stage-1 sections that land later (Eat) still precede it.
    expect(films[2]!.rank).toBeGreaterThanOrEqual(LIMITS.recommendationsPerCategory * CATEGORIES.length);
    const appendedIds = new Set([films[2]!.id]);
    const shownBefore = after.filter((a) => !appendedIds.has(a.id)).map((a) => a.id);
    expect(after.slice(0, shownBefore.length).map((a) => a.id)).toEqual(shownBefore);
    for (const c of ['wear', 'play', 'watch', 'eat']) expect(after.filter((a) => a.category === c).length).toBeLessThanOrEqual(3);

    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.status).toBe('ready');
    // The advisory veto only lowers certainty: the style card and the reference both stay, the reference
    // keeps its place and now reads as qualified; the reference stage 2 added comes after every published one.
    expect(view.recommendations.map((r) => r.title)).toContain('Vintage Racing');
    expect(beforeRefs).toContain('Vintage Racing');
    const names = view.references.map((r) => r.name);
    expect(names.slice(0, beforeRefs.length)).toEqual(beforeRefs);
    expect(names.slice(beforeRefs.length)).toEqual(expect.arrayContaining(['Fixture Denim Co', 'Mid-Century Modern']));
    expect(view.references.find((r) => r.name === 'Vintage Racing')!.qualified).toBe(true);
    const { rows: refs } = await db.query<{ name: string; certainty: number; advisory_veto: boolean; is_anchor: boolean; evidence_region: { boxes: unknown[] } }>(
      `SELECT r.canonical_name AS name, cr.certainty, cr.advisory_veto, cr.is_anchor, cr.evidence_region
         FROM capture_references cr JOIN cultural_references r ON r.id = cr.reference_id
         JOIN analyses a ON a.id = cr.analysis_id WHERE a.capture_id = $1`,
      [capture_id],
    );
    const racing = refs.find((r) => r.name === 'Vintage Racing')!;
    expect(racing).toMatchObject({ advisory_veto: true, is_anchor: true, certainty: 0.3 });
    // The held brand published only after stage 2 read it (G-BRAND-CORROBORATE), through the append path.
    expect(refs.find((r) => r.name === 'Fixture Denim Co')).toMatchObject({ advisory_veto: false, certainty: 0.9, is_anchor: false });
    expect(refs.find((r) => r.name === 'Fixture Denim Co')!.evidence_region.boxes).toHaveLength(1);
    expect(refs.find((r) => r.name === 'Mid-Century Modern')).toMatchObject({ advisory_veto: false, is_anchor: false });

    // The inspector reading gains rationales, observations and visible text; the title stays.
    const { rows: analysis } = await db.query<{ title: string; observations: { text: string }[]; candidates: { name: string; rationale: string; boxes: unknown[] }[] }>(
      `SELECT a.title, a.observations, a.candidates FROM analyses a WHERE a.capture_id = $1`,
      [capture_id],
    );
    expect(analysis[0]!.title).toBe('Vintage racing references');
    expect(analysis[0]!.observations.map((o) => o.text)).toEqual(['Leather driving gloves', 'FIXTURE DENIM']);
    expect(analysis[0]!.candidates.map((c) => [c.name, c.rationale])).toEqual([
      ['1960s motor racing style', 'Gloves may be ordinary winter gloves'],
      ['Italian aperitivo culture', 'Spritz glass on the table'],
      ['Fixture Denim Co', 'Legible chest wordmark'],
      ['Mid-Century Modern', 'Teak side table behind the chair'],
    ]);

    const { rows: pq } = await db.query<{ status: string; results: { confirmed: unknown[] } }>(
      `SELECT pq.status, pq.results FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id
        WHERE a.capture_id = $1 AND pq.provider = 'vlm' AND pq.operation = 'enrich_image'`,
      [capture_id],
    );
    expect(pq).toHaveLength(1);
    expect(pq[0]!.status).toBe('ok');
    expect(await stageTrace(job_id, 'enrich')).toMatchObject({ status: 'complete', vetoed: 1, additions: 2, heldPublished: 1, resolvedAdditions: 2, appended: { watch: 1 } });
    // Both guard passes are in the trace for the inspector.
    const { rows: guard } = await db.query<{ data: { stage: number; decisions: { name: string; action: string; rules: string[] }[] } }>(
      `SELECT data FROM trace_events WHERE job_id = $1 AND name = 'guard' ORDER BY created_at`,
      [job_id],
    );
    expect(guard.map((g) => g.data.stage)).toEqual([1, 2]);
    expect(guard[0]!.data.decisions.find((d) => d.name === 'Fixture Denim Co')).toMatchObject({ action: 'hold', rules: ['G-DEPICTED', 'G-BRAND'] });
    expect(guard[1]!.data.decisions.find((d) => d.name === 'Fixture Denim Co')).toMatchObject({
      action: 'publish',
      rules: ['G-VERDICT', 'G-BRAND-CORROBORATE', 'G-CATEGORY'],
    });
    // Budget: the per-job Qloo cap still holds with the stage-2 lookups.
    const { rows: q } = await db.query<{ n: number }>(
      `SELECT COALESCE(SUM((pq.query_context->>'attempts')::int), 0)::int AS n FROM provider_queries pq
         JOIN analyses a ON a.id = pq.analysis_id WHERE a.capture_id = $1 AND pq.provider = 'qloo'`,
      [capture_id],
    );
    expect(q[0]!.n).toBeLessThanOrEqual(12);
  });

  it('a failed enrichment leaves every stage-1 result exactly as published', async () => {
    const run = async (enrich: boolean) => {
      const enricher = new ScriptedEnricher(async () => new ProviderError('model-gateway', 'timeout', 'Analysis timed out'));
      const { providers } = world({ overrides: { vlm: new QuickVlm(), ...(enrich ? { vlmEnrich: enricher } : {}) } });
      const ctx = await accountCtx(providers);
      const { capture_id, job_id } = await submit(ctx);
      await runJobs(ctx, [job_id]);
      const view = await captures.getCapture(ctx, { id: capture_id });
      return { view, enricher, job_id, capture_id };
    };
    const single = await run(false);
    const failed = await run(true);
    expect(failed.enricher.calls).toHaveLength(1);
    expect(failed.view.status).toBe(single.view.status);
    expect(failed.view.analysis!.sections).toEqual(single.view.analysis!.sections);
    expect(failed.view.recommendations.map((r) => [r.category, r.title])).toEqual(single.view.recommendations.map((r) => [r.category, r.title]));
    expect(failed.view.references.map((r) => r.name)).toEqual(single.view.references.map((r) => r.name));
    expect(await stageTrace(failed.job_id, 'enrich')).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(await stageTrace(single.job_id, 'enrich')).toMatchObject({ status: 'skipped', reason: 'enrich_unavailable' });
    const { rows } = await db.query<{ status: string; error_code: string }>(
      `SELECT pq.status, pq.error_code FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id
        WHERE a.capture_id = $1 AND pq.operation = 'enrich_image'`,
      [failed.capture_id],
    );
    expect(rows).toEqual([{ status: 'error', error_code: 'timeout' }]);
  });

  it('runs stage 2 only for a quick read, and never when fast_analysis_two_stage is killed', async () => {
    const enricher = new ScriptedEnricher(async () => ENRICHMENT);
    // The legacy single full reading (or a fallback model's) carries no quick read.
    const full = world({ vlm: vlmFixture('clear-outfit.json'), overrides: { vlmEnrich: enricher } });
    const ctx1 = await accountCtx(full.providers);
    const a = await submit(ctx1);
    await runJobs(ctx1, [a.job_id]);
    expect(await stageTrace(a.job_id, 'enrich')).toMatchObject({ status: 'skipped', reason: 'single_stage_reading' });

    // Environment kill switch.
    const quick = world({ overrides: { vlm: new QuickVlm(), vlmEnrich: enricher } });
    const ctx2 = await accountCtx(quick.providers, testConfig({ FEATURE_KILL_SWITCHES: 'fast_analysis_two_stage' }));
    const b = await submit(ctx2);
    await runJobs(ctx2, [b.job_id]);
    expect(await stageTrace(b.job_id, 'enrich')).toMatchObject({ status: 'skipped', reason: 'killed' });

    // Per-account database kill (runbook): other accounts keep stage 2.
    const ctx3 = await accountCtx(quick.providers);
    const accountId = (ctx3.principal as { accountId: string }).accountId;
    await setFeatureKill(db, { flag: 'fast_analysis_two_stage', accountId, reason: 'test', actor: 'test' });
    const c = await submit(ctx3);
    await runJobs(ctx3, [c.job_id]);
    expect(await stageTrace(c.job_id, 'enrich')).toMatchObject({ status: 'skipped', reason: 'killed' });
    expect(enricher.calls).toHaveLength(0);

    const ctx4 = await accountCtx(quick.providers);
    const d = await submit(ctx4);
    await runJobs(ctx4, [d.job_id]);
    expect(await stageTrace(d.job_id, 'enrich')).toMatchObject({ status: 'complete' });
    expect(enricher.calls).toHaveLength(1);
  });

  it('caps Qloo resolution at 5 candidates and 3 concurrent requests per analysis', async () => {
    // Styles that pass every guardrail (brands would be held until stage 2 reads them).
    const names = ['Alpha Fixture', 'Beta Fixture', 'Gamma Fixture', 'Delta Fixture', 'Epsilon Fixture'];
    const quick = VlmQuickRead.parse({
      ...QUICK,
      candidates: names.map((name, i) => ({ name, type: 'style', relation: 'resembles', certainty: 0.9 - i * 0.1, categories: ['wear'], tag_query: name })),
    });
    const extra = ['Zeta Fixture', 'Eta Fixture', 'Theta Fixture', 'Iota Fixture'];
    // No visible text: a style whose name shares a word with text read on the photo would be held (G-TEXT-ECHO).
    const enricher = new ScriptedEnricher(async () => ({
      ...ENRICHMENT,
      visible_text: [],
      confirmed: [],
      additional_candidates: extra.map((name) => ({ ...ENRICHMENT.additional_candidates[0]!, name, type: 'style' as const, tag_query: name })),
    }));
    const inner = fakeQloo();
    let inFlight = 0;
    let maxInFlight = 0;
    const lookups: string[] = [];
    const slow = <A extends unknown[], R>(op: string, fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        if (op !== 'insights') lookups.push(op);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise((r) => setTimeout(r, 15));
          return await fn(...args);
        } finally {
          inFlight--;
        }
      };
    const qloo: QlooProvider = {
      id: inner.id,
      capability: () => inner.capability(),
      searchEntities: slow('search', (req) => inner.searchEntities(req)),
      lookupTags: slow('tags', (req) => inner.lookupTags(req)),
      insights: slow('insights', (req) => inner.insights(req)),
      trending: (req) => inner.trending(req),
      entityTrends: (req) => inner.entityTrends(req),
    };
    const { providers } = world({ overrides: { vlm: new QuickVlm(quick), vlmEnrich: enricher, qloo } });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    expect(enricher.calls).toHaveLength(1);
    expect(lookups).toHaveLength(5);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
    // The four additions stay in the inspector reading; none was sent to Qloo past the cap.
    const { rows } = await db.query<{ candidates: { name: string }[] }>('SELECT candidates FROM analyses WHERE capture_id = $1', [capture_id]);
    expect(rows[0]!.candidates.map((c) => c.name)).toEqual([...names, ...extra]);
    expect(await stageTrace(job_id, 'enrich')).toMatchObject({ status: 'complete', additions: 4, resolvedAdditions: 0 });
  });
});
