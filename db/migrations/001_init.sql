-- culture atlas: initial schema.
-- Implements every record in the build spec "Data model" table plus the
-- infrastructure tables the spec implies (uploads, idempotency keys, job stages,
-- trace events, taste profiles, exclusions, sensor import ledger).
--
-- Conventions
--   * UUID primary keys (gen_random_uuid, built into PostgreSQL 13+).
--   * All timestamps are timestamptz; the application pool sets timezone=UTC.
--   * Private records carry an owner. Records that may belong to an anonymous
--     session use the owner pair (owner_account_id, owner_session_id) with
--     exactly one non-null. Account-only records use owner_account_id NOT NULL.
--   * External references use explicit provider namespaces inside jsonb, e.g.
--     {"qloo": "<entity_id>", "wikidata": "Q123"}.
--   * Enumerations are CHECK constraints on text so later migrations can extend
--     them with a simple constraint swap.

-- ---------------------------------------------------------------------------
-- Accounts and sessions
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject     text NOT NULL UNIQUE,
  display_name     text,
  preferences      jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_policy jsonb NOT NULL DEFAULT '{"discard_photo_after_compile": false}'::jsonb,
  is_demo_owner    boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  claimed_at  timestamptz,
  revoked_at  timestamptz,
  last_seen_at timestamptz
);
CREATE INDEX sessions_account_idx ON sessions (account_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Agent and sensor connections
-- ---------------------------------------------------------------------------

CREATE TABLE agent_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_name        text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 80),
  -- 'agent' = personal agent connection; 'sensor_bridge' = restricted capture-write
  -- token used by apps/sensor-bridge for one sensor connection.
  purpose            text NOT NULL DEFAULT 'agent' CHECK (purpose IN ('agent', 'sensor_bridge')),
  credential_hash    text NOT NULL UNIQUE,
  credential_prefix  text NOT NULL,
  scopes             text[] NOT NULL DEFAULT ARRAY[]::text[],
  library_access     text NOT NULL DEFAULT 'none'
                     CHECK (library_access IN ('none', 'selected_collections', 'all')),
  sensor_connection_id uuid,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  last_used_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (scopes <@ ARRAY['captures:read','captures:write','collections:read','collections:write',
                         'taste:read','taste:write','plans:read','plans:write']::text[])
);
CREATE INDEX agent_connections_owner_idx ON agent_connections (owner_account_id);

CREATE TABLE sensor_connections (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  configured_origin           text NOT NULL,
  -- 'poll': the app polls the relay directly; 'bridge': apps/sensor-bridge pushes.
  mode                        text NOT NULL DEFAULT 'poll' CHECK (mode IN ('poll', 'bridge')),
  encrypted_viewer_credential bytea,
  credential_key_id           text,
  cursor                      text,
  enabled                     boolean NOT NULL DEFAULT true,
  last_success_at             timestamptz,
  last_attempt_at             timestamptz,
  last_error_code             text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  disabled_at                 timestamptz
);
CREATE INDEX sensor_connections_owner_idx ON sensor_connections (owner_account_id);

ALTER TABLE agent_connections
  ADD CONSTRAINT agent_connections_sensor_fk
  FOREIGN KEY (sensor_connection_id) REFERENCES sensor_connections(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Uploads and captures
-- ---------------------------------------------------------------------------

-- An upload holds validated bytes before a capture is created from them
-- (REST multipart or agent flows that pass an owned upload_id).
CREATE TABLE uploads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id    uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id    uuid REFERENCES sessions(id) ON DELETE CASCADE,
  agent_connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
  object_key          text NOT NULL,
  content_type        text NOT NULL,
  byte_size           integer NOT NULL CHECK (byte_size > 0),
  sha256              text NOT NULL,
  width               integer,
  height              integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  CHECK (num_nonnulls(owner_account_id, owner_session_id) = 1)
);
CREATE INDEX uploads_owner_account_idx ON uploads (owner_account_id);
CREATE INDEX uploads_owner_session_idx ON uploads (owner_session_id);

CREATE TABLE captures (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id       uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id       uuid REFERENCES sessions(id) ON DELETE CASCADE,
  source                 text NOT NULL CHECK (source IN ('upload', 'camera', 'sensor', 'sample')),
  upload_id              uuid REFERENCES uploads(id) ON DELETE SET NULL,
  sample_id              text,
  -- Normalized derivative (<= 2048 px long edge, oriented, metadata stripped).
  private_object_key     text,
  -- Original bytes; only kept when the intake policy requires it.
  original_object_key    text,
  image_sha256           text NOT NULL,
  width                  integer,
  height                 integer,
  captured_at            timestamptz,
  received_at            timestamptz NOT NULL DEFAULT now(),
  -- {"kind": "whole"} | {"kind": "choice", "choice_id": "...", "label": "..."} | {"kind": "region", ...}
  focus                  jsonb NOT NULL DEFAULT '{"kind": "whole"}'::jsonb,
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'processing', 'ready', 'partial', 'failed', 'deleted')),
  active_analysis_id     uuid,
  sensor_connection_id   uuid REFERENCES sensor_connections(id) ON DELETE SET NULL,
  sensor_asset_id        text,
  created_by_agent_connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
  expires_at             timestamptz,
  deleted_at             timestamptz,
  purge_after            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(owner_account_id, owner_session_id) = 1),
  CHECK ((source = 'sample') = (sample_id IS NOT NULL)),
  CHECK ((sensor_asset_id IS NULL) OR (sensor_connection_id IS NOT NULL)),
  UNIQUE (sensor_connection_id, sensor_asset_id)
);
CREATE INDEX captures_owner_account_idx ON captures (owner_account_id, created_at DESC);
CREATE INDEX captures_owner_session_idx ON captures (owner_session_id, created_at DESC);
CREATE INDEX captures_hash_idx ON captures (image_sha256);
CREATE INDEX captures_purge_idx ON captures (purge_after) WHERE deleted_at IS NOT NULL;

-- Analyses are immutable; corrections create a new version and the capture's
-- active_analysis_id moves to it.
CREATE TABLE analyses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id          uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  version             integer NOT NULL CHECK (version >= 1),
  compiler_version    text NOT NULL,
  focus               jsonb NOT NULL DEFAULT '{"kind": "whole"}'::jsonb,
  -- Consumer summary.
  title               text,
  interpretation      text,
  -- "What caught your eye?" {prompt, choices:[{id,label}]} when subjects compete.
  clarifying_question jsonb,
  observations        jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidates          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- {"observations": "complete", "references": "running", "wear": "failed", ...}
  section_statuses    jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings            jsonb NOT NULL DEFAULT '[]'::jsonb,
  corrections         jsonb,
  job_id              uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capture_id, version)
);

ALTER TABLE captures
  ADD CONSTRAINT captures_active_analysis_fk
  FOREIGN KEY (active_analysis_id) REFERENCES analyses(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Public cultural reference library (no private context stored here)
-- ---------------------------------------------------------------------------

CREATE TABLE cultural_references (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  text NOT NULL,
  -- Normalized identity used for dedupe: e.g. "qloo:<id>", "wikidata:Q123", "style:mod-1960s".
  canonical_key   text NOT NULL UNIQUE,
  type            text NOT NULL
                  CHECK (type IN ('object', 'creator', 'work', 'brand', 'style', 'tradition', 'place', 'cuisine')),
  external_ids    jsonb NOT NULL DEFAULT '{}'::jsonb,
  overview        text,
  -- [{heading, body, claim_ids: []}] up to three sections.
  sections        jsonb NOT NULL DEFAULT '[]'::jsonb,
  research_status text NOT NULL DEFAULT 'none'
                  CHECK (research_status IN ('none', 'pending', 'complete', 'failed', 'unsupported')),
  revision        integer NOT NULL DEFAULT 1,
  researched_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cultural_references_name_idx ON cultural_references (lower(canonical_name));

CREATE TABLE capture_references (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id       uuid NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  reference_id      uuid NOT NULL REFERENCES cultural_references(id) ON DELETE CASCADE,
  relation          text NOT NULL CHECK (relation IN ('depicted', 'resembles', 'user_selected')),
  -- {"region_ids": [...], "boxes": [{x,y,w,h}]} normalized 0..1 coordinates.
  evidence_region   jsonb,
  certainty         real CHECK (certainty IS NULL OR (certainty >= 0 AND certainty <= 1)),
  resolution_status text NOT NULL DEFAULT 'resolved'
                    CHECK (resolution_status IN ('resolved', 'unmatched', 'ambiguous', 'user_confirmed', 'rejected')),
  is_anchor         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_id, reference_id, relation)
);
CREATE INDEX capture_references_reference_idx ON capture_references (reference_id);

CREATE TABLE sources (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url                      text NOT NULL UNIQUE,
  title                    text,
  publisher                text,
  retrieved_at             timestamptz NOT NULL DEFAULT now(),
  -- Only metadata we are allowed to display (title, publisher, license). No full articles.
  allowed_display_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE claims (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES cultural_references(id) ON DELETE CASCADE,
  text         text NOT NULL,
  claim_type   text NOT NULL CHECK (claim_type IN ('factual', 'interpretive')),
  source_ids   uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  reviewed_at  timestamptz,
  revision     integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- A factual claim must cite at least one source.
  CHECK (claim_type <> 'factual' OR cardinality(source_ids) >= 1)
);
CREATE INDEX claims_reference_idx ON claims (reference_id);

-- ---------------------------------------------------------------------------
-- Discovery items, plans and discovery contexts
-- ---------------------------------------------------------------------------

CREATE TABLE discovery_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id    uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id    uuid REFERENCES sessions(id) ON DELETE CASCADE,
  is_sample           boolean NOT NULL DEFAULT false,
  kind                text NOT NULL
                      CHECK (kind IN ('capture', 'style', 'brand', 'artist', 'track', 'film', 'food', 'reference')),
  category            text CHECK (category IS NULL OR category IN ('wear', 'play', 'watch', 'eat')),
  -- Stable identity: "qloo:<entity_id>" for canonical provider items,
  -- "capture:<capture_id>" for captures, "food:<normalized>|<reference ids>" etc.
  canonical_key       text NOT NULL,
  capture_id          uuid REFERENCES captures(id) ON DELETE CASCADE,
  reference_id        uuid REFERENCES cultural_references(id) ON DELETE SET NULL,
  title               text NOT NULL,
  -- {subtitle, year, image:{object_key|url,width,height,alt,license}, text_treatment, destination_url}
  display_metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_ids        jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_anchor_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((is_sample AND owner_account_id IS NULL AND owner_session_id IS NULL)
         OR (NOT is_sample AND num_nonnulls(owner_account_id, owner_session_id) = 1)),
  CHECK ((kind = 'capture') = (capture_id IS NOT NULL)),
  UNIQUE (owner_account_id, canonical_key),
  UNIQUE (owner_session_id, canonical_key)
);
CREATE UNIQUE INDEX discovery_items_sample_key_idx ON discovery_items (canonical_key) WHERE is_sample;
CREATE INDEX discovery_items_capture_idx ON discovery_items (capture_id);

CREATE TABLE collections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description      text CHECK (description IS NULL OR char_length(description) <= 500),
  revision         integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_account_id)
);
CREATE INDEX collections_owner_idx ON collections (owner_account_id, updated_at DESC);

CREATE TABLE agent_connection_collections (
  agent_connection_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  collection_id       uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  granted_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_connection_id, collection_id)
);

CREATE TABLE saved_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id  uuid REFERENCES sessions(id) ON DELETE CASCADE,
  discovery_item_id uuid NOT NULL REFERENCES discovery_items(id) ON DELETE CASCADE,
  -- For an inspiration save: the capture focus that was endorsed.
  endorsed_focus    jsonb,
  saved_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(owner_account_id, owner_session_id) = 1),
  UNIQUE (owner_account_id, discovery_item_id),
  UNIQUE (owner_session_id, discovery_item_id),
  UNIQUE (id, owner_account_id)
);
CREATE INDEX saved_items_owner_account_idx ON saved_items (owner_account_id, saved_at DESC);
CREATE INDEX saved_items_owner_session_idx ON saved_items (owner_session_id, saved_at DESC);

-- Memberships. Composite FKs enforce that the collection and the saved item
-- belong to the same account.
CREATE TABLE collection_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id    uuid NOT NULL,
  saved_item_id    uuid NOT NULL,
  owner_account_id uuid NOT NULL,
  position         integer NOT NULL,
  added_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, saved_item_id),
  FOREIGN KEY (collection_id, owner_account_id)
    REFERENCES collections(id, owner_account_id) ON DELETE CASCADE,
  FOREIGN KEY (saved_item_id, owner_account_id)
    REFERENCES saved_items(id, owner_account_id) ON DELETE CASCADE
);
CREATE INDEX collection_items_order_idx ON collection_items (collection_id, position);
CREATE INDEX collection_items_saved_idx ON collection_items (saved_item_id);

CREATE TABLE plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_collection_id uuid REFERENCES collections(id) ON DELETE SET NULL,
  template             text NOT NULL DEFAULT 'movie_night' CHECK (template IN ('movie_night')),
  -- discovery_item ids of the selected inputs (2..5).
  selected_item_ids    uuid[] NOT NULL CHECK (cardinality(selected_item_ids) BETWEEN 2 AND 5),
  fixed_film_item_id   uuid,
  constraints          jsonb NOT NULL DEFAULT '{}'::jsonb,
  exploration          text NOT NULL DEFAULT 'balanced'
                       CHECK (exploration IN ('familiar', 'balanced', 'adventurous')),
  status               text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'partial', 'complete', 'failed', 'cancelled')),
  active_version       integer,
  created_by_agent_connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_owner_idx ON plans (owner_account_id, created_at DESC);

CREATE TABLE plan_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  version             integer NOT NULL CHECK (version >= 1),
  collection_revision integer,
  -- {items:[{item_id, kind, title, revision, anchors:[{reference_id, revision, external_ids}]}],
  --  constraints, exploration, collection_id}
  input_snapshot      jsonb NOT NULL,
  fixed_film_id       uuid,
  title               text,
  summary             text,
  film                jsonb,
  food                jsonb,
  music               jsonb,
  section_statuses    jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale           text,
  recommendation_ids  uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  -- Version this one was derived from by a section replacement.
  based_on_version    integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

-- Context for an explicit "Discover more" / related-discovery expansion.
CREATE TABLE discovery_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id    uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id    uuid REFERENCES sessions(id) ON DELETE CASCADE,
  origin_item_id      uuid NOT NULL REFERENCES discovery_items(id) ON DELETE CASCADE,
  -- Agent grant context: related results stay tied to their granted origin.
  agent_connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
  origin_collection_id uuid REFERENCES collections(id) ON DELETE SET NULL,
  category            text CHECK (category IS NULL OR category IN ('wear', 'play', 'watch', 'eat')),
  anchor_reference_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  taste_revision      integer NOT NULL DEFAULT 0,
  job_id              uuid,
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'partial', 'complete', 'failed', 'cancelled')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(owner_account_id, owner_session_id) = 1)
);
CREATE INDEX discovery_jobs_origin_idx ON discovery_jobs (origin_item_id, created_at DESC);

CREATE TABLE provider_queries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id      uuid REFERENCES analyses(id) ON DELETE CASCADE,
  plan_id          uuid REFERENCES plans(id) ON DELETE CASCADE,
  plan_version     integer,
  discovery_job_id uuid REFERENCES discovery_jobs(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('qloo', 'vlm', 'research', 'wikipedia', 'text_model', 'catalog')),
  operation        text NOT NULL,
  -- Request with secrets removed (no API keys, no image bytes, no private prompts).
  sanitized_request jsonb NOT NULL DEFAULT '{}'::jsonb,
  results          jsonb,
  status           text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'empty', 'error')),
  http_status      integer,
  error_code       text,
  duration_ms      integer,
  -- true when results came from a recorded fixture ("Example result"), never live.
  is_replay        boolean NOT NULL DEFAULT false,
  retrieved_at     timestamptz NOT NULL DEFAULT now(),
  cache_expiry     timestamptz,
  query_context    jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id         text,
  CHECK (num_nonnulls(analysis_id, plan_id, discovery_job_id) = 1)
);
CREATE INDEX provider_queries_analysis_idx ON provider_queries (analysis_id);
CREATE INDEX provider_queries_plan_idx ON provider_queries (plan_id);
CREATE INDEX provider_queries_discovery_idx ON provider_queries (discovery_job_id);
CREATE INDEX provider_queries_trace_idx ON provider_queries (trace_id);

CREATE TABLE recommendations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id                uuid REFERENCES analyses(id) ON DELETE CASCADE,
  plan_id                    uuid REFERENCES plans(id) ON DELETE CASCADE,
  plan_version               integer,
  discovery_job_id           uuid REFERENCES discovery_jobs(id) ON DELETE CASCADE,
  discovery_item_id          uuid NOT NULL REFERENCES discovery_items(id) ON DELETE CASCADE,
  category                   text CHECK (category IS NULL OR category IN ('wear', 'play', 'watch', 'eat')),
  -- Plan section when parent is a plan: film | alternate_film | food | music_before | music_after.
  section                    text,
  rank                       integer NOT NULL DEFAULT 0,
  title                      text NOT NULL,
  external_ids               jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_reason             text,
  -- qloo: traceable to provider_query_ids; vlm_creative: creative rationale from
  -- supported references; sample/replay: labeled "Example result".
  origin                     text NOT NULL CHECK (origin IN ('qloo', 'research', 'catalog', 'vlm_creative', 'sample', 'replay')),
  source_ids                 uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  provider_query_ids         uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  contributing_reference_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  destination_url            text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(analysis_id, plan_id, discovery_job_id) = 1),
  CHECK (origin <> 'qloo' OR cardinality(provider_query_ids) >= 1)
);
CREATE INDEX recommendations_analysis_idx ON recommendations (analysis_id, rank);
CREATE INDEX recommendations_plan_idx ON recommendations (plan_id, plan_version);
CREATE INDEX recommendations_discovery_idx ON recommendations (discovery_job_id, rank);
CREATE INDEX recommendations_item_idx ON recommendations (discovery_item_id);

-- ---------------------------------------------------------------------------
-- Taste memory
-- ---------------------------------------------------------------------------

CREATE TABLE preference_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id    uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id    uuid REFERENCES sessions(id) ON DELETE CASCADE,
  action              text NOT NULL CHECK (action IN ('save', 'remove', 'hide', 'unhide', 'correct')),
  target_type         text NOT NULL CHECK (target_type IN ('discovery_item', 'capture', 'reference', 'analysis')),
  target_id           uuid NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(owner_account_id, owner_session_id) = 1)
);
CREATE INDEX preference_events_owner_account_idx ON preference_events (owner_account_id, created_at);
CREATE INDEX preference_events_owner_session_idx ON preference_events (owner_session_id, created_at);
CREATE INDEX preference_events_target_idx ON preference_events (target_type, target_id);

-- Current hide exclusions (derived from preference_events; rebuildable).
CREATE TABLE item_exclusions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id  uuid REFERENCES sessions(id) ON DELETE CASCADE,
  discovery_item_id uuid REFERENCES discovery_items(id) ON DELETE CASCADE,
  canonical_key     text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(owner_account_id, owner_session_id) = 1),
  UNIQUE (owner_account_id, canonical_key),
  UNIQUE (owner_session_id, canonical_key)
);

-- Derived taste profile (rebuildable view over current explicit preferences).
-- revision increments on every save/remove/hide/unhide/correct and is part of
-- recommendation cache keys.
CREATE TABLE taste_profiles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  revision         integer NOT NULL DEFAULT 0,
  -- {anchors:[{reference_id, weight, kind, category}], categories:{...}}
  summary          jsonb NOT NULL DEFAULT '{}'::jsonb,
  rebuilt_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(owner_account_id, owner_session_id) = 1),
  UNIQUE (owner_account_id),
  UNIQUE (owner_session_id)
);

CREATE TABLE feed_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id  uuid REFERENCES sessions(id) ON DELETE CASCADE,
  taste_revision    integer NOT NULL,
  category          text CHECK (category IS NULL OR category IN ('wear', 'play', 'watch', 'eat')),
  ordered_item_ids  uuid[] NOT NULL,
  is_example_feed   boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  CHECK (num_nonnulls(owner_account_id, owner_session_id) = 1)
);
CREATE INDEX feed_snapshots_owner_account_idx ON feed_snapshots (owner_account_id, created_at DESC);
CREATE INDEX feed_snapshots_owner_session_idx ON feed_snapshots (owner_session_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Jobs (database-backed queue with leases)
-- ---------------------------------------------------------------------------

CREATE TABLE jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Both NULL only for system jobs (e.g. purge).
  owner_account_id    uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id    uuid REFERENCES sessions(id) ON DELETE CASCADE,
  agent_connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
  type                text NOT NULL,
  state               text NOT NULL DEFAULT 'queued'
                      CHECK (state IN ('queued', 'running', 'partial', 'complete', 'failed', 'cancelled')),
  -- Public progress stage name, e.g. 'observing', 'resolving', 'researching', 'recommending'.
  stage               text,
  attempt             integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 3,
  available_at        timestamptz NOT NULL DEFAULT now(),
  lease_owner         text,
  lease_expiry        timestamptz,
  heartbeat_at        timestamptz,
  -- {"qloo_requests": 12, "research_refs": 5, "provider_retries": 2, "deadline_ms": 60000}
  budget              jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key          text,
  error_code          text,
  error_message       text,
  error_retryable     boolean,
  -- What this job produced: ('analysis', id) | ('plan', id) | ('discovery_job', id) ...
  result_type         text,
  result_id           uuid,
  trace_id            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  cancel_requested_at timestamptz,
  CHECK (num_nonnulls(owner_account_id, owner_session_id) <= 1)
);
-- Same input + version reuses the existing job unless it failed or was cancelled.
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state NOT IN ('failed', 'cancelled');
CREATE INDEX jobs_claim_idx ON jobs (available_at) WHERE state = 'queued';
CREATE INDEX jobs_lease_idx ON jobs (lease_expiry) WHERE state = 'running';
CREATE INDEX jobs_result_idx ON jobs (result_type, result_id);
CREATE INDEX jobs_owner_account_idx ON jobs (owner_account_id, created_at DESC);
CREATE INDEX jobs_owner_session_idx ON jobs (owner_session_id, created_at DESC);

-- Idempotent per-stage outputs. A completed stage is never overwritten by a
-- later attempt; workers read it back and skip the stage.
CREATE TABLE job_stages (
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage        text NOT NULL,
  status       text NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'skipped')),
  attempt      integer NOT NULL,
  output       jsonb,
  error_code   text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (job_id, stage)
);

-- ---------------------------------------------------------------------------
-- Idempotency keys (REST/MCP mutations)
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- "account:<id>" | "session:<id>" | "agent:<connection_id>"
  principal_key   text NOT NULL,
  -- e.g. "POST /v1/collections"
  route           text NOT NULL,
  key             text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  request_hash    text NOT NULL,
  state           text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress', 'complete')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (principal_key, route, key)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Sensor import ledger and demo traces
-- ---------------------------------------------------------------------------

-- Dedupe ledger keyed by connection + relay asset id. Survives capture deletion
-- so a deleted photo is not silently re-imported.
CREATE TABLE sensor_imports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_connection_id uuid NOT NULL REFERENCES sensor_connections(id) ON DELETE CASCADE,
  asset_id             text NOT NULL,
  capture_id           uuid REFERENCES captures(id) ON DELETE SET NULL,
  declared_sha256      text,
  verified_sha256      text,
  captured_at          timestamptz,
  status               text NOT NULL CHECK (status IN ('imported', 'skipped', 'failed', 'pending_selection')),
  error_code           text,
  imported_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sensor_connection_id, asset_id)
);

-- Demo inspector trace events: pipeline stages, provider calls and agent tool calls.
CREATE TABLE trace_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id            text,
  job_id              uuid REFERENCES jobs(id) ON DELETE CASCADE,
  owner_account_id    uuid REFERENCES accounts(id) ON DELETE CASCADE,
  owner_session_id    uuid REFERENCES sessions(id) ON DELETE CASCADE,
  agent_connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('stage', 'provider_call', 'agent_tool_call', 'rest_call', 'note')),
  name                text NOT NULL,
  -- Redacted: no tokens, credentials, image bytes or full private prompts.
  data                jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms         integer,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trace_events_job_idx ON trace_events (job_id, created_at);
CREATE INDEX trace_events_trace_idx ON trace_events (trace_id, created_at);
CREATE INDEX trace_events_agent_idx ON trace_events (agent_connection_id, created_at);

-- Daily quota counters (per anonymous session / account / IP bucket).
CREATE TABLE usage_counters (
  bucket      text NOT NULL,
  metric      text NOT NULL,
  day         date NOT NULL,
  count       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, metric, day)
);
