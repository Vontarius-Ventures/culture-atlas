-- culture atlas: library/plans stream (030-039).
-- 1. Email + password credentials for the demo sign-in (scrypt hashes only).
-- 2. Feed snapshots remember which categories the pool had, so pages read
--    from a cursor never rebuild the pool.
-- 3. Plan versions record each input's contribution.

CREATE TABLE account_credentials (
  account_id       uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Lower-cased, trimmed email used for lookup.
  email            text NOT NULL UNIQUE CHECK (char_length(email) BETWEEN 3 AND 254),
  -- "scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>"
  password_hash    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE feed_snapshots
  ADD COLUMN available_categories text[] NOT NULL DEFAULT ARRAY[]::text[];

-- 3. Per-input contribution of a plan version ({item_id, contribution, note}),
--    so weak inputs can be disclosed in the optional rationale.
ALTER TABLE plan_versions
  ADD COLUMN input_contributions jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX feed_snapshots_expires_idx ON feed_snapshots (expires_at);
CREATE INDEX plan_versions_plan_idx ON plan_versions (plan_id, version DESC);
CREATE INDEX discovery_jobs_job_idx ON discovery_jobs (job_id);
CREATE INDEX item_exclusions_owner_account_idx ON item_exclusions (owner_account_id);
CREATE INDEX item_exclusions_owner_session_idx ON item_exclusions (owner_session_id);
