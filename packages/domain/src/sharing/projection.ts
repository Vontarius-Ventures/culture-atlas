import type { Queryable } from '../db/pool';
import type { Category, ItemKind } from '../enums';
import type { SharedDiscovery, SharedMedia } from '../schemas/collection-shares';
import { readDisplayMetadata } from '../services/display';

/**
 * ShareProjection: the deep module that decides what a share viewer may see.
 *
 * It is a positive projection. Nothing is spread from stored rows; every
 * field is chosen here. Excluded by construction:
 *  - recommendation reasons, evidence, traces and taste (never read);
 *  - capture items and their stored photos (only sanitized media below);
 *  - private stored images (display images with an object_key);
 *  - device provenance, coordinates, EXIF, transcripts, media titles and
 *    analysis output (media rows are reduced to kind, size and duration);
 *  - every other collection (all queries are bound to the share's collection
 *    AND its owner).
 * The projection is live: it reads current membership on every call, so
 * additions appear and removals disappear under the share's current policy.
 */

export const SHARE_PAYLOAD_LIMIT = 100;

export interface LiveShare {
  id: string;
  owner_account_id: string;
  collection_id: string;
  audience: 'restricted' | 'link';
  include_media: boolean;
  allow_originals: boolean;
  expires_at: Date | null;
  policy_version: number;
}

const SAFE_IMAGE = /^(https:\/\/|\/samples\/)/;
const SAFE_LINK = /^https:\/\//;

/** Public catalog references are the only items a viewer may copy into their own library. */
export function isPublicCatalogKey(canonicalKey: string): boolean {
  return canonicalKey.startsWith('qloo:');
}

/**
 * Media currently in the shared collection: v2 media memberships plus legacy
 * capture items whose photo was promoted to a media asset. Bound to owner.
 * `$1` collection id, `$2` owner account id.
 */
const SHARED_MEDIA_MEMBERSHIP = `(
  EXISTS (SELECT 1 FROM collection_media_items cm
           WHERE cm.collection_id = $1 AND cm.account_id = $2 AND cm.asset_id = m.id)
  OR EXISTS (SELECT 1 FROM collection_items ci
               JOIN saved_items si ON si.id = ci.saved_item_id AND si.owner_account_id = ci.owner_account_id
               JOIN discovery_items di ON di.id = si.discovery_item_id AND di.owner_account_id = ci.owner_account_id
               JOIN captures c ON c.id = di.capture_id AND c.owner_account_id = ci.owner_account_id
              WHERE ci.collection_id = $1 AND ci.owner_account_id = $2 AND c.media_asset_id = m.id))`;

export interface ShareableMediaObject {
  assetId: string;
  kind: 'photo' | 'video';
  objectKey: string;
  byteSize: number;
  durationMs: number | null;
  variant: 'poster' | 'playback' | 'original';
}

export async function projectDiscoveries(db: Queryable, share: LiveShare): Promise<{ items: SharedDiscovery[]; truncated: boolean }> {
  const { rows } = await db.query<{
    id: string; kind: ItemKind; category: Category | null; title: string; display_metadata: unknown;
    is_sample: boolean; canonical_key: string;
  }>(
    `SELECT di.id, di.kind, di.category, di.title, di.display_metadata, di.is_sample, di.canonical_key
       FROM collection_items ci
       JOIN saved_items si ON si.id = ci.saved_item_id AND si.owner_account_id = ci.owner_account_id
       JOIN discovery_items di ON di.id = si.discovery_item_id
            AND (di.owner_account_id = ci.owner_account_id OR di.is_sample)
      WHERE ci.collection_id = $1 AND ci.owner_account_id = $2 AND di.kind <> 'capture'
      ORDER BY ci.position, ci.added_at, ci.id
      LIMIT $3`,
    [share.collection_id, share.owner_account_id, SHARE_PAYLOAD_LIMIT + 1],
  );
  const items = rows.slice(0, SHARE_PAYLOAD_LIMIT).map((r): SharedDiscovery => {
    const meta = readDisplayMetadata(r.display_metadata);
    const image = meta.image && !meta.image.object_key && meta.image.url && SAFE_IMAGE.test(meta.image.url)
      ? { url: meta.image.url, width: meta.image.width ?? null, height: meta.image.height ?? null, alt: meta.image.alt ?? '' }
      : null;
    return {
      id: r.id,
      kind: r.kind,
      category: r.category,
      title: r.title,
      subtitle: meta.subtitle ?? (meta.year ? String(meta.year) : null),
      description: meta.description ?? null,
      detail: meta.detail ?? null,
      image,
      destination_url: meta.destination_url && SAFE_LINK.test(meta.destination_url) ? meta.destination_url : null,
      is_example: r.is_sample || meta.example === true,
      saveable: isPublicCatalogKey(r.canonical_key),
    };
  });
  return { items, truncated: rows.length > SHARE_PAYLOAD_LIMIT };
}

function mediaUrl(share: LiveShare, assetId: string, variant: string) {
  return `/v2/shared/media/${assetId}/${variant}?share=${share.id}`;
}

export async function projectMedia(db: Queryable, share: LiveShare): Promise<{ items: SharedMedia[]; truncated: boolean }> {
  if (!share.include_media) return { items: [], truncated: false };
  const { rows } = await db.query<{
    id: string; kind: 'photo' | 'video'; duration_ms: number | null; original_key: string | null;
    poster: string | null; playback: string | null; width: number | null; height: number | null;
  }>(
    `SELECT m.id, m.kind, m.duration_ms, m.original_key,
            (SELECT d.id::text FROM media_derivatives d WHERE d.account_id = m.account_id AND d.asset_id = m.id
               AND d.generation = m.generation AND d.share_safe AND d.kind = 'poster' LIMIT 1) AS poster,
            (SELECT d.id::text FROM media_derivatives d WHERE d.account_id = m.account_id AND d.asset_id = m.id
               AND d.generation = m.generation AND d.share_safe
               AND d.kind = CASE WHEN m.kind = 'video' THEN 'playback' ELSE 'normalized' END LIMIT 1) AS playback,
            (SELECT d.width FROM media_derivatives d WHERE d.account_id = m.account_id AND d.asset_id = m.id
               AND d.generation = m.generation AND d.share_safe
               AND d.kind = CASE WHEN m.kind = 'video' THEN 'playback' ELSE 'normalized' END LIMIT 1) AS width,
            (SELECT d.height FROM media_derivatives d WHERE d.account_id = m.account_id AND d.asset_id = m.id
               AND d.generation = m.generation AND d.share_safe
               AND d.kind = CASE WHEN m.kind = 'video' THEN 'playback' ELSE 'normalized' END LIMIT 1) AS height
       FROM media_assets m
      WHERE m.account_id = $2 AND m.deleted_at IS NULL AND m.hidden_at IS NULL AND m.status = 'ready'
        AND ${SHARED_MEDIA_MEMBERSHIP}
      ORDER BY m.created_at DESC, m.id
      LIMIT $3`,
    [share.collection_id, share.owner_account_id, SHARE_PAYLOAD_LIMIT + 1],
  );
  const items = rows
    // Only media with a sanitized derivative are visible at all.
    .filter((r) => r.playback !== null)
    .slice(0, SHARE_PAYLOAD_LIMIT)
    .map((r): SharedMedia => ({
      id: r.id,
      kind: r.kind,
      width: r.width,
      height: r.height,
      duration_ms: r.kind === 'video' ? r.duration_ms : null,
      poster_url: r.poster ? mediaUrl(share, r.id, 'poster') : null,
      playback_url: mediaUrl(share, r.id, 'playback'),
      original_url: share.allow_originals && r.original_key ? mediaUrl(share, r.id, 'original') : null,
    }));
  return { items, truncated: rows.length > SHARE_PAYLOAD_LIMIT };
}

/**
 * Resolve one media object for a viewer request, re-checking current
 * membership and policy. Returns null for anything not currently visible
 * (callers answer with an indistinguishable 404).
 */
export async function resolveSharedMediaObject(
  db: Queryable,
  share: LiveShare,
  assetId: string,
  variant: 'poster' | 'playback' | 'original',
): Promise<ShareableMediaObject | null> {
  if (!share.include_media) return null;
  if (variant === 'original' && !share.allow_originals) return null;
  const { rows } = await db.query<{
    kind: 'photo' | 'video'; duration_ms: number | null; original_key: string | null; byte_size: string;
    object_key: string | null; derivative_bytes: string | null; derivative_duration: number | null;
  }>(
    `SELECT m.kind, m.duration_ms, m.original_key, m.byte_size::text,
            d.object_key, d.byte_size::text AS derivative_bytes, d.duration_ms AS derivative_duration
       FROM media_assets m
       LEFT JOIN media_derivatives d ON d.account_id = m.account_id AND d.asset_id = m.id
            AND d.generation = m.generation AND d.share_safe
            AND d.kind = CASE WHEN $4 = 'poster' THEN 'poster'
                              WHEN m.kind = 'video' THEN 'playback' ELSE 'normalized' END
      WHERE m.id = $3 AND m.account_id = $2 AND m.deleted_at IS NULL AND m.hidden_at IS NULL
        AND m.status = 'ready' AND ${SHARED_MEDIA_MEMBERSHIP}
      LIMIT 1`,
    [share.collection_id, share.owner_account_id, assetId, variant],
  );
  const row = rows[0];
  if (!row) return null;
  if (variant === 'original') {
    if (!row.original_key) return null;
    return { assetId, kind: row.kind, objectKey: row.original_key, byteSize: Number(row.byte_size),
      durationMs: row.duration_ms, variant };
  }
  if (!row.object_key || row.derivative_bytes === null) return null;
  return {
    assetId, kind: row.kind, objectKey: row.object_key, byteSize: Number(row.derivative_bytes),
    durationMs: variant === 'playback' && row.kind === 'video' ? (row.derivative_duration ?? row.duration_ms) : null, variant,
  };
}

/** Max bytes per authorized playback response: about 30 seconds of the stream. */
export const SHARE_SEGMENT_SECONDS = 30;
export const SHARE_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;

export function segmentByteLimit(object: Pick<ShareableMediaObject, 'byteSize' | 'durationMs'>): number {
  if (!object.durationMs || object.durationMs <= 0) return SHARE_SEGMENT_MAX_BYTES;
  const perSegment = Math.ceil((object.byteSize * SHARE_SEGMENT_SECONDS * 1000) / object.durationMs);
  return Math.max(64 * 1024, Math.min(SHARE_SEGMENT_MAX_BYTES, perSegment));
}

/**
 * Parse a Range header and clamp it to one authorized segment. Returns null for
 * an unsatisfiable range. Without a Range header the first segment is served.
 */
export function clampShareRange(
  rangeHeader: string | null,
  totalBytes: number,
  limit: number,
): { start: number; end: number } | null {
  if (totalBytes <= 0) return null;
  let start = 0;
  let end = totalBytes - 1;
  if (rangeHeader) {
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!parsed || (!parsed[1] && !parsed[2])) return null;
    if (parsed[1]) {
      start = Number(parsed[1]);
      if (parsed[2]) end = Math.min(Number(parsed[2]), end);
    } else {
      start = Math.max(0, totalBytes - Number(parsed[2]));
    }
  }
  if (!Number.isSafeInteger(start) || start > end || start >= totalBytes) return null;
  end = Math.min(end, start + limit - 1);
  return { start, end };
}
