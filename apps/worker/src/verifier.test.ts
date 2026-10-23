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
 * The independent verifier (vision_verify, vlm-verify-v3, guard-v8) in the
 * compiler, on a real database with the real Worker
 * (docs/requalification-plan.md, round 3). Readings and verifier replies are
 * FIXTURE data; Qloo is the fixture-backed fake.
 *  - off by default; on only with ANALYSIS_VERIFIER_ENABLED, never when killed;
 *  - binding and before publication: the first section's style, place and
 *    tradition claims are checked in parallel with resolve and publish only on
 *    "yes"; what stage 2 would publish is checked before it does;
 *  - "no", "unsure", no answer or a failed call block that claim only: it
 *    never becomes a reference, a candidate or a stage-2 input.
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

const enrichment = (additions: unknown[] = []) =>
  VlmEnrichment.parse({
    observations: [{ text: 'Lustre-glazed bowls on glass shelves', kind: 'object' }],
    visible_text: ['NISHAPUR, 10TH CENTURY'],
    illegible_text_present: false,
    confirmed: [
      { name: 'Mid-century modern', rationale: 'Display case design', verdict: 'supported' },
      { name: 'Fixture lustreware', rationale: 'Glaze could be several traditions', verdict: 'weak' },
    ],
    additional_candidates: additions,
    regions: [],
    uncertainty: { overall: 'medium', notes: [] },
    competing_subjects: [],
  });
const CELADON = { name: 'Fixture celadon', type: 'style', relation: 'resembles', certainty: 0.7, domain: 'craft', evidence: 'distinctive_form', evidence_text: null, tag_query: 'celadon', rationale: 'Green crackled glaze' };

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
  readonly inputs: VlmEnrichInput[] = [];
  constructor(
    private readonly log: string[],
    private readonly additions: unknown[],
  ) {}
  capability() {
    return AVAILABLE;
  }
  async enrichImage(input: VlmEnrichInput): Promise<VlmEnrichResult> {
    this.log.push('enrich');
    this.inputs.push(input);
    return { enrichment: enrichment(this.additions), model: 'fake-enrich-v2', durationMs: 1 };
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
  const refs = await db.query<{ name: string; is_anchor: boolean }>(
    `SELECT r.canonical_name AS name, cr.is_anchor
       FROM capture_references cr JOIN cultural_references r ON r.id = cr.reference_id JOIN analyses a ON a.id = cr.analysis_id
      WHERE a.capture_id = $1 ORDER BY r.canonical_name`,
    [captureId],
  );
  const cands = await db.query<{ candidates: { name: string }[] | null }>(`SELECT candidates FROM analyses WHERE capture_id = $1`, [captureId]);
  return { refs: refs.rows, candidates: (cands.rows[0]?.candidates ?? []).map((c) => c.name) };
}

async function verifyTrace(jobId: string) {
  const { rows } = await db.query<{ data: { stage?: number; status: string; reason?: string; blocked?: number; checks?: { name: string; answer: string | null; action: string; note: string }[] } }>(
    `SELECT data FROM trace_events WHERE job_id = $1 AND name = 'verify' ORDER BY created_at, id`,
    [jobId],
  );
  return rows.map((r) => r.data);
}

/** Every verifier check of the job, in order (what the inspector lists as verifier decisions). */
async function guardDecisions(jobId: string) {
  return (await verifyTrace(jobId)).flatMap((t) => t.checks ?? []);
}

async function run(
  config: Partial<Record<string, string>>,
  respond: (input: VlmVerifyInput) => Promise<VlmVerification | Error>,
  additions: unknown[] = [],
) {
  const log: string[] = [];
  let atFirstCheck: Awaited<ReturnType<typeof snapshot>> | null = null;
  let captureId = '';
  const verifier = new Verifier(log, async (input) => {
    if (!atFirstCheck) atFirstCheck = await snapshot(captureId);
    return respond(input);
  });
  const enricher = new Enricher(log, additions);
  const { providers } = world({ overrides: { vlm: new QuickVlm(), vlmEnrich: enricher, vlmVerify: verifier, qloo: fakeQloo() } });
  const ctx: ServiceContext = await accountCtx(providers, testConfig(config));
  const { capture_id, job_id } = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
  captureId = capture_id;
  await runJobs(ctx, [job_id]);
  return { ctx, verifier, enricher, log, captureId: capture_id, jobId: job_id, atFirstCheck: () => atFirstCheck, after: () => snapshot(capture_id) };
}

const ON = { ANALYSIS_VERIFIER_ENABLED: 'true' };
const answer = (pairs: [string, 'yes' | 'no' | 'unsure'][]): VlmVerification => ({ checks: pairs.map(([name, a]) => ({ name, answer: a, reason: 'Fixture reason' })) });

describe('the verifier in the compiler (binding, before publication)', () => {
  it('is off by default: no call, the first section publishes as before, and the trace says why', async () => {
    const r = await run({}, async () => ({ checks: [] }));
    expect(r.verifier.calls).toEqual([]);
    expect((await verifyTrace(r.jobId))[0]).toMatchObject({ status: 'skipped', reason: 'not_enabled' });
    const after = await r.after();
    expect(after.refs.map((x) => x.name)).toEqual(expect.arrayContaining(['Fixture lustreware']));
    expect(after.candidates).toEqual(['Mid-century modern', 'Fixture lustreware']);
  });

  it('checks the first section before it publishes: a "no" keeps that claim out of references, candidates and stage 2', async () => {
    const r = await run(ON, async () => answer([['Mid-century modern', 'yes'], ['Fixture lustreware', 'no']]));
    // The stage-1 check runs with resolve, before stage 2; stage 2 adds nothing here, so there is no second check.
    expect(r.log).toEqual(['verify', 'enrich']);
    expect(r.verifier.calls).toHaveLength(1);
    expect(r.verifier.calls[0]!.claims).toEqual([
      { name: 'Mid-century modern', type: 'style' },
      { name: 'Fixture lustreware', type: 'style' },
    ]);
    expect(r.verifier.calls[0]!.visibleText).toEqual([]);
    // While it checks, its targets are not published yet.
    expect(r.atFirstCheck()!.candidates).toEqual([]);
    const after = await r.after();
    expect(after.refs.map((x) => x.name)).not.toContain('Fixture lustreware');
    expect(after.candidates).not.toContain('Fixture lustreware');
    expect(after.candidates).toContain('Mid-century modern');
    // Stage 2 is not asked about a claim that was never published.
    expect(r.enricher.inputs[0]!.stage1.candidates).toEqual(['Mid-century modern']);
    const view = await captures.getCapture(r.ctx, { id: r.captureId });
    expect(view.references.map((x) => x.name)).not.toContain('Fixture lustreware');

    expect((await verifyTrace(r.jobId))[0]).toMatchObject({ stage: 1, status: 'complete', blocked: 1 });
    expect((await guardDecisions(r.jobId)).map((d) => [d.name, d.action, d.note])).toEqual([
      ['Mid-century modern', 'publish', 'verifier_yes'],
      ['Fixture lustreware', 'block', 'verifier_no'],
    ]);
    const { rows } = await db.query<{ operation: string; status: string }>(
      `SELECT q.operation, q.status FROM provider_queries q JOIN analyses a ON a.id = q.analysis_id WHERE a.capture_id = $1 AND q.operation = 'verify_image'`,
      [r.captureId],
    );
    expect(rows).toEqual([{ operation: 'verify_image', status: 'ok' }]);
  });

  it('"unsure" and an unanswered claim block too; "yes" to both publishes both', async () => {
    const unsure = await run(ON, async () => answer([['Mid-century modern', 'unsure']]));
    expect((await unsure.after()).candidates).toEqual([]);
    expect((await guardDecisions(unsure.jobId)).map((d) => d.note)).toEqual(['verifier_unsure', 'verifier_unanswered']);
    const yes = await run(ON, async () => answer([['Mid-century modern', 'yes'], ['Fixture lustreware', 'yes']]));
    expect((await yes.after()).candidates).toEqual(['Mid-century modern', 'Fixture lustreware']);
  });

  it('a failed call blocks its claims (fail closed) and is traced', async () => {
    const r = await run(ON, async () => new ProviderError('model-gateway', 'timeout', 'Verifier timed out'));
    const after = await r.after();
    expect(after.candidates).toEqual([]);
    expect(after.refs.map((x) => x.name)).not.toContain('Fixture lustreware');
    expect((await verifyTrace(r.jobId))[0]).toMatchObject({ stage: 1, status: 'failed', reason: 'timeout', blocked: 2 });
  });

  it('checks what stage 2 would publish before it does', async () => {
    const r = await run(
      ON,
      async (input) => (input.claims.some((c) => c.name === 'Fixture celadon') ? answer([['Fixture celadon', 'no']]) : answer([['Mid-century modern', 'yes'], ['Fixture lustreware', 'yes']])),
      [CELADON],
    );
    expect(r.log).toEqual(['verify', 'enrich', 'verify']);
    expect(r.verifier.calls[1]!.claims).toEqual([{ name: 'Fixture celadon', type: 'style' }]);
    expect(r.verifier.calls[1]!.visibleText).toEqual(['NISHAPUR, 10TH CENTURY']);
    const after = await r.after();
    expect(after.candidates).toEqual(['Mid-century modern', 'Fixture lustreware']);
    expect(after.refs.map((x) => x.name)).not.toContain('Fixture celadon');
    expect((await verifyTrace(r.jobId)).map((t) => [t.stage, t.blocked])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it('a kill switch turns it off, as does killing the two-stage reading', async () => {
    for (const kill of ['analysis_verifier_enabled', 'fast_analysis_two_stage']) {
      const r = await run({ ...ON, FEATURE_KILL_SWITCHES: kill }, async () => ({ checks: [] }));
      expect(r.verifier.calls, kill).toEqual([]);
      expect((await r.after()).candidates, kill).toContain('Mid-century modern');
    }
  });
});
