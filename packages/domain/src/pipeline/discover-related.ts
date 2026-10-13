import { notImplemented } from '../errors';
import type { JobHandler } from '../jobs/handler';

/**
 * Explicit "Discover more" for one item: anchors = item's canonical entities/
 * tags; bounded Qloo insights across supported categories; at most 6 cached
 * results tied to discovery_jobs (parent of provider_queries/recommendations).
 * TODO(discovery owner): implement.
 */
export const discoverRelated: JobHandler<'discover_related'> = async (ctx) => {
  void ctx;
  notImplemented('pipeline.discoverRelated');
};
