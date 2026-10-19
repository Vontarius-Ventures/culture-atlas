import { afterAll, describe, expect, it } from 'vitest';
import { captures, type ServiceContext } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, testConfig } from '@culture-atlas/domain/testing';
import {
  ProviderError,
  VlmEnrichment,
  VlmQuickRead,
  VlmVerification,
  toVlmAnalysis,
  type CapabilityEntry,
  type VlmAnalyzeInput,
  type VlmEnricher,
  type VlmEnrichInput,
  type VlmEnrichResult,
  type VlmProvider,
  type VlmResult,
  type VlmVerifier,
  type VlmVerifyInput,
  type VlmVerifyResult,
} from '@culture-atlas/providers';
import { accountCtx, fakeQloo, runJobs, testJpeg, world } from './test-world';

/**
 * The independent verifier (vision_verify) in the compiler, on a real
 * database with the real Worker (docs/requalification-plan.md). Readings and
 * verifier replies are FIXTURE data; Qloo is the fixture-backed fake.
 *  - off by default; on only with ANALYSIS_VERIFIER_ENABLED, never when killed;
 *  - runs in the background after stage 2 published;
 *  - checks only non-anchor style/place/tradition claims that stage 2 hedged
 *    or the read text does not bear out;
 *  - can only lower certainty or mark a reference qualified: no reference,
 *    card or rank changes otherwise, and a failed call changes nothing.
 */
const db = getTestDb();
afterAll(closeTestDb);

const AVAILABLE: CapabilityEntry = { status: 'available', provider: 'fake' };

const QUICK = VlmQuickRead.parse({
  title: 'Glazed bowls in a museum case',
  interpretation: 'A case of lustre-glazed bowls.',
  candidates: [
    { name: 'Mid-century modern', type: 'style', relation: 'resembles', certainty: 0.7, domain: 'design', evidence: 'distinctive_form', evidence_text: null, tag_query: 'mid-century modern' },
    { name: 'Fixture lustreware', type: 'style', relation: 'resembles', certainty: 0.6, domain: 'craft', evidence: 'distinctive_form', evidence_text: null, tag_query: 'fixture lustreware' },
  ],
  quality: { usable: true, issue: null },
});

const ENRICHMENT = VlmEnrichment.parse({
  observations: [{ text: 'Lustre-glazed bowls on glass shelves', kind: 'object' }],
  visible_text: ['NISHAPUR, 10TH CENTURY'],
  illegible_text_present: false,
  confirmed: [
    { name: 'Mid-century modern', rationale: 'Display case design', verdict: 'supported' },
    { name: 'Fixture lustreware', rationale: 'Glaze could be several traditions', verdict: 'weak' },
  ],
  additional_candidates: [],
  regions: [],
  uncertainty: { overall: 'medium', notes: [] },
  competing_subjects: [],
});

class QuickVlm implements VlmProvider {
  readonly id = 'vlm:fake-quick-v2';
  capability() {
    return AVAILABLE;
  }
  async analyzeImage(_input: VlmAnalyzeInput): Promise<VlmResult> {
    const quick = VlmQuickRead.parse(structuredClone(QUICK));
    return { analysis: toVlmAnalysis(quick), quick, model: 'fake-quick-v2', durationMs: 1 };
  }
}

class Enricher implements VlmEnricher {
  readonly id = 'vlm-enrich:fake-v2';
  constructor(private readonly log: string[]) {}
  capability() {
    return AVAILABLE;
  }
  async enrichImage(_input: VlmEnrichInput): Promise<VlmEnrichResult> {
    this.log.push('enrich');
    return { enrichment: VlmEnrichment.parse(ENRICHMENT), model: 'fake-enrich-v2', durationMs: 1 };
  }
}

class Verifier implements VlmVerifier {
  readonly id = 'vlm-verify:fake';
  readonly calls: VlmVerifyInput[] = [];
  constructor(
    private readonly log: string[],
    private readonly respond: (input: VlmVerifyInput) => Promise<VlmVerification | Error>,
  ) {}
  capability() {
    return AVAILABLE;
  }
  async verifyImage(input: VlmVerifyInput): Promise<VlmVerifyResult> {
    this.log.push('verify');
    this.calls.push(input);
    const out = await this.respond(input);
    if (out instanceof Error) throw out;
    return { verification: VlmVerification.parse(out), model: 'fake-verify', durationMs: 1 };
  }
}

async function snapshot(captureId: string) {
  const recs = await db.query<{ id: string; rank: number; title: string }>(
    `SELECT r.id, r.rank, r.title FROM recommendations r JOIN analyses a ON a.id = r.analysis_id WHERE a.capture_id = $1 ORDER BY r.rank, r.id`,
    [captureId],
  );
  const refs = await db.query<{ name: string; is_anchor: boolean; certainty: number; published_certainty: number | null; verifier_check: string | null }>(
    `SELECT r.canonical_name AS name, cr.is_anchor, cr.certainty, cr.published_certainty, cr.verifier_check
       FROM capture_references cr JOIN cultural_references r ON r.id = cr.reference_id JOIN analyses a ON a.id = cr.analysis_id
      WHERE a.capture_id = $1 ORDER BY r.canonical_name`,
    [captureId],
  );
  return { recs: recs.rows, refs: refs.rows };
}

async function verifyTrace(jobId: string) {
  const { rows } = await db.query<{ data: { status: string; reason?: string; checks?: { name: string; answer: string; action: string }[] } }>(
    `SELECT data FROM trace_events WHERE job_id = $1 AND name = 'verify' ORDER BY created_at, id`,
    [jobId],
  );
  return rows.map((r) => r.data);
}

async function run(config: Partial<Record<string, string>>, respond: (input: VlmVerifyInput) => Promise<VlmVerification | Error>) {
  const log: string[] = [];
  let before: Awaited<ReturnType<typeof snapshot>> | null = null;
  let captureId = '';
  const verifier = new Verifier(log, async (input) => {
    before = await snapshot(captureId);
    return respond(input);
  });
  const { providers } = world({ overrides: { vlm: new QuickVlm(), vlmEnrich: new Enricher(log), vlmVerify: verifier, qloo: fakeQloo() } });
  const ctx: ServiceContext = await accountCtx(providers, testConfig(config));
  const { capture_id, job_id } = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
  captureId = capture_id;
  await runJobs(ctx, [job_id]);
  return { ctx, verifier, log, captureId: capture_id, jobId: job_id, before: () => before, after: () => snapshot(capture_id) };
}

const ON = { ANALYSIS_VERIFIER_ENABLED: 'true' };

describe('the verifier in the compiler', () => {
  it('is off by default: no call, nothing changes, and the trace says why', async () => {
    const r = await run({}, async () => ({ checks: [] }));
    expect(r.verifier.calls).toEqual([]);
    expect((await verifyTrace(r.jobId))[0]).toMatchObject({ status: 'skipped', reason: 'not_enabled' });
    expect((await r.after()).refs.every((x) => x.verifier_check === null)).toBe(true);
  });

  it('runs after stage 2, checks only the hedged non-anchor claim, and only lowers and qualifies it', async () => {
    const r = await run(ON, async () => ({ checks: [{ name: 'Fixture lustreware', answer: 'no', reason: 'The label names Nishapur' }] }));
    // Background ordering: stage 2 first, then the verifier.
    expect(r.log).toEqual(['enrich', 'verify']);
    // The anchor (resolved Mid-century modern) is never checked, though the label does not name it.
    expect(r.verifier.calls).toHaveLength(1);
    expect(r.verifier.calls[0]!.claims).toEqual([{ name: 'Fixture lustreware', type: 'style' }]);
    expect(r.verifier.calls[0]!.visibleText).toEqual(['NISHAPUR, 10TH CENTURY']);

    const before = r.before()!;
    const after = await r.after();
    // Nothing removed or reordered: same references, same cards, same ranks.
    expect(after.refs.map((x) => x.name)).toEqual(before.refs.map((x) => x.name));
    expect(after.recs).toEqual(before.recs);
    const lustre = after.refs.find((x) => x.name === 'Fixture lustreware')!;
    const was = before.refs.find((x) => x.name === 'Fixture lustreware')!;
    expect(lustre).toMatchObject({ verifier_check: 'no', is_anchor: false, published_certainty: was.certainty });
    expect(lustre.certainty).toBeCloseTo(was.certainty * 0.5, 3);
    const anchor = after.refs.find((x) => x.is_anchor)!;
    expect(anchor).toMatchObject({ verifier_check: null, certainty: before.refs.find((x) => x.is_anchor)!.certainty });

    // Still listed under "Explore the references", now qualified.
    const view = await captures.getCapture(r.ctx, { id: r.captureId });
    expect(view.references.find((x) => x.name === 'Fixture lustreware')).toMatchObject({ qualified: true });
    expect(view.references.map((x) => x.name)).toEqual(expect.arrayContaining(['Fixture lustreware']));

    const trace = await verifyTrace(r.jobId);
    expect(trace[0]).toMatchObject({ status: 'complete', lowered: 1, qualified: 1 });
    expect(trace[0]!.checks).toEqual([expect.objectContaining({ name: 'Fixture lustreware', answer: 'no', action: 'lower' })]);
    const { rows } = await db.query<{ operation: string; status: string }>(
      `SELECT q.operation, q.status FROM provider_queries q JOIN analyses a ON a.id = q.analysis_id WHERE a.capture_id = $1 AND q.operation = 'verify_image'`,
      [r.captureId],
    );
    expect(rows).toEqual([{ operation: 'verify_image', status: 'ok' }]);
  });

  it('a "yes" changes nothing but the record; an unanswered claim is only qualified', async () => {
    const yes = await run(ON, async () => ({ checks: [{ name: 'Fixture lustreware', answer: 'yes', reason: 'Lustre glaze is visible' }] }));
    const y = (await yes.after()).refs.find((x) => x.name === 'Fixture lustreware')!;
    expect(y.verifier_check).toBe('yes');
    expect(y.certainty).toBe(yes.before()!.refs.find((x) => x.name === 'Fixture lustreware')!.certainty);
    const silent = await run(ON, async () => ({ checks: [] }));
    const s = (await silent.after()).refs.find((x) => x.name === 'Fixture lustreware')!;
    expect(s.verifier_check).toBe('unsure');
    expect(s.certainty).toBe(silent.before()!.refs.find((x) => x.name === 'Fixture lustreware')!.certainty);
  });

  it('a failed call changes nothing (published results stay exactly as they were)', async () => {
    const r = await run(ON, async () => new ProviderError('model-gateway', 'timeout', 'Verifier timed out'));
    expect(await r.after()).toEqual(r.before());
    expect((await verifyTrace(r.jobId))[0]).toMatchObject({ status: 'failed', reason: 'timeout' });
  });

  it('a kill switch turns it off, as does killing the two-stage reading', async () => {
    for (const kill of ['analysis_verifier_enabled', 'fast_analysis_two_stage']) {
      const r = await run({ ...ON, FEATURE_KILL_SWITCHES: kill }, async () => ({ checks: [] }));
      expect(r.verifier.calls, kill).toEqual([]);
      expect((await r.after()).refs.every((x) => x.verifier_check === null), kill).toBe(true);
    }
  });
});
