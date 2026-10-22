-- Amendment 2.3 Music Mode: audio as a first-class private medium.
-- Additive. Photo/video rows, v1 library projections and existing grants stay unchanged.
-- Audio scopes are stored as text; they are not granted to existing agent rows.

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_kind_check;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_source_check;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_duration_ms_check;
ALTER TABLE capture_sessions DROP CONSTRAINT IF EXISTS capture_sessions_media_mode_check;
ALTER TABLE capture_sessions DROP CONSTRAINT IF EXISTS capture_sessions_source_check;
ALTER TABLE media_derivatives DROP CONSTRAINT IF EXISTS media_derivatives_kind_check;
ALTER TABLE media_derivatives DROP CONSTRAINT IF EXISTS media_derivatives_width_check;
ALTER TABLE media_derivatives DROP CONSTRAINT IF EXISTS media_derivatives_height_check;
ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_action_check;
ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_duration_seconds_check;
ALTER TABLE agent_connections DROP CONSTRAINT IF EXISTS agent_connections_scopes_v2;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'c'
       AND c.conrelid IN (
         'media_assets'::regclass, 'capture_sessions'::regclass,
         'media_derivatives'::regclass, 'device_commands'::regclass
       )
       AND (
         (c.conrelid = 'media_assets'::regclass AND pg_get_constraintdef(c.oid) LIKE '%kind%' AND pg_get_constraintdef(c.oid) LIKE '%photo%')
         OR (c.conrelid = 'media_assets'::regclass AND pg_get_constraintdef(c.oid) LIKE '%browser_camera%')
         OR (c.conrelid = 'media_assets'::regclass AND pg_get_constraintdef(c.oid) LIKE '%duration_ms%')
         OR (c.conrelid = 'capture_sessions'::regclass AND pg_get_constraintdef(c.oid) LIKE '%media_mode%')
         OR (c.conrelid = 'capture_sessions'::regclass AND pg_get_constraintdef(c.oid) LIKE '%phone_camera%')
         OR (c.conrelid = 'media_derivatives'::regclass AND pg_get_constraintdef(c.oid) LIKE '%normalized%')
         OR (c.conrelid = 'media_derivatives'::regclass AND pg_get_constraintdef(c.oid) LIKE '%width%')
         OR (c.conrelid = 'media_derivatives'::regclass AND pg_get_constraintdef(c.oid) LIKE '%height%')
         OR (c.conrelid = 'device_commands'::regclass AND pg_get_constraintdef(c.oid) LIKE '%capture_photo%')
         OR (c.conrelid = 'device_commands'::regclass AND pg_get_constraintdef(c.oid) LIKE '%duration_seconds%')
       )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE media_assets ADD CONSTRAINT media_assets_kind_check
  CHECK (kind IN ('photo','video','audio'));
ALTER TABLE media_assets ADD CONSTRAINT media_assets_source_check
  CHECK (source IN (
    'browser_camera','phone_camera','meta_glasses','upload','legacy_sensor',
    'browser_microphone','phone_microphone'
  ));
ALTER TABLE media_assets ADD CONSTRAINT media_assets_duration_ms_check
  CHECK (
    duration_ms IS NULL OR (
      duration_ms > 0 AND (
        (kind = 'audio' AND duration_ms <= 600000) OR
        (kind <> 'audio' AND duration_ms <= 120000)
      )
    )
  );

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS capture_mode text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS sample_rate_hz integer;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS channels integer;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS codec text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS bitrate integer;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS source_route text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS audio_quality text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS camera_active boolean;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS speech_analysis text NOT NULL DEFAULT 'off';
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS has_audio_track boolean;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS audio_decodable boolean;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS signal_detected boolean;

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_audio_invariants;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_audio_invariants CHECK (
  (kind <> 'audio' AND schema_version = 1) OR (
    kind = 'audio'
    AND schema_version = 2
    AND capture_mode = 'music'
    AND camera_active IS FALSE
    AND speech_analysis = 'off'
    AND source IN ('upload','meta_glasses','browser_microphone','phone_microphone')
    AND (sample_rate_hz IS NULL OR (sample_rate_hz BETWEEN 8000 AND 96000))
    AND (channels IS NULL OR channels IN (1, 2))
  )
);

ALTER TABLE capture_sessions ADD CONSTRAINT capture_sessions_media_mode_check
  CHECK (media_mode IN ('photo','video','audio'));
ALTER TABLE capture_sessions ADD CONSTRAINT capture_sessions_source_check
  CHECK (source IN ('phone_camera','meta_glasses','phone_microphone','browser_microphone'));

ALTER TABLE media_derivatives ALTER COLUMN width DROP NOT NULL;
ALTER TABLE media_derivatives ALTER COLUMN height DROP NOT NULL;
ALTER TABLE media_derivatives ADD CONSTRAINT media_derivatives_kind_check
  CHECK (kind IN ('normalized','playback','poster','frame','audio_playback','waveform','analysis_audio'));
ALTER TABLE media_derivatives ADD CONSTRAINT media_derivatives_dimensions_check CHECK (
  (kind IN ('normalized','playback','poster','frame') AND width > 0 AND height > 0) OR
  (kind IN ('audio_playback','waveform','analysis_audio') AND width IS NULL AND height IS NULL)
);

ALTER TABLE device_commands ADD CONSTRAINT device_commands_action_check
  CHECK (action IN ('capture_photo','start_video','stop_video','record_audio','stop_audio'));
ALTER TABLE device_commands ADD CONSTRAINT device_commands_duration_seconds_check
  CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 1 AND 120);

ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_scopes_v2 CHECK (
  scopes <@ ARRAY[
    'captures:read','captures:write','collections:read','collections:write',
    'taste:read','taste:write','plans:read','plans:write','setup:read','preferences:read',
    'preferences:write','media:read','media:download','media:write','media:analyze','devices:command',
    'audio:read','audio:analyze','transcripts:read','transcripts:write','devices:microphone_record'
  ]::text[]
);

CREATE TABLE IF NOT EXISTS media_tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  generation integer NOT NULL,
  role text NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','alternate')),
  codec text,
  channels integer CHECK (channels IS NULL OR channels IN (1, 2)),
  sample_rate_hz integer CHECK (sample_rate_hz IS NULL OR (sample_rate_hz BETWEEN 8000 AND 96000)),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, asset_id, generation, role),
  FOREIGN KEY (account_id, asset_id) REFERENCES media_assets (account_id, id)
);

CREATE TABLE IF NOT EXISTS audio_analysis_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  generation integer NOT NULL,
  job_id uuid,
  contract_version integer NOT NULL DEFAULT 2 CHECK (contract_version = 2),
  requested_components jsonb NOT NULL,
  selection jsonb NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','partial','complete','failed','cancelled')),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, asset_id) REFERENCES media_assets (account_id, id)
);
CREATE INDEX IF NOT EXISTS audio_analysis_reuse
  ON audio_analysis_requests (account_id, asset_id, generation, request_hash)
  WHERE state IN ('queued','running','complete','partial');

CREATE TABLE IF NOT EXISTS audio_analysis_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  generation integer NOT NULL,
  component text NOT NULL CHECK (component IN ('music_match','speech_references','soundscape')),
  state text NOT NULL
    CHECK (state IN ('not_requested','queued','running','succeeded','no_result','unavailable','failed','cancelled')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, analysis_id, component),
  FOREIGN KEY (account_id, analysis_id) REFERENCES audio_analysis_requests (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, asset_id) REFERENCES media_assets (account_id, id)
);

CREATE TABLE IF NOT EXISTS media_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  generation integer NOT NULL,
  analysis_id uuid NOT NULL,
  track_id uuid,
  modality text NOT NULL CHECK (modality IN ('audio','visual','spoken','written')),
  relationship text NOT NULL DEFAULT 'heard'
    CHECK (relationship IN ('heard','spoken','seen','written','user_confirmed','related')),
  start_ms integer,
  end_ms integer,
  method text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('matched','ambiguous','no_match','unavailable','partial')),
  recognition_id uuid,
  qloo_entity_id text,
  vendor_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, asset_id) REFERENCES media_assets (account_id, id),
  FOREIGN KEY (account_id, analysis_id) REFERENCES audio_analysis_requests (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, track_id) REFERENCES media_tracks (account_id, id),
  CHECK (start_ms IS NULL OR (start_ms >= 0 AND end_ms IS NOT NULL AND start_ms < end_ms))
);

CREATE TABLE IF NOT EXISTS recognized_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  generation integer NOT NULL,
  analysis_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  vendor text NOT NULL,
  vendor_recording_id text,
  title text,
  artist_name text,
  album_title text,
  artist_catalog_id text,
  album_catalog_id text,
  match_status text NOT NULL CHECK (match_status IN ('identified','possible_matches','no_reliable_match','provider_unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, asset_id) REFERENCES media_assets (account_id, id),
  FOREIGN KEY (account_id, analysis_id) REFERENCES audio_analysis_requests (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, evidence_id) REFERENCES media_evidence (account_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audio_entity_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  generation integer NOT NULL,
  analysis_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  qloo_entity_id text NOT NULL,
  qloo_entity_type text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('resolved','ambiguous','unresolved')),
  insights_eligible boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, asset_id) REFERENCES media_assets (account_id, id),
  FOREIGN KEY (account_id, analysis_id) REFERENCES audio_analysis_requests (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, evidence_id) REFERENCES media_evidence (account_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS saved_moments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  generation integer NOT NULL,
  start_ms integer NOT NULL CHECK (start_ms >= 0),
  end_ms integer NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, asset_id) REFERENCES media_assets (account_id, id),
  CHECK (start_ms < end_ms)
);

CREATE FUNCTION audio_analysis_forget() RETURNS trigger AS $$
BEGIN
  UPDATE audio_analysis_requests SET result = NULL
   WHERE account_id = NEW.account_id AND asset_id = NEW.id AND result IS NOT NULL;
  DELETE FROM media_evidence WHERE account_id = NEW.account_id AND asset_id = NEW.id;
  DELETE FROM recognized_recordings WHERE account_id = NEW.account_id AND asset_id = NEW.id;
  DELETE FROM audio_entity_resolutions WHERE account_id = NEW.account_id AND asset_id = NEW.id;
  DELETE FROM saved_moments WHERE account_id = NEW.account_id AND asset_id = NEW.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_assets_forget_audio ON media_assets;
CREATE TRIGGER media_assets_forget_audio
  AFTER UPDATE OF deleted_at ON media_assets
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION audio_analysis_forget();
