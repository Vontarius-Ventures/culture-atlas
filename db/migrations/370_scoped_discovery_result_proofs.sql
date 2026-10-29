-- Pinned per-result proofs for the approved grant-scoped Discover more graph
-- branch (approved 2026-10-29; scoped-discover-graph-results).
--
-- The scoped branch publishes its admitted results as recommendations of the
-- discovery job that the enqueue's immutable authority row pins (migration
-- 360). Each published result's rendered reason rests on walked shared
-- assertions and reviewed evidence, so the exact (id, revision) pins of that
-- path are recorded here — the same discipline the account-owned graph keeps
-- in recommendation_graph_proofs, but keyed to the scoped discovery parent
-- instead of a graph run:
--   * (discovery_job_id, owner_account_id) binds every proof to the pinned
--     owner's discovery job (the scoped parent);
--   * (recommendation_id, discovery_job_id) binds every proof to a
--     recommendation of THAT discovery job — recommendations are
--     one-parent (migration 240), so the pair can never cross jobs, and a
--     deleted scoped result takes its proof with it;
--   * root/mid/candidate node ids pin the walked shared identities.
--
-- Evidence/source retraction and expiry revalidate these rows exactly like
-- the account-owned proofs: withdrawing every pinned witness (or a revision
-- drift past a recorded pin) marks the scoped proof invalid, so a published
-- scoped reason can never silently survive the evidence it rested on. The
-- account-owned graph tables (graph_runs, graph_frontier,
-- personal_interest_*) stay untouched by the scoped branch: this table is
-- its only durable graph-side record, and it is not a frontier, feed or
-- interest — it never feeds account-wide discovery state.

-- Guaranteed-addable owner-scoped key: `id` is already the primary key of
-- recommendations, so (id, discovery_job_id) is unique per existing row.
ALTER TABLE recommendations ADD CONSTRAINT recommendations_id_discovery_job_key
  UNIQUE (id, discovery_job_id);

CREATE TABLE scoped_discovery_result_proofs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id        uuid NOT NULL,
  discovery_job_id        uuid NOT NULL,
  recommendation_id       uuid NOT NULL,
  -- Pinned shared assertion identities and their revisions at publication.
  assertion_ids           uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  assertion_revisions     integer[] NOT NULL DEFAULT ARRAY[]::int[],
  -- Pinned reviewed evidence identities and their revisions at publication.
  evidence_ids            uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  evidence_revisions      integer[] NOT NULL DEFAULT ARRAY[]::int[],
  -- The approved template that rendered the reason, and its grammar version.
  reason_template         text NOT NULL,
  reason_template_version text NOT NULL,
  -- The walked shared identities: the origin's root, the shared midpoint and
  -- the admitted candidate.
  root_node_id            uuid NOT NULL REFERENCES graph_nodes(id),
  mid_node_id             uuid NOT NULL REFERENCES graph_nodes(id),
  candidate_node_id       uuid NOT NULL REFERENCES graph_nodes(id),
  -- Retraction/withdrawal invalidation record (revalidation may repair it).
  validity_state          text NOT NULL DEFAULT 'valid' CHECK (validity_state IN ('valid', 'invalid')),
  invalidated_at          timestamptz,
  invalidation_reason     text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_account_id),
  CHECK (cardinality(assertion_ids) = cardinality(assertion_revisions)),
  CHECK (cardinality(evidence_ids) = cardinality(evidence_revisions)),
  FOREIGN KEY (discovery_job_id, owner_account_id)
    REFERENCES discovery_jobs(id, owner_account_id) ON DELETE CASCADE,
  FOREIGN KEY (recommendation_id, discovery_job_id)
    REFERENCES recommendations(id, discovery_job_id) ON DELETE CASCADE
);

-- The scoped parent's proof list, newest runs last.
CREATE INDEX scoped_discovery_result_proofs_job_idx
  ON scoped_discovery_result_proofs (discovery_job_id, created_at);
-- Retraction scans: dependent rows whose pinned path touches a withdrawn
-- assertion or evidence id (same && probes as the account-owned proofs).
CREATE INDEX scoped_discovery_result_proofs_assertions_idx
  ON scoped_discovery_result_proofs USING gin (assertion_ids);
CREATE INDEX scoped_discovery_result_proofs_evidence_idx
  ON scoped_discovery_result_proofs USING gin (evidence_ids);
