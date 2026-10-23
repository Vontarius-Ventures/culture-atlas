-- Operator kill switches (global or per account) and installation push references.
-- Additive only. A kill can only turn a feature OFF; nothing here can enable a
-- feature whose activation rule (specs/capture-platform-v2/feature-flags.json)
-- is not met. Library reads, deletion and already captured media never depend
-- on these rows.
CREATE TABLE IF NOT EXISTS feature_flag_kills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  flag text NOT NULL CHECK (flag IN (
    'camera_photo','camera_video','file_photo_upload','file_video_upload',
    'meta_glasses_capture_enabled','meta_glasses_audio_enabled','remote_glasses_capture_enabled',
    'concentrate_analysis_enabled','automatic_analysis','native_video_model_input',
    'agent_api_enabled','collection_sharing_enabled','agent_remote_capture_enabled')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS feature_flag_kills_active
  ON feature_flag_kills ((COALESCE(account_id,'00000000-0000-0000-0000-000000000000'::uuid)), flag)
  WHERE lifted_at IS NULL;

-- APNs/FCM device tokens are stored encrypted (AES-256-GCM, installation id as
-- associated data) and only ever used to send an opaque wake reference.
ALTER TABLE mobile_installations ADD COLUMN IF NOT EXISTS push_provider text
  CHECK (push_provider IN ('apns','fcm'));
ALTER TABLE mobile_installations ADD COLUMN IF NOT EXISTS push_environment text
  CHECK (push_environment IN ('production','sandbox'));
ALTER TABLE mobile_installations ADD COLUMN IF NOT EXISTS push_token_ciphertext bytea;
ALTER TABLE mobile_installations ADD COLUMN IF NOT EXISTS push_token_key_id text;
ALTER TABLE mobile_installations ADD COLUMN IF NOT EXISTS push_updated_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mobile_installations_push_pairing') THEN
    ALTER TABLE mobile_installations ADD CONSTRAINT mobile_installations_push_pairing CHECK (
      (push_provider IS NULL AND push_token_ciphertext IS NULL AND push_environment IS NULL)
      OR (push_provider IS NOT NULL AND push_token_ciphertext IS NOT NULL AND push_token_key_id IS NOT NULL
          AND push_environment IS NOT NULL));
  END IF;
END $$;
