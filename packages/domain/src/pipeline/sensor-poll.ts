import { notImplemented } from '../errors';
import type { JobHandler } from '../jobs/handler';

/**
 * Poll the configured relay origin for committed kind=photo assets (only
 * allowed origins; no redirects to unapproved hosts; size/content-type limits),
 * dedupe by connection+asset_id (sensor_imports), verify declared hashes,
 * create captures (source 'sensor', captured_at preserved), advance the
 * cursor, and re-enqueue itself after SENSOR_POLL_INTERVAL_MS while enabled.
 * TODO(sensor owner): implement.
 */
export const sensorPoll: JobHandler<'sensor_poll'> = async (ctx) => {
  void ctx;
  notImplemented('pipeline.sensorPoll');
};
