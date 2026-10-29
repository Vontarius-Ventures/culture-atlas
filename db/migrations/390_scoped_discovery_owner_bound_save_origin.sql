-- 390_scoped_discovery_owner_bound_save_origin.sql
--
-- Owner-bound save origin for the scoped Discover more authority
-- (feature scoped-discover-origin-and-epoch-repair; repairs DISC-SCR-030).
--
-- Migration 360 bound the scoped authority's origin to the origin item's
-- OWNERSHIP: (origin_item_id, owner_account_id) -> discovery_items(id,
-- owner_account_id). But the legitimate selected-collection origin also
-- includes reviewed PUBLIC SAMPLES — shared ownerless discovery_items rows
-- (is_sample, packages/domain/src/feed/samples.ts) that the owner saved into
-- an owned collection (services/collections.ts). Such an enqueue — the
-- existing REST/MCP operation, graph-off and graph-on alike — passed every
-- visibility, membership and anchor check and then failed that FK, rolling the
-- whole enqueue back with an internal error.
--
-- The authority is now bound through the OWNER'S SAVE ROW instead:
--   * origin_saved_item_id pins the owner's saved_items row that grounds the
--     origin's membership in the exact granted collection. The composite FK
--     (origin_saved_item_id, owner_account_id) -> saved_items(id,
--     owner_account_id) keeps the pinned save the owner's own row, and its
--     ON DELETE CASCADE replaces the old origin-item cascade: unsave (which
--     deletes the save and its memberships) or origin deletion (which
--     cascades the save) closes the authority with the resource that lost
--     it, exactly like before.
--   * (origin_saved_item_id, origin_item_id) -> saved_items(id,
--     discovery_item_id) ties the pinned origin item to exactly the pinned
--     save's own item, so no row can pair one owner's save with a different
--     item — an owned item, a shared public sample, never another account's
--     private item.
-- The enqueue transaction resolves and validates that save row itself:
-- exact collection membership, owner-bound save, and an eligible origin item
-- (owned by the account, or a validated ownerless public sample). The shared
-- sample's ownership is never mutated and no implicit save is ever created.
--
-- The old ownership FK is dropped: private authority no longer requires the
-- shared origin to be an owned discovery item. The
-- discovery_items_id_owner_key unique constraint (migration 230) stays:
-- the owner-bound graph dependencies still reference it.

-- Guaranteed-addable: `id` is saved_items' primary key, so
-- (id, discovery_item_id) is unique per existing row.
ALTER TABLE saved_items ADD CONSTRAINT saved_items_id_discovery_item_key UNIQUE (id, discovery_item_id);

ALTER TABLE discovery_grant_authorities ADD COLUMN origin_saved_item_id uuid;

-- Backfill each existing authority with the save row that grounds its
-- origin's CURRENT membership in the pinned collection. The immutability
-- trigger is suspended for this one structural backfill only (a NOT NULL
-- column transition, never a grant-epoch rewrite); it is re-enabled right
-- after and still rejects every later in-place rewrite.
ALTER TABLE discovery_grant_authorities DISABLE TRIGGER discovery_grant_authority_no_rewrite;
UPDATE discovery_grant_authorities a
   SET origin_saved_item_id = si.id
     FROM collection_items ci, saved_items si
    WHERE si.id = ci.saved_item_id
      AND ci.collection_id = a.origin_collection_id
      AND ci.owner_account_id = a.owner_account_id
      AND si.discovery_item_id = a.origin_item_id;
ALTER TABLE discovery_grant_authorities ENABLE TRIGGER discovery_grant_authority_no_rewrite;

-- An authority whose origin membership has no grounding save row is dead —
-- its publication fence would reject it anyway — and DELETE is the
-- authority's own closed path (rollback cleanup and cascades).
DELETE FROM discovery_grant_authorities WHERE origin_saved_item_id IS NULL;

ALTER TABLE discovery_grant_authorities
  ALTER COLUMN origin_saved_item_id SET NOT NULL,
  ADD CONSTRAINT discovery_grant_authorities_origin_saved_item_owner_fkey
    FOREIGN KEY (origin_saved_item_id, owner_account_id)
      REFERENCES saved_items(id, owner_account_id) ON DELETE CASCADE,
  ADD CONSTRAINT discovery_grant_authorities_origin_item_of_save_fkey
    FOREIGN KEY (origin_saved_item_id, origin_item_id)
      REFERENCES saved_items(id, discovery_item_id),
  DROP CONSTRAINT discovery_grant_authorities_origin_item_id_owner_account_i_fkey;
