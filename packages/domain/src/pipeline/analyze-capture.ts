import { isProviderError } from '@culture-atlas/providers';
import { CaptureCompiler, markCaptureFailed } from '../compiler/analyze';
import { isAppError } from '../errors';
import { JobCancelledError, type JobHandler } from '../jobs/handler';

/**
 * Cultural compilation pipeline (build spec steps 3-8). See
 * compiler/analyze.ts for the stages:
 *  observe   VLM structured observations/candidates/regions/uncertainty
 *            (stage-1 quick read when the profile is two-stage, amendment 2.2)
 *  resolve   up to 5 candidates via Qloo /search + /v2/tags (<= 3 in flight); keep
 *            unmatched observations; select <= 5 anchors (cultural_references + capture_references)
 *  recommend Qloo /v2/insights per supported category with real IDs
 *            (<= 12 Qloo requests per job), provider_queries rows
 *  enrich    stage-2 enrichment (fast_analysis_two_stage): rationales, evidence,
 *            advisory vetoes and extra references; appends only, never reorders
 *  compose   <= 3 per category, <= 12 total; hidden items/exclusions filtered;
 *            rank fusion across sources (no raw-score averaging); recommendations
 *            with origin + provider_query_ids; discovery_items deduped by canonical_key
 *  research  <= 5 reference pages (research provider), claims + sources
 *  publish   sections progressively (setSectionStatus); activateAnalysis at end
 * Qloo unavailable -> keep references, mark categories 'unavailable', state 'partial'.
 */
export const analyzeCapture: JobHandler<'analyze_capture'> = async (ctx) => {
  try {
    return await new CaptureCompiler(ctx).run();
  } catch (caught) {
    let err = caught;
    // Anything that fails after a deletion/cancellation (e.g. a write racing a
    // capture delete) is a cancellation, not a retryable failure.
    if (!(err instanceof JobCancelledError)) {
      try {
        await ctx.ensureActive();
      } catch (stop) {
        if (stop instanceof JobCancelledError) err = stop;
      }
    }
    const reason = ctx.signal.aborted ? String((ctx.signal.reason as Error | undefined)?.message ?? '') : '';
    const cancelled = err instanceof JobCancelledError ? !err.message.includes('deadline') : ctx.signal.aborted && !reason.includes('deadline');
    if (!cancelled) {
      const retryable = isAppError(err) ? err.retryable : isProviderError(err) ? err.retryable : true;
      // The worker re-queues retryable errors while attempts remain; only a
      // final failure changes what the user sees.
      if (!retryable || ctx.attempt >= ctx.job.max_attempts) await markCaptureFailed(ctx).catch(() => undefined);
    }
    throw err;
  }
};
