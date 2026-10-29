-- Durable grant authority for the approved grant-scoped Discover more branch
-- (approved 2026-10-29).
--
-- The existing selected-collection REST POST /v1/items/{id}/discoveries /
-- MCP discover_related operation is the sole supported grant-scoped graph
-- producer. One immutable authority row is written in the enqueue transaction
-- of every selected-collection Discover more and pins exactly what authorized
-- that enqueue:
--   * the account owner,
--   * the initiating agent connection and its enqueue-time authorization
--     version (NULL when the owner initiated; recorded together or not at all,
--     like the media/capture grant fences of migration 055),
--   * the granted_at of the (connection, collection) grant at enqueue — the
--     per-collection grant epoch, because the v1 owner grant-replacement path
--     (PATCH /v1/agent-connections/{id}) can remove and re-grant a collection
--     WITHOUT advancing authorization_version,
--   * the granted collection, the origin item, and both job identities
--     (the discovery job and the queue job), each composite-bound to the owner
--     so no row can adopt another owner or resource.
--
-- Immutability is enforced by the database, not by convention: the trigger
-- below rejects EVERY in-place rewrite, so retries, redeliveries, dedupe and
-- even direct SQL cannot adopt a later grant epoch, owner or resource — a
-- fresh epoch is always a fresh enqueue with a fresh authority row. DELETE
-- stays allowed for the enqueue transaction's own rollback cleanup (a dedupe
-- race loser) and for the ON DELETE CASCADE paths (account, connection,
-- collection, discovery job, queue job, origin item), which fail the whole
-- authority closed together with the resource that lost it.
--
-- Legacy whole-library Discover more (no collection) enqueues NO authority
-- row, and account-owned graph work (graph_runs, frontier, personal edges)
-- remains unrelated to this table: grant revoke/narrow/regrant transitions
-- never write here and never touch account-owned graph state.

-- Owner-scoped unique keys reused by the composite foreign keys below. Both
-- are guaranteed-addable: `id` is already the primary key of each table, so
-- (id, owner_account_id) is unique per existing row.
ALTER TABLE discovery_jobs ADD CONSTRAINT discovery_jobs_id_owner_key UNIQUE (id, owner_account_id);
ALTER TABLE jobs         ADD CONSTRAINT jobs_id_owner_key UNIQUE (id, owner_account_id);

CREATE TABLE discovery_grant_authorities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The selected-collection Discover more context this authority authorizes.
  discovery_job_id      uuid NOT NULL,
  job_id                uuid NOT NULL,
  -- Initiating agent connection and its enqueue-time authorization version.
  agent_connection_id   uuid,
  authorization_version integer CHECK (authorization_version IS NULL OR authorization_version >= 1),
  -- granted_at of the (connection, collection) grant at enqueue; NULL for
  -- owner-initiated authorities and for whole-library connections, which have
  -- no per-collection grant row.
  collection_granted_at timestamptz,
  origin_collection_id  uuid NOT NULL,
  origin_item_id        uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_account_id),
  UNIQUE (discovery_job_id),
  FOREIGN KEY (discovery_job_id, owner_account_id)
    REFERENCES discovery_jobs(id, owner_account_id) ON DELETE CASCADE,
  FOREIGN KEY (job_id, owner_account_id)
    REFERENCES jobs(id, owner_account_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_account_id, agent_connection_id)
    REFERENCES agent_connections(owner_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_account_id, origin_collection_id)
    REFERENCES collections(owner_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (origin_item_id, owner_account_id)
    REFERENCES discovery_items(id, owner_account_id) ON DELETE CASCADE,
  -- A recorded authorization version exists exactly when a connection initiated.
  CHECK ((agent_connection_id IS NULL) = (authorization_version IS NULL)),
  -- A per-collection grant timestamp requires an initiating connection.
  CHECK (agent_connection_id IS NOT NULL OR collection_granted_at IS NULL)
);

CREATE INDEX discovery_grant_authorities_owner_idx
  ON discovery_grant_authorities (owner_account_id, created_at DESC);

CREATE OR REPLACE FUNCTION discovery_grant_authority_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'discovery grant authority is immutable: retry, redelivery and dedupe cannot adopt a new grant epoch, owner or resource'
    USING HINT = 'A later grant epoch, owner or resource is a fresh enqueue with a fresh authority row, never an in-place rewrite.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER discovery_grant_authority_no_rewrite
  BEFORE UPDATE ON discovery_grant_authorities
  FOR EACH ROW EXECUTE FUNCTION discovery_grant_authority_immutable();
