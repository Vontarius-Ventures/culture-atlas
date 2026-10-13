import { notImplemented } from '../errors';
import type { JobHandler } from '../jobs/handler';

/**
 * Physically purge deleted captures (purge_after < now), expired anonymous
 * sessions/uploads (24h) and their media, expired idempotency keys and feed
 * snapshots. TODO(captures owner): implement.
 */
export const purgeDeleted: JobHandler<'purge_deleted'> = async (ctx) => {
  void ctx;
  notImplemented('pipeline.purgeDeleted');
};
