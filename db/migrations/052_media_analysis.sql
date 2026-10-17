ALTER TABLE capture_work DROP CONSTRAINT capture_work_kind_check;
ALTER TABLE capture_work ADD CHECK(kind IN ('verify_upload','prepare_media','purge_media','cleanup_upload','analyze_media'));
-- Distinct user-requested analysis revisions do not change the media generation.
ALTER TABLE capture_work DROP CONSTRAINT capture_work_account_id_asset_id_generation_kind_key;
ALTER TABLE capture_work ADD COLUMN analysis_id uuid;
CREATE UNIQUE INDEX capture_work_preparation_once ON capture_work(account_id,asset_id,generation,kind) WHERE analysis_id IS NULL;
CREATE UNIQUE INDEX capture_work_analysis_once ON capture_work(account_id,analysis_id) WHERE analysis_id IS NOT NULL;
CREATE TABLE media_analysis_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  generation integer NOT NULL,
  mode text NOT NULL CHECK(mode IN ('photo','selected_frame','sampled_video')),
  focus text NOT NULL DEFAULT '',
  selected_frames jsonb NOT NULL,
  extraction_version text,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','partial','complete','failed','cancelled')),
  capture_id uuid REFERENCES captures(id),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,id),
  FOREIGN KEY(account_id,asset_id) REFERENCES media_assets(account_id,id)
);
CREATE INDEX media_analysis_reuse ON media_analysis_requests(account_id,asset_id,generation,request_hash)
 WHERE state IN ('queued','running','complete','partial');
ALTER TABLE capture_work ADD FOREIGN KEY(account_id,analysis_id) REFERENCES media_analysis_requests(account_id,id);
