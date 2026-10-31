import { setTimeout as delay } from 'node:timers/promises';
import type { GatewayDb } from '../model-gateway/postgres';
import type { ConnectionAssetCheckContext } from './types';
import type { ConnectionAssetEvidence } from './schema';
import { CONNECTION_ASSET_CHECKER_VERSION } from './schema';
import { CONNECTION_ASSET_IMAGE_LIMITS, fetchPublicConnectionImage } from './image';

/** Validate before DB allocation/acquisition; never expose snapshot or parse errors. */
export function assertConnectionAssetReadingSnapshot(snapshot: unknown): asserts snapshot is string {
  const invalid = () => new Error('Invalid asset reading snapshot');
  if (typeof snapshot !== 'string' || snapshot.length > 256 * 1024 ||
      Buffer.byteLength(snapshot, 'utf8') > 256 * 1024) throw invalid();
  let reading: unknown;
  try { reading = JSON.parse(snapshot); } catch { throw invalid(); }
  if (typeof reading !== 'object' || reading === null || Array.isArray(reading)) throw invalid();
  const rev = (reading as Record<string, unknown>).rev;
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev <= 0) throw invalid();
}

export async function assertConnectionAssetCheckActive(
  db: GatewayDb, context: ConnectionAssetCheckContext, lock = false,
): Promise<void> {
  assertConnectionAssetReadingSnapshot(context.readingSnapshot);
  if (context.signal.aborted) throw new Error('Inactive asset check');
  // Do not acquire a second pool connection while already inside a transaction.
  // The SQL below enforces the same ownership/lease/cancel/kill fence atomically.
  if (!db.inTransaction) await context.ensureActive();
  const { rows } = await db.query(
    `SELECT c.id FROM captures c
      JOIN analyses an ON an.id=c.active_analysis_id AND an.capture_id=c.id
      JOIN jobs j ON j.id=$4 AND an.job_id=j.id
      WHERE c.id=$1 AND c.active_analysis_id=$2 AND c.owner_account_id=$3
        AND c.deleted_at IS NULL AND j.owner_account_id=$3 AND j.state='running'
        AND an.style_reading=$6::jsonb
        AND j.cancel_requested_at IS NULL AND j.lease_expiry>now() AND j.lease_owner=$5
        AND EXISTS (SELECT 1 FROM connection_asset_fetch_control f WHERE f.id=1 AND f.stop_status IS NULL)
        AND NOT EXISTS (SELECT 1 FROM feature_flag_kills k WHERE k.lifted_at IS NULL
          AND (k.account_id IS NULL OR k.account_id=$3)
          AND k.flag IN ('concentrate_analysis_enabled','experimental_analysis_enabled'))
      ${lock ? 'FOR UPDATE OF c,an,j' : ''}`,
    [context.captureId, context.analysisId, context.accountId, context.jobId, context.workerId, context.readingSnapshot],
  );
  if (!rows.length || context.signal.aborted) throw new Error('Inactive asset check');
}
export interface ConnectionAssetSlot extends Record<string, unknown> {
  slot: number;
  state: 'allocated' | 'complete' | 'failed';
  request_binding: string;
  evidence: unknown;
}
/** Commits BEFORE network/model dispatch. A crash burns the slot; it never replays. */
export async function allocateConnectionAssetSlot(
  context: ConnectionAssetCheckContext, candidateId: string, imageUrl: string, requestBinding: string, max: number,
): Promise<{ slot: ConnectionAssetSlot; fresh: boolean } | null> {
  assertConnectionAssetReadingSnapshot(context.readingSnapshot);
  return context.db.transaction(async tx => {
    await assertConnectionAssetCheckActive(tx, context, true);
    const { rows } = await tx.query<ConnectionAssetSlot>(
      `SELECT slot,state,request_binding,evidence FROM connection_asset_checks
       WHERE capture_id=$1 ORDER BY slot`, [context.captureId],
    );
    const previous = await tx.query<ConnectionAssetSlot>(
      `SELECT slot,state,request_binding,evidence FROM connection_asset_checks
       WHERE capture_id=$1 AND candidate_id=$2 AND image_url=$3 AND checker_version=$4`,
      [context.captureId, candidateId, imageUrl, CONNECTION_ASSET_CHECKER_VERSION],
    );
    if (previous.rows.length) {
      const slot = previous.rows[0]!;
      return slot.state === 'complete' && slot.request_binding === requestBinding ? { slot, fresh: false } : null;
    }
    if (rows.length >= max || rows.length >= 3) return null;
    const slot = rows.length + 1;
    const inserted = await tx.query<ConnectionAssetSlot>(
      `INSERT INTO connection_asset_checks
       (capture_id,slot,analysis_id,owner_account_id,job_id,candidate_id,image_url,checker_version,request_binding,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'allocated') RETURNING slot,state,request_binding,evidence`,
      [context.captureId, slot, context.analysisId, context.accountId, context.jobId,
        candidateId, imageUrl, CONNECTION_ASSET_CHECKER_VERSION, requestBinding],
    );
    return inserted.rows[0] ? { slot: inserted.rows[0], fresh: true } : null;
  });
}
export async function finishConnectionAssetSlot(
  context: ConnectionAssetCheckContext, slot: number, requestBinding: string, evidence: ConnectionAssetEvidence | null,
): Promise<boolean> {
  return context.db.transaction(async tx => {
    // Failed/stale attempts remain allocated if fencing fails; they are still burned.
    await assertConnectionAssetCheckActive(tx, context, true);
    const { rows } = await tx.query(
      `UPDATE connection_asset_checks SET state=$4,evidence=$5::jsonb,updated_at=now()
       WHERE capture_id=$1 AND slot=$2 AND request_binding=$3 AND state='allocated'
         AND analysis_id=$6 AND owner_account_id=$7 AND job_id=$8 RETURNING slot`,
      [context.captureId, slot, requestBinding, evidence ? 'complete' : 'failed',
        evidence ? JSON.stringify(evidence) : null, context.analysisId, context.accountId, context.jobId],
    );
    return rows.length === 1;
  });
}
/** Independent durable CDN control; never clears or launders gateway pauses/costs. */
export async function stopConnectionAssetAcquisition(db: GatewayDb, status: number): Promise<void> {
  if (![401, 403, 429, 503].includes(status)) return;
  await db.query('UPDATE connection_asset_fetch_control SET stop_status=$1 WHERE id=1', [status]);
}
export async function acquireConnectionAssetImage(context: ConnectionAssetCheckContext, imageUrl: string): Promise<Buffer | null> {
  assertConnectionAssetReadingSnapshot(context.readingSnapshot);
  return context.db.transaction(async tx => {
    // Fail closed rather than wait in an unbounded worker queue.
    const lock = await tx.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(742110,1) AS acquired',
    );
    if (!lock.rows[0]?.acquired) return null;
    const { rows } = await tx.query<{ stop_status: number | null; elapsed_ms: number | null }>(
      `SELECT stop_status,extract(epoch FROM (clock_timestamp()-last_started_at))*1000 AS elapsed_ms
       FROM connection_asset_fetch_control WHERE id=1 FOR UPDATE`,
    );
    const control = rows[0];
    if (!control || control.stop_status !== null) return null;
    const elapsed = control.elapsed_ms === null ? null : Number(control.elapsed_ms);
    if (elapsed !== null && (!Number.isFinite(elapsed) || elapsed < 0)) return null;
    const wait = elapsed === null ? 0 : Math.max(0, CONNECTION_ASSET_IMAGE_LIMITS.spacingMs - elapsed);
    if (wait > 0) await delay(Math.min(wait, CONNECTION_ASSET_IMAGE_LIMITS.spacingMs), undefined, { signal: context.signal });
    await assertConnectionAssetCheckActive(tx, context);
    await tx.query('UPDATE connection_asset_fetch_control SET last_started_at=clock_timestamp() WHERE id=1');
    const result = await fetchPublicConnectionImage(imageUrl, context.signal);
    if ([401, 403, 429, 503].includes(result.status))
      await tx.query('UPDATE connection_asset_fetch_control SET stop_status=$1 WHERE id=1', [result.status]);
    return context.signal.aborted ? null : result.bytes;
  });
}
