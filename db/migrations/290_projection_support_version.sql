-- Interest graph, PR 8 foundation upgrade repair: bounded versioned
-- completeness for applied personal graph projections.
--
-- Projections built before migration 270 (shared-save graph support) can sit
-- 'ready' at the CURRENT taste revision with every outbox event done while
-- silently omitting explicit saves of ownerless shared rows: the pre-270
-- projector filtered them out. Equal revisions and a satisfied outbox mean no
-- mutation intent will ever re-arm such an account, so the backfill's due
-- predicate (no state row, or behind revisions, or unsatisfied events) skips
-- it forever.
--
-- The state row therefore records WHICH projection semantics produced the
-- applied projection. Every existing row becomes version 1 (legacy: may omit
-- shared-save roots); the projector stamps the current
-- PROJECTION_SUPPORT_VERSION on every successful pass, and due computations
-- (backfill, dispatch catch-up, reconciled reads) treat a behind-version row
-- as due for a current-state rebuild. The repair is a normal deterministic
-- rebuild of current authoritative support — no fabricated event history, no
-- blanket user-data reset. Bumping the code constant is the bounded mechanism
-- for any future completeness change: each bump re-marks every applied
-- projection due exactly once.

ALTER TABLE personal_graph_state
  ADD COLUMN support_version integer NOT NULL DEFAULT 1 CHECK (support_version >= 1);
