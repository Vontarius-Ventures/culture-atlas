import { resolveTasteScope } from '../authz';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import type { Category, ItemKind } from '../enums';
import { loadItemAnchors } from '../library/anchors';
import { hiddenKeys, loadAccessibleCollection } from '../library/access';
import { foldPreferences, type FoldSave, type TasteSummary } from '../library/taste-fold';
import { ownerColumns, ownerOf, ownerPredicate, type Owner } from '../principal';
import type { TasteQuery, TasteResponse } from '../schemas/taste';

/**
 * Taste memory: derived, rebuildable profile over CURRENT explicit preferences
 * (saved items + hides + corrections). Upload/view/open alone never changes it.
 * Saving into extra collections never multiplies an item's global weight.
 */

/** Current taste revision for an owner (0 when no profile yet). */
export async function getTasteRevision(db: Queryable, owner: Owner): Promise<number> {
  const cols = ownerColumns(owner);
  const { rows } = await db.query<{ revision: number }>(
    `SELECT revision FROM taste_profiles
      WHERE owner_account_id IS NOT DISTINCT FROM $1 AND owner_session_id IS NOT DISTINCT FROM $2`,
    [cols.owner_account_id, cols.owner_session_id],
  );
  return rows[0]?.revision ?? 0;
}

/**
 * Increment the owner's taste revision (call inside the same transaction as
 * any save/remove/hide/unhide/correct). Returns the new revision. Part of
 * recommendation/feed cache keys.
 */
export async function bumpTasteRevision(db: Queryable, owner: Owner): Promise<number> {
  const cols = ownerColumns(owner);
  const conflict = owner.kind === 'account' ? '(owner_account_id)' : '(owner_session_id)';
  const { rows } = await db.query<{ revision: number }>(
    `INSERT INTO taste_profiles (owner_account_id, owner_session_id, revision)
     VALUES ($1, $2, 1)
     ON CONFLICT ${conflict} DO UPDATE SET revision = taste_profiles.revision + 1
     RETURNING revision`,
    [cols.owner_account_id, cols.owner_session_id],
  );
  return rows[0]!.revision;
}

/** Saved items (optionally only members of one collection) with their anchors, ready to fold. */
export async function loadFoldSaves(db: Queryable, owner: Owner, collectionId?: string): Promise<FoldSave[]> {
  const own = ownerPredicate(owner, 'si', 1);
  const params: unknown[] = [...own.params];
  let membership = '';
  if (collectionId) {
    params.push(collectionId);
    membership = `AND EXISTS (SELECT 1 FROM collection_items ci WHERE ci.saved_item_id = si.id AND ci.collection_id = $${params.length})`;
  }
  const { rows } = await db.query<{
    saved_item_id: string;
    item_id: string;
    kind: ItemKind;
    category: Category | null;
    title: string;
    canonical_key: string;
    reference_id: string | null;
  }>(
    `SELECT si.id AS saved_item_id, di.id AS item_id, di.kind, di.category, di.title, di.canonical_key, di.reference_id
       FROM saved_items si JOIN discovery_items di ON di.id = si.discovery_item_id
      WHERE ${own.sql} ${membership}
      ORDER BY si.saved_at DESC, si.id`,
    params,
  );
  const anchors = await loadItemAnchors(db, rows.map((r) => r.item_id));
  return rows.map((r) => ({
    ...r,
    anchors: (anchors.get(r.item_id) ?? []).map((a) => ({ reference_id: a.reference_id, name: a.name, user_selected: a.user_selected })),
  }));
}

/**
 * GET /v1/taste. Global for accounts/anonymous/whole-library agents;
 * collection-scoped (resolveTasteScope) for selected-collection agents.
 */
export async function getTaste(ctx: ServiceContext, query: TasteQuery): Promise<TasteResponse> {
  const scope = resolveTasteScope(ctx.principal, query.collection_id);
  const owner = ownerOf(ctx.principal);
  if (scope.kind === 'collection') await loadAccessibleCollection(ctx, scope.collectionId);
  const [saves, hidden, revision] = await Promise.all([
    loadFoldSaves(ctx.db, owner, scope.kind === 'collection' ? scope.collectionId : undefined),
    hiddenKeys(ctx.db, owner),
    getTasteRevision(ctx.db, owner),
  ]);
  const summary = foldPreferences(saves, hidden);
  return {
    scope: scope.kind,
    collection_id: scope.kind === 'collection' ? scope.collectionId : null,
    revision,
    interests: summary.interests.map(({ weight: _w, ...i }) => i),
    saved_count: summary.saved_count,
    // The global hidden list is not part of a collection-scoped view.
    hidden_count: scope.kind === 'collection' ? 0 : hidden.size,
  };
}

/** Recompute the stored summary for an owner (idempotent). */
export async function computeTasteSummary(db: Queryable, owner: Owner): Promise<TasteSummary> {
  const [saves, hidden] = await Promise.all([loadFoldSaves(db, owner), hiddenKeys(db, owner)]);
  return foldPreferences(saves, hidden);
}

/**
 * Recompute taste_profiles.summary from current preferences (after
 * save/unsave/hide/delete/correct). Idempotent; never changes the revision.
 */
export async function rebuildTasteProfile(db: Queryable, owner: Owner): Promise<void> {
  const summary = await computeTasteSummary(db, owner);
  const cols = ownerColumns(owner);
  const conflict = owner.kind === 'account' ? '(owner_account_id)' : '(owner_session_id)';
  await db.query(
    `INSERT INTO taste_profiles (owner_account_id, owner_session_id, revision, summary, rebuilt_at)
     VALUES ($1, $2, 0, $3::jsonb, now())
     ON CONFLICT ${conflict} DO UPDATE SET summary = EXCLUDED.summary, rebuilt_at = now()`,
    [cols.owner_account_id, cols.owner_session_id, JSON.stringify(summary)],
  );
}
