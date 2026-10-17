import type { Db } from '../db/pool';

/**
 * Legacy compatibility adapter: every account-owned v1 photo capture gets one
 * media asset that points at its stored keys verbatim (never reconstructed paths,
 * never moved objects). Migration 051/054 backfilled the rows that existed at
 * deploy time; this keeps later v1 captures, anonymous captures claimed by an
 * account and (optionally) World Sensor imports in step with the v2 library.
 *
 * Sensor import is a separate legacy source: with `includeSensor:false` no new
 * Sensor capture enters the library and the v2 media module does not depend on it.
 * Sample captures are product fixtures, not owned media, and are never imported.
 */
export interface LegacyBackfillOptions {
  includeSensor: boolean;
  accountId?: string;
  limit?: number;
  now?: Date;
}
export interface LegacyBackfillResult {
  imported: number;
  tombstoned: number;
  analysisUpdated: number;
}

const SOURCE_SQL = `CASE c.source WHEN 'sensor' THEN 'legacy_sensor' WHEN 'camera' THEN 'browser_camera' ELSE 'upload' END`;
const ANALYSIS_SQL = `CASE
  WHEN c.active_analysis_id IS NOT NULL AND c.status IN ('ready','partial') THEN 'complete'
  WHEN c.status IN ('pending','processing') THEN 'running'
  WHEN c.status='failed' THEN 'failed'
  ELSE 'not_requested' END`;

export async function backfillLegacyCaptures(
  db: Db,
  options: LegacyBackfillOptions,
): Promise<LegacyBackfillResult> {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
  const account = options.accountId ?? null;
  return db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string; legacy_capture_id: string }>(
      `INSERT INTO media_assets(account_id,client_capture_id,kind,source,status,analysis_status,original_key,
         sha256,byte_size,content_type,width,height,captured_at,created_at,received_at,legacy_capture_id,legacy_imported)
       SELECT c.owner_account_id,c.id,'photo',${SOURCE_SQL},'ready',${ANALYSIS_SQL},c.original_object_key,
         c.image_sha256,COALESCE(u.byte_size,0),'image/jpeg',c.width,c.height,c.captured_at,c.created_at,
         c.received_at,c.id,true
       FROM captures c LEFT JOIN uploads u ON u.id=c.upload_id
       WHERE c.owner_account_id IS NOT NULL AND c.media_asset_id IS NULL AND c.deleted_at IS NULL
         AND c.source<>'sample' AND (c.source<>'sensor' OR $1::boolean)
         AND ($2::uuid IS NULL OR c.owner_account_id=$2)
         AND c.private_object_key IS NOT NULL
       ORDER BY c.created_at,c.id
       LIMIT $3
       ON CONFLICT DO NOTHING
       RETURNING id,legacy_capture_id`,
      [options.includeSensor, account, limit],
    );
    for (const row of inserted.rows) {
      await tx.query(
        `UPDATE captures SET media_asset_id=$2 WHERE id=$1 AND media_asset_id IS NULL`,
        [row.legacy_capture_id, row.id],
      );
    }
    // A v1 deletion hides the library item too; v1 owns purge of its own keys.
    const tombstoned = await tx.query(
      `UPDATE media_assets m SET status='deleted',deleted_at=c.deleted_at,generation=m.generation+1,
         revision=m.revision+1
       FROM captures c
       WHERE m.legacy_capture_id=c.id AND m.account_id=c.owner_account_id AND m.legacy_imported
         AND m.deleted_at IS NULL AND c.deleted_at IS NOT NULL AND ($1::uuid IS NULL OR m.account_id=$1)`,
      [account],
    );
    const analysis = await tx.query(
      `UPDATE media_assets m SET analysis_status=${ANALYSIS_SQL}
       FROM captures c
       WHERE m.legacy_capture_id=c.id AND m.account_id=c.owner_account_id AND m.legacy_imported
         AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND m.analysis_status<>${ANALYSIS_SQL}
         AND ($1::uuid IS NULL OR m.account_id=$1)`,
      [account],
    );
    return {
      imported: inserted.rowCount ?? 0,
      tombstoned: tombstoned.rowCount ?? 0,
      analysisUpdated: analysis.rowCount ?? 0,
    };
  });
}
