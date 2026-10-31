-- Private comparison evidence; no forged recommendation origins or provider query ids.
-- One allocation per capture enforces a lifetime maximum of two even across re-analysis.
CREATE TABLE visual_reference_runs (
  capture_id uuid PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  catalog_hash text NOT NULL CHECK (catalog_hash ~ '^[a-f0-9]{64}$'),
  catalog_version text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  source_asset_hash text NOT NULL,
  reading_hash text NOT NULL CHECK (reading_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','running','ready','empty','failed','unavailable')),
  reason text,
  candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array' AND jsonb_array_length(candidates) <= 2),
  attempted_ids text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(attempted_ids) <= 2)
);
ALTER TABLE inference_attempts DROP CONSTRAINT IF EXISTS inference_attempts_role_check;
ALTER TABLE inference_attempts ADD CONSTRAINT inference_attempts_role_check CHECK (role IN (
  'vision_photo','vision_video_frame','research_text','composer','vision_photo_enrich','vision_verify','vision_style','vision_similarity'));
ALTER TABLE model_gateway_attempts DROP CONSTRAINT IF EXISTS model_gateway_attempts_role_check;
ALTER TABLE model_gateway_attempts ADD CONSTRAINT model_gateway_attempts_role_check CHECK (role IN (
  'vision_photo','vision_video_frame','research_text','composer','vision_photo_enrich','vision_verify','vision_style','vision_similarity'));
