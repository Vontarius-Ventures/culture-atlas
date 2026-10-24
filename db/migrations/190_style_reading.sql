-- Style reading and style-driven discovery (prp/2026-10-23-style-analysis/design.md §E.1).
-- Additive only; rollback = drop the new columns/table and restore the two
-- constraint lists below. No existing data depends on them.
--
--  * analyses.style_reading: the guarded style reading (atlas_style_reading_v1)
--    plus provenance (wording/guard/vocab versions, model, measured swatches).
--    Written as a whole JSON value by publishStyle(); a later write may only
--    raise wording, release held claims or mark a vetoed claim retracted.
--  * analyses.experimental: the analysis ran on at least one unqualified role
--    under ANALYSIS_EXPERIMENTAL_ROLES (or the non-production demo override);
--    every client labels it "Experimental".
--  * analyses.style_retries: "Try again" on a failed style reading is allowed once.
--  * recommendations.rail: 'more_like_this' (same-domain style rail, keyed by
--    subject_id) or 'cross_domain'; NULL on older rows reads as cross-domain.
--    style_match is the structured overlap behind the reason (C.4);
--    reading_rev the style reading revision the card was built from; hidden_at
--    soft-hides a card whose only overlap was a retracted claim (R-6).
--  * Model ledger roles gain vision_style; the kill switch list gains
--    experimental_analysis_enabled (a kill can only turn experimental roles off).
--  * qloo_rate_buckets: cross-process token bucket and daily request counter
--    for the shared Qloo key (R-11); web, worker and media-worker share it.

ALTER TABLE analyses
  ADD COLUMN style_reading jsonb,
  ADD COLUMN style_reading_version text CHECK (style_reading_version IS NULL OR style_reading_version = 'atlas_style_reading_v1'),
  ADD COLUMN experimental boolean NOT NULL DEFAULT false,
  ADD COLUMN style_retries integer NOT NULL DEFAULT 0 CHECK (style_retries BETWEEN 0 AND 1);

ALTER TABLE recommendations
  ADD COLUMN rail text CHECK (rail IN ('more_like_this', 'cross_domain')),
  ADD COLUMN subject_id text CHECK (subject_id IS NULL OR subject_id IN ('s1', 's2')),
  ADD COLUMN style_match jsonb,
  ADD COLUMN reading_rev integer,
  ADD COLUMN hidden_at timestamptz,
  ADD CONSTRAINT recommendations_rail_subject CHECK (rail IS DISTINCT FROM 'more_like_this' OR subject_id IS NOT NULL);

CREATE INDEX recommendations_rail_idx ON recommendations (analysis_id, rail) WHERE rail IS NOT NULL;

ALTER TABLE media_analysis_requests
  ADD COLUMN experimental boolean NOT NULL DEFAULT false,
  -- v2 photos: the media worker starts the style call next to stage 1 (B.1 "t0") and stores the raw
  -- reading here; the compile job guards, words and publishes it (no second call).
  ADD COLUMN style_state text CHECK (style_state IS NULL OR style_state IN ('running', 'complete', 'failed')),
  ADD COLUMN style_observation jsonb;
-- D.2: an experimental reading past its daily bucket waits with reason daily_limit (no error code).
ALTER TABLE media_analysis_requests DROP CONSTRAINT IF EXISTS media_analysis_requests_waiting_reason_check;
ALTER TABLE media_analysis_requests ADD CONSTRAINT media_analysis_requests_waiting_reason_check
  CHECK (waiting_reason IS NULL OR waiting_reason IN ('ai_paused','rate_limited','daily_limit'));

ALTER TABLE feature_flag_kills DROP CONSTRAINT IF EXISTS feature_flag_kills_flag_check;
ALTER TABLE feature_flag_kills ADD CONSTRAINT feature_flag_kills_flag_check CHECK (flag IN (
  'camera_photo','camera_video','file_photo_upload','file_video_upload',
  'meta_glasses_capture_enabled','meta_glasses_audio_enabled','remote_glasses_capture_enabled',
  'concentrate_analysis_enabled','automatic_analysis','native_video_model_input',
  'agent_api_enabled','collection_sharing_enabled','agent_remote_capture_enabled',
  'onboarding_required','taste_seed_enabled','fast_analysis_two_stage','while_we_look_enabled',
  'analysis_verifier_enabled','experimental_analysis_enabled'));

ALTER TABLE inference_attempts DROP CONSTRAINT IF EXISTS inference_attempts_role_check;
ALTER TABLE inference_attempts ADD CONSTRAINT inference_attempts_role_check CHECK (role IN (
  'vision_photo','vision_video_frame','research_text','composer','vision_photo_enrich','vision_verify','vision_style'));

ALTER TABLE model_gateway_attempts DROP CONSTRAINT IF EXISTS model_gateway_attempts_role_check;
ALTER TABLE model_gateway_attempts ADD CONSTRAINT model_gateway_attempts_role_check CHECK (role IN (
  'vision_photo','vision_video_frame','research_text','composer','vision_photo_enrich','vision_verify','vision_style'));

CREATE TABLE qloo_rate_buckets (
  key_id      text PRIMARY KEY CHECK (char_length(key_id) <= 64),
  tokens      double precision NOT NULL,
  refilled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  day         date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  day_count   integer NOT NULL DEFAULT 0 CHECK (day_count >= 0)
);
