import { notImplemented } from '../errors';
import type { JobHandler } from '../jobs/handler';

/**
 * Cultural compilation pipeline (build spec steps 3-8):
 *  observe   VLM structured observations/candidates/regions/uncertainty
 *  resolve   up to 8 candidates via Qloo /search + /v2/tags; keep unmatched
 *            observations; select <= 5 anchors (cultural_references + capture_references)
 *  research  <= 5 reference pages (research provider), claims + sources
 *  recommend Qloo /v2/insights per supported category with real IDs
 *            (<= 12 Qloo requests per job), provider_queries rows
 *  compose   <= 3 per category, <= 12 total; hidden items/exclusions filtered;
 *            rank fusion across sources (no raw-score averaging); recommendations
 *            with origin + provider_query_ids; discovery_items deduped by canonical_key
 *  publish   sections progressively (setSectionStatus); activateAnalysis at end
 * Qloo unavailable -> keep references, mark categories 'unavailable', state 'partial'.
 * TODO(pipeline owner): implement.
 */
export const analyzeCapture: JobHandler<'analyze_capture'> = async (ctx) => {
  void ctx;
  notImplemented('pipeline.analyzeCapture');
};
