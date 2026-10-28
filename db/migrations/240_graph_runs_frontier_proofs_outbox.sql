-- Interest graph, PR 8 package A: graph runs as a real, mutually exclusive
-- parent of recommendations AND provider queries, the account frontier, pinned
-- per-recommendation proofs and the transactional projection outbox.
--
-- Graph-parented rows carry their owning account explicitly (owner_account_id),
-- so owner joins, readers and cleanup stay owner-scoped without backfilling
-- legacy rows: those keep deriving ownership from their parent joins. Storage
-- method is not provenance: existing origins (qloo, research, ...) stay intact
-- and no 'graph' origin exists.

CREATE TABLE graph_runs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id                    uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  run_kind                  text NOT NULL CHECK (run_kind IN ('projection','expansion','research')),
  input_taste_revision      integer NOT NULL DEFAULT 0 CHECK (input_taste_revision >= 0),
  input_projection_revision integer NOT NULL DEFAULT 0 CHECK (input_projection_revision >= 0),
  input_generation          integer NOT NULL DEFAULT 0 CHECK (input_generation >= 0),
  policy_version            text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 64),
  budget                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  state                     text NOT NULL DEFAULT 'queued'
                            CHECK (state IN ('queued','running','complete','failed','cancelled')),
  published                 boolean NOT NULL DEFAULT false,
  started_at                timestamptz,
  finished_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_account_id)
);
CREATE INDEX graph_runs_owner_idx ON graph_runs (owner_account_id, created_at DESC);
CREATE INDEX graph_runs_sweep_idx ON graph_runs (state, updated_at) WHERE state IN ('queued','running');

-- Bounded candidate frontier: account + run, candidate identity, intent,
-- support roots, path versions, state, expiry and a dedupe key. Entries live
-- at most seven days; evidence/rights expiry shortens, never extends, life.
CREATE TABLE graph_frontier (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id            uuid NOT NULL,
  node_id           uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  intent            text NOT NULL DEFAULT 'expansion' CHECK (intent IN ('expansion','research')),
  -- Private explicit-root ids this candidate was reached from.
  support_root_ids  uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  path_versions     jsonb NOT NULL DEFAULT '{}'::jsonb,
  state             text NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active','admitted','rejected','pruned','expired','published')),
  score             real CHECK (score IS NULL OR score >= 0),
  dedupe_key        text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_account_id),
  UNIQUE (owner_account_id, dedupe_key),
  FOREIGN KEY (run_id, owner_account_id)
    REFERENCES graph_runs(id, owner_account_id) ON DELETE CASCADE,
  CHECK (expires_at <= created_at + interval '7 days')
);
CREATE INDEX graph_frontier_active_idx ON graph_frontier (owner_account_id, created_at) WHERE state = 'active';
CREATE INDEX graph_frontier_expiry_idx ON graph_frontier (expires_at) WHERE state = 'active';

-- Transactional projection outbox: preference, pick, exclusion, analysis and
-- claim mutations commit the intent row in the same transaction; dispatch is
-- at-least-once and idempotent. The logical event key dedupes bursts to one
-- row per effective revision.
CREATE TABLE graph_outbox (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_type            text NOT NULL
                        CHECK (event_type IN ('taste','picks','claim','analysis','backfill','retract')),
  logical_event_key     text NOT NULL CHECK (char_length(logical_event_key) BETWEEN 1 AND 200),
  target_taste_revision integer NOT NULL CHECK (target_taste_revision >= 0),
  target_generation     integer NOT NULL DEFAULT 0 CHECK (target_generation >= 0),
  job_intent            text NOT NULL CHECK (job_intent IN (
                          'project_interest_graph','expand_interest_graph','research_graph_relation','backfill')),
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  dispatch_state        text NOT NULL DEFAULT 'pending'
                        CHECK (dispatch_state IN ('pending','dispatched','done','failed')),
  attempts              integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  dispatched_at         timestamptz,
  processed_at          timestamptz,
  UNIQUE (owner_account_id, logical_event_key, target_taste_revision)
);
CREATE INDEX graph_outbox_pending_idx ON graph_outbox (created_at) WHERE dispatch_state = 'pending';

-- The fifth parent on both tables, exclusive of every other parent. Legacy
-- rows keep working unchanged; graph-parented rows pin the owning account.
ALTER TABLE provider_queries
  ADD COLUMN graph_run_id uuid,
  ADD COLUMN owner_account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE provider_queries ADD CONSTRAINT provider_queries_graph_run_fk
  FOREIGN KEY (graph_run_id, owner_account_id) REFERENCES graph_runs(id, owner_account_id) ON DELETE CASCADE;
ALTER TABLE provider_queries ADD CONSTRAINT provider_queries_graph_owner_pair
  CHECK (num_nonnulls(graph_run_id, owner_account_id) IN (0, 2));

ALTER TABLE recommendations
  ADD COLUMN graph_run_id uuid,
  ADD COLUMN owner_account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  ADD CONSTRAINT recommendations_id_graph_run_key UNIQUE (id, graph_run_id);
ALTER TABLE recommendations ADD CONSTRAINT recommendations_graph_run_fk
  FOREIGN KEY (graph_run_id, owner_account_id) REFERENCES graph_runs(id, owner_account_id) ON DELETE CASCADE;
-- A graph-parented card's discovery item must belong to the same account.
ALTER TABLE recommendations ADD CONSTRAINT recommendations_graph_item_fk
  FOREIGN KEY (discovery_item_id, owner_account_id)
  REFERENCES discovery_items(id, owner_account_id) ON DELETE CASCADE;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_graph_owner_pair
  CHECK (num_nonnulls(graph_run_id, owner_account_id) IN (0, 2));

CREATE INDEX provider_queries_graph_run_idx ON provider_queries (graph_run_id) WHERE graph_run_id IS NOT NULL;
CREATE INDEX recommendations_graph_run_idx ON recommendations (graph_run_id) WHERE graph_run_id IS NOT NULL;
CREATE INDEX recommendations_graph_owner_idx
  ON recommendations (owner_account_id, created_at DESC) WHERE graph_run_id IS NOT NULL;

-- Replace the four-parent CHECKs of 120 with five-parent versions.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname, rel.relname
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname IN ('provider_queries', 'recommendations') AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%num_nonnulls(analysis_id, plan_id, discovery_job_id%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.relname, c.conname);
  END LOOP;
END $$;

ALTER TABLE provider_queries ADD CONSTRAINT provider_queries_one_parent_check
  CHECK (num_nonnulls(analysis_id, plan_id, discovery_job_id, taste_seed_run_id, graph_run_id) = 1);
ALTER TABLE recommendations ADD CONSTRAINT recommendations_one_parent_check
  CHECK (num_nonnulls(analysis_id, plan_id, discovery_job_id, taste_seed_run_id, graph_run_id) = 1);

-- Pinned per-recommendation proof: the exact assertion/evidence revisions and
-- private support a served card's reason rests on, unique per proof version.
-- The composite FKs pin the proof to the recommendation's own graph run and
-- to the owning account, so a proof can never cross owners.
CREATE TABLE recommendation_graph_proofs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recommendation_id       uuid NOT NULL,
  graph_run_id            uuid NOT NULL,
  proof_version           integer NOT NULL CHECK (proof_version >= 1),
  -- Pinned shared assertion identities and their revisions at publication.
  assertion_ids           uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  assertion_revisions     integer[] NOT NULL DEFAULT ARRAY[]::int[],
  evidence_ids            uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  evidence_revisions      integer[] NOT NULL DEFAULT ARRAY[]::int[],
  -- Private support edges behind the personal-relevance half.
  support_edge_ids        uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  intent                  text NOT NULL CHECK (intent IN ('personal','photo')),
  reason_template         text NOT NULL CHECK (char_length(reason_template) BETWEEN 1 AND 100),
  reason_template_version text NOT NULL CHECK (char_length(reason_template_version) BETWEEN 1 AND 64),
  validity_state          text NOT NULL DEFAULT 'valid'
                          CHECK (validity_state IN ('valid','invalid','revoked','superseded')),
  invalidated_at          timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_account_id),
  UNIQUE (recommendation_id, proof_version),
  FOREIGN KEY (recommendation_id, graph_run_id)
    REFERENCES recommendations(id, graph_run_id) ON DELETE CASCADE,
  FOREIGN KEY (graph_run_id, owner_account_id)
    REFERENCES graph_runs(id, owner_account_id) ON DELETE CASCADE,
  CHECK (cardinality(assertion_ids) = cardinality(assertion_revisions)),
  CHECK (cardinality(evidence_ids) = cardinality(evidence_revisions))
);
CREATE INDEX recommendation_graph_proofs_owner_idx
  ON recommendation_graph_proofs (owner_account_id, created_at DESC);
CREATE INDEX recommendation_graph_proofs_valid_idx
  ON recommendation_graph_proofs (recommendation_id) WHERE validity_state = 'valid';
