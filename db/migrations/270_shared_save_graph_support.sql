-- Interest graph, PR 8 package B correction: explicitly saved shared sample
-- rows are confirmed taste and must project as private support. The owner FK
-- fence on edges (discovery_item_id, owner_account_id) correctly rejects a
-- private edge onto an ownerless shared catalog row; silently dropping the
-- save from the projection was the wrong fix. Edges gain a third, fully
-- private target form instead: the account's OWN saved_items row. A save of a
-- shared row becomes account-owned graph support without forging an item
-- owner and without weakening any owner foreign key, and two accounts saving
-- the same shared row keep two independent private edges.

ALTER TABLE personal_interest_edges ADD COLUMN saved_item_id uuid;

-- The saved-item target is composite-bound to the same account as the edge,
-- exactly like every other private target. Unsave (the saved_items row is
-- deleted) withdraws the private support immediately via the cascade.
ALTER TABLE personal_interest_edges
  ADD CONSTRAINT personal_interest_edges_saved_item_owner_fkey
    FOREIGN KEY (saved_item_id, owner_account_id)
    REFERENCES saved_items(id, owner_account_id) ON DELETE CASCADE;

-- Exactly one target form: a shared identity, one of the account's own
-- discovery items, or the account's own save of a shared/ownerless row.
ALTER TABLE personal_interest_edges DROP CONSTRAINT personal_interest_edges_check;
ALTER TABLE personal_interest_edges
  ADD CONSTRAINT personal_interest_edges_one_target_check
  CHECK (num_nonnulls(node_id, discovery_item_id, saved_item_id) = 1);

-- One edge per account per own save (the upsert conflict target).
CREATE UNIQUE INDEX personal_interest_edges_saved_item_idx
  ON personal_interest_edges (owner_account_id, saved_item_id) WHERE saved_item_id IS NOT NULL;
