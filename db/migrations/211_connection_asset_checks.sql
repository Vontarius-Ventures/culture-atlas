-- Independent single-candidate asset checks. Never modifies visual_reference_runs,
-- historical attempts, source allowances, or their lifetime-two comparison limit.
ALTER TABLE inference_attempts DROP CONSTRAINT inference_attempts_role_check;
ALTER TABLE inference_attempts ADD CONSTRAINT inference_attempts_role_check CHECK (role IN (
  'vision_photo','vision_video_frame','research_text','composer','vision_photo_enrich',
  'vision_verify','vision_style','vision_similarity','vision_connection_asset'));
ALTER TABLE model_gateway_attempts DROP CONSTRAINT model_gateway_attempts_role_check;
ALTER TABLE model_gateway_attempts ADD CONSTRAINT model_gateway_attempts_role_check CHECK (role IN (
  'vision_photo','vision_video_frame','research_text','composer','vision_photo_enrich',
  'vision_verify','vision_style','vision_similarity','vision_connection_asset'));

-- Capture-lifetime slots are stricter than a per-analysis quota: a restart,
-- second subject, reanalysis, profile change or hidden retry cannot reset three.
CREATE TABLE connection_asset_checks (
  capture_id uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 3),
  -- Keep burned capture slots without blocking privacy/retention deletion of
  -- analyses or jobs. A missing historical binding can never be published again.
  analysis_id uuid REFERENCES analyses(id) ON DELETE SET NULL,
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  candidate_id text NOT NULL CHECK (length(candidate_id) BETWEEN 1 AND 200),
  image_url text NOT NULL CHECK (length(image_url)<=2048 AND image_url ~
    '^https://images[.]qloo[.]com/i/[A-Za-z0-9_-]+[.](jpg|jpeg|png|webp)$'),
  checker_version text NOT NULL CHECK (length(checker_version) BETWEEN 1 AND 100),
  request_binding text NOT NULL CHECK (request_binding ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('allocated','complete','failed')),
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(capture_id,slot),
  UNIQUE(capture_id,candidate_id,image_url,checker_version),
  CHECK ((state='complete') = (evidence IS NOT NULL)),
  CHECK (evidence IS NULL OR COALESCE((jsonb_typeof(evidence)='object'
    AND evidence->>'version'='connection_asset_evidence_v1'
    AND evidence->>'candidateId'=candidate_id AND evidence->>'imageUrl'=image_url
    AND evidence->>'checkerVersion'=checker_version
    AND evidence->>'originalSha256' ~ '^[a-f0-9]{64}$'
    AND evidence->>'modelInputSha256' ~ '^[a-f0-9]{64}$'
    AND evidence->>'identity' IN ('corroborated','contradicted','unknown')
    AND evidence->>'image' IN ('available','placeholder','unavailable')
    AND (evidence->>'image'='available' OR evidence->>'identity'='unknown')),false))
);
CREATE TABLE connection_asset_fetch_control (
  id integer PRIMARY KEY CHECK(id=1),
  last_started_at timestamptz,
  stop_status integer CHECK(stop_status IN (401,403,429,503))
);
INSERT INTO connection_asset_fetch_control(id) VALUES(1);
-- A stop is deliberately sticky across workers/restarts. Operator review is
-- required before any explicit resume; the checker never clears this field.
