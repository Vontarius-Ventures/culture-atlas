-- Spec amendment 2.2, ONB-04 ("The seed job makes at most 6 Qloo requests"):
-- the cap is per job, across all of its retry attempts. Each Qloo request a
-- taste_seed job makes reserves one unit here first (atomic UPDATE with the
-- cap in its WHERE clause), so a retry never spends more than what the earlier
-- attempts left, and a crash mid-attempt never forgets a request already sent.
ALTER TABLE taste_seed_runs
  ADD COLUMN qloo_requests_used integer NOT NULL DEFAULT 0 CHECK (qloo_requests_used >= 0);
