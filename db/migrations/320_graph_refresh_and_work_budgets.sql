-- Interest graph, PR 8 discovery slice: the closed-app refresh bookkeeping and
-- the durable budgets of one LOGICAL graph work item (VAL-DISC-003/005/006).
--
-- graph_refresh_state is one account's discovery refresh state:
--  - discovery_paused_at: the persistent pause. It stops expansion and
--    relation-research DISPATCH and PUBLICATION only — never the authoritative
--    projection, retraction/invalidation or deletion cleanup.
--  - expansion_due_since: the durable due marker a successful projection pass
--    stamps (fresh committed support awaits one bounded refresh); a completed
--    expansion consumes it. A marker that survives a dispatcher outage or a
--    restart keeps the account due without any new user mutation or feed read.
--  - last_expansion_at: the dispatch stamp. The periodic refresh hands an
--    account to the queue at most once per 15 minutes; a fresh due marker
--    (newer than the stamp) refreshes sooner. One active expansion per account
--    is enforced by the queue dedupe, so concurrent reads, mutation bursts and
--    sweeper sweeps coalesce.
--
-- graph_work_budgets is the durable budget of one LOGICAL work item
-- (expansion or relation research): the Qloo HTTP attempt allowance (at most
-- four per logical expansion, including retries) and the logical deadline
-- (45 seconds) anchor at the item's FIRST attempt and are never reset by
-- lease loss, worker restart or redelivery — every later job attempt reserves
-- against the very same row. Reservations are single atomic UPDATEs, so
-- concurrent sessions can never exceed the cap. Paid research additionally
-- flows through the existing model-gateway spend ledger (durable account and
-- global daily limits); this table never replaces it.

CREATE TABLE graph_refresh_state (
  owner_account_id     uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Persistent discovery pause; NULL = refreshing is allowed.
  discovery_paused_at  timestamptz,
  -- Fresh projected support awaiting its bounded refresh (set by the
  -- projector's successful pass; consumed by a completed expansion).
  expansion_due_since  timestamptz,
  -- Dispatch stamp: coalesces the periodic refresh to one per 15 minutes.
  last_expansion_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX graph_refresh_state_due_idx
  ON graph_refresh_state (COALESCE(expansion_due_since, last_expansion_at));

CREATE TABLE graph_work_budgets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  work_kind           text NOT NULL CHECK (work_kind IN ('expansion','research')),
  -- Logical identity of the work item: the queue dedupe key of the expansion
  -- dispatch window or the research pair. Redeliveries reuse the same row.
  work_key            text NOT NULL CHECK (char_length(work_key) BETWEEN 1 AND 300),
  qloo_attempts_used  integer NOT NULL DEFAULT 0 CHECK (qloo_attempts_used >= 0),
  qloo_attempts_max   integer NOT NULL DEFAULT 4 CHECK (qloo_attempts_max >= 0),
  -- The logical deadline anchor: set once at first sight, never re-anchored.
  deadline_started_at timestamptz NOT NULL,
  deadline_ms         integer NOT NULL DEFAULT 45000 CHECK (deadline_ms > 0),
  state               text NOT NULL DEFAULT 'active'
                      CHECK (state IN ('active','stopped','complete')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_account_id, work_key)
);
