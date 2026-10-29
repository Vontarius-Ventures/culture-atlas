-- 400_scoped_discovery_work_deadline.sql
--
-- The anchored durable work deadline of one scoped Discover more job
-- (feature scoped-discover-ordered-window-and-expiry; repairs DISC-SCR-035).
--
-- The scoped graph pass bounded HOW MUCH it traversed
-- (SCOPED_DISCOVERY_BOUNDS) but not HOW LONG it runs: it set no SQL
-- statement/lock timeout, so a held discovery_jobs, connection, collection,
-- assertion or evidence row could block the worker indefinitely — the
-- Worker's per-attempt timer only aborts its controller and cannot interrupt
-- in-flight pg queries — and there was no liveness/deadline check after the
-- tail DELETE/INSERT/proof writes, so a wait there could resume and commit
-- after expiry. The queue job's budget carries only a per-attempt deadline
-- that every retry resets, which is not the architectural 45-second logical
-- window (the same gap expansion/research closed with graph_work_budgets).
--
-- The anchor therefore lives on the immutable authority row itself: the
-- enqueue transaction writes `work_deadline_at = now + 45 seconds` once, and
-- the migration-360 immutability trigger rejects every later rewrite, so
-- retry, redelivery and dedupe inherit the SAME window — a delayed first
-- claim never gets a fresh 45 seconds, and a redelivered expired window
-- fails honestly instead of publishing. The graph pass bounds each statement
-- and lock wait to the window's CURRENT remaining time (refreshed at every
-- stage boundary), and the final publication boundary re-reads the window
-- with the database's own clock before the commit (see
-- packages/domain/src/interest-graph/scoped-discovery-graph.ts).
--
-- The legacy provider path is deliberately untouched: graph-off scoped jobs
-- keep their existing per-attempt behavior byte-identical, and this column is
-- inert metadata until the graph branch reads it.

-- One structural backfill, exactly like migration 390's column transition:
-- existing authorities get the window they were enqueued under
-- (created_at + the architectural 45 seconds); for every long-enqueued row
-- that window has already ended, which is the honest anchor — the
-- immutability trigger is suspended only for this transition and still
-- rejects every later in-place rewrite (a later window is a fresh enqueue).
ALTER TABLE discovery_grant_authorities ADD COLUMN work_deadline_at timestamptz;

ALTER TABLE discovery_grant_authorities DISABLE TRIGGER discovery_grant_authority_no_rewrite;
UPDATE discovery_grant_authorities
   SET work_deadline_at = created_at + interval '45 seconds'
 WHERE work_deadline_at IS NULL;
ALTER TABLE discovery_grant_authorities ENABLE TRIGGER discovery_grant_authority_no_rewrite;

ALTER TABLE discovery_grant_authorities ALTER COLUMN work_deadline_at SET NOT NULL;
