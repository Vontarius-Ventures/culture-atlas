-- Foundation scrutiny repair (feature foundation-owner-bound-dependencies):
-- two direct-database isolation gaps in the graph schema.
--
-- 1. graph_private_links.capture_reference_id was only enforced through the
--    nullable composite FK (capture_reference_id, analysis_id); with a NULL
--    analysis_id MATCH SIMPLE skipped the check entirely, so a private link
--    could name any capture reference, foreign or nonexistent. Reference-
--    bearing links now must carry their analysis, which makes the existing
--    owner-bound capture/analysis ancestry foreign keys actually apply.
--
-- 2. The private dependency UUID arrays graph_frontier.support_root_ids and
--    recommendation_graph_proofs.support_edge_ids had no owner enforcement:
--    an owner-valid frontier or proof could hold another account's private
--    support ids even through direct SQL. Those dependencies are now
--    owner-bound typed relations: every row is composite-bound to its
--    container AND to the account-owned private edge, so an owner-valid
--    container alone is not enough. The pinned PUBLIC dependency arrays
--    (assertions/evidence) stay exactly as they were, and no existing owner
--    constraint is weakened.

-- 1) A private link that names a capture reference must name the analysis it
--    was resolved from; the ancestry foreign keys of migration 230 then bind
--    the reference to the link's own capture and account.
ALTER TABLE graph_private_links
  ADD CONSTRAINT graph_private_links_reference_requires_analysis_check
  CHECK (capture_reference_id IS NULL OR analysis_id IS NOT NULL);

-- 2a) Frontier support roots: one row per private explicit-root edge a
--     candidate was reached from, bound to the frontier row and its account
--     and to the root edge's owner.
CREATE TABLE graph_frontier_support_roots (
  frontier_id      uuid NOT NULL,
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  root_id          uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (frontier_id, root_id),
  FOREIGN KEY (frontier_id, owner_account_id)
    REFERENCES graph_frontier(id, owner_account_id) ON DELETE CASCADE,
  FOREIGN KEY (root_id, owner_account_id)
    REFERENCES personal_interest_edges(id, owner_account_id) ON DELETE CASCADE
);
CREATE INDEX graph_frontier_support_roots_root_idx
  ON graph_frontier_support_roots (owner_account_id, root_id);

-- 2b) Proof support edges: the same owner binding for the private support
--     behind a recommendation proof.
CREATE TABLE recommendation_graph_proof_support_edges (
  proof_id         uuid NOT NULL,
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  support_edge_id  uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proof_id, support_edge_id),
  FOREIGN KEY (proof_id, owner_account_id)
    REFERENCES recommendation_graph_proofs(id, owner_account_id) ON DELETE CASCADE,
  FOREIGN KEY (support_edge_id, owner_account_id)
    REFERENCES personal_interest_edges(id, owner_account_id) ON DELETE CASCADE
);
CREATE INDEX recommendation_graph_proof_support_edges_edge_idx
  ON recommendation_graph_proof_support_edges (owner_account_id, support_edge_id);

-- Carry existing array contents over. Only dependencies that really belong
-- to the containing row's account can be represented; foreign or dangling
-- entries were contract violations and are dropped, never bound.
INSERT INTO graph_frontier_support_roots (frontier_id, owner_account_id, root_id)
SELECT f.id, f.owner_account_id, r.root_id
  FROM graph_frontier f
 CROSS JOIN LATERAL unnest(f.support_root_ids) AS r(root_id)
  JOIN personal_interest_edges e
    ON e.id = r.root_id AND e.owner_account_id = f.owner_account_id
ON CONFLICT DO NOTHING;

INSERT INTO recommendation_graph_proof_support_edges (proof_id, owner_account_id, support_edge_id)
SELECT p.id, p.owner_account_id, s.support_edge_id
  FROM recommendation_graph_proofs p
 CROSS JOIN LATERAL unnest(p.support_edge_ids) AS s(support_edge_id)
  JOIN personal_interest_edges e
    ON e.id = s.support_edge_id AND e.owner_account_id = p.owner_account_id
ON CONFLICT DO NOTHING;

-- The unvalidated private arrays are gone: direct SQL has no remaining path
-- that stores another account's private dependency ids.
ALTER TABLE graph_frontier DROP COLUMN support_root_ids;
ALTER TABLE recommendation_graph_proofs DROP COLUMN support_edge_ids;
