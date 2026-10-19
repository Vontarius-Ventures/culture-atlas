import {
  isProviderError,
  isUsable,
  ProviderError,
  type CallOptions,
  type QlooEntity,
  type QlooResponse,
  type QlooTag,
  type RequestBudget,
  ENRICHMENT_VETO_CERTAINTY_FACTOR,
  MERGED_CANDIDATES_MAX,
  VlmAnalysis,
  type VlmCandidate,
  type VlmEnrichment,
  candidateNameKey,
  mergeEnrichment,
  validateVision,
  vetoedCandidateKeys,
} from '@culture-atlas/providers';
import { activeKills } from '../flags/feature-flags';
import { CATEGORIES, LIMITS, type Category, type ReferenceType, type ResolutionStatus, type SectionStatus } from '../enums';
import { AppError } from '../errors';
import { EXAMPLE_REPLAY_MODEL, examplePickItems, exampleReplay, type ExampleReplay } from '../feed/examples';
import { ensureSampleItems, sampleKey } from '../feed/samples';
import type { JobContext } from '../jobs/handler';
import type { JobOutcome } from '../jobs/types';
import type { Owner } from '../principal';
import type { Focus } from '../schemas/common';
import { activateAnalysis, ensureAnalysisRow } from '../services/analyses';
import { foodExclusionsFor } from '../services/onboarding';
import { violatedExclusions } from '../composer/dietary';
import { JobBudget } from './budget';
import { composeDishIdeas } from './dishes';
import { reciprocalRankFusion, selectDiverse, type RankedList } from './fusion';
import { CATEGORY_ENTITY_TYPE, CATEGORY_ITEM_KIND, entityYear, searchTypesFor, TAG_RESOLVED_TYPES } from './mapping';
import { attemptCounter, attemptsSpent, errorSummary, recordProviderQuery } from './provider-queries';
import { researchReferences } from './research';
import {
  insertRecommendation,
  loadCapture,
  loadExcludedKeys,
  ownerFromRow,
  publishForCapture,
  setAnalysisSection,
  upsertDiscoveryItem,
  upsertReference,
  type CaptureForCompile,
} from './store';
import { humanList, nameSimilarity, normalizeName, slugify } from './text';

/**
 * Cultural compilation pipeline for one capture (build spec steps 3-8):
 *   observe    VLM structured observations / candidates / regions / uncertainty
 *   resolve    up to 5 candidates via Qloo /search or /v2/tags (<= 3 in flight);
 *              unmatched observations are preserved; at most 5 anchors
 *   recommend  Qloo /v2/insights per supported category with real returned ids
 *   enrich     stage 2 of the two-stage reading (amendment 2.2): merged
 *              deterministically, vetoes advisory, additions appended; never
 *              reorders or removes published cards (FAST-02)
 *   compose    rank fusion + diversity, <= 3 per category, <= 12 total, hidden
 *              items filtered, DiscoveryItem + Recommendation with evidence
 *   research   <= 5 reference pages with sourced claims (public library)
 *   eat        dish ideas from supported cuisine/place references (creative)
 * Sections are published progressively; each publish re-checks that the job
 * is still active and the capture still exists. Qloo unavailable -> reference
 * results are kept and discovery categories are marked 'unavailable'.
 */

export const QLOO_CATEGORIES = ['wear', 'play', 'watch'] as const satisfies readonly Category[];
const MATCH_THRESHOLD_ENTITY = 0.75;
const MATCH_THRESHOLD_TAG = 0.6;
const PROVIDER_CACHE_TTL_SECONDS = 24 * 3600;
/** Stage-2 enrichment deadline (amendment 2.2), further capped by the job's soft deadline. */
const ENRICH_TIMEOUT_MS = 20_000;

export const WARNINGS = {
  unclear: { code: 'unclear_photo', message: 'Try a clearer photo, or tell us what caught your eye.' },
  delayed: { code: 'discoveries_delayed', message: 'Related discoveries are taking longer.' },
} as const;

export interface ResolvedRef {
  referenceId: string;
  name: string;
  candidateName: string;
  type: ReferenceType;
  relation: 'depicted' | 'resembles' | 'user_selected';
  certainty: number;
  resolution: ResolutionStatus;
  qloo: { entityId?: string; tagId?: string; types?: string[] } | null;
  providerQueryId: string | null;
  isReplay: boolean;
  isAnchor: boolean;
  suggestedCategories: Category[];
  regionIds: string[];
  boxes: { x: number; y: number; w: number; h: number }[];
}

interface ObserveOutput {
  analysis: VlmAnalysis;
  model: string;
  /** Stage 1 was a Concentrate quick read (two-stage reading); only then may stage 2 run. */
  quickRead?: boolean;
}

/** Stage-2 model output, cached by runStage so a retried attempt never dispatches it twice. */
interface EnrichOutput {
  enrichment: VlmEnrichment | null;
  model: string | null;
  errorCode: string | null;
}

interface EnrichSummary {
  status: 'complete' | 'skipped' | 'failed';
  reason?: string | null;
  model?: string | null;
  confirmed?: number;
  vetoed?: number;
  additions?: number;
  resolvedAdditions?: number;
  appended?: Record<string, number>;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

interface ResolveOutput {
  refs: ResolvedRef[];
  qloo: 'ok' | 'unavailable' | 'errors' | 'budget';
}

/** Shared Qloo state while resolving one batch of candidates (budget exhaustion stops later lookups). */
interface QlooResolveState {
  usable: boolean;
  state: ResolveOutput['qloo'];
}

interface ResolveWork {
  candidate: VlmCandidate;
  userSelected: boolean;
}

interface CategoryCandidate {
  entityId: string;
  name: string;
  year: number | null;
  explain: string[];
}

interface RecommendOutput {
  category: Category;
  status: SectionStatus;
  providerQueryId: string | null;
  isReplay: boolean;
  candidates: CategoryCandidate[];
  reason?: string;
}

interface Correction {
  previous_analysis_id: string;
  reject_reference_ids: string[];
  confirm_reference_id?: string;
  replacement?: { name: string; type?: string };
}

const REFERENCE_TYPES: ReadonlySet<string> = new Set(['object', 'creator', 'work', 'brand', 'style', 'tradition', 'place', 'cuisine']);

function toRefType(t: string | undefined): ReferenceType {
  return t && REFERENCE_TYPES.has(t) ? (t as ReferenceType) : 'object';
}

function bestMatch<T>(name: string, items: readonly T[], nameOf: (t: T) => string, threshold: number): { item: T | null; ambiguous: boolean } {
  const scored = items.map((item) => ({ item, s: nameSimilarity(name, nameOf(item)) })).filter((x) => x.s >= threshold);
  if (scored.length === 0) return { item: null, ambiguous: false };
  scored.sort((a, b) => b.s - a.s);
  const top = scored[0]!;
  const second = scored[1];
  const ambiguous = top.s < 1 && !!second && second.s >= top.s - 0.05 && nameOf(second.item) !== nameOf(top.item);
  return { item: top.item, ambiguous };
}

function boxesFor(regionIds: readonly string[], analysis: VlmAnalysis) {
  return regionIds.map((id) => analysis.regions.find((r) => r.id === id)?.box).filter((b): b is NonNullable<typeof b> => !!b);
}

/** Plain-language "Why this?" — names references, never scores or provider names. */
export function buildReason(contributors: readonly ResolvedRef[]): string {
  const names = contributors.slice(0, 2).map((r) => r.name);
  if (names.length === 0) return 'Connected to what stood out in your photo.';
  const resembles = contributors.slice(0, 2).every((r) => r.relation === 'resembles');
  return resembles ? `Picked for the ${humanList(names)} feel of your photo.` : `Connected to ${humanList(names)} in your photo.`;
}

export class CaptureCompiler {
  private readonly startedAt = Date.now();
  private readonly softDeadlineAt: number;
  private budget!: JobBudget;
  private analysisId!: string;
  private capture!: CaptureForCompile;
  private owner!: Owner;
  private readonly warnings = new Map<string, { code: string; message: string }>();
  private readonly sections = new Map<string, SectionStatus>();
  private readonly traceId: string | null;
  /** Reviewed replay for an example photo when the VLM is unavailable (feed/examples.ts). */
  private example: ExampleReplay | null = null;
  /** Two-stage plan, decided before stage 1 (both calls reserved together). */
  private twoStage: { enabled: boolean; reason: string | null } = { enabled: false, reason: 'not_planned' };
  constructor(private readonly ctx: JobContext<'analyze_capture'>) {
    this.softDeadlineAt = this.startedAt + Math.floor(ctx.budget.deadlineMs * 0.75);
    this.traceId = ctx.job.trace_id;
  }

  private pastSoftDeadline(): boolean {
    return Date.now() > this.softDeadlineAt || this.ctx.signal.aborted;
  }

  private callOptions(stage: string): CallOptions {
    return { signal: this.ctx.signal, budget: this.budget.forStage(stage), maxRetries: this.ctx.budget.providerRetries, traceId: this.traceId ?? undefined };
  }

  /**
   * Every Qloo call goes through here: refuse when the job budget is spent
   * (even if an adapter would not check), and charge at least one request per
   * logical call. Returns the number of requests charged for this call.
   */
  private async qlooCall<T>(stage: string, fn: (options: CallOptions) => Promise<T>): Promise<{ value: T; attempts: number }> {
    // Prepay the first request synchronously so concurrent calls can never
    // overshoot the budget, whether or not the adapter consults it.
    const stageBudget = this.budget.forStage(stage);
    if (!stageBudget.take('qloo', 'request')) throw Object.assign(new ProviderError('qloo', 'budget_exhausted', 'qloo request budget exhausted'), { attempts: 0 });
    let prepaid = true;
    let attempts = 1;
    const budget: RequestBudget = {
      take: (provider, kind) => {
        if (provider === 'qloo' && kind === 'request' && prepaid) {
          prepaid = false;
          return true;
        }
        const ok = stageBudget.take(provider, kind);
        if (ok && provider === 'qloo') attempts++;
        return ok;
      },
    };
    try {
      return { value: await fn({ ...this.callOptions(stage), budget }), attempts };
    } catch (err) {
      throw Object.assign(err as object, { attempts });
    }
  }

  private async section(name: string, status: SectionStatus): Promise<void> {
    this.sections.set(name, status);
    await setAnalysisSection(this.ctx.db, this.analysisId, name, status);
  }

  private async traceStage(name: string, started: number, data: Record<string, unknown>): Promise<void> {
    await this.ctx.trace({ kind: 'stage', name, data, durationMs: Date.now() - started, traceId: this.traceId });
  }

  async run(): Promise<JobOutcome> {
    const { ctx } = this;
    const capture = await loadCapture(ctx.db, ctx.payload.capture_id);
    if (!capture || capture.deleted_at) {
      await ctx.ensureActive();
      throw new AppError('not_found', { message: 'Capture no longer exists.', retryable: false });
    }
    this.capture = capture;
    this.owner = ownerFromRow(capture);
    // "Try an example" replays its reviewed reading when no vision model can
    // serve this job: none is usable, or the job has no account and the budgeted
    // gateway (which charges spend to an account) would refuse it.
    const modelServesJob = isUsable(ctx.providers.vlm.capability()) && !(ctx.providers.modelGateway && !ctx.job.owner_account_id);
    this.example = capture.source === 'sample' && !modelServesJob ? exampleReplay(capture.sample_id) : null;

    const row = await ensureAnalysisRow(ctx.db, {
      captureId: capture.id,
      version: ctx.payload.analysis_version,
      compilerVersion: ctx.payload.compiler_version,
      focus: ctx.payload.focus,
      jobId: ctx.job.id,
    });
    this.analysisId = row.id;
    this.budget = new JobBudget(
      {
        qlooRequests: ctx.budget.qlooRequests,
        researchRefs: ctx.budget.researchRefs,
        retriesPerStage: ctx.budget.providerRetries,
        visionCalls: LIMITS.visionCallsPerAnalysis,
      },
      { qloo: await attemptsSpent(ctx.db, row.id, 'qloo') },
    );
    await ctx.db.query(
      `UPDATE captures SET status = 'processing', updated_at = now() WHERE id = $1 AND deleted_at IS NULL AND status IN ('pending', 'failed')`,
      [capture.id],
    );

    // ---- observe -----------------------------------------------------------
    await ctx.setStage('observing');
    let t0 = Date.now();
    const correction = ctx.payload.correction as Correction | undefined;
    const { rejectedNames, confirmed } = await this.loadCorrection(correction);
    const rejectedIds = new Set(correction?.reject_reference_ids ?? []);
    // Two-stage reading (amendment 2.2): decide up front and reserve both calls.
    this.twoStage = await this.planTwoStage(!!ctx.payload.media_analysis_id);
    const observed = await ctx.runStage<ObserveOutput>('observe', () => this.observe(rejectedNames, confirmed));
    await this.publishObserve(observed.analysis);
    await this.traceStage('observe', t0, { model: observed.model, candidates: observed.analysis.candidates.length, usable: observed.analysis.quality.usable });

    if (!observed.analysis.quality.usable) {
      this.warnings.set(WARNINGS.unclear.code, WARNINGS.unclear);
      for (const s of ['references', 'research', ...CATEGORIES]) await this.section(s, 'skipped');
      return this.finish();
    }

    // ---- resolve -----------------------------------------------------------
    await ctx.setStage('resolving');
    t0 = Date.now();
    const resolved = await ctx.runStage<ResolveOutput>('resolve', () => this.resolve(observed.analysis, rejectedNames, rejectedIds, confirmed, correction?.replacement));
    await this.publishReferences(resolved);
    await this.traceStage('resolve', t0, {
      resolved: resolved.refs.filter((r) => r.qloo).length,
      unmatched: resolved.refs.filter((r) => r.resolution === 'unmatched').length,
      anchors: resolved.refs.filter((r) => r.isAnchor).length,
      qloo: resolved.qloo,
    });

    // ---- recommend + compose per Qloo category (progressive) ---------------
    await ctx.setStage('recommending');
    const anchors = resolved.refs.filter((r) => r.isAnchor);
    const order = this.categoryOrder(anchors);
    const excluded = await loadExcludedKeys(ctx.db, this.owner);
    const usedKeys = new Set<string>(anchors.flatMap((a) => (a.qloo?.entityId ? [`qloo:${a.qloo.entityId}`] : [])));
    const qlooCaps = ctx.providers.qloo.capability();
    for (const category of order.filter((c): c is (typeof QLOO_CATEGORIES)[number] => (QLOO_CATEGORIES as readonly string[]).includes(c))) {
      t0 = Date.now();
      const rec = await ctx.runStage<RecommendOutput>(`recommend:${category}`, () => this.recommend(category, anchors, isUsable(qlooCaps.insights)));
      await this.composeCategory(rec, resolved.refs, order, excluded, usedKeys);
      await this.traceStage(`recommend:${category}`, t0, { status: rec.status, candidates: rec.candidates.length, reason: rec.reason });
    }
    if (resolved.qloo === 'unavailable' || [...this.sections.entries()].some(([k, v]) => (QLOO_CATEGORIES as readonly string[]).includes(k) && (v === 'unavailable' || v === 'failed'))) {
      this.warnings.set(WARNINGS.delayed.code, WARNINGS.delayed);
    }

    // ---- enrich (stage 2, background; never reorders or removes cards) ----
    t0 = Date.now();
    await ctx.setStage('enriching');
    const enriched = await this.enrichStage(observed, resolved, { rejectedNames, rejectedIds }, order, excluded, usedKeys);
    await this.traceStage('enrich', t0, { ...enriched });

    // ---- research ----------------------------------------------------------
    await ctx.setStage('researching');
    t0 = Date.now();
    if (this.pastSoftDeadline()) {
      await this.section('research', 'skipped');
    } else {
      await this.section('research', 'running');
      const targets = [...resolved.refs]
        .filter((r) => r.resolution !== 'ambiguous')
        .sort((a, b) => Number(b.isAnchor) - Number(a.isAnchor) || b.certainty - a.certainty)
        .map((r) => ({ referenceId: r.referenceId, name: r.name, type: r.type }));
      const research = await researchReferences({
        db: ctx.db,
        providers: ctx.providers,
        targets,
        maxRefs: Math.min(ctx.budget.researchRefs, LIMITS.researchedReferencesMax),
        analysisId: this.analysisId,
        traceId: this.traceId,
        callOptions: (stage) => this.callOptions(stage),
        shouldStop: () => this.pastSoftDeadline(),
      });
      await publishForCapture(ctx.db, capture.id, ctx.ensureActive, async (tx) => {
        await setAnalysisSection(tx, this.analysisId, 'research', research.status);
      });
      this.sections.set('research', research.status);
      await this.traceStage('research', t0, { status: research.status, researched: research.researched.length, reused: research.reused.length, failed: research.failed.length });
    }

    // ---- eat (creative dish ideas from supported references) --------------
    t0 = Date.now();
    await ctx.setStage('composing');
    const eatStatus = await this.composeEat(resolved.refs, order, excluded, usedKeys);
    await this.traceStage('recommend:eat', t0, { status: eatStatus });

    if (this.example) {
      t0 = Date.now();
      const added = await this.composeExample(this.example, resolved.refs, order, excluded, usedKeys);
      await this.traceStage('example', t0, { sample_id: this.example.sampleId, picks: added, origin: 'sample' });
    }

    return this.finish();
  }

  // -------------------------------------------------------------------------

  private async loadCorrection(correction: Correction | undefined): Promise<{
    rejectedNames: string[];
    confirmed: { id: string; name: string; type: ReferenceType; externalIds: Record<string, unknown> } | null;
  }> {
    if (!correction) return { rejectedNames: [], confirmed: null };
    const ids = [...correction.reject_reference_ids, ...(correction.confirm_reference_id ? [correction.confirm_reference_id] : [])];
    const { rows } = ids.length
      ? await this.ctx.db.query<{ id: string; canonical_name: string; type: ReferenceType; external_ids: Record<string, unknown> }>(
          'SELECT id, canonical_name, type, external_ids FROM cultural_references WHERE id = ANY($1::uuid[])',
          [ids],
        )
      : { rows: [] };
    const byId = new Map(rows.map((r) => [r.id, r]));
    const rejectedNames = correction.reject_reference_ids.map((id) => byId.get(id)?.canonical_name).filter((n): n is string => !!n);
    const c = correction.confirm_reference_id ? byId.get(correction.confirm_reference_id) : undefined;
    return { rejectedNames, confirmed: c ? { id: c.id, name: c.canonical_name, type: c.type, externalIds: c.external_ids } : null };
  }

  private async focusForVlm(): Promise<{ label?: string; box?: { x: number; y: number; w: number; h: number } } | undefined> {
    const focus = this.ctx.payload.focus as Focus;
    if (focus.kind === 'whole') return undefined;
    if (focus.kind === 'region') return { box: focus.box, label: focus.label };
    if (focus.label) return { label: focus.label };
    // Resolve a choice id against the clarifying question of the active analysis.
    const { rows } = await this.ctx.db.query<{ clarifying_question: { choices?: { id: string; label: string }[] } | null }>(
      'SELECT a.clarifying_question FROM analyses a JOIN captures c ON c.active_analysis_id = a.id WHERE c.id = $1',
      [this.capture.id],
    );
    const label = rows[0]?.clarifying_question?.choices?.find((ch) => ch.id === focus.choice_id)?.label;
    return label ? { label } : undefined;
  }

  private async observe(rejectedNames: string[], confirmed: { name: string } | null): Promise<ObserveOutput> {
    const { ctx } = this;
    if (ctx.payload.media_analysis_id) return this.observeFromMedia(ctx.payload.media_analysis_id, rejectedNames);
    if (!this.capture.private_object_key) throw new AppError('internal', { message: 'Capture image is missing.', retryable: false });
    const object = await ctx.providers.storage.get(this.capture.private_object_key);
    if (!object) {
      await ctx.ensureActive();
      throw new AppError('internal', { message: 'Capture image is missing.', retryable: false });
    }
    const replacement = (ctx.payload.correction as Correction | undefined)?.replacement?.name;
    const confirmedInterests = [confirmed?.name, replacement].filter((v): v is string => !!v);
    if (this.example) return this.observeExample(this.example);
    const counter = attemptCounter();
    const started = Date.now();
    const request = {
      model_capability: ctx.providers.vlm.id,
      focus: (ctx.payload.focus as Focus).kind,
      max_candidates: LIMITS.vlmCandidatesToResolve,
      confirmed_interests: confirmedInterests.length,
      rejected: rejectedNames.length,
    };
    try {
      const res = await ctx.providers.vlm.analyzeImage(
        {
          image: { bytes: object.body, mediaType: 'image/jpeg' },
          focus: await this.focusForVlm(),
          confirmedInterests,
          rejectedNames,
          maxCandidates: LIMITS.vlmCandidatesToResolve,
        },
        { ...this.callOptions('observe'), onAttempt: counter.observer },
      );
      await recordProviderQuery(ctx.db, {
        parent: { analysisId: this.analysisId },
        provider: 'vlm',
        operation: 'analyze_image',
        request,
        results: {
          model: res.model,
          observations: res.analysis.observations.length,
          candidates: res.analysis.candidates.map((c) => ({ id: c.id, name: c.name, type: c.type, relation: c.relation, certainty: c.certainty })),
          quality: res.analysis.quality,
          uncertainty: res.analysis.uncertainty.overall,
        },
        status: 'ok',
        durationMs: Date.now() - started,
        queryContext: { stage: 'observe', attempts: counter.count() },
        traceId: this.traceId,
      });
      // Drop candidates the user already rejected even if the model repeats them.
      const rejected = new Set(rejectedNames.map(normalizeName));
      res.analysis.candidates = res.analysis.candidates.filter((c) => !rejected.has(normalizeName(c.name)));
      return { analysis: res.analysis, model: res.model, quickRead: !!res.quick };
    } catch (err) {
      const e = errorSummary(err);
      await recordProviderQuery(ctx.db, {
        parent: { analysisId: this.analysisId },
        provider: 'vlm',
        operation: 'analyze_image',
        request,
        status: 'error',
        errorCode: e.code,
        httpStatus: e.status,
        durationMs: Date.now() - started,
        queryContext: { stage: 'observe', attempts: counter.count() },
        traceId: this.traceId,
      });
      throw err;
    }
  }

  /**
   * v2 media analysis already produced a validated reading for this capture
   * (owner, capture link and media liveness re-checked here). No second model call.
   */
  private async observeFromMedia(mediaAnalysisId: string, rejectedNames: string[]): Promise<ObserveOutput> {
    const { rows } = await this.ctx.db.query<{ observation: unknown; observation_model: string | null; reading: string | null }>(
      `SELECT a.observation, a.observation_model, a.result->>'reading' AS reading FROM media_analysis_requests a
         JOIN media_assets m ON m.account_id = a.account_id AND m.id = a.asset_id AND m.deleted_at IS NULL
        WHERE a.id = $1 AND a.capture_id = $2 AND a.account_id = $3 AND a.observation IS NOT NULL`,
      [mediaAnalysisId, this.capture.id, this.capture.owner_account_id],
    );
    const row = rows[0];
    if (!row) {
      await this.ctx.ensureActive();
      throw new AppError('not_found', { message: 'This media is no longer available.', retryable: false });
    }
    const analysis = VlmAnalysis.parse(row.observation);
    const rejected = new Set(rejectedNames.map(normalizeName));
    analysis.candidates = analysis.candidates.filter((c) => !rejected.has(normalizeName(c.name)));
    const model = row.observation_model ?? 'unknown';
    await recordProviderQuery(this.ctx.db, {
      parent: { analysisId: this.analysisId },
      provider: 'vlm',
      operation: 'analyze_image',
      request: { source: 'media_analysis', media_analysis_id: mediaAnalysisId },
      results: {
        model,
        observations: analysis.observations.length,
        candidates: analysis.candidates.map((c) => ({ id: c.id, name: c.name, type: c.type, relation: c.relation, certainty: c.certainty })),
        quality: analysis.quality,
        uncertainty: analysis.uncertainty.overall,
      },
      status: 'ok',
      durationMs: 0,
      queryContext: { stage: 'observe', source: 'media_analysis' },
      traceId: this.traceId,
    });
    // The v2 worker marks readings built from Concentrate quick reads; only those get stage 2.
    return { analysis, model, quickRead: row.reading === 'quick' };
  }

  /**
   * Example photo without a VLM: replay the reviewed reading (never a model
   * output) and record it as a replayed observe query for the inspector.
   */
  private async observeExample(example: ExampleReplay): Promise<ObserveOutput> {
    await recordProviderQuery(this.ctx.db, {
      parent: { analysisId: this.analysisId },
      provider: 'vlm',
      operation: 'analyze_image',
      request: { example: example.sampleId, reason: 'vlm_unavailable' },
      results: {
        model: EXAMPLE_REPLAY_MODEL,
        reviewed_at: example.reviewedAt,
        observations: example.analysis.observations.length,
        candidates: example.analysis.candidates.map((c) => ({ id: c.id, name: c.name, type: c.type, relation: c.relation, certainty: c.certainty })),
        quality: example.analysis.quality,
        uncertainty: example.analysis.uncertainty.overall,
      },
      status: 'ok',
      durationMs: 0,
      isReplay: true,
      queryContext: { stage: 'observe', example: example.sampleId },
      traceId: this.traceId,
    });
    return { analysis: example.analysis, model: EXAMPLE_REPLAY_MODEL };
  }

  /**
   * Adds the example's reviewed picks (public sample items, origin 'sample')
   * to categories that have no live results. Live provider results always
   * win; picks are never labeled as provider results.
   */
  private async composeExample(example: ExampleReplay, refs: readonly ResolvedRef[], order: readonly Category[], excluded: Set<string>, usedKeys: Set<string>): Promise<number> {
    const { ctx } = this;
    await ensureSampleItems(ctx.db);
    const picks = examplePickItems(example);
    const { rows } = await ctx.db.query<{ id: string; canonical_key: string }>(
      'SELECT id, canonical_key FROM discovery_items WHERE is_sample AND canonical_key = ANY($1::text[])',
      [picks.map((p) => sampleKey(p.item.slug))],
    );
    const idByKey = new Map(rows.map((r) => [r.canonical_key, r.id]));
    let added = 0;
    await publishForCapture(ctx.db, this.capture.id, ctx.ensureActive, async (tx) => {
      const { rows: live } = await tx.query<{ category: Category }>('SELECT DISTINCT category FROM recommendations WHERE analysis_id = $1 AND category IS NOT NULL', [this.analysisId]);
      const liveCategories = new Set(live.map((r) => r.category));
      const positions = new Map<Category, number>();
      for (const { pick, item } of picks) {
        const key = sampleKey(item.slug);
        const itemId = idByKey.get(key);
        if (!itemId || liveCategories.has(pick.category) || excluded.has(key) || usedKeys.has(key)) continue;
        const position = positions.get(pick.category) ?? 0;
        if (position >= LIMITS.recommendationsPerCategory) continue;
        positions.set(pick.category, position + 1);
        const contributors = pick.references
          .map((name) => refs.find((r) => normalizeName(r.candidateName) === normalizeName(name)))
          .filter((r): r is ResolvedRef => !!r);
        await insertRecommendation(tx, {
          analysisId: this.analysisId,
          discoveryItemId: itemId,
          category: pick.category,
          rank: this.rankFor(order, pick.category, position),
          title: item.title,
          externalIds: {},
          displayReason: pick.reason,
          origin: 'sample',
          providerQueryIds: [],
          contributingReferenceIds: contributors.map((r) => r.referenceId),
          destinationUrl: item.destination_url,
        });
        usedKeys.add(key);
        added++;
      }
      for (const category of positions.keys()) {
        await setAnalysisSection(tx, this.analysisId, category, 'partial');
        this.sections.set(category, 'partial');
      }
    });
    return added;
  }

  private async publishObserve(analysis: VlmAnalysis): Promise<void> {
    const focus = this.ctx.payload.focus as Focus;
    const question =
      focus.kind === 'whole' && analysis.competing_subjects.length >= 2
        ? {
            prompt: 'What caught your eye?',
            choices: analysis.competing_subjects.slice(0, LIMITS.clarifyingChoicesMax).map((s) => ({ id: s.id, label: s.label })),
            whole_photo_choice_id: 'whole',
          }
        : null;
    const observations = [
      ...analysis.observations,
      ...analysis.visible_text.map((t, i) => ({ id: `text${i + 1}`, kind: 'visible_text', text: t.text, region_ids: t.region_id ? [t.region_id] : [] })),
    ];
    const candidates = analysis.candidates.map((c) => ({ ...c, boxes: boxesFor(c.region_ids, analysis) }));
    const isCorrection = !!this.ctx.payload.correction;
    await publishForCapture(this.ctx.db, this.capture.id, this.ctx.ensureActive, async (tx, capture) => {
      await tx.query(
        `UPDATE analyses SET title = $2, interpretation = $3, observations = $4::jsonb, candidates = $5::jsonb,
                clarifying_question = $6::jsonb,
                section_statuses = section_statuses || '{"observations":"complete"}'::jsonb
          WHERE id = $1`,
        [this.analysisId, analysis.title.slice(0, 120), analysis.interpretation.slice(0, 300), JSON.stringify(observations), JSON.stringify(candidates), question ? JSON.stringify(question) : null],
      );
      // The capture's own card takes the editorial title of its first analysis.
      if (!capture.active_analysis_id || isCorrection) {
        await tx.query(`UPDATE discovery_items SET title = $2, updated_at = now() WHERE capture_id = $1 AND kind = 'capture'`, [capture.id, analysis.title.slice(0, 120)]);
      }
      // Progressive publishing: a first analysis becomes visible right away.
      // Correction versions are activated when complete (analyses are immutable).
      if (!capture.active_analysis_id) await activateAnalysis(tx, { captureId: capture.id, analysisId: this.analysisId });
    });
    this.sections.set('observations', 'complete');
  }

  private categoriesFor(c: VlmCandidate): Category[] {
    return [...new Set(c.suggested_categories)] as Category[];
  }

  private async resolve(
    analysis: VlmAnalysis,
    rejectedNames: string[],
    rejectedIds: ReadonlySet<string>,
    confirmed: { id: string; name: string; type: ReferenceType; externalIds: Record<string, unknown> } | null,
    replacement: { name: string; type?: string } | undefined,
  ): Promise<ResolveOutput> {
    const { ctx } = this;
    const caps = ctx.providers.qloo.capability();
    const qlooUsable = isUsable(caps.search) || isUsable(caps.tags);
    const rejected = new Set(rejectedNames.map(normalizeName));
    const q: QlooResolveState = { usable: qlooUsable, state: qlooUsable ? 'ok' : 'unavailable' };

    const candidates = [...analysis.candidates]
      .filter((c) => !rejected.has(normalizeName(c.name)))
      .sort((a, b) => b.certainty - a.certainty)
      .slice(0, LIMITS.vlmCandidatesToResolve);

    const work: { candidate: VlmCandidate; userSelected: boolean }[] = candidates.map((c) => ({ candidate: c, userSelected: false }));
    if (replacement) {
      work.unshift({
        userSelected: true,
        candidate: {
          id: 'user-replacement',
          name: replacement.name,
          type: toRefType(replacement.type),
          relation: 'resembles',
          rationale: 'Named by the user',
          certainty: 1,
          region_ids: [],
          suggested_categories: ['wear', 'play', 'watch', 'eat'],
          tag_queries: [],
        },
      });
    }

    const refs: ResolvedRef[] = [];
    if (confirmed) {
      const q = confirmed.externalIds;
      refs.push({
        referenceId: confirmed.id,
        name: confirmed.name,
        candidateName: confirmed.name,
        type: confirmed.type,
        relation: 'user_selected',
        certainty: 1,
        resolution: 'user_confirmed',
        qloo: typeof q.qloo === 'string' ? { entityId: q.qloo } : typeof q.qloo_tag === 'string' ? { tagId: q.qloo_tag } : null,
        providerQueryId: null,
        isReplay: false,
        isAnchor: false,
        suggestedCategories: ['wear', 'play', 'watch', 'eat'],
        regionIds: [],
        boxes: [],
      });
    }


    const results = await this.resolveCandidates(work, analysis, q);
    for (const r of results) {
      if (refs.some((x) => x.referenceId === r.referenceId)) continue;
      // A candidate that resolves to a reference the user rejected stays rejected.
      if (rejectedIds.has(r.referenceId)) r.resolution = 'rejected';
      refs.push(r);
    }

    // Anchors: resolved with real provider ids; user selections first, then
    // depicted, then certainty. At most five.
    const anchorable = refs
      .filter((r) => r.qloo && (r.resolution === 'resolved' || r.resolution === 'user_confirmed'))
      .sort(
        (a, b) =>
          Number(b.relation === 'user_selected') - Number(a.relation === 'user_selected') ||
          Number(b.relation === 'depicted') - Number(a.relation === 'depicted') ||
          b.certainty - a.certainty,
      )
      .slice(0, LIMITS.anchorsMax);
    for (const a of anchorable) a.isAnchor = true;
    return { refs, qloo: q.state };
  }

  /**
   * Resolves candidates through Qloo (/search or /v2/tags) with at most
   * LIMITS.qlooResolveConcurrency requests in flight; the job budget is shared
   * and synchronous, so concurrent calls never overshoot it.
   */
  private async resolveCandidates(work: readonly ResolveWork[], analysis: VlmAnalysis, q: QlooResolveState): Promise<ResolvedRef[]> {
    let next = 0;
    const results: ResolvedRef[] = new Array(work.length);
    await Promise.all(
      Array.from({ length: Math.min(LIMITS.qlooResolveConcurrency, work.length) }, async () => {
        while (next < work.length) {
          const i = next++;
          results[i] = await this.resolveCandidate(work[i]!, analysis, q);
        }
      }),
    );
    return results;
  }

  private async resolveCandidate({ candidate, userSelected }: ResolveWork, analysis: VlmAnalysis, q: QlooResolveState): Promise<ResolvedRef> {
    const { ctx } = this;
    const type = toRefType(candidate.type);
    const base = {
      candidateName: candidate.name,
      type,
      relation: userSelected ? ('user_selected' as const) : candidate.relation,
      certainty: candidate.certainty,
      suggestedCategories: this.categoriesFor(candidate),
      regionIds: candidate.region_ids,
      boxes: boxesFor(candidate.region_ids, analysis),
    };
    let match: { kind: 'entity'; entity: QlooEntity } | { kind: 'tag'; tag: QlooTag } | null = null;
    let ambiguous = false;
    let providerQueryId: string | null = null;
    let isReplay = false;
    if (q.usable && q.state !== 'budget') {
      const useTags = TAG_RESOLVED_TYPES.has(type);
      const counter = attemptCounter();
      const started = Date.now();
      const query = useTags ? (candidate.tag_queries[0] ?? candidate.name) : candidate.name;
      let attempts: number;
      try {
        let res: QlooResponse<QlooEntity[]> | QlooResponse<QlooTag[]>;
        if (useTags) {
          const call = await this.qlooCall('resolve', (o) => ctx.providers.qloo.lookupTags({ query, take: 5 }, { ...o, onAttempt: counter.observer }));
          attempts = call.attempts;
          const r = call.value;
          const m = bestMatch(query, r.data, (t) => t.name, MATCH_THRESHOLD_TAG);
          const alt = m.item ? m : bestMatch(candidate.name, r.data, (t) => t.name, MATCH_THRESHOLD_TAG);
          if (alt.item) match = { kind: 'tag', tag: alt.item };
          ambiguous = alt.ambiguous;
          res = r;
        } else {
          const call = await this.qlooCall('resolve', (o) => ctx.providers.qloo.searchEntities({ query, types: searchTypesFor(type), take: 5 }, { ...o, onAttempt: counter.observer }));
          attempts = call.attempts;
          const r = call.value;
          const m = bestMatch(query, r.data, (e) => e.name, MATCH_THRESHOLD_ENTITY);
          if (m.item) match = { kind: 'entity', entity: m.item };
          ambiguous = m.ambiguous;
          res = r;
        }
        isReplay = res.is_replay;
        providerQueryId = await recordProviderQuery(ctx.db, {
          parent: { analysisId: this.analysisId },
          provider: 'qloo',
          operation: useTags ? 'tags' : 'search',
          request: res.request,
          results: (res.data as (QlooEntity | QlooTag)[]).map((x, i) =>
            'entity_id' in x ? { rank: i + 1, entity_id: x.entity_id, name: x.name, types: x.types } : { rank: i + 1, tag_id: x.id, name: x.name, type: x.type },
          ),
          status: res.data.length ? 'ok' : 'empty',
          httpStatus: res.status,
          durationMs: res.duration_ms,
          isReplay: res.is_replay,
          queryContext: { stage: 'resolve', candidate_id: candidate.id, candidate_name: candidate.name, matched: match !== null, attempts },
          traceId: this.traceId,
          cacheTtlSeconds: PROVIDER_CACHE_TTL_SECONDS,
        });
      } catch (err) {
        const e = errorSummary(err);
        if (isProviderError(err) && err.kind === 'budget_exhausted') q.state = 'budget';
        else if (isProviderError(err) && (err.kind === 'unavailable' || err.kind === 'auth')) q.state = q.state === 'ok' ? 'unavailable' : q.state;
        else if (q.state === 'ok') q.state = 'errors';
        attempts = (err as { attempts?: number }).attempts ?? counter.count();
        if (e.code !== 'budget_exhausted' || attempts > 0) {
          await recordProviderQuery(ctx.db, {
            parent: { analysisId: this.analysisId },
            provider: 'qloo',
            operation: TAG_RESOLVED_TYPES.has(type) ? 'tags' : 'search',
            request: { query },
            status: 'error',
            errorCode: e.code,
            httpStatus: e.status,
            durationMs: Date.now() - started,
            queryContext: { stage: 'resolve', candidate_id: candidate.id, attempts },
            traceId: this.traceId,
          });
        }
      }
    }

    if (match?.kind === 'entity') {
      const e = match.entity;
      const referenceId = await upsertReference(ctx.db, { canonicalKey: `qloo:${e.entity_id}`, name: e.name, type, externalIds: { qloo: e.entity_id, qloo_types: e.types } });
      return { ...base, referenceId, name: e.name, resolution: ambiguous ? 'ambiguous' : userSelected ? 'user_confirmed' : 'resolved', qloo: { entityId: e.entity_id, types: e.types }, providerQueryId, isReplay, isAnchor: false };
    }
    if (match?.kind === 'tag') {
      const t = match.tag;
      const referenceId = await upsertReference(ctx.db, { canonicalKey: `qloo_tag:${t.id}`, name: t.name, type, externalIds: { qloo_tag: t.id, qloo_tag_type: t.type } });
      return { ...base, referenceId, name: t.name, resolution: ambiguous ? 'ambiguous' : userSelected ? 'user_confirmed' : 'resolved', qloo: { tagId: t.id }, providerQueryId, isReplay, isAnchor: false };
    }
    // Unmatched: keep the descriptive observation as a qualified reference.
    const referenceId = await upsertReference(ctx.db, { canonicalKey: `${type}:${slugify(candidate.name)}`, name: candidate.name, type, externalIds: {} });
    return { ...base, referenceId, name: candidate.name, resolution: userSelected ? 'user_confirmed' : 'unmatched', qloo: null, providerQueryId, isReplay: false, isAnchor: false };
  }

  private async publishReferences(out: ResolveOutput): Promise<void> {
    const status: SectionStatus = out.refs.length === 0 ? 'complete' : out.qloo === 'ok' ? 'complete' : 'partial';
    await publishForCapture(this.ctx.db, this.capture.id, this.ctx.ensureActive, async (tx) => {
      for (const r of out.refs) {
        await tx.query(
          `INSERT INTO capture_references (analysis_id, reference_id, relation, evidence_region, certainty, resolution_status, is_anchor)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
           ON CONFLICT (analysis_id, reference_id, relation) DO UPDATE
             SET evidence_region = EXCLUDED.evidence_region, certainty = EXCLUDED.certainty,
                 resolution_status = EXCLUDED.resolution_status, is_anchor = EXCLUDED.is_anchor`,
          [this.analysisId, r.referenceId, r.relation, JSON.stringify({ region_ids: r.regionIds, boxes: r.boxes }), Math.min(1, Math.max(0, r.certainty)), r.resolution, r.isAnchor],
        );
      }
      await setAnalysisSection(tx, this.analysisId, 'references', status);
    });
    this.sections.set('references', status);
  }

  // ---- two-stage reading (amendment 2.2) -----------------------------------

  /** Operator kills apply between stages too: fast_analysis_two_stage or analysis as a whole. */
  private async twoStageKilled(): Promise<boolean> {
    const killed = await activeKills(this.ctx.db, this.ctx.job.owner_account_id ?? NIL_UUID, this.ctx.config);
    return killed.has('fast_analysis_two_stage') || killed.has('concentrate_analysis_enabled');
  }

  /**
   * fast_analysis_two_stage for this job: a usable stage-2 enricher (a
   * qualified Concentrate vision_photo_enrich role; never Elorian), not
   * killed, and room for both calls. Both calls are reserved together: in the
   * job budget, and (for the real gateway) checked against the spend ledger
   * before stage 1 is dispatched, so stage 2 is not planned when only stage 1
   * would fit. When off, the reading is the single stage-1 call.
   */
  private async planTwoStage(fromMedia: boolean): Promise<{ enabled: boolean; reason: string | null }> {
    const { ctx } = this;
    // A v2 media reading already spent stage 1 in the media worker; this job only adds stage 2.
    const stage1Calls = fromMedia ? 0 : 1;
    const off = (reason: string) => {
      if (stage1Calls) this.budget.reserveVisionCalls(stage1Calls);
      return { enabled: false, reason };
    };
    if (this.example) return off('example');
    if (!isUsable(ctx.providers.vlmEnrich.capability())) return off('enrich_unavailable');
    if (await this.twoStageKilled()) return off('killed');
    const gateway = ctx.providers.modelGateway;
    const enrichRunner = gateway?.runners.vision_photo_enrich;
    if (enrichRunner && gateway?.ledger) {
      const accountId = ctx.job.owner_account_id;
      if (!accountId) return off('no_account');
      const stage1 = fromMedia ? undefined : gateway.runners.vision_photo?.profile;
      const profiles = [...(stage1 ? [stage1] : []), enrichRunner.profile];
      if (!(await gateway.ledger.canReserveAll({ accountId, jobId: ctx.job.id }, profiles))) return off('budget');
    }
    if (!this.budget.reserveVisionCalls(stage1Calls + 1)) return off('budget');
    return { enabled: true, reason: null };
  }

  private async enrichStage(
    observed: ObserveOutput,
    resolved: ResolveOutput,
    rejected: { rejectedNames: string[]; rejectedIds: ReadonlySet<string> },
    order: readonly Category[],
    excluded: Set<string>,
    usedKeys: Set<string>,
  ): Promise<EnrichSummary> {
    const { ctx } = this;
    if (!this.twoStage.enabled) return { status: 'skipped', reason: this.twoStage.reason };
    if (!observed.quickRead) return { status: 'skipped', reason: 'single_stage_reading' };
    if (this.pastSoftDeadline()) return { status: 'skipped', reason: 'deadline' };
    if (await this.twoStageKilled()) return { status: 'skipped', reason: 'killed' };
    const out = await ctx.runStage<EnrichOutput>('enrich', () => this.enrich(observed.analysis));
    // A failed or timed-out enrichment leaves every stage-1 result as published.
    if (!out.enrichment) return { status: 'failed', reason: out.errorCode, model: out.model };
    return this.publishEnrichment(observed.analysis, out, resolved, rejected, order, excluded, usedKeys);
  }

  /** One stage-2 call on the analysis image (for v2 media: the best frame the worker chose). */
  private async enrich(analysis: VlmAnalysis): Promise<EnrichOutput> {
    const { ctx } = this;
    const object = this.capture.private_object_key ? await ctx.providers.storage.get(this.capture.private_object_key) : null;
    if (!object) return { enrichment: null, model: null, errorCode: 'image_missing' };
    const counter = attemptCounter();
    const started = Date.now();
    const stage1 = { title: analysis.title, candidates: analysis.candidates.map((c) => c.name) };
    const request = { model_capability: ctx.providers.vlmEnrich.id, focus: (ctx.payload.focus as Focus).kind, stage1_candidates: stage1.candidates.length };
    try {
      const res = await ctx.providers.vlmEnrich.enrichImage(
        { image: { bytes: object.body, mediaType: 'image/jpeg' }, stage1, focus: await this.focusForVlm() },
        {
          ...this.callOptions('enrich'),
          timeoutMs: Math.max(1, Math.min(ENRICH_TIMEOUT_MS, this.softDeadlineAt - Date.now())),
          onAttempt: counter.observer,
        },
      );
      const e = res.enrichment;
      await recordProviderQuery(ctx.db, {
        parent: { analysisId: this.analysisId },
        provider: 'vlm',
        operation: 'enrich_image',
        request,
        results: {
          model: res.model,
          observations: e.observations.length,
          visible_text: e.visible_text.length,
          confirmed: e.confirmed.map((c) => ({ name: c.name, keep: c.keep })),
          additional: e.additional_candidates.map((c) => ({ name: c.name, type: c.type, relation: c.relation, certainty: c.certainty })),
          regions: e.regions.length,
          uncertainty: e.uncertainty.overall,
        },
        status: 'ok',
        durationMs: Date.now() - started,
        queryContext: { stage: 'enrich', attempts: counter.count() },
        traceId: this.traceId,
      });
      return { enrichment: e, model: res.model, errorCode: null };
    } catch (err) {
      if (ctx.signal.aborted || (isProviderError(err) && err.kind === 'aborted')) throw err;
      const e = errorSummary(err);
      await recordProviderQuery(ctx.db, {
        parent: { analysisId: this.analysisId },
        provider: 'vlm',
        operation: 'enrich_image',
        request,
        status: 'error',
        errorCode: e.code,
        httpStatus: e.status,
        durationMs: Date.now() - started,
        queryContext: { stage: 'enrich', attempts: counter.count() },
        traceId: this.traceId,
      });
      return { enrichment: null, model: null, errorCode: e.code };
    }
  }

  /**
   * Publishes a stage-2 enrichment (FAST-02). Strictly additive:
   *  - the inspector reading gains observations, regions, visible text and
   *    rationales (title and interpretation stay);
   *  - a veto (keep=false) only lowers the reference's certainty and moves it
   *    out of "Explore the references"; its cards and anchor role stay;
   *  - additional candidates resolve through Qloo into the slots left under
   *    the 5-candidate cap and are appended to the references;
   *  - they fill Qloo categories that have fewer than 3 cards, after the
   *    published cards; nothing is reordered or removed.
   */
  private async publishEnrichment(
    base: VlmAnalysis,
    out: EnrichOutput,
    resolved: ResolveOutput,
    rejected: { rejectedNames: string[]; rejectedIds: ReadonlySet<string> },
    order: readonly Category[],
    excluded: Set<string>,
    usedKeys: Set<string>,
  ): Promise<EnrichSummary> {
    const { ctx } = this;
    const enrichment = out.enrichment!;
    let merged: VlmAnalysis;
    try {
      merged = mergeEnrichment(base, enrichment);
      validateVision(merged, MERGED_CANDIDATES_MAX);
    } catch {
      return { status: 'failed', reason: 'invalid_enrichment', model: out.model };
    }
    const rejectedKeys = new Set(rejected.rejectedNames.map(normalizeName));
    const vetoed = vetoedCandidateKeys(base, enrichment);
    const additions = merged.candidates.slice(base.candidates.length).filter((c) => !rejectedKeys.has(normalizeName(c.name)));

    // Qloo resolution stays capped at LIMITS.vlmCandidatesToResolve candidates per analysis.
    const stage1Resolved = Math.min(
      LIMITS.vlmCandidatesToResolve,
      base.candidates.filter((c) => !rejectedKeys.has(normalizeName(c.name))).length,
    );
    const toResolve = additions.slice(0, Math.max(0, LIMITS.vlmCandidatesToResolve - stage1Resolved));
    const caps = ctx.providers.qloo.capability();
    const qlooUsable = isUsable(caps.search) || isUsable(caps.tags);
    const q: QlooResolveState = { usable: qlooUsable && !this.pastSoftDeadline(), state: qlooUsable ? 'ok' : 'unavailable' };
    const fresh = toResolve.length
      ? await this.resolveCandidates(
          toResolve.map((candidate) => ({ candidate, userSelected: false })),
          merged,
          q,
        )
      : [];
    const newRefs: ResolvedRef[] = [];
    for (const r of fresh) {
      if (resolved.refs.some((x) => x.referenceId === r.referenceId) || newRefs.some((x) => x.referenceId === r.referenceId)) continue;
      if (rejected.rejectedIds.has(r.referenceId)) r.resolution = 'rejected';
      newRefs.push(r);
    }
    const vetoedRefs = resolved.refs.filter((r) => r.relation !== 'user_selected' && vetoed.has(candidateNameKey(r.candidateName)));
    const evidence = resolved.refs
      .map((r) => {
        const c = merged.candidates.find((m) => candidateNameKey(m.name) === candidateNameKey(r.candidateName));
        return c && c.region_ids.length && r.regionIds.length === 0 ? { ref: r, regionIds: c.region_ids, boxes: boxesFor(c.region_ids, merged) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);

    const focus = this.ctx.payload.focus as Focus;
    const observations = [
      ...merged.observations,
      ...merged.visible_text.map((t, i) => ({ id: `text${i + 1}`, kind: 'visible_text', text: t.text, region_ids: t.region_id ? [t.region_id] : [] })),
    ];
    const candidates = merged.candidates.map((c) => ({ ...c, boxes: boxesFor(c.region_ids, merged) }));
    const question =
      focus.kind === 'whole' && merged.competing_subjects.length >= 2
        ? {
            prompt: 'What caught your eye?',
            choices: merged.competing_subjects.slice(0, LIMITS.clarifyingChoicesMax).map((s) => ({ id: s.id, label: s.label })),
            whole_photo_choice_id: 'whole',
          }
        : null;
    await publishForCapture(ctx.db, this.capture.id, ctx.ensureActive, async (tx) => {
      // Title and interpretation are never rewritten; a question is only added, never replaced.
      await tx.query(
        `UPDATE analyses SET observations = $2::jsonb, candidates = $3::jsonb,
                clarifying_question = COALESCE(clarifying_question, $4::jsonb)
          WHERE id = $1`,
        [this.analysisId, JSON.stringify(observations), JSON.stringify(candidates), question ? JSON.stringify(question) : null],
      );
      for (const r of vetoedRefs) {
        r.certainty = Math.round(r.certainty * ENRICHMENT_VETO_CERTAINTY_FACTOR * 1000) / 1000;
        await tx.query(
          `UPDATE capture_references SET certainty = LEAST(certainty, $4), advisory_veto = true
            WHERE analysis_id = $1 AND reference_id = $2 AND relation = $3`,
          [this.analysisId, r.referenceId, r.relation, r.certainty],
        );
      }
      for (const { ref, regionIds, boxes } of evidence) {
        ref.regionIds = regionIds;
        ref.boxes = boxes;
        await tx.query(
          `UPDATE capture_references SET evidence_region = $4::jsonb WHERE analysis_id = $1 AND reference_id = $2 AND relation = $3`,
          [this.analysisId, ref.referenceId, ref.relation, JSON.stringify({ region_ids: regionIds, boxes })],
        );
      }
      for (const r of newRefs) {
        await tx.query(
          `INSERT INTO capture_references (analysis_id, reference_id, relation, evidence_region, certainty, resolution_status, is_anchor)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, false)
           ON CONFLICT (analysis_id, reference_id, relation) DO NOTHING`,
          [this.analysisId, r.referenceId, r.relation, JSON.stringify({ region_ids: r.regionIds, boxes: r.boxes }), Math.min(1, Math.max(0, r.certainty)), r.resolution],
        );
      }
    });
    resolved.refs.push(...newRefs);

    // Fill thin Qloo categories from the new references only, after published cards.
    const appended: Record<string, number> = {};
    const signals = newRefs.filter((r) => r.qloo && (r.resolution === 'resolved' || r.resolution === 'user_confirmed'));
    if (signals.length) {
      const { rows } = await ctx.db.query<{ category: Category; n: number }>(
        'SELECT category, COUNT(*)::int AS n FROM recommendations WHERE analysis_id = $1 AND category IS NOT NULL GROUP BY category',
        [this.analysisId],
      );
      const counts = new Map(rows.map((r) => [r.category, r.n]));
      const insightsUsable = isUsable(caps.insights);
      for (const category of order.filter((c): c is (typeof QLOO_CATEGORIES)[number] => (QLOO_CATEGORIES as readonly string[]).includes(c))) {
        const existing = counts.get(category) ?? 0;
        const categorySignals = signals.filter((r) => r.suggestedCategories.includes(category));
        if (existing >= LIMITS.recommendationsPerCategory || categorySignals.length === 0 || this.pastSoftDeadline()) continue;
        const rec = await ctx.runStage<RecommendOutput>(`enrich:recommend:${category}`, () => this.recommend(category, categorySignals, insightsUsable));
        const added = await this.composeCategory(rec, resolved.refs, order, excluded, usedKeys, { signals: categorySignals, existing });
        if (added) appended[category] = added;
      }
    }
    return {
      status: 'complete',
      model: out.model,
      confirmed: enrichment.confirmed.filter((c) => c.keep).length,
      vetoed: vetoedRefs.length,
      additions: additions.length,
      resolvedAdditions: newRefs.filter((r) => r.qloo).length,
      appended,
    };
  }

  /** Category priority from anchor suggestions (strongest first); Eat last only when unsuggested. */
  private categoryOrder(anchors: readonly ResolvedRef[]): Category[] {
    const score = new Map<Category, number>(CATEGORIES.map((c) => [c, 0]));
    for (const a of anchors) for (const c of a.suggestedCategories) score.set(c, (score.get(c) ?? 0) + a.certainty + 0.01);
    return [...CATEGORIES].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
  }

  private async recommend(category: (typeof QLOO_CATEGORIES)[number], anchors: readonly ResolvedRef[], insightsUsable: boolean): Promise<RecommendOutput> {
    const { ctx } = this;
    const empty = (status: SectionStatus, reason: string): RecommendOutput => ({ category, status, providerQueryId: null, isReplay: false, candidates: [], reason });
    if (!insightsUsable) return empty('unavailable', 'qloo_unavailable');
    const entityIds = anchors.map((a) => a.qloo?.entityId).filter((v): v is string => !!v);
    const tagIds = anchors.map((a) => a.qloo?.tagId).filter((v): v is string => !!v);
    if (entityIds.length + tagIds.length === 0) return empty('skipped', 'no_anchors');
    if (this.budget.remaining('qloo') === 0) return empty('skipped', 'budget');
    if (this.pastSoftDeadline()) return empty('skipped', 'deadline');
    const counter = attemptCounter();
    const started = Date.now();
    const request = { filterType: CATEGORY_ENTITY_TYPE[category]!, signalEntities: entityIds, signalTags: tagIds.map((id) => ({ id })), explainability: true, take: 10 };
    try {
      const call = await this.qlooCall(`recommend:${category}`, (o) => ctx.providers.qloo.insights(request, { ...o, onAttempt: counter.observer }));
      const res = call.value;
      const anchorIds = new Set(entityIds);
      const entities = res.data.entities.filter((e) => !anchorIds.has(e.entity_id));
      const providerQueryId = await recordProviderQuery(ctx.db, {
        parent: { analysisId: this.analysisId },
        provider: 'qloo',
        operation: 'insights',
        request: res.request,
        results: res.data.entities.map((e, i) => ({ rank: i + 1, entity_id: e.entity_id, name: e.name, affinity: e.query?.affinity ?? null, explainability: e.query?.explainability ?? null })),
        status: entities.length ? 'ok' : 'empty',
        httpStatus: res.status,
        durationMs: res.duration_ms,
        isReplay: res.is_replay,
        queryContext: { stage: 'recommend', category, signal_reference_ids: anchors.map((a) => a.referenceId), attempts: call.attempts },
        traceId: this.traceId,
        cacheTtlSeconds: PROVIDER_CACHE_TTL_SECONDS,
      });
      return {
        category,
        status: 'complete',
        providerQueryId,
        isReplay: res.is_replay,
        candidates: entities.map((e) => ({ entityId: e.entity_id, name: e.name, year: entityYear(e), explain: (e.query?.explainability ?? []).sort((a, b) => b.score - a.score).map((x) => x.entity_id) })),
      };
    } catch (err) {
      const e = errorSummary(err);
      const attempts = (err as { attempts?: number }).attempts ?? counter.count();
      if (e.code !== 'budget_exhausted' || attempts > 0) {
        await recordProviderQuery(ctx.db, {
          parent: { analysisId: this.analysisId },
          provider: 'qloo',
          operation: 'insights',
          request: { filterType: request.filterType, signalEntities: entityIds, signalTags: tagIds },
          status: 'error',
          errorCode: e.code,
          httpStatus: e.status,
          durationMs: Date.now() - started,
          queryContext: { stage: 'recommend', category, attempts },
          traceId: this.traceId,
        });
      }
      if (isProviderError(err) && err.kind === 'budget_exhausted') return empty('skipped', 'budget');
      if (isProviderError(err) && (err.kind === 'unavailable' || err.kind === 'auth')) return empty('unavailable', e.code);
      if (isProviderError(err) && err.kind === 'aborted') throw err;
      return empty('failed', e.code);
    }
  }

  private rankFor(order: readonly Category[], category: Category, position: number): number {
    return position * CATEGORIES.length + Math.max(0, order.indexOf(category));
  }

  /**
   * Publishes one category. Default: replaces this analysis's cards for the
   * category. `append` (stage-2 enrichment): only adds cards after the ones
   * already published, signalled by the given new references, up to the
   * per-category cap; existing cards keep their rows, ranks and order.
   */
  private async composeCategory(
    rec: RecommendOutput,
    refs: readonly ResolvedRef[],
    order: readonly Category[],
    excluded: Set<string>,
    usedKeys: Set<string>,
    append?: { signals: readonly ResolvedRef[]; existing: number },
  ): Promise<number> {
    const { ctx } = this;
    const category = rec.category;
    const anchors = append ? append.signals.filter((r) => r.qloo) : refs.filter((r) => r.isAnchor);
    const refByEntity = new Map(anchors.filter((a) => a.qloo?.entityId).map((a) => [a.qloo!.entityId!, a]));
    const kind = CATEGORY_ITEM_KIND[category];

    type Payload =
      | { source: 'insights'; candidate: CategoryCandidate }
      | { source: 'style'; ref: ResolvedRef };
    const lists: RankedList<Payload>[] = [
      {
        source: `qloo:insights:${category}`,
        items: rec.candidates.map((c) => {
          const contributors = c.explain.map((id) => refByEntity.get(id)).filter((r): r is ResolvedRef => !!r);
          return { key: `qloo:${c.entityId}`, originRefs: (contributors.length ? contributors : anchors).map((r) => r.referenceId), payload: { source: 'insights' as const, candidate: c } };
        }),
      },
    ];
    if (category === 'wear') {
      // Style directions the photo resembles, resolved to real Qloo tags.
      const styles = (append ? append.signals : refs).filter((r) => r.type === 'style' && r.qloo?.tagId && r.resolution === 'resolved' && r.providerQueryId);
      lists.push({ source: 'qloo:tags:style', items: styles.map((r) => ({ key: `qloo_tag:${r.qloo!.tagId}`, originRefs: [r.referenceId], payload: { source: 'style' as const, ref: r } })) });
    }
    const fused = reciprocalRankFusion(lists, { exclude: new Set([...excluded, ...usedKeys]) });
    const slots = LIMITS.recommendationsPerCategory - (append?.existing ?? 0);
    const picked = slots > 0 ? selectDiverse(fused, slots) : [];
    if (append && picked.length === 0) return 0;
    // Complete when the provider answered (even with nothing usable); partial
    // when only supplementary results exist; otherwise the provider status.
    // Appending never downgrades: a complete section stays complete, and a
    // skipped one becomes complete only when the provider answered.
    const previous = this.sections.get(category) ?? 'skipped';
    const status: SectionStatus = append
      ? previous === 'complete' || (previous === 'skipped' && rec.status === 'complete')
        ? 'complete'
        : 'partial'
      : rec.status === 'complete'
        ? 'complete'
        : picked.length > 0
          ? 'partial'
          : rec.status;

    await publishForCapture(ctx.db, this.capture.id, ctx.ensureActive, async (tx) => {
      if (!append) await tx.query('DELETE FROM recommendations WHERE analysis_id = $1 AND category = $2', [this.analysisId, category]);
      let position = append?.existing ?? 0;
      for (const p of picked) {
        const contributors = p.originRefs.map((id) => refs.find((r) => r.referenceId === id)).filter((r): r is ResolvedRef => !!r);
        if (p.payload.source === 'insights') {
          const c = p.payload.candidate;
          const itemId = await upsertDiscoveryItem(tx, this.owner, {
            kind,
            category,
            canonicalKey: p.key,
            title: c.name,
            displayMetadata: { subtitle: kind === 'film' && c.year ? String(c.year) : null, year: kind === 'film' ? c.year : null, image: null, example: Boolean(rec.isReplay) },
            externalIds: { qloo: c.entityId },
            resolvedAnchorIds: contributors.map((r) => r.referenceId),
          });
          await insertRecommendation(tx, {
            analysisId: this.analysisId,
            discoveryItemId: itemId,
            category,
            rank: this.rankFor(order, category, position++),
            title: c.name,
            externalIds: { qloo: c.entityId },
            displayReason: buildReason(contributors),
            origin: rec.isReplay ? 'replay' : 'qloo',
            providerQueryIds: [rec.providerQueryId!],
            contributingReferenceIds: contributors.map((r) => r.referenceId),
          });
        } else {
          const r = p.payload.ref;
          const itemId = await upsertDiscoveryItem(tx, this.owner, {
            kind: 'style',
            category: 'wear',
            canonicalKey: p.key,
            title: r.name,
            displayMetadata: { subtitle: 'Style direction', image: null, example: Boolean(r.isReplay) },
            externalIds: { qloo_tag: r.qloo!.tagId },
            referenceId: r.referenceId,
            resolvedAnchorIds: [r.referenceId],
          });
          await insertRecommendation(tx, {
            analysisId: this.analysisId,
            discoveryItemId: itemId,
            category: 'wear',
            rank: this.rankFor(order, category, position++),
            title: r.name,
            externalIds: { qloo_tag: r.qloo!.tagId },
            displayReason: 'A style direction your photo resembles.',
            origin: r.isReplay ? 'replay' : 'qloo',
            providerQueryIds: [r.providerQueryId!],
            contributingReferenceIds: [r.referenceId],
          });
        }
        usedKeys.add(p.key);
      }
      await setAnalysisSection(tx, this.analysisId, category, status);
    });
    this.sections.set(category, status);
    return picked.length;
  }

  private async composeEat(refs: readonly ResolvedRef[], order: readonly Category[], excluded: Set<string>, usedKeys: Set<string>): Promise<SectionStatus> {
    const { ctx } = this;
    const supported = await this.supportedFoodReferences(refs);
    let status: SectionStatus;
    let ideas: Awaited<ReturnType<typeof composeDishIdeas>>['ideas'] = [];
    let providerQueryId: string | null = null;
    if (supported.length === 0) status = 'skipped';
    else if (!isUsable(ctx.providers.composer.capability())) status = 'unavailable';
    else if (this.pastSoftDeadline()) status = 'skipped';
    else {
      const out = await ctx.runStage<{ status: SectionStatus; ideas: typeof ideas; providerQueryId: string | null }>('recommend:eat', async () => {
        const counter = attemptCounter();
        const started = Date.now();
        try {
          const res = await composeDishIdeas(ctx.providers.composer, supported, { ...this.callOptions('recommend:eat'), onAttempt: counter.observer });
          const pq = await recordProviderQuery(ctx.db, {
            parent: { analysisId: this.analysisId },
            provider: 'text_model',
            operation: 'dish_ideas',
            request: { references: supported.map((r) => r.name) },
            results: res.ideas.map((d) => ({ name: d.name, reference_ids: d.referenceIds })),
            status: res.ideas.length ? 'ok' : 'empty',
            durationMs: Date.now() - started,
            queryContext: { stage: 'recommend', category: 'eat', origin: 'vlm_creative', attempts: counter.count() },
            traceId: this.traceId,
          });
          return { status: 'complete' as SectionStatus, ideas: res.ideas, providerQueryId: pq };
        } catch (err) {
          if (isProviderError(err) && err.kind === 'aborted') throw err;
          const e = errorSummary(err);
          await recordProviderQuery(ctx.db, {
            parent: { analysisId: this.analysisId },
            provider: 'text_model',
            operation: 'dish_ideas',
            request: { references: supported.map((r) => r.name) },
            status: 'error',
            errorCode: e.code,
            durationMs: Date.now() - started,
            queryContext: { stage: 'recommend', category: 'eat', attempts: counter.count() },
            traceId: this.traceId,
          });
          return { status: (isProviderError(err) && err.kind === 'unavailable' ? 'unavailable' : 'failed') as SectionStatus, ideas: [], providerQueryId: null };
        }
      });
      status = out.status;
      ideas = out.ideas;
      providerQueryId = out.providerQueryId;
    }

    // Amendment 2.2 (ONB-05): the account's food exclusions filter Eat ideas.
    const foodExclusions = await foodExclusionsFor(ctx.db, this.owner);
    await publishForCapture(ctx.db, this.capture.id, ctx.ensureActive, async (tx) => {
      await tx.query(`DELETE FROM recommendations WHERE analysis_id = $1 AND category = 'eat'`, [this.analysisId]);
      let position = 0;
      for (const idea of ideas) {
        if (position >= LIMITS.recommendationsPerCategory) break;
        const key = `food:${slugify(idea.name)}|${[...idea.referenceIds].sort().join(',')}`;
        if (excluded.has(key) || usedKeys.has(key)) continue;
        if (violatedExclusions({ title: idea.name, cuisine: idea.cuisine, description: idea.reason }, foodExclusions).length) continue;
        const itemId = await upsertDiscoveryItem(tx, this.owner, {
          kind: 'food',
          category: 'eat',
          canonicalKey: key,
          title: idea.name,
          displayMetadata: { subtitle: idea.cuisine || null, detail: idea.cuisine || null, image: null },
          externalIds: {},
          resolvedAnchorIds: idea.referenceIds,
        });
        await insertRecommendation(tx, {
          analysisId: this.analysisId,
          discoveryItemId: itemId,
          category: 'eat',
          rank: this.rankFor(order, 'eat', position++),
          title: idea.name,
          externalIds: {},
          displayReason: idea.reason,
          origin: 'vlm_creative',
          providerQueryIds: providerQueryId ? [providerQueryId] : [],
          contributingReferenceIds: idea.referenceIds,
        });
        usedKeys.add(key);
      }
      await setAnalysisSection(tx, this.analysisId, 'eat', status);
    });
    this.sections.set('eat', status);
    return status;
  }

  /** Cuisine/place/tradition references with support: resolved via Qloo or researched. */
  private async supportedFoodReferences(refs: readonly ResolvedRef[]): Promise<{ id: string; name: string; type: string }[]> {
    const foodish = refs.filter((r) => (r.type === 'cuisine' || r.type === 'place' || r.type === 'tradition' || r.suggestedCategories.includes('eat')) && r.resolution !== 'ambiguous');
    if (foodish.length === 0) return [];
    const { rows } = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM cultural_references WHERE id = ANY($1::uuid[]) AND research_status = 'complete'`,
      [foodish.map((r) => r.referenceId)],
    );
    const researched = new Set(rows.map((r) => r.id));
    return foodish
      .filter((r) => r.qloo !== null || researched.has(r.referenceId) || r.resolution === 'user_confirmed')
      .slice(0, 5)
      .map((r) => ({ id: r.referenceId, name: r.name, type: r.type }));
  }

  private async finish(): Promise<JobOutcome> {
    const { ctx } = this;
    const statuses = [...this.sections.values()];
    const partial = statuses.some((s) => s === 'failed' || s === 'unavailable' || s === 'partial') || this.warnings.has(WARNINGS.delayed.code);
    await ctx.setStage('publishing');
    await publishForCapture(ctx.db, this.capture.id, ctx.ensureActive, async (tx) => {
      await tx.query(`UPDATE analyses SET warnings = $2::jsonb WHERE id = $1`, [this.analysisId, JSON.stringify([...this.warnings.values()])]);
      const ok = await activateAnalysis(tx, { captureId: this.capture.id, analysisId: this.analysisId });
      if (!ok) throw new AppError('not_found', { retryable: false });
      await tx.query(`UPDATE captures SET status = $2, updated_at = now() WHERE id = $1`, [this.capture.id, partial ? 'partial' : 'ready']);
    });
    await ctx.trace({ kind: 'stage', name: 'publish', data: { sections: Object.fromEntries(this.sections), warnings: [...this.warnings.keys()], qloo_requests: this.budget.usedBy('qloo') }, durationMs: Date.now() - this.startedAt, traceId: this.traceId });
    return { state: partial ? 'partial' : 'complete', resultType: 'capture', resultId: this.capture.id };
  }
}

/**
 * Marks a capture failed after a non-recoverable error (or the last attempt),
 * without touching already-published sections. Never resurrects a deleted capture.
 */
export async function markCaptureFailed(ctx: JobContext<'analyze_capture'>): Promise<void> {
  await ctx.db.query(
    `UPDATE captures SET status = 'failed', updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND active_analysis_id IS NULL`,
    [ctx.payload.capture_id],
  );
  await ctx.db.query(
    `UPDATE captures SET status = 'partial', updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND active_analysis_id IS NOT NULL AND status = 'processing'`,
    [ctx.payload.capture_id],
  );
}
