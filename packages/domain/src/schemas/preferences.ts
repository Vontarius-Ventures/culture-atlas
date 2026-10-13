import { z } from 'zod';
import { ItemKind, PreferenceAction, PreferenceTargetType } from '../enums';
import { Cursor, DiscoveryCard, LimitQuery, Timestamp, Uuid } from './common';

/**
 * POST /v1/preferences — explicit save/remove/hide/unhide.
 *  save:   creates SavedItem (unfiled unless memberships are added).
 *  remove: "Unsave everywhere" — deletes SavedItem and all memberships.
 *  hide:   exclusion for this item only (not a whole category/culture).
 *  unhide: removes that exclusion.
 * target_type 'capture' saves/removes the capture inspiration (whole + current focus).
 */
export const PreferenceRequest = z.strictObject({
  action: PreferenceAction,
  target_type: PreferenceTargetType.default('discovery_item'),
  target_id: Uuid,
});
export type PreferenceRequest = z.infer<typeof PreferenceRequest>;

export const SavedItemDto = z.object({
  id: Uuid,
  discovery_item_id: Uuid,
  saved_at: Timestamp,
});
export type SavedItemDto = z.infer<typeof SavedItemDto>;

export const PreferenceResponse = z.object({
  action: PreferenceAction,
  target_type: PreferenceTargetType,
  target_id: Uuid,
  /** Present after save (and when the item remains saved). */
  saved_item: SavedItemDto.nullable(),
  taste_revision: z.number().int(),
  /** Request that reverses this action ("Undo"). */
  undo: z.object({ action: PreferenceAction, target_type: PreferenceTargetType, target_id: Uuid }).nullable(),
});
export type PreferenceResponse = z.infer<typeof PreferenceResponse>;

/** GET /v1/saved — cursor-paginated inspirations/items. */
export const SavedQuery = LimitQuery.extend({
  cursor: Cursor.optional(),
  /** 'unfiled' = saved items with no memberships (the "Saved for later" view). */
  filter: z.enum(['all', 'unfiled']).default('all'),
  kind: ItemKind.optional(),
});
export type SavedQuery = z.infer<typeof SavedQuery>;

export const SavedEntry = z.object({
  saved_item_id: Uuid,
  saved_at: Timestamp,
  item: DiscoveryCard,
  /** Memberships visible to the principal (agents: granted collections only). */
  membership_ids: z.array(Uuid),
  collection_ids: z.array(Uuid),
});
export type SavedEntry = z.infer<typeof SavedEntry>;

export const SavedListResponse = z.object({
  items: z.array(SavedEntry),
  next_cursor: Cursor.nullable(),
});
export type SavedListResponse = z.infer<typeof SavedListResponse>;
