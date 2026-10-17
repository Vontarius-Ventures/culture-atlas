import type { MultipartStorage } from '@culture-atlas/providers';
import type { Db } from '../db/pool';

/**
 * Storage/database reconciliation for the capture v2 private namespace.
 *
 * Storage and the database are not atomic, so this sweep compares the object
 * inventory with live records after a safety window:
 * - staging objects and incomplete multipart uploads whose upload session is no
 *   longer active (or never committed a record) are removed;
 * - committed originals/derivatives of tombstoned assets are removed (safe to repeat);
 * - unreferenced attempt output is removed only when no live lease can still publish it;
 * - referenced objects that are missing are reported, never synthesized or deleted.
 * Nothing is deleted while an upload session remains active, and no prefix outside
 * `accounts/` is touched. Results carry counts only (no keys, filenames or bytes).
 */
export interface ReconcileOptions {
  now?: Date;
  /** Minimum object age before an unreferenced object may be removed. Default 24h. */
  safetyWindowMs?: number;
  /** Upper bound of objects inspected per sweep. */
  maxObjects?: number;
  accountId?: string;
}
export interface ReconcileResult {
  scanned: number;
  deletedOrphans: number;
  abortedMultipart: number;
  missingReferenced: number;
  unrecognized: number;
  complete: boolean;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STAGING = new RegExp(`^accounts/(${UUID})/staging/(${UUID})/(${UUID})$`);
const MEDIA = new RegExp(
  `^accounts/(${UUID})/media/(${UUID})/(\\d+)/(original|derived/(${UUID})/.+)$`,
);
const ACTIVE_UPLOAD = ['created', 'uploading', 'verifying', 'paused'];

export async function reconcileCaptureStorage(
  db: Db,
  storage: MultipartStorage,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.safetyWindowMs ?? 86400000));
  const max = options.maxObjects ?? 10000;
  const prefix = options.accountId ? `accounts/${options.accountId}` : 'accounts';
  const result: ReconcileResult = {
    scanned: 0,
    deletedOrphans: 0,
    abortedMultipart: 0,
    missingReferenced: 0,
    unrecognized: 0,
    complete: true,
  };
  if (!storage.list) {
    result.complete = false;
    return result;
  }
  const seen = new Set<string>();
  for await (const object of storage.list(prefix)) {
    if (result.scanned >= max) {
      result.complete = false;
      break;
    }
    result.scanned++;
    seen.add(object.key);
    if (await shouldDelete(db, object.key, object.lastModified, cutoff, now, result)) {
      await storage.delete(object.key);
      result.deletedOrphans++;
    }
  }
  if (storage.listIncompleteUploads) {
    for await (const upload of storage.listIncompleteUploads(prefix)) {
      if (upload.initiatedAt > cutoff) continue;
      const { rows } = await db.query(
        `SELECT state,expires_at FROM upload_sessions WHERE staging_key=$1 AND provider_multipart_id=$2`,
        [upload.key, upload.uploadId],
      );
      const live = rows[0] && ACTIVE_UPLOAD.includes(rows[0].state) && rows[0].expires_at > now;
      if (live) continue;
      await storage.abort(upload.key, upload.uploadId);
      result.abortedMultipart++;
    }
  }
  if (result.complete) {
    // Only a full inventory can prove a referenced object is missing.
    const referenced = await db.query<{ key: string }>(
      `SELECT original_key AS key FROM media_assets
        WHERE deleted_at IS NULL AND NOT legacy_imported AND original_key IS NOT NULL
          AND status IN ('processing','ready','failed') AND ($1::uuid IS NULL OR account_id=$1)
       UNION ALL
       SELECT d.object_key FROM media_derivatives d JOIN media_assets m
         ON m.account_id=d.account_id AND m.id=d.asset_id AND m.generation=d.generation
        WHERE m.deleted_at IS NULL AND ($1::uuid IS NULL OR m.account_id=$1)`,
      [options.accountId ?? null],
    );
    result.missingReferenced = referenced.rows.filter((r) => !seen.has(r.key)).length;
  }
  return result;
}

async function shouldDelete(
  db: Db,
  key: string,
  lastModified: Date,
  cutoff: Date,
  now: Date,
  result: ReconcileResult,
): Promise<boolean> {
  const staging = STAGING.exec(key);
  if (staging) {
    const { rows } = await db.query(
      `SELECT state,expires_at FROM upload_sessions WHERE account_id=$1 AND asset_id=$2 AND id=$3 AND staging_key=$4`,
      [staging[1], staging[2], staging[3], key],
    );
    const session = rows[0];
    if (session && ACTIVE_UPLOAD.includes(session.state) && session.expires_at > now) return false;
    return lastModified <= cutoff;
  }
  const media = MEDIA.exec(key);
  if (!media) {
    result.unrecognized++;
    return false;
  }
  const [, accountId, assetId, generationText, , attemptId] = media;
  const { rows } = await db.query(
    `SELECT original_key,deleted_at,generation FROM media_assets WHERE account_id=$1 AND id=$2`,
    [accountId, assetId],
  );
  const asset = rows[0];
  if (!asset) return lastModified <= cutoff;
  // Tombstoned namespaces are always safe to purge (purge_media repeats this).
  if (asset.deleted_at) return true;
  if (!attemptId) {
    if (asset.original_key === key) return false;
    if (lastModified > cutoff) return false;
    return !(await liveLease(db, accountId!, assetId!, Number(generationText), null, now));
  }
  const referenced = await db.query(
    `SELECT 1 FROM media_derivatives WHERE account_id=$1 AND asset_id=$2 AND object_key=$3`,
    [accountId, assetId, key],
  );
  if (referenced.rowCount) return false;
  if (lastModified > cutoff) return false;
  return !(await liveLease(db, accountId!, assetId!, Number(generationText), attemptId, now));
}

async function liveLease(
  db: Db,
  accountId: string,
  assetId: string,
  generation: number,
  attemptId: string | null,
  now: Date,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM capture_work WHERE account_id=$1 AND asset_id=$2 AND generation=$3
       AND kind IN ('verify_upload','prepare_media') AND state='running' AND lease_expires_at>$4
       AND ($5::uuid IS NULL OR attempt_id=$5)`,
    [accountId, assetId, generation, now, attemptId],
  );
  return !!rowCount;
}
