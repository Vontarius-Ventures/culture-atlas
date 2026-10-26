import { randomUUID } from 'node:crypto';
import { requireScopes } from '../authz';
import type { ServiceContext } from '../context';
import { AppError } from '../errors';
import { enqueueJob } from '../jobs/queue';
import { ownerOf } from '../principal';
import type { SetCityRequest } from '../schemas/style';
import { STYLE_RETRY_QLOO_REQUESTS } from '../pipeline/style-retry';
import { loadAccessibleCapture } from './captures';

/**
 * POST /v1/captures/{id}/style/retry (style design §D.2, R-16e): re-queues
 * only the style stage of the active analysis, once, while its style reading
 * is still null and the section failed. 202 with sections.style "running";
 * a second use is 409 retry_used.
 */
export async function retryStyle(ctx: ServiceContext, input: { id: string }): Promise<{ job_id: string; sections: { style: 'running' } }> {
  requireScopes(ctx.principal, 'captures:write');
  const owner = ownerOf(ctx.principal);
  const p = ctx.principal;
  return ctx.db.transaction(async (tx) => {
    const capture = await loadAccessibleCapture(ctx, input.id, { db: tx, forUpdate: true });
    if (!capture.active_analysis_id) throw new AppError('conflict', { message: 'This photo has not been read yet.' });
    const { rows } = await tx.query<{ id: string; style_retries: number; has_reading: boolean; style: string | null }>(
      `SELECT id, style_retries, style_reading IS NOT NULL AS has_reading, section_statuses->>'style' AS style
         FROM analyses WHERE id = $1 FOR UPDATE`,
      [capture.active_analysis_id],
    );
    const a = rows[0];
    if (!a) throw new AppError('not_found');
    if (a.style_retries >= 1) throw new AppError('conflict', { message: 'This style reading was already retried.', details: { reason: 'retry_used' } });
    if (a.has_reading || a.style !== 'failed') throw new AppError('conflict', { message: 'There is no failed style reading to retry.', details: { reason: 'not_failed' } });
    await tx.query(
      `UPDATE analyses SET style_retries = style_retries + 1,
              section_statuses = section_statuses || '{"style":"running"}'::jsonb
        WHERE id = $1`,
      [a.id],
    );
    const { job } = await enqueueJob(tx, {
      type: 'style_retry',
      owner,
      payload: { capture_id: capture.id, analysis_id: a.id },
      dedupeKey: `style_retry:${a.id}`,
      agentConnectionId: p.kind === 'agent' ? p.connectionId : null,
      maxAttempts: 1,
      budget: { qloo_requests: STYLE_RETRY_QLOO_REQUESTS, research_refs: 0, provider_retries: ctx.config.JOB_MAX_PROVIDER_RETRIES, deadline_ms: ctx.config.ANALYSIS_DEADLINE_MS },
      traceId: randomUUID(),
      resultType: 'capture',
      resultId: capture.id,
    });
    return { job_id: job.id, sections: { style: 'running' as const } };
  });
}

/**
 * PUT /v1/me/city (C.6): the one explicit, user-entered city source. Stored
 * in accounts.preferences.city; sent to Qloo only as a location filter or
 * signal. No EXIF, no IP geolocation. null clears it. 204.
 */
export async function setCity(ctx: ServiceContext, input: { body: SetCityRequest }): Promise<void> {
  requireScopes(ctx.principal, 'preferences:write');
  const owner = ownerOf(ctx.principal);
  if (owner.kind !== 'account') throw new AppError('account_required');
  const city = input.body.city?.trim() || null;
  await ctx.db.query(
    city
      ? `UPDATE accounts SET preferences = preferences || jsonb_build_object('city', $2::text), updated_at = now() WHERE id = $1`
      : `UPDATE accounts SET preferences = preferences - 'city', updated_at = now() WHERE id = $1`,
    city ? [owner.accountId, city] : [owner.accountId],
  );
}
