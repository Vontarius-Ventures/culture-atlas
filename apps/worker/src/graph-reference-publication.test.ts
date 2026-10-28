import { afterAll, describe, expect, it } from 'vitest';
import { analyses, captures, dispatchGraphOutbox, getJobById, preferences, type ServiceContext } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, testConfig } from '@culture-atlas/domain/testing';
import {
  VlmEnrichmentV1,
  VlmQuickRead,
  toVlmAnalysis,
  type CapabilityEntry,
  type QlooCapabilities,
  type QlooEntity,
  type QlooEntityTrendsResult,
  type QlooInsightsResult,
  type QlooProvider,
  type QlooResponse,
  type QlooTag,
  type QlooTrendingResult,
  type VlmAnalyzeInput,
  type VlmEnricher,
  type VlmEnrichInput,
  type VlmEnrichResult,
  type VlmProvider,
  type VlmResult,
} from '@culture-atlas/providers';
import { accountCtx, anonCtx, fakeQloo, runJobs, testJpeg, world } from './test-world';

/**
 * VAL-PROJ-006/007 staged active-analysis gap: a saved capture can project
 * after its analysis activated but before the pipeline published the analysis's
 * references (activation and reference publication are separate transactions).
 * The later initial or enrichment publication must then durably re-arm the
 * account's projection intent INSIDE its own publish transaction — the active
 * analysis pointer does not move, so nothing else would dirty the projection.
 * Identical re-publication (a lost-lease retry) and publication to an inactive
 * analysis (a pending correction version) add no intent, and the publication
 * and its intent commit or roll back together. All cases run through the real
 * compiler in the real Worker with the fixture-backed fake providers.
 */

const db = getTestDb();
afterAll(closeTestDb);

const config = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

async function submit(ctx: ServiceContext) {
  return captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg() }, fields: { source: 'upload', focus: undefined } });
}

interface AnalysisOutboxRow {
  id: string;
  logical_event_key: string;
  target_taste_revision: number;
  dispatch_state: string;
  processed_at: string | null;
  payload: Record<string, unknown>;
}

async function analysisRows(accountId: string): Promise<AnalysisOutboxRow[]> {
  const { rows } = await db.query<AnalysisOutboxRow>(
    `SELECT id, logical_event_key, target_taste_revision, dispatch_state, processed_at, payload
       FROM graph_outbox WHERE owner_account_id = $1 AND event_type = 'analysis'
      ORDER BY target_taste_revision, created_at, id`,
    [accountId],
  );
  return rows;
}

async function tasteRevision(accountId: string): Promise<number> {
  const { rows } = await db.query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [accountId]);
  return rows[0]?.revision ?? 0;
}

async function stateRow(accountId: string): Promise<{ state: string; applied: number } | null> {
  const { rows } = await db.query<{ state: string; applied: number }>(
    `SELECT state, applied_taste_revision AS applied FROM personal_graph_state WHERE owner_account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

/** The authorized (resolved/user-confirmed, never text-only) reference rows of the capture's CURRENT active analysis. */
async function authorizedRefRows(captureId: string): Promise<{ capture_reference_id: string; name: string }[]> {
  const { rows } = await db.query<{ capture_reference_id: string; name: string }>(
    `SELECT cr.id AS capture_reference_id, r.canonical_name AS name
       FROM captures c
       JOIN analyses a ON a.id = c.active_analysis_id
       JOIN capture_references cr ON cr.analysis_id = a.id
       JOIN cultural_references r ON r.id = cr.reference_id
      WHERE c.id = $1
        AND cr.resolution_status IN ('resolved','user_confirmed')
        AND COALESCE(cr.text_only, false) = false`,
    [captureId],
  );
  return rows;
}

/** The derived capture-reference support the projection currently holds. */
async function captureSupportRows(
  accountId: string,
): Promise<{ capture_reference_id: string; analysis_id: string; dependency_versions: Record<string, unknown> }[]> {
  const { rows } = await db.query<{ capture_reference_id: string; analysis_id: string; dependency_versions: Record<string, unknown> }>(
    `SELECT s.capture_reference_id, s.analysis_id, s.dependency_versions
       FROM personal_interest_support s
      WHERE s.owner_account_id = $1 AND s.origin_kind = 'capture_reference'`,
    [accountId],
  );
  return rows;
}

/** Hand the account's pending intents to the queue and project them through the real Worker. */
async function projectThroughWorker(ctx: ServiceContext, accountId: string) {
  const dispatched = await dispatchGraphOutbox(db, { config: ctx.config, ownerAccountId: accountId });
  for (const account of dispatched.accounts) await runJobs(ctx, [account.jobId]);
  return dispatched;
}

function accountIdOf(ctx: ServiceContext): string {
  if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
  return ctx.principal.accountId;
}

/**
 * The fixture Qloo with a one-shot AWAITED barrier on the resolve lookups: the
 * lookup does not return until the barrier finished, so the pipeline is
 * provably paused between activation and the reference publication.
 */
class BarrierQloo implements QlooProvider {
  readonly id: string;
  private armed = true;
  constructor(private readonly inner: QlooProvider, private readonly barrier: () => Promise<void>) {
    this.id = inner.id;
  }
  capability(): QlooCapabilities {
    return this.inner.capability();
  }
  private async once(): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    await this.barrier();
  }
  async searchEntities(req: Parameters<QlooProvider['searchEntities']>[0]): Promise<QlooResponse<QlooEntity[]>> {
    await this.once();
    return this.inner.searchEntities(req);
  }
  async lookupTags(req: Parameters<QlooProvider['lookupTags']>[0]): Promise<QlooResponse<QlooTag[]>> {
    await this.once();
    return this.inner.lookupTags(req);
  }
  async insights(req: Parameters<QlooProvider['insights']>[0]): Promise<QlooResponse<QlooInsightsResult>> {
    return this.inner.insights(req);
  }
  async trending(req: Parameters<QlooProvider['trending']>[0]): Promise<QlooResponse<QlooTrendingResult>> {
    return this.inner.trending(req);
  }
  async entityTrends(req: Parameters<QlooProvider['entityTrends']>[0]): Promise<QlooResponse<QlooEntityTrendsResult>> {
    return this.inner.entityTrends(req);
  }
}

// --- two-stage reading fixtures (the measured-shaped stage-1/stage-2 pair) ---

const AVAILABLE: CapabilityEntry = { status: 'available', provider: 'fake' };

const QUICK = VlmQuickRead.parse({
  title: 'Vintage racing references',
  interpretation: 'A few vintage racing references stood out beside a spritz on the table.',
  candidates: [
    { name: 'Fixture Denim Co', type: 'brand', relation: 'depicted', certainty: 0.9, categories: ['wear'], tag_query: null },
    { name: 'Vintage motor racing style', type: 'style', relation: 'resembles', certainty: 0.6, categories: ['wear', 'watch', 'play'], tag_query: 'vintage racing' },
    { name: 'Italian aperitivo culture', type: 'tradition', relation: 'resembles', certainty: 0.4, categories: ['eat'], tag_query: null },
  ],
  quality: { usable: true, issue: null },
});

const ENRICHMENT = VlmEnrichmentV1.parse({
  observations: [{ text: 'Leather driving gloves', kind: 'garment' }],
  visible_text: ['FIXTURE DENIM'],
  confirmed: [
    { name: 'Fixture Denim Co', rationale: 'Legible chest wordmark', keep: true },
    { name: 'Vintage motor racing style', rationale: 'Gloves may be ordinary winter gloves', keep: false },
    { name: 'Italian aperitivo culture', rationale: 'Spritz glass on the table', keep: true },
  ],
  additional_candidates: [
    { name: 'Mid-Century Modern', type: 'style', relation: 'resembles', certainty: 0.5, categories: ['watch'], tag_query: 'mid-century modern', rationale: 'Teak side table behind the chair' },
  ],
  regions: [{ label: 'Fixture Denim Co', box: { x: 0.45, y: 0.3, w: 0.1, h: 0.05 } }],
  uncertainty: { overall: 'medium', notes: ['Gloves are partly hidden'] },
  competing_subjects: [],
});

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
  constructor(private readonly respond: (input: VlmEnrichInput) => Promise<VlmEnrichmentV1 | Error>) {}
  capability() {
    return AVAILABLE;
  }
  async enrichImage(input: VlmEnrichInput): Promise<VlmEnrichResult> {
    this.calls.push(input);
    const out = await this.respond(input);
    if (out instanceof Error) throw out;
    return { enrichment: out, model: 'fake-vlm-enrich', durationMs: 1 };
  }
}

describe('active-analysis reference publication re-arms projection (VAL-PROJ-006/007)', () => {
  it('an initial reference publication durably re-arms the intent after the activation was already projected', async () => {
    const observed = { ready: false, supportBefore: -1, revision: -1 };
    let ctxRef: ServiceContext | null = null;
    let ownerRef = '';
    const qloo = new BarrierQloo(fakeQloo(), async () => {
      // The staged gap: activation committed, references unresolved. The real
      // dispatcher + worker project the saved capture NOW, so the projection
      // becomes ready at the current revision with zero derived support.
      const ctx = ctxRef!;
      const dispatched = await dispatchGraphOutbox(db, { config: ctx.config, ownerAccountId: ownerRef });
      expect(dispatched.accounts).toHaveLength(1);
      await runJobs(ctx, [dispatched.accounts[0]!.jobId]);
      const state = await stateRow(ownerRef);
      observed.ready = state?.state === 'ready';
      observed.supportBefore = (await captureSupportRows(ownerRef)).length;
      observed.revision = await tasteRevision(ownerRef);
      const consumed = await analysisRows(ownerRef);
      expect(consumed.every((r) => r.dispatch_state === 'done')).toBe(true);
    });
    const { providers } = world({ overrides: { qloo } });
    const ctx = await accountCtx(providers, config);
    ctxRef = ctx;
    const accountId = accountIdOf(ctx);
    ownerRef = accountId;

    const { capture_id, job_id } = await submit(ctx);
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: capture_id });
    await runJobs(ctx, [job_id]);

    // The barrier really ran between activation and publication: the projection
    // was ready with no derived support, at the then-current revision.
    expect(observed.ready).toBe(true);
    expect(observed.supportBefore).toBe(0);
    const revisionAtBarrier = observed.revision;
    expect(revisionAtBarrier).toBeGreaterThan(0);

    // The publication re-armed the durable intent in its own transaction:
    // same row, same revision (no user mutation), newest intent wins.
    const rows = (await analysisRows(accountId)).filter((r) => r.payload.capture_id === capture_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      logical_event_key: `analysis:${capture_id}`,
      dispatch_state: 'pending',
      target_taste_revision: revisionAtBarrier,
      payload: { action: 'references_published', capture_id, analysis_id: expect.any(String), stage: 'references' },
    });
    expect(await tasteRevision(accountId)).toBe(revisionAtBarrier);

    // Without another user mutation, dispatch + the real worker catch the
    // projection up to the exact current authorized support.
    const authorized = await authorizedRefRows(capture_id);
    expect(authorized.length).toBeGreaterThan(0);
    const dispatched = await dispatchGraphOutbox(db, { config, ownerAccountId: accountId });
    expect(dispatched.accounts).toHaveLength(1);
    await runJobs(ctx, [dispatched.accounts[0]!.jobId]);

    const support = await captureSupportRows(accountId);
    expect(support.map((s) => s.capture_reference_id).sort()).toEqual(authorized.map((a) => a.capture_reference_id).sort());
    const active = await db.query<{ active_analysis_id: string }>('SELECT active_analysis_id FROM captures WHERE id = $1', [capture_id]);
    for (const s of support) {
      expect(s.analysis_id).toBe(active.rows[0]!.active_analysis_id);
      expect(s.dependency_versions).toMatchObject({ analysis_version: 1 });
    }
    const state = (await stateRow(accountId))!;
    expect(state.state).toBe('ready');
    expect(state.applied).toBe(revisionAtBarrier);
    expect((await analysisRows(accountId)).find((r) => r.payload.capture_id === capture_id)!.dispatch_state).toBe('done');
  });

  it('an enrichment publication re-arms the intent the same way after an earlier projection', async () => {
    const observed = { ready: false, supportBefore: -1, revision: -1 };
    let ctxRef: ServiceContext | null = null;
    let ownerRef = '';
    const enricher = new ScriptedEnricher(async () => {
      // Barrier between the initial publication and the enrichment publish:
      // the real dispatcher + worker consume the intents committed so far.
      const ctx = ctxRef!;
      if (observed.supportBefore === -1) {
        const dispatched = await dispatchGraphOutbox(db, { config: ctx.config, ownerAccountId: ownerRef });
        expect(dispatched.accounts).toHaveLength(1);
        await runJobs(ctx, [dispatched.accounts[0]!.jobId]);
        const state = await stateRow(ownerRef);
        observed.ready = state?.state === 'ready';
        observed.supportBefore = (await captureSupportRows(ownerRef)).length;
        observed.revision = await tasteRevision(ownerRef);
      }
      return ENRICHMENT;
    });
    const { providers } = world({ overrides: { vlm: new QuickVlm(), vlmEnrich: enricher } });
    const ctx = await accountCtx(providers, config);
    ctxRef = ctx;
    const accountId = accountIdOf(ctx);
    ownerRef = accountId;

    const { capture_id, job_id } = await submit(ctx);
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: capture_id });
    await runJobs(ctx, [job_id]);
    expect(enricher.calls).toHaveLength(1);

    // The barrier projected the stage-1 references only (one authorized tag).
    expect(observed.ready).toBe(true);
    expect(observed.supportBefore).toBe(1);
    const revisionAtBarrier = observed.revision;

    const rows = (await analysisRows(accountId)).filter((r) => r.payload.capture_id === capture_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dispatch_state: 'pending',
      target_taste_revision: revisionAtBarrier,
      payload: { action: 'references_published', stage: 'enrichment' },
    });
    expect(await tasteRevision(accountId)).toBe(revisionAtBarrier);

    // Eventual catch-up without another user mutation: the enrichment-added
    // references (the corroborated brand + the additional style) project too.
    const dispatched = await dispatchGraphOutbox(db, { config, ownerAccountId: accountId });
    expect(dispatched.accounts).toHaveLength(1);
    await runJobs(ctx, [dispatched.accounts[0]!.jobId]);
    const authorized = await authorizedRefRows(capture_id);
    const support = await captureSupportRows(accountId);
    expect(authorized.map((a) => a.name).sort()).toEqual(['Fixture Denim Co', 'Mid-Century Modern', 'Vintage Racing']);
    expect(support.map((s) => s.capture_reference_id).sort()).toEqual(authorized.map((a) => a.capture_reference_id).sort());
    expect((await stateRow(accountId))!.state).toBe('ready');
  });

  it('an identical republication (lost-lease retry) re-arms nothing', async () => {
    const { providers } = world();
    const ctx = await accountCtx(providers, config);
    const accountId = accountIdOf(ctx);
    const { capture_id, job_id } = await submit(ctx);
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: capture_id });
    await runJobs(ctx, [job_id]);
    await projectThroughWorker(ctx, accountId);

    const before = (await analysisRows(accountId)).find((r) => r.payload.capture_id === capture_id)!;
    expect(before.dispatch_state).toBe('done');
    const revisionBefore = await tasteRevision(accountId);

    // Simulate a lost lease after completion: the job re-runs from its stored
    // stages and re-publishes the identical references.
    await db.query(`UPDATE jobs SET state = 'queued', lease_owner = NULL, finished_at = NULL, max_attempts = 5 WHERE id = $1`, [job_id]);
    await runJobs(ctx, [job_id]);

    const after = (await analysisRows(accountId)).find((r) => r.payload.capture_id === capture_id)!;
    expect(after.id).toBe(before.id);
    expect(after.dispatch_state).toBe('done');
    expect(new Date(after.processed_at!).getTime()).toBe(new Date(before.processed_at!).getTime());
    expect(after.payload).toEqual(before.payload);
    expect(after.target_taste_revision).toBe(revisionBefore);
    expect(await tasteRevision(accountId)).toBe(revisionBefore);
    expect((await analysisRows(accountId)).filter((r) => r.payload.capture_id === capture_id)).toHaveLength(1);
  });

  it('publication to an inactive analysis (pending correction version) adds no intent', async () => {
    const midJob = { correctionPayload: null as Record<string, unknown> | null, revisionBeforeCorrection: -1 };
    let ownerRef = '';
    let observed = false;
    const enricher = new ScriptedEnricher(async () => {
      // The enrichment stage of a job runs AFTER its initial reference
      // publication and BEFORE the finish-time activation: exactly the window
      // where an (incorrect) intent for the inactive version would show.
      // (The first analysis's own enrichment pass stays a no-op here.)
      if (!observed && midJob.revisionBeforeCorrection >= 0) {
        observed = true;
        const rows = (await analysisRows(ownerRef)).filter((r) => r.target_taste_revision > midJob.revisionBeforeCorrection);
        midJob.correctionPayload = rows[0]?.payload ?? null;
      }
      return ENRICHMENT;
    });
    const { providers } = world({ overrides: { vlm: new QuickVlm(), vlmEnrich: enricher } });
    const ctx = await accountCtx(providers, config);
    const accountId = accountIdOf(ctx);
    ownerRef = accountId;

    const { capture_id, job_id } = await submit(ctx);
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: capture_id });
    await runJobs(ctx, [job_id]);
    expect((await analysisRows(accountId)).filter((r) => r.payload.capture_id === capture_id)).toHaveLength(1);

    // The user corrects the active analysis: the replacement version publishes
    // its references while the pointer still names version 1.
    const view = await captures.getCapture(ctx, { id: capture_id });
    const racing = view.references.find((r) => r.name === 'Vintage Racing')!;
    midJob.revisionBeforeCorrection = await tasteRevision(accountId);
    const correction = await analyses.submitCorrection(ctx, { id: capture_id, body: { expected_analysis_version: 1, reject_reference_ids: [racing.id] } });
    await runJobs(ctx, [correction.job_id]);

    // Mid-replacement-job observation: the correction's own intent is untouched
    // by the replacement's initial AND enrichment publications to the
    // still-inactive version.
    expect(midJob.correctionPayload).toMatchObject({ action: 'correct', capture_id });

    // After the replacement completes, the pointer move is the only re-arm:
    // exactly the activation-era row and the correction/activation row.
    const rows = (await analysisRows(accountId)).filter((r) => r.payload.capture_id === capture_id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.payload).toMatchObject({ action: 'references_published', stage: 'enrichment' });
    expect(rows[1]).toMatchObject({
      dispatch_state: 'pending',
      payload: { action: 'analysis_activated', capture_id, analysis_id: expect.any(String) },
    });
  });

  it('the reference publication and its projection intent commit or roll back together', async () => {
    const { providers } = world();
    const ctx = await accountCtx(providers, config);
    const accountId = accountIdOf(ctx);
    const { capture_id, job_id } = await submit(ctx);
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: capture_id });

    // Fail exactly the publication's intent write inside the publish transaction.
    await db.query(`DROP TRIGGER IF EXISTS ca_test_ref_pub_fence ON graph_outbox`);
    await db.query(`DROP FUNCTION IF EXISTS ca_test_ref_pub_fence`);
    await db.query(`
      CREATE FUNCTION ca_test_ref_pub_fence() RETURNS trigger AS $fence$
      BEGIN
        IF NEW.payload->>'action' = 'references_published' THEN
          RAISE EXCEPTION 'reference publication intent refused' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $fence$ LANGUAGE plpgsql`);
    await db.query(`CREATE TRIGGER ca_test_ref_pub_fence BEFORE INSERT ON graph_outbox
      FOR EACH ROW EXECUTE FUNCTION ca_test_ref_pub_fence()`);
    try {
      await db.query(`UPDATE jobs SET max_attempts = 1 WHERE id = $1`, [job_id]);
      await runJobs(ctx, [job_id]);
      expect((await getJobById(db, job_id))?.state).toBe('failed');

      // The whole publication rolled back with the intent: no reference rows,
      // the references section never completed, only the activation intent remains.
      const refs = await db.query(`SELECT 1 FROM capture_references cr JOIN analyses a ON a.id = cr.analysis_id WHERE a.capture_id = $1`, [capture_id]);
      expect(refs.rows).toHaveLength(0);
      const sections = await db.query<{ section_statuses: { references?: string } }>(`SELECT section_statuses FROM analyses WHERE capture_id = $1`, [capture_id]);
      expect(sections.rows[0]!.section_statuses.references).toBe('pending');
      const rows = await analysisRows(accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dispatch_state: 'pending', payload: { action: 'analysis_activated', capture_id } });
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ca_test_ref_pub_fence ON graph_outbox`);
      await db.query(`DROP FUNCTION IF EXISTS ca_test_ref_pub_fence`);
    }

    // With the fault gone, the retried job publishes the references and commits
    // the re-armed intent with them.
    await db.query(`UPDATE jobs SET state = 'queued', lease_owner = NULL, finished_at = NULL, max_attempts = 5 WHERE id = $1`, [job_id]);
    await runJobs(ctx, [job_id]);
    expect((await getJobById(db, job_id))?.state).toBe('complete');
    const rows = (await analysisRows(accountId)).filter((r) => r.payload.capture_id === capture_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dispatch_state: 'pending', payload: { action: 'references_published', stage: 'references' } });
    expect((await authorizedRefRows(capture_id)).length).toBeGreaterThan(0);
  });

  it('the enrichment publication and its projection intent commit or roll back together', async () => {
    const { providers } = world({ overrides: { vlm: new QuickVlm(), vlmEnrich: new ScriptedEnricher(async () => ENRICHMENT) } });
    const ctx = await accountCtx(providers, config);
    const accountId = accountIdOf(ctx);
    const { capture_id, job_id } = await submit(ctx);
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: capture_id });

    // Fail exactly the enrichment publication's intent write; the initial
    // publication (stage 'references') still commits inside its own transaction.
    await db.query(`DROP TRIGGER IF EXISTS ca_test_enrich_pub_fence ON graph_outbox`);
    await db.query(`DROP FUNCTION IF EXISTS ca_test_enrich_pub_fence`);
    await db.query(`
      CREATE FUNCTION ca_test_enrich_pub_fence() RETURNS trigger AS $fence$
      BEGIN
        IF NEW.payload->>'action' = 'references_published' AND NEW.payload->>'stage' = 'enrichment' THEN
          RAISE EXCEPTION 'enrichment publication intent refused' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $fence$ LANGUAGE plpgsql`);
    await db.query(`CREATE TRIGGER ca_test_enrich_pub_fence BEFORE INSERT ON graph_outbox
      FOR EACH ROW EXECUTE FUNCTION ca_test_enrich_pub_fence()`);
    try {
      await db.query(`UPDATE jobs SET max_attempts = 1 WHERE id = $1`, [job_id]);
      await runJobs(ctx, [job_id]);
      expect((await getJobById(db, job_id))?.state).toBe('failed');

      // The enrichment publication rolled back with its intent: its new
      // references are gone, the stage-1 reference stayed, and the intent row
      // still names the (committed) initial publication.
      const refs = await db.query<{ name: string }>(
        `SELECT r.canonical_name AS name
           FROM capture_references cr
           JOIN analyses a ON a.id = cr.analysis_id
           JOIN cultural_references r ON r.id = cr.reference_id
          WHERE a.capture_id = $1`,
        [capture_id],
      );
      const names = refs.rows.map((r) => r.name);
      expect(names).toContain('Vintage Racing');
      expect(names).not.toContain('Fixture Denim Co');
      expect(names).not.toContain('Mid-Century Modern');
      const rows = (await analysisRows(accountId)).filter((r) => r.payload.capture_id === capture_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dispatch_state: 'pending', payload: { action: 'references_published', stage: 'references' } });
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ca_test_enrich_pub_fence ON graph_outbox`);
      await db.query(`DROP FUNCTION IF EXISTS ca_test_enrich_pub_fence`);
    }

    // With the fault gone, the retried job re-publishes the enrichment and
    // commits its intent with it (newest intent wins on the same row).
    await db.query(`UPDATE jobs SET state = 'queued', lease_owner = NULL, finished_at = NULL, max_attempts = 5 WHERE id = $1`, [job_id]);
    await runJobs(ctx, [job_id]);
    expect((await getJobById(db, job_id))?.state).toBe('complete');
    const rows = (await analysisRows(accountId)).filter((r) => r.payload.capture_id === capture_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dispatch_state: 'pending', payload: { action: 'references_published', stage: 'enrichment' } });
    const names = (await authorizedRefRows(capture_id)).map((a) => a.name).sort();
    expect(names).toEqual(['Fixture Denim Co', 'Mid-Century Modern', 'Vintage Racing']);
  });

  it('session-owned captures and flag-off accounts never queue publication intents', async () => {
    // Flag off (default): the publication path stays silent.
    const offCtx = await accountCtx(world().providers, testConfig());
    const off = await submit(offCtx);
    await runJobs(offCtx, [off.job_id]);
    expect((await analysisRows(accountIdOf(offCtx))).length).toBe(0);
    expect((await db.query(`SELECT 1 FROM graph_outbox WHERE owner_account_id = $1`, [accountIdOf(offCtx)])).rows).toHaveLength(0);

    // Session-owned capture with projection on: no owner, no intent.
    const { providers } = world();
    const ctx = await anonCtx(providers, config);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    expect((await db.query(`SELECT 1 FROM graph_outbox WHERE payload->>'capture_id' = $1`, [capture_id])).rows).toHaveLength(0);
  });
});
