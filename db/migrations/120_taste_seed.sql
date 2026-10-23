-- Spec amendment 2.2, package B: the taste seed job (range 120-129).
--  * taste_seed_runs: one row per taste_seed job (reused across its retry
--    attempts). Account data: deleted with the account.
--  * taste_seed_categories: per-category progress that GET /v1/onboarding/seed
--    reports (pending | ready | empty | unavailable). card_count counts real
--    Qloo-backed recommendations only.
--  * provider_queries and recommendations gain a fourth parent,
--    taste_seed_run_id, so every seeded card cites the Qloo query it came from.

CREATE TABLE taste_seed_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id           uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  taste_revision   integer NOT NULL CHECK (taste_revision >= 0),
  catalog_version  text CHECK (catalog_version IS NULL OR char_length(catalog_version) <= 64),
  state            text NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued', 'running', 'retrying', 'partial', 'complete', 'failed')),
  -- How many real Qloo ids the run used as signals (never the ids themselves).
  signal_count     integer NOT NULL DEFAULT 0 CHECK (signal_count >= 0),
  first_ready_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX taste_seed_runs_owner_idx ON taste_seed_runs (owner_account_id, created_at DESC);

CREATE TABLE taste_seed_categories (
  run_id     uuid NOT NULL REFERENCES taste_seed_runs(id) ON DELETE CASCADE,
  category   text NOT NULL CHECK (category IN ('wear', 'play', 'watch', 'eat')),
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'empty', 'unavailable')),
  card_count integer NOT NULL DEFAULT 0 CHECK (card_count >= 0),
  ready_at   timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, category),
  CHECK ((state = 'ready') = (card_count > 0)),
  CHECK ((state = 'ready') = (ready_at IS NOT NULL))
);
CREATE INDEX taste_seed_categories_ready_idx ON taste_seed_categories (category, ready_at DESC) WHERE state = 'ready';

ALTER TABLE provider_queries ADD COLUMN taste_seed_run_id uuid REFERENCES taste_seed_runs(id) ON DELETE CASCADE;
ALTER TABLE recommendations ADD COLUMN taste_seed_run_id uuid REFERENCES taste_seed_runs(id) ON DELETE CASCADE;
CREATE INDEX provider_queries_taste_seed_idx ON provider_queries (taste_seed_run_id) WHERE taste_seed_run_id IS NOT NULL;
CREATE INDEX recommendations_taste_seed_idx ON recommendations (taste_seed_run_id, category, rank) WHERE taste_seed_run_id IS NOT NULL;

-- Replace the "exactly one parent" CHECKs of 001 (auto-named) with four-parent versions.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname, rel.relname
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname IN ('provider_queries', 'recommendations') AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%num_nonnulls(analysis_id, plan_id, discovery_job_id)%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.relname, c.conname);
  END LOOP;
END $$;

ALTER TABLE provider_queries ADD CONSTRAINT provider_queries_one_parent_check
  CHECK (num_nonnulls(analysis_id, plan_id, discovery_job_id, taste_seed_run_id) = 1);
ALTER TABLE recommendations ADD CONSTRAINT recommendations_one_parent_check
  CHECK (num_nonnulls(analysis_id, plan_id, discovery_job_id, taste_seed_run_id) = 1);
