-- One ACTIVE graph expansion per account, at the storage level
-- (DISC-SCR-012, VAL-DISC-003).
--
-- The expansion dispatch is one ordered per-account operation (eligibility,
-- active-job check, dedupe-key selection, enqueue, dispatch stamp under the
-- account authority lock), so two queued/running expansions for one account
-- cannot be produced by dispatch alone. This partial unique index is the
-- storage fence for every OTHER path and every residual gap: a second active
-- expand_interest_graph job for the same account cannot be inserted at all.
--
-- - Only graph expansion is bounded: the legacy `interest_expand` wave jobs
--   keep their existing semantics (PR 8 keeps legacy paid expansion intact).
-- - Failed and cancelled jobs leave the index set, so a terminal failure
--   frees the account for the next window exactly as before.
-- - Worker reclaim updates the SAME job row (never inserts), so lease loss
--   and redelivery cannot trip the fence.
-- - enqueueJob's dedupe arbiter (jobs_dedupe_idx) is unaffected: a violation
--   of THIS index surfaces as a loud unique error the dispatcher treats as a
--   lost race (skip without consuming due-ness), never as silent duplication.

CREATE UNIQUE INDEX jobs_one_active_graph_expansion_idx
  ON jobs (owner_account_id)
  WHERE type = 'expand_interest_graph' AND state IN ('queued', 'running');
