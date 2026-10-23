-- Additive v2 storage. Account equality is structural, never UUID secrecy.
CREATE TABLE mobile_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  installation_public_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  app_version text NOT NULL,
  auth_session_id uuid REFERENCES sessions(id),
  capabilities jsonb NOT NULL DEFAULT '{}',
  readiness text NOT NULL DEFAULT 'unavailable' CHECK (readiness IN ('unavailable','user_action_required','ready')),
  app_state text NOT NULL DEFAULT 'terminated' CHECK (app_state IN ('foreground','background','terminated')),
  status_sequence bigint NOT NULL DEFAULT -1,
  revision integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,id),
  UNIQUE(account_id,installation_public_id)
);
CREATE TABLE capture_enrollment_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id),
  session_id text NOT NULL,
  installation_public_id uuid NOT NULL,
  proof_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE wearable_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  sdk_reference_hash text NOT NULL,
  display_name text NOT NULL,
  capabilities jsonb NOT NULL,
  permission_state text NOT NULL CHECK (permission_state IN ('unknown','denied','granted')),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  UNIQUE(account_id,id),
  FOREIGN KEY(account_id,installation_id) REFERENCES mobile_installations(account_id,id)
);
CREATE TABLE capture_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  wearable_connection_id uuid,
  local_session_id uuid,
  source text NOT NULL CHECK (source IN ('phone_camera','meta_glasses')),
  media_mode text NOT NULL CHECK (media_mode IN ('photo','video')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','ended')),
  generation integer NOT NULL DEFAULT 1,
  remote_arm_expires_at timestamptz,
  allowed_agent_connection_ids uuid[] NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  UNIQUE(account_id,id),
  UNIQUE(account_id,installation_id,local_session_id),
  FOREIGN KEY(account_id,installation_id) REFERENCES mobile_installations(account_id,id),
  FOREIGN KEY(account_id,wearable_connection_id) REFERENCES wearable_connections(account_id,id)
);
CREATE TABLE device_events (
  account_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  sequence bigint NOT NULL,
  event_type text NOT NULL,
  safe_payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(installation_id,sequence),
  FOREIGN KEY(account_id,installation_id) REFERENCES mobile_installations(account_id,id)
);
CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  installation_id uuid,
  client_capture_id uuid NOT NULL,
  capture_session_id uuid,
  kind text NOT NULL CHECK (kind IN ('photo','video')),
  source text NOT NULL CHECK (source IN ('browser_camera','phone_camera','meta_glasses','upload','legacy_sensor')),
  status text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload','verifying','processing','ready','failed','deleted')),
  analysis_status text NOT NULL DEFAULT 'not_requested',
  title text,
  original_key text,
  sha256 text,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  content_type text NOT NULL,
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  duration_ms integer CHECK (duration_ms > 0 AND duration_ms <= 120000),
  container text,
  codecs jsonb,
  audio_present boolean,
  audio_source text,
  captured_at timestamptz,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  generation integer NOT NULL DEFAULT 1,
  revision integer NOT NULL DEFAULT 1,
  error_code text,
  legacy_capture_id uuid UNIQUE REFERENCES captures(id),
  UNIQUE(account_id,id),
  UNIQUE(account_id,client_capture_id),
  FOREIGN KEY(account_id,installation_id) REFERENCES mobile_installations(account_id,id),
  FOREIGN KEY(account_id,capture_session_id) REFERENCES capture_sessions(account_id,id)
);
CREATE INDEX media_library_idx ON media_assets(account_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  installation_id uuid,
  authority_session_id text,
  state text NOT NULL DEFAULT 'created' CHECK(state IN ('created','uploading','verifying','committed','aborted','expired','rejected')),
  staging_key text NOT NULL UNIQUE,
  provider_multipart_id text,
  expected_bytes bigint NOT NULL CHECK(expected_bytes > 0),
  expected_sha256 text NOT NULL,
  reserved_bytes bigint NOT NULL CHECK(reserved_bytes >= expected_bytes),
  request_hash text NOT NULL,
  part_receipts jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz NOT NULL,
  committed_version text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,id),
  FOREIGN KEY(account_id,asset_id) REFERENCES media_assets(account_id,id),
  FOREIGN KEY(account_id,installation_id) REFERENCES mobile_installations(account_id,id)
);
CREATE UNIQUE INDEX upload_one_active ON upload_sessions(account_id,asset_id) WHERE state IN ('created','uploading','verifying','committed');
CREATE TABLE usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  upload_id uuid NOT NULL UNIQUE,
  resource text NOT NULL DEFAULT 'media_bytes',
  amount bigint NOT NULL CHECK(amount >= 0),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released','unknown')),
  FOREIGN KEY(account_id,upload_id) REFERENCES upload_sessions(account_id,id)
);
CREATE TABLE media_derivatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  generation integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('normalized','playback','poster','frame')),
  processing_version text NOT NULL,
  object_key text NOT NULL UNIQUE,
  checksum text NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size >= 0),
  width integer NOT NULL CHECK(width > 0),
  height integer NOT NULL CHECK(height > 0),
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,id),
  UNIQUE(account_id,asset_id,generation,kind,processing_version),
  FOREIGN KEY(account_id,asset_id) REFERENCES media_assets(account_id,id)
);
CREATE TABLE media_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  frame_derivative_id uuid NOT NULL,
  timestamp_ms integer NOT NULL CHECK(timestamp_ms >= 0),
  extraction_version text NOT NULL,
  FOREIGN KEY(account_id,asset_id) REFERENCES media_assets(account_id,id),
  FOREIGN KEY(account_id,frame_derivative_id) REFERENCES media_derivatives(account_id,id)
);
-- This table is both transactional outbox and durable queue. No broker required.
CREATE TABLE capture_work (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  asset_id uuid,
  upload_id uuid,
  generation integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('verify_upload','prepare_media','purge_media','cleanup_upload')),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','complete','failed','cancelled')),
  attempt_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_code text,
  UNIQUE(account_id,asset_id,generation,kind),
  FOREIGN KEY(account_id,asset_id) REFERENCES media_assets(account_id,id),
  FOREIGN KEY(account_id,upload_id) REFERENCES upload_sessions(account_id,id)
);
CREATE INDEX capture_work_claim ON capture_work(available_at,created_at) WHERE state IN ('queued','running');
CREATE TABLE capture_v2_idempotency (
  account_id uuid NOT NULL REFERENCES accounts(id),
  authority text NOT NULL,
  operation text NOT NULL,
  key uuid NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,authority,operation,key)
);
ALTER TABLE captures ADD COLUMN media_asset_id uuid REFERENCES media_assets(id);
-- Keep historical keys verbatim. Never reconstruct/move session-era objects.
INSERT INTO media_assets(account_id,client_capture_id,kind,source,status,original_key,sha256,
                         byte_size,content_type,created_at,received_at,legacy_capture_id)
 SELECT owner_account_id,id,'photo','legacy_sensor',
        CASE WHEN deleted_at IS NOT NULL THEN 'deleted' ELSE 'ready' END,
        original_object_key,image_sha256,0,'image/jpeg',created_at,received_at,id
 FROM captures WHERE owner_account_id IS NOT NULL;
UPDATE captures c SET media_asset_id = m.id FROM media_assets m WHERE m.legacy_capture_id = c.id;
