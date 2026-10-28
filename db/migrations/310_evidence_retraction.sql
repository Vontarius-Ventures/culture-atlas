-- Interest graph, PR 8 discovery slice: source retraction and expiry
-- invalidation (VAL-EVID-004).
--
-- Evidence and source revisions are append-only in CONTENT (migration 300
-- guards rewrites of locator/excerpt/structured value/rights); retraction is a
-- STATUS change, deliberately writable on its own columns. A retracted source
-- revision takes every evidence row read from it with it, and retraction of
-- sole evidence immediately invalidates the proofs that pinned it — the
-- authoritative invalidation happens synchronously in the retraction
-- transaction, before any asynchronous cleanup, while independently sourced
-- valid evidence survives.
--
-- Expiry needs no stored flip at all: evidence rows already carry expires_at
-- and their revisions carry rights_expires_at, and every justification /
-- pinned-proof revalidation compares those against the CURRENT time, so an
-- expired right blocks its dependent reasons at read time even before any
-- sweep touches the stored rows.
--
-- The GIN indexes below exist for the invalidation scans: proofs pin evidence
-- and assertion ids in uuid[] arrays, and frontier candidates pin the approved
-- path (template + assertion/evidence versions) in path_versions jsonb.

ALTER TABLE graph_evidence
  ADD COLUMN validity_state text NOT NULL DEFAULT 'valid'
    CHECK (validity_state IN ('valid', 'retracted')),
  ADD COLUMN invalidated_at timestamptz,
  ADD COLUMN invalidation_reason text CHECK (invalidation_reason IS NULL OR char_length(invalidation_reason) BETWEEN 1 AND 1000);
ALTER TABLE graph_evidence
  ADD CONSTRAINT graph_evidence_retraction_pair_check
    CHECK ((validity_state = 'retracted') = (invalidated_at IS NOT NULL)),
  ADD CONSTRAINT graph_evidence_retraction_reason_check
    CHECK (validity_state = 'valid' OR invalidation_reason IS NOT NULL);
CREATE INDEX graph_evidence_retracted_idx ON graph_evidence (invalidated_at) WHERE validity_state = 'retracted';

ALTER TABLE graph_source_revisions
  ADD COLUMN validity_state text NOT NULL DEFAULT 'valid'
    CHECK (validity_state IN ('valid', 'retracted')),
  ADD COLUMN invalidated_at timestamptz,
  ADD COLUMN invalidation_reason text CHECK (invalidation_reason IS NULL OR char_length(invalidation_reason) BETWEEN 1 AND 1000);
ALTER TABLE graph_source_revisions
  ADD CONSTRAINT graph_source_revisions_retraction_pair_check
    CHECK ((validity_state = 'retracted') = (invalidated_at IS NOT NULL)),
  ADD CONSTRAINT graph_source_revisions_retraction_reason_check
    CHECK (validity_state = 'valid' OR invalidation_reason IS NOT NULL);
CREATE INDEX graph_source_revisions_retracted_idx ON graph_source_revisions (invalidated_at) WHERE validity_state = 'retracted';

CREATE INDEX recommendation_graph_proofs_evidence_gin_idx
  ON recommendation_graph_proofs USING gin (evidence_ids);
CREATE INDEX recommendation_graph_proofs_assertions_gin_idx
  ON recommendation_graph_proofs USING gin (assertion_ids);
CREATE INDEX graph_frontier_path_gin_idx
  ON graph_frontier USING gin (path_versions jsonb_path_ops);
