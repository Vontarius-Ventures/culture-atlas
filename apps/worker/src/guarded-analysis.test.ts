import { afterAll, describe, expect, it } from 'vitest';
import { captures, type ServiceContext } from '@culture-atlas/domain';
import { closeTestDb, getTestDb } from '@culture-atlas/domain/testing';
import {
  ProviderError,
  VlmEnrichment,
  VlmQuickRead,
  toVlmAnalysis,
  type CapabilityEntry,
  type VlmAnalyzeInput,
  type VlmEnricher,
  type VlmEnrichInput,
  type VlmEnrichResult,
  type VlmProvider,
  type VlmResult,
} from '@culture-atlas/providers';
import { accountCtx, fakeQloo, runJobs, testJpeg, world } from './test-world';

/**
 * Reading guardrails in the compiler (docs/quality-plan.md §4) on a real
 * database with the real Worker. Readings are FIXTURE data in the reading-v2
 * shape; nothing is a provider result, and Qloo is the fixture-backed fake.
 *  - only the publish set is published, resolved and anchored at stage 1;
 *  - held claims publish only on a binding stage-2 verdict, through the
 *    append path, and never when stage 2 fails (fail closed);
 *  - FAST-02 holds: no published card or reference is removed or reordered;
 *  - every decision is in the analysis trace.
 */
const db = getTestDb();
afterAll(closeTestDb);

const AVAILABLE: CapabilityEntry = { status: 'available', provider: 'fake' };

const QUICK = VlmQuickRead.parse({
  title: 'Bike and racing jacket still life',
  interpretation: 'A painting of a bike beside a racing jacket.',
  candidates: [
    { name: 'Vintage Racing', type: 'style', relation: 'resembles', certainty: 0.7, domain: 'fashion', evidence: 'distinctive_form', evidence_text: null, tag_query: 'vintage racing' },
    { name: 'Mughal architecture', type: 'style', relation: 'resembles', certainty: 0.6, domain: 'architecture', evidence: 'distinctive_form', evidence_text: null, tag_query: 'mughal architecture' },
    { name: 'Fixture Denim Co', type: 'brand', relation: 'depicted', certainty: 0.9, domain: 'fashion', evidence: 'logo', evidence_text: 'FIXTURE DENIM', tag_query: null },
    { name: 'Fixturo X-Trail', type: 'object', relation: 'resembles', certainty: 0.45, domain: 'vehicle', evidence: 'context', evidence_text: null, tag_query: null },
    { name: 'Road bicycle', type: 'object', relation: 'depicted', certainty: 0.9, domain: 'sport', evidence: 'distinctive_form', evidence_text: null, tag_query: null },
  ],
  quality: { usable: true, issue: null },
});

const ENRICHMENT = VlmEnrichment.parse({
  observations: [
    { text: 'Leather driving gloves', kind: 'garment' },
    { text: 'The rider has a shaved head', kind: 'person_style' },
  ],
  visible_text: ['FIXTURE DENIM', 'Licence plate characters are illegible due to blur'],
  illegible_text_present: true,
  confirmed: [
    { name: 'Vintage Racing', rationale: 'Racing stripes on the jacket', verdict: 'supported' },
    { name: 'Mughal architecture', rationale: 'Not shown in the photo', verdict: 'unsupported' },
    { name: 'Fixture Denim Co', rationale: 'Legible chest wordmark', verdict: 'supported' },
    { name: 'Fixturo X-Trail', rationale: 'Tail light design matches', verdict: 'supported' },
  ],
  additional_candidates: [],
  regions: [{ label: 'Fixture Denim Co', box: { x: 0.45, y: 0.3, w: 0.1, h: 0.05 } }],
  uncertainty: { overall: 'medium', notes: [] },
  competing_subjects: [],
});

class QuickVlm implements VlmProvider {
  readonly id = 'vlm:fake-quick-v2';
  constructor(private readonly quick: VlmQuickRead = QUICK) {}
  capability() {
    return AVAILABLE;
  }
  async analyzeImage(_input: VlmAnalyzeInput): Promise<VlmResult> {
    const quick = VlmQuickRead.parse(structuredClone(this.quick));
    return { analysis: toVlmAnalysis(quick), quick, model: 'fake-quick-v2', durationMs: 1 };
  }
}

class ScriptedEnricher implements VlmEnricher {
  readonly id = 'vlm-enrich:fake-v2';
  readonly calls: VlmEnrichInput[] = [];
  constructor(private readonly respond: (input: VlmEnrichInput) => Promise<VlmEnrichment | Error>) {}
  capability() {
    return AVAILABLE;
  }
  async enrichImage(input: VlmEnrichInput): Promise<VlmEnrichResult> {
    this.calls.push(input);
    const out = await this.respond(input);
    if (out instanceof Error) throw out;
    return { enrichment: VlmEnrichment.parse(out), model: 'fake-enrich-v2', durationMs: 1 };
  }
}

async function submit(ctx: ServiceContext) {
  return captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
}

async function snapshot(captureId: string) {
  const recs = await db.query<{ id: string; category: string; title: string; rank: number }>(
    `SELECT r.id, r.category, r.title, r.rank FROM recommendations r JOIN analyses a ON a.id = r.analysis_id
      WHERE a.capture_id = $1 ORDER BY r.rank, r.id`,
    [captureId],
  );
  const refs = await db.query<{ name: string; relation: string; is_anchor: boolean; enrichment_added: boolean; certainty: number; advisory_veto: boolean }>(
    `SELECT r.canonical_name AS name, cr.relation, cr.is_anchor, cr.enrichment_added, cr.certainty, cr.advisory_veto
       FROM capture_references cr JOIN cultural_references r ON r.id = cr.reference_id
       JOIN analyses a ON a.id = cr.analysis_id WHERE a.capture_id = $1 ORDER BY r.canonical_name`,
    [captureId],
  );
  const analysis = await db.query<{ title: string; interpretation: string; observations: { text: string; kind: string }[]; candidates: { name: string; suggested_categories: string[] }[] }>(
    'SELECT title, interpretation, observations, candidates FROM analyses WHERE capture_id = $1',
    [captureId],
  );
  return { recs: recs.rows, refs: refs.rows, analysis: analysis.rows[0]! };
}

async function guardTrace(jobId: string) {
  const { rows } = await db.query<{ data: { stage: number; version: string; decisions: { name: string; action: string; rules: string[]; note?: string }[]; dropped?: unknown } }>(
    `SELECT data FROM trace_events WHERE job_id = $1 AND name = 'guard' ORDER BY created_at, id`,
    [jobId],
  );
  return rows.map((r) => r.data);
}

const lookups = (qloo: ReturnType<typeof fakeQloo>) =>
  qloo.calls.filter((c) => c.op === 'search' || c.op === 'tags').map((c) => (c.req as { query: string }).query);

describe('reading guardrails in the compiler', () => {
  it('publishes only the publish set at stage 1 and a held brand only once stage 2 reads it (FAST-02 holds)', async () => {
    let captureId = '';
    let before: Awaited<ReturnType<typeof snapshot>> | null = null;
    const enricher = new ScriptedEnricher(async () => {
      before = await snapshot(captureId);
      return ENRICHMENT;
    });
    const qloo = fakeQloo();
    const { providers } = world({ overrides: { vlm: new QuickVlm(), vlmEnrich: enricher, qloo } });
    const ctx = await accountCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    captureId = capture_id;
    await runJobs(ctx, [job_id]);

    // Stage 1: the medium words left the title, the generic bicycle is an observation, nothing held was shown.
    const b = before!;
    expect(b.analysis.title).toBe('Bike and racing jacket');
    expect(b.analysis.interpretation).toBe('A bike beside a racing jacket.');
    expect(b.analysis.candidates.map((c) => [c.name, c.suggested_categories])).toEqual([
      ['Vintage Racing', ['wear']],
      ['Mughal architecture', []],
    ]);
    expect(b.analysis.observations.map((o) => [o.text, o.kind])).toEqual([['Road bicycle', 'object']]);
    expect(b.refs.map((r) => r.name)).not.toContain('Fixture Denim Co');
    expect(b.recs.length).toBeGreaterThan(0);
    // Stage 2 checks the published candidates and both held claims.
    expect(enricher.calls[0]!.stage1.candidates).toEqual(['Vintage Racing', 'Mughal architecture', 'Fixture Denim Co', 'Fixturo X-Trail']);

    const after = await snapshot(capture_id);
    // FAST-02: every card published before stage 2 is still there, same row, same rank, same order.
    for (const r of b.recs) expect(after.recs.find((a) => a.id === r.id)).toEqual(r);
    expect(after.recs.filter((a) => b.recs.some((r) => r.id === a.id)).map((a) => a.id)).toEqual(b.recs.map((r) => r.id));
    for (const ref of b.refs) expect(after.refs.map((r) => r.name)).toContain(ref.name);
    // The unsupported published reference stays, as an advisory veto.
    expect(after.refs.find((r) => r.name.toLowerCase().includes('mughal'))).toMatchObject({ advisory_veto: true });
    // The held brand was read at stage 2 and appended; the shape-guessed model never was.
    expect(after.refs.find((r) => r.name === 'Fixture Denim Co')).toMatchObject({ relation: 'depicted', is_anchor: false, enrichment_added: true });
    expect(after.refs.map((r) => r.name)).not.toContain('Fixturo X-Trail');
    expect(after.analysis.candidates.map((c) => c.name)).toEqual(['Vintage Racing', 'Mughal architecture', 'Fixture Denim Co']);
    // Visible text is transcription only; person descriptions never reach the reading.
    expect(after.analysis.observations.map((o) => o.text)).toEqual(['Road bicycle', 'Leather driving gloves', 'FIXTURE DENIM']);
    // Qloo never saw the generic object or the unconfirmed model, and saw the brand only after stage 2.
    const q = lookups(qloo);
    expect(q).not.toContain('Road bicycle');
    expect(q).not.toContain('Fixturo X-Trail');
    expect(q.indexOf('Fixture Denim Co')).toBeGreaterThan(q.indexOf('vintage racing'));

    const trace = await guardTrace(job_id);
    expect(trace.map((t) => [t.stage, t.version])).toEqual([
      [1, 'guard-v9'],
      [2, 'guard-v9'],
    ]);
    expect(trace[0]!.decisions.map((d) => [d.name, d.action])).toEqual([
      ['Vintage Racing', 'publish'],
      ['Mughal architecture', 'publish'],
      ['Fixture Denim Co', 'hold'],
      ['Fixturo X-Trail', 'hold'],
      ['Road bicycle', 'demote'],
    ]);
    expect(trace[1]!.decisions.map((d) => [d.name, d.action, d.rules])).toEqual([
      ['Fixture Denim Co', 'publish', ['G-VERDICT', 'G-BRAND-CORROBORATE', 'G-CATEGORY']],
      ['Fixturo X-Trail', 'drop', ['G-VERDICT', 'G-BRAND-CORROBORATE']],
    ]);
    expect(trace[1]!.dropped).toEqual({ visibleText: 1, observations: 1, subjects: 0 });
  });

  it('fails closed: when stage 2 fails, held claims are dropped and stage-1 results stay as published', async () => {
    const enricher = new ScriptedEnricher(async () => new ProviderError('model-gateway', 'timeout', 'Analysis timed out'));
    const qloo = fakeQloo();
    const { providers } = world({ overrides: { vlm: new QuickVlm(), vlmEnrich: enricher, qloo } });
    const ctx = await accountCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const s = await snapshot(capture_id);
    expect(s.refs.map((r) => r.name)).not.toContain('Fixture Denim Co');
    expect(s.analysis.candidates.map((c) => c.name)).toEqual(['Vintage Racing', 'Mughal architecture']);
    expect(lookups(qloo)).not.toContain('Fixture Denim Co');
    const trace = await guardTrace(job_id);
    expect(trace[1]!.decisions.map((d) => [d.name, d.action, d.note])).toEqual([
      ['Fixture Denim Co', 'drop', 'stage_2_timeout'],
      ['Fixturo X-Trail', 'drop', 'stage_2_timeout'],
    ]);
  });

  it('lists a name read only at stage 2 as a text-only reference: never searched, anchored, researched or a subject choice', async () => {
    const court = VlmQuickRead.parse({
      title: 'An outdoor basketball hoop',
      interpretation: 'A hoop against a clear sky.',
      candidates: [{ name: 'Streetball', type: 'tradition', relation: 'resembles', certainty: 0.7, domain: 'sport', evidence: 'distinctive_form', evidence_text: null, tag_query: 'streetball' }],
      quality: { usable: true, issue: null },
    });
    const enrichment = VlmEnrichment.parse({
      observations: [{ text: 'A metal hoop with a net', kind: 'object' }],
      visible_text: ['NBA', 'FIXTURE LEBROOK 23'],
      illegible_text_present: false,
      confirmed: [{ name: 'Streetball', rationale: 'Outdoor court hoop', verdict: 'supported' }],
      additional_candidates: [
        { name: 'NBA', type: 'brand', relation: 'depicted', certainty: 0.8, domain: 'sport', evidence: 'logo', evidence_text: 'NBA', tag_query: null, rationale: 'Logo on the backboard' },
        { name: 'Fixture Lebrook', type: 'creator', relation: 'depicted', certainty: 0.8, domain: 'people', evidence: 'read_text', evidence_text: 'FIXTURE LEBROOK', tag_query: null, rationale: 'Jersey lettering' },
      ],
      regions: [],
      uncertainty: { overall: 'medium', notes: [] },
      competing_subjects: ['The hoop', 'Fixture Lebrook'],
    });
    const qloo = fakeQloo();
    const { providers } = world({ overrides: { vlm: new QuickVlm(court), vlmEnrich: new ScriptedEnricher(async () => enrichment), qloo } });
    const ctx = await accountCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);

    // Listed under "Explore the references" with the text each was read from, after the stage-1 reference.
    const view = await captures.getCapture(ctx, { id: capture_id });
    const listed = view.references.map((r) => [r.name, r.read_text ?? null, r.has_page]);
    expect(listed[0]![0]).toBe('Streetball');
    expect(listed.slice(1)).toEqual(
      expect.arrayContaining([
        ['NBA', 'NBA', false],
        ['Fixture Lebrook', 'FIXTURE LEBROOK 23', false],
      ]),
    );
    expect(view.references.filter((r) => r.read_text).every((r) => r.qualified)).toBe(true);
    // Never searched in Qloo, never an anchor or a research target, never a "What caught your eye?" choice.
    const q = lookups(qloo);
    expect(q).not.toContain('NBA');
    expect(q).not.toContain('nba');
    expect(q).not.toContain('Fixture Lebrook');
    const rows = await db.query<{ name: string; is_anchor: boolean; text_only: boolean; read_text: string | null; research_status: string }>(
      `SELECT r.canonical_name AS name, cr.is_anchor, cr.text_only, cr.read_text, r.research_status
         FROM capture_references cr JOIN cultural_references r ON r.id = cr.reference_id JOIN analyses a ON a.id = cr.analysis_id
        WHERE a.capture_id = $1 AND cr.text_only ORDER BY r.canonical_name`,
      [capture_id],
    );
    expect(rows.rows.map((r) => [r.name, r.is_anchor, r.read_text])).toEqual([
      ['Fixture Lebrook', false, 'FIXTURE LEBROOK 23'],
      ['NBA', false, 'NBA'],
    ]);
    expect(rows.rows.every((r) => r.research_status !== 'complete')).toBe(true);
    const question = view.analysis!.question;
    expect((question?.choices ?? []).map((c) => c.label)).not.toContain('Fixture Lebrook');
    // The inspector's reason code is in the trace.
    const trace = await guardTrace(job_id);
    expect(trace[1]!.decisions.filter((d) => d.note === 'single_read_text_only').map((d) => d.name).sort()).toEqual(['Fixture Lebrook', 'NBA']);
  });

  it('a photo the model calls blurred publishes no candidate and asks for a clearer photo', async () => {
    const blurred = VlmQuickRead.parse({ ...QUICK, quality: { usable: true, issue: 'blurred' } });
    const qloo = fakeQloo();
    const enricher = new ScriptedEnricher(async () => ENRICHMENT);
    const { providers } = world({ overrides: { vlm: new QuickVlm(blurred), vlmEnrich: enricher, qloo } });
    const ctx = await accountCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.analysis!.warnings.map((w) => w.code)).toEqual(['unclear_photo']);
    expect(view.references).toEqual([]);
    expect(view.recommendations).toEqual([]);
    expect(qloo.calls).toEqual([]);
    expect(enricher.calls).toEqual([]);
    expect((await guardTrace(job_id))[0]!.decisions.every((d) => d.action === 'drop' && d.rules[0] === 'G-QUAL')).toBe(true);
  });
});
