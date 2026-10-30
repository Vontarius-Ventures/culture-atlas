-- 410_feed_snapshot_pinned_recommendations.sql
--
-- Feed snapshot pinning (feature feed-proof-snapshot-integration;
-- VAL-FEED-003/VAL-FEED-004, PR 8 §Feed).
--
-- Every feed snapshot position stores the exact recommendation its card was
-- selected from at snapshot creation, so the "Why this" served for that
-- position can never silently swap another run's reason while the snapshot is
-- being served: a newer run republishing the same item does not replace the
-- pinned recommendation, and read-time revalidation of the PINNED proof (not
-- a fresh "latest reason" lookup) decides whether the position's reason still
-- holds.
--
-- The array is parallel to ordered_item_ids by construction:
--   * NULL for legacy rows created before pinning existed (their reads fall
--     back to the newest currently serving owner-context recommendation);
--   * for new rows, one entry per position — the pinned recommendation id, or
--     NULL for positions with no recommendation context (reviewed samples,
--     saved-only items).
-- The CHECK keeps the arrays parallel so a position's pin can never drift.

ALTER TABLE feed_snapshots ADD COLUMN pinned_recommendation_ids uuid[];

ALTER TABLE feed_snapshots
  ADD CONSTRAINT feed_snapshots_pinned_parallel
  CHECK (pinned_recommendation_ids IS NULL
         OR cardinality(pinned_recommendation_ids) = cardinality(ordered_item_ids));

-- Read-time support-withdrawal detection for graph proofs (the same
-- feature). Migration 280 made the proof's private support owner-bound typed
-- rows (recommendation_graph_proof_support_edges) — but their FK cascades on
-- edge deletion, so after the owner's edge is removed the proof row can no
-- longer tell "rested on deleted support" from "never rested on any": the
-- withdrawal would silently heal. pinned_support_edge_ids is the durable
-- PUBLICATION RECORD of what the proof rested on at insert time. It is not
-- an active dependency: the owner-bound mirror relation stays the enforced
-- set, and read-time serving requires every recorded edge to still be
-- present there in a live state — so the record can only make serving
-- STRICTER (a tampered entry withdraws the card, never admits anything).
-- NULL for proofs predating the column: those fall back to the mirror rows.
ALTER TABLE recommendation_graph_proofs ADD COLUMN pinned_support_edge_ids uuid[];
