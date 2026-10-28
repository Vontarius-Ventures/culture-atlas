-- Interest graph, PR 8 package B: projector state lineage and the
-- checkpointed current-state backfill. Additive only.
--
-- personal_graph_state gains the graph run that produced the applied
-- projection (lineage: which run, at which input revisions, from which
-- source), composite-bound to the same account so it can never point at
-- another owner's run.
ALTER TABLE personal_graph_state
  ADD COLUMN last_graph_run_id uuid,
  ADD CONSTRAINT personal_graph_state_last_run_fk
    FOREIGN KEY (last_graph_run_id, owner_account_id)
    REFERENCES graph_runs(id, owner_account_id);

-- Deployment-singleton backfill checkpoint: a resumable cursor over accounts
-- still due for a current-state projection, plus honest progress counts. The
-- cursor is a marker, not a relationship: a referenced account may be deleted
-- freely, so there is deliberately no foreign key. The checkpoint advances
-- only after an account's projection committed; replay re-projects nothing
-- because the projection itself is a deterministic rebuild of current state.
CREATE TABLE graph_backfill_state (
  id                    integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state                 text NOT NULL DEFAULT 'running' CHECK (state IN ('running','complete')),
  started_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  last_owner_account_id uuid,
  accounts_projected    integer NOT NULL DEFAULT 0 CHECK (accounts_projected >= 0),
  passes                integer NOT NULL DEFAULT 0 CHECK (passes >= 0)
);

-- Per-account unsatisfied-intent lookups (dispatch, projector tail and the
-- lagging-read reconciliation) without scanning the done backlog.
CREATE INDEX graph_outbox_account_idx
  ON graph_outbox (owner_account_id) WHERE dispatch_state IN ('pending','dispatched');
