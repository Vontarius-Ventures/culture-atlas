import { peopleShown, ProviderError, type CallOptions, type RequestBudget, type VlmAnalysis } from '@culture-atlas/providers';
import { JobBudget } from '../compiler/budget';
import { StyleStage, type StyleAnchor } from '../compiler/style-stage';
import { loadCapture, loadExcludedKeys, ownerFromRow } from '../compiler/store';
import { AppError } from '../errors';
import type { JobHandler } from '../jobs/handler';
import { normalizeStyleName } from '../style/vocabulary';

/** R-11: the style retry's own budget: at most 6 Qloo requests and one vision call. */
export const STYLE_RETRY_QLOO_REQUESTS = 6;

/**
 * "Try again" on a failed style reading (style design §D.2, R-16e): re-runs
 * only the style stage and its rails, writing into the same analysis version
 * while style_reading is still null. Allowed once per analysis (the API
 * checks and counts it); stage-1 facts and anchors come from what the
 * analysis already published.
 */
export const styleRetry: JobHandler<'style_retry'> = async (ctx) => {
  const capture = await loadCapture(ctx.db, ctx.payload.capture_id);
  if (!capture || capture.deleted_at) throw new AppError('not_found', { message: 'Capture no longer exists.', retryable: false });
  const { rows } = await ctx.db.query<{ id: string; title: string | null; interpretation: string | null; observations: { id: string; kind: string; text: string; region_ids: string[] }[] | null; candidates: VlmAnalysis['candidates'] | null; style_reading: unknown }>(
    `SELECT id, title, interpretation, observations, candidates, style_reading FROM analyses WHERE id = $1 AND capture_id = $2`,
    [ctx.payload.analysis_id, capture.id],
  );
  const analysis = rows[0];
  if (!analysis) throw new AppError('not_found', { retryable: false });
  if (analysis.style_reading) return { state: 'complete', resultType: 'capture', resultId: capture.id };
  const startedAt = Date.now();
  const softDeadlineAt = startedAt + Math.floor(ctx.budget.deadlineMs * 0.75);
  const budget = new JobBudget({ qlooRequests: STYLE_RETRY_QLOO_REQUESTS, researchRefs: 0, retriesPerStage: ctx.budget.providerRetries, visionCalls: 1 });
  const callOptions = (stage: string): CallOptions => ({ signal: ctx.signal, budget: budget.forStage(stage), maxRetries: ctx.budget.providerRetries, traceId: ctx.job.trace_id ?? undefined });
  const qlooCall = async <T>(stage: string, fn: (o: CallOptions) => Promise<T>) => {
    const stageBudget = budget.forStage(stage);
    if (!stageBudget.take('qloo', 'request')) throw Object.assign(new ProviderError('qloo', 'budget_exhausted', 'qloo request budget exhausted'), { attempts: 0 });
    let prepaid = true;
    let attempts = 1;
    const b: RequestBudget = {
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
      return { value: await fn({ ...callOptions(stage), budget: b }), attempts };
    } catch (err) {
      throw Object.assign(err as object, { attempts });
    }
  };
  const owner = ownerFromRow(capture);
  const { rows: shown } = await ctx.db.query<{ key: string }>(
    `SELECT di.canonical_key AS key FROM recommendations r JOIN discovery_items di ON di.id = r.discovery_item_id WHERE r.analysis_id = $1`,
    [analysis.id],
  );
  const stage = new StyleStage({
    ctx,
    analysisId: analysis.id,
    capture,
    owner,
    traceId: ctx.job.trace_id,
    budget,
    startedAt,
    qlooCall,
    callOptions,
    pastSoftDeadline: () => Date.now() > softDeadlineAt || ctx.signal.aborted,
    usedKeys: new Set(shown.map((r) => r.key)),
    excludedKeys: () => loadExcludedKeys(ctx.db, owner),
  });
  const plan = await StyleStage.plan(ctx, budget, { example: false });
  if (!plan.enabled) {
    await stage.publishOff(plan.off!.status, plan.off!.reason);
    return { state: 'partial', resultType: 'capture', resultId: capture.id };
  }
  const observations = Array.isArray(analysis.observations) ? analysis.observations : [];
  const candidates = Array.isArray(analysis.candidates) ? analysis.candidates : [];
  stage.setStage1({
    usable: true,
    peopleShown: peopleShown({ title: analysis.title ?? '', interpretation: analysis.interpretation ?? '', observations: observations.filter((o) => o.kind !== 'visible_text') as VlmAnalysis['observations'], candidates }),
    visibleText: observations.filter((o) => o.kind === 'visible_text').map((o) => o.text),
    styleNames: candidates.filter((c) => c.type === 'style' || c.type === 'tradition').flatMap((c) => [c.name, ...(c.tag_queries ?? [])]).map(normalizeStyleName),
  });
  const { rows: anchorRows } = await ctx.db.query<{ reference_id: string; name: string; external_ids: { qloo?: string; qloo_types?: string[] }; evidence_region: { boxes?: StyleAnchor['boxes'] } | null }>(
    `SELECT cr.reference_id, r.canonical_name AS name, r.external_ids, cr.evidence_region
       FROM capture_references cr JOIN cultural_references r ON r.id = cr.reference_id
      WHERE cr.analysis_id = $1 AND cr.is_anchor AND r.external_ids ? 'qloo'`,
    [analysis.id],
  );
  stage.setAnchors(
    anchorRows
      .filter((a) => typeof a.external_ids.qloo === 'string')
      .map((a) => ({ referenceId: a.reference_id, name: a.name, entityId: a.external_ids.qloo!, types: a.external_ids.qloo_types ?? [], boxes: a.evidence_region?.boxes ?? [], tags: [] })),
  );
  const status = await stage.run();
  return { state: status === 'ready' ? 'complete' : 'partial', resultType: 'capture', resultId: capture.id };
};
