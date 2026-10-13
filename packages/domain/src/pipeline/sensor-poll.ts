import type { JobHandler } from '../jobs/handler';
import { runSensorPoll, scheduleSensorPoll } from '../sensor/importer';

/**
 * One World Sensor poll ('poll' mode). Lists committed kind=photo assets
 * after the stored cursor (allowlisted origin only, no redirects to other
 * hosts, size and content-type limits), dedupes by connection + asset_id,
 * verifies declared hashes, creates captures (source 'sensor', captured_at
 * preserved) and advances the cursor only past fully resolved pages. Then it
 * schedules the next poll: SENSOR_POLL_INTERVAL_MS while healthy, backing off
 * while the relay is offline. A relay outage is not a job failure: the error
 * is recorded on the connection (shown in connection settings) and the chain
 * continues, so reconnecting resumes without skips or duplicates.
 */
export const sensorPoll: JobHandler<'sensor_poll'> = async (ctx) => {
  const connectionId = ctx.payload.sensor_connection_id;
  const started = Date.now();
  await ctx.setStage('polling');
  const outcome = await runSensorPoll(connectionId, {
    db: ctx.db,
    providers: ctx.providers,
    config: ctx.config,
    signal: ctx.signal,
    log: ctx.log,
  });

  if (outcome.sync || outcome.errorCode) {
    // Ids and counts only: no credentials, origins or image bytes.
    await ctx.trace({
      kind: 'stage',
      name: 'sensor_poll',
      durationMs: Date.now() - started,
      data: {
        sensor_connection_id: connectionId,
        imported: outcome.sync?.imported.length ?? 0,
        duplicates: outcome.sync?.duplicates.length ?? 0,
        failed: outcome.sync?.failed ?? [],
        baseline_skipped: outcome.sync?.baselineSkipped ?? 0,
        selection_not_found: outcome.sync?.selectionNotFound.length ?? 0,
        pending_uncommitted: outcome.sync?.pendingUncommitted ?? 0,
        pages: outcome.sync?.pagesRead ?? 0,
        error_code: outcome.errorCode,
      },
    });
  }

  if (outcome.reschedule && outcome.nextPollAt && ctx.job.owner_account_id) {
    await scheduleSensorPoll(ctx.db, {
      connectionId,
      ownerAccountId: ctx.job.owner_account_id,
      availableAt: outcome.nextPollAt,
      excludeJobId: ctx.job.id,
    });
  }
  return { state: outcome.errorCode ? 'partial' : 'complete', resultType: 'sensor_connection', resultId: connectionId };
};
