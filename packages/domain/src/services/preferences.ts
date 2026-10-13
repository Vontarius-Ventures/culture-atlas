import type { ServiceContext } from '../context';
import { notImplemented } from '../errors';
import type { PreferenceRequest, PreferenceResponse, SavedListResponse, SavedQuery } from '../schemas/preferences';

/**
 * Taste memory actions. Every action writes a PreferenceEvent and bumps the
 * taste revision (taste.bumpTasteRevision) in the same transaction.
 *  save   -> upsert SavedItem (unique owner+item); capture target endorses the
 *            capture inspiration + current focus.
 *  remove -> "Unsave everywhere": delete SavedItem and all memberships
 *            (bump revisions of affected collections). Agents need whole-library.
 *  hide   -> item_exclusions row (this item only). Agents need whole-library.
 *  unhide -> remove exclusion.
 * Agents: taste:write, and an explicit user preference per tool instructions.
 */

/** POST /v1/preferences. TODO(collections/taste owner): implement. */
export async function recordPreference(ctx: ServiceContext, body: PreferenceRequest): Promise<PreferenceResponse> {
  void ctx;
  void body;
  notImplemented('preferences.recordPreference');
}

/**
 * GET /v1/saved — canonical saved items with membership ids. Selected-
 * collection agents only see items in granted collections (no unfiled).
 * TODO(collections/taste owner): implement.
 */
export async function listSaved(ctx: ServiceContext, query: SavedQuery): Promise<SavedListResponse> {
  void ctx;
  void query;
  notImplemented('preferences.listSaved');
}
