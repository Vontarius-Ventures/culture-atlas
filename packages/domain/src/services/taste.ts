import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { notImplemented } from '../errors';
import { ownerColumns, type Owner } from '../principal';
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

/**
 * GET /v1/taste. Global for accounts/anonymous/whole-library agents;
 * collection-scoped (resolveTasteScope) for selected-collection agents.
 * TODO(taste owner): implement summary from saved items' resolved anchors.
 */
export async function getTaste(ctx: ServiceContext, query: TasteQuery): Promise<TasteResponse> {
  void ctx;
  void query;
  notImplemented('taste.getTaste');
}

/**
 * Recompute taste_profiles.summary from current preferences (after
 * unsave/delete/correct). Must be idempotent.
 * TODO(taste owner): implement.
 */
export async function rebuildTasteProfile(db: Queryable, owner: Owner): Promise<void> {
  void db;
  void owner;
  notImplemented('taste.rebuildTasteProfile');
}
