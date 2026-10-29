-- 380_scoped_discovery_authority_marker.sql
--
-- Durable scoped-operation marker on discovery_jobs
-- (feature scoped-discover-revocation-publication; VAL-DISC-007/009).
--
-- The approved grant-scoped Discover more operation (the existing
-- selected-collection POST /v1/items/{id}/discoveries / MCP discover_related,
-- migration 360) pins one immutable discovery_grant_authorities row per
-- enqueue. That row CASCADES away when the owner deletes the origin
-- collection, and discovery_jobs.origin_collection_id is SET NULL by the same
-- deletion — so after a resource change NOTHING in the job's own row could
-- distinguish "scoped operation whose authority was lost" from a legacy
-- whole-library enqueue: with graph discovery enabled, a redelivered scoped
-- job silently fell back to the legacy provider path and published stale
-- owner-visible results after the revoking resource change.
--
-- This marker is written in the enqueue transaction (exactly when the
-- authority row is) and survives collection deletion, so the discover_related
-- handler can require the pinned authority for scoped jobs whenever the graph
-- branch is enabled: a lost authority fails the job closed instead of
-- adopting the provider path. Legacy jobs (whole-library or anonymous
-- enqueues, no collection context) keep marker=false and their unchanged
-- behavior for every flag state.

ALTER TABLE discovery_jobs
  ADD COLUMN scoped_authority_required boolean NOT NULL DEFAULT false;

-- Backfill: origin_collection_id is only ever set for the account-owner
-- scoped operation (anonymous sessions cannot pass collection checks, and
-- every account-owner selected-collection enqueue records an authority row),
-- so the current population with collection context is exactly the scoped
-- population. Jobs whose collection was already deleted before this migration
-- keep marker=false and keep their historical legacy behavior.
UPDATE discovery_jobs
   SET scoped_authority_required = true
 WHERE origin_collection_id IS NOT NULL;
