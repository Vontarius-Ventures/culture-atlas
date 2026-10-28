import type { Db, Queryable } from '../db/pool';
import type { Category, ItemKind, ReferenceType, SectionStatus } from '../enums';
import { JobCancelledError } from '../jobs/handler';
import { setSectionStatus } from '../jobs/stages';
import type { Owner } from '../principal';
import { forDisplayUpsert, storeSanitizedDisplayMetadata, type DisplayMetadata } from '../services/display';

/** Capture row fields the compiler needs. */
export interface CaptureForCompile {
  id: string;
  owner_account_id: string | null;
  owner_session_id: string | null;
  private_object_key: string | null;
  image_sha256: string;
  source: string;
  sample_id: string | null;
  focus: unknown;
  status: string;
  active_analysis_id: string | null;
  deleted_at: Date | null;
}

export function ownerFromRow(row: { owner_account_id: string | null; owner_session_id: string | null }): Owner {
  return row.owner_account_id ? { kind: 'account', accountId: row.owner_account_id } : { kind: 'session', sessionId: row.owner_session_id! };
}

export async function loadCapture(db: Queryable, captureId: string): Promise<CaptureForCompile | null> {
  const { rows } = await db.query<CaptureForCompile>(
    `SELECT id, owner_account_id, owner_session_id, private_object_key, image_sha256, source, sample_id, focus, status,
            active_analysis_id, deleted_at
       FROM captures WHERE id = $1`,
    [captureId],
  );
  return rows[0] ?? null;
}

/**
 * Locks the capture row for the duration of a publish transaction. Returns
 * null when it was deleted: callers must not publish. Capture deletion takes
 * the same lock, so a delete either happens before (and we publish nothing)
 * or after (and removes what we published).
 */
export async function lockLiveCapture(tx: Queryable, captureId: string): Promise<CaptureForCompile | null> {
  const { rows } = await tx.query<CaptureForCompile>(
    `SELECT id, owner_account_id, owner_session_id, private_object_key, image_sha256, source, sample_id, focus, status,
            active_analysis_id, deleted_at
       FROM captures WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [captureId],
  );
  return rows[0] ?? null;
}

/**
 * Deletion/cancellation check + transactional publish. `ensureActive` throws
 * JobCancelledError when the job was cancelled (e.g. by capture deletion) or
 * the lease was lost; the row lock catches a delete that raced it.
 */
export async function publishForCapture<T>(
  db: Db,
  captureId: string,
  ensureActive: () => Promise<void>,
  fn: (tx: Db, capture: CaptureForCompile) => Promise<T>,
): Promise<T> {
  await ensureActive();
  return db.transaction(async (tx) => {
    const capture = await lockLiveCapture(tx, captureId);
    if (!capture) throw new JobCancelledError('capture deleted');
    return fn(tx, capture);
  });
}

export async function setAnalysisSection(db: Queryable, analysisId: string, section: string, status: SectionStatus): Promise<void> {
  await setSectionStatus(db, 'analyses', analysisId, section, status);
}

export async function upsertReference(
  db: Queryable,
  ref: { canonicalKey: string; name: string; type: ReferenceType; externalIds: Record<string, unknown> },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cultural_references (canonical_name, canonical_key, type, external_ids)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (canonical_key) DO UPDATE
       SET external_ids = cultural_references.external_ids || EXCLUDED.external_ids, updated_at = now()
     RETURNING id`,
    [ref.name.slice(0, 200), ref.canonicalKey, ref.type, JSON.stringify(ref.externalIds)],
  );
  return rows[0]!.id;
}

export interface DiscoveryItemInput {
  kind: ItemKind;
  category: Category | null;
  canonicalKey: string;
  title: string;
  displayMetadata: DisplayMetadata;
  externalIds: Record<string, unknown>;
  referenceId?: string | null;
  resolvedAnchorIds: readonly string[];
}

/**
 * Stable per-owner identity (owner + canonical_key): the same film/brand from
 * two analyses maps to ONE DiscoveryItem. Existing items keep their id (saved
 * state survives); anchors are merged and metadata refreshed.
 *
 * Provider display-rights boundary (VAL-EVID-005): the incoming metadata is
 * sanitized before it is written, and the stored side is cleaned on the
 * conflict-merge so a legacy row's restricted content cannot survive a new
 * upsert. Qloo prose never persists on provider-backed items, and an image
 * persists only when it is user-owned stored media or an app-owned/cleared
 * asset — never an uncleared external URL.
 */
export async function upsertDiscoveryItem(db: Queryable, owner: Owner, item: DiscoveryItemInput): Promise<string> {
  const conflict = owner.kind === 'account' ? '(owner_account_id, canonical_key)' : '(owner_session_id, canonical_key)';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, owner_session_id, kind, category, canonical_key, reference_id,
                                  title, display_metadata, external_ids, resolved_anchor_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::uuid[])
     ON CONFLICT ${conflict} DO UPDATE
       SET display_metadata =
         -- Stored legacy metadata is cleaned of restricted content before the
         -- sanitized EXCLUDED overlay: prose disappears when the merged
         -- identity is provider-backed, and an uncleared external image URL is
         -- nulled while user-owned object_key images survive.
         (discovery_items.display_metadata
            || CASE WHEN (discovery_items.external_ids || EXCLUDED.external_ids) ?| ARRAY['qloo','qloo_tag']
                    THEN '{"description": null}'::jsonb ELSE '{}'::jsonb END
            || CASE WHEN (discovery_items.display_metadata -> 'image') ? 'object_key'
                     OR left(COALESCE(discovery_items.display_metadata -> 'image' ->> 'url', ''), 1) = '/'
                   THEN '{}'::jsonb ELSE '{"image": null}'::jsonb END)
         || EXCLUDED.display_metadata,
           external_ids = discovery_items.external_ids || EXCLUDED.external_ids,
           resolved_anchor_ids = ARRAY(SELECT DISTINCT unnest(discovery_items.resolved_anchor_ids || EXCLUDED.resolved_anchor_ids)),
           updated_at = now()
     RETURNING id`,
    [
      owner.kind === 'account' ? owner.accountId : null,
      owner.kind === 'session' ? owner.sessionId : null,
      item.kind,
      item.category,
      item.canonicalKey,
      item.referenceId ?? null,
      item.title.slice(0, 200),
      JSON.stringify(forDisplayUpsert(storeSanitizedDisplayMetadata(item.displayMetadata, item.externalIds))),
      JSON.stringify(item.externalIds),
      [...item.resolvedAnchorIds],
    ],
  );
  return rows[0]!.id;
}

/** Canonical keys the owner hid (filtered before presentation). */
export async function loadExcludedKeys(db: Queryable, owner: Owner): Promise<Set<string>> {
  const { rows } = await db.query<{ canonical_key: string }>(
    owner.kind === 'account'
      ? 'SELECT canonical_key FROM item_exclusions WHERE owner_account_id = $1'
      : 'SELECT canonical_key FROM item_exclusions WHERE owner_session_id = $1',
    [owner.kind === 'account' ? owner.accountId : owner.sessionId],
  );
  return new Set(rows.map((r) => r.canonical_key));
}

export interface RecommendationInput {
  analysisId: string;
  discoveryItemId: string;
  category: Category | null;
  rank: number;
  title: string;
  externalIds: Record<string, unknown>;
  displayReason: string | null;
  origin: 'qloo' | 'research' | 'catalog' | 'vlm_creative' | 'sample' | 'replay';
  sourceIds?: readonly string[];
  providerQueryIds: readonly string[];
  contributingReferenceIds: readonly string[];
  destinationUrl?: string | null;
}

export async function insertRecommendation(db: Queryable, r: RecommendationInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO recommendations (analysis_id, discovery_item_id, category, rank, title, external_ids, display_reason,
                                  origin, source_ids, provider_query_ids, contributing_reference_ids, destination_url)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::uuid[], $10::uuid[], $11::uuid[], $12)
     RETURNING id`,
    [
      r.analysisId,
      r.discoveryItemId,
      r.category,
      r.rank,
      r.title.slice(0, 200),
      JSON.stringify(r.externalIds),
      r.displayReason,
      r.origin,
      [...(r.sourceIds ?? [])],
      [...r.providerQueryIds],
      [...r.contributingReferenceIds],
      r.destinationUrl ?? null,
    ],
  );
  return rows[0]!.id;
}
