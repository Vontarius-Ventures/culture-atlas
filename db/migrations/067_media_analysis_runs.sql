-- Durable per-frame checkpoints for v2 media analysis (CONCENTRATE.md: "recover
-- durable stage output rather than send twice"). A validated reading is stored
-- once per analysis/frame; a dispatch whose outcome was lost is recorded as
-- 'unknown' and never re-sent. Readings are model text derived from private
-- media: they are removed when the asset is tombstoned (trigger below).
CREATE TABLE media_analysis_frames (
  account_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  -- 'photo' or the frame derivative id.
  frame_key text NOT NULL CHECK (length(frame_key) BETWEEN 1 AND 64),
  derivative_id uuid,
  timestamp_ms integer CHECK (timestamp_ms IS NULL OR timestamp_ms >= 0),
  state text NOT NULL CHECK (state IN ('complete','failed','unknown')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  retryable boolean NOT NULL DEFAULT false,
  -- Failed dispatch rounds for this frame (bounded: at most 3 HTTP attempts per frame).
  rounds integer NOT NULL DEFAULT 0 CHECK (rounds BETWEEN 0 AND 3),
  -- Dispatches refused by an AI-wide pause (402 credits / 429 throttling). They
  -- do not consume rounds; each one gets a fresh ledger attempt key.
  deferrals integer NOT NULL DEFAULT 0 CHECK (deferrals >= 0),
  reading jsonb,
  model text,
  inference_attempt_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, analysis_id, frame_key),
  FOREIGN KEY (account_id, analysis_id) REFERENCES media_analysis_requests(account_id, id) ON DELETE CASCADE,
  CHECK ((state = 'complete') = (reading IS NOT NULL))
);

-- Aggregated vision reading handed to the cultural compiler, the safe consumer
-- projection (frame citations, statuses), and why queued work is waiting.
ALTER TABLE media_analysis_requests ADD COLUMN observation jsonb;
ALTER TABLE media_analysis_requests ADD COLUMN observation_model text;
ALTER TABLE media_analysis_requests ADD COLUMN result jsonb;
ALTER TABLE media_analysis_requests ADD COLUMN waiting_reason text
  CHECK (waiting_reason IS NULL OR waiting_reason IN ('ai_paused','rate_limited'));
ALTER TABLE media_analysis_requests ADD COLUMN completed_at timestamptz;

CREATE FUNCTION media_analysis_forget() RETURNS trigger AS $$
BEGIN
  DELETE FROM media_analysis_frames f USING media_analysis_requests r
   WHERE r.account_id = NEW.account_id AND r.asset_id = NEW.id
     AND f.account_id = r.account_id AND f.analysis_id = r.id;
  UPDATE media_analysis_requests SET observation = NULL, result = NULL
   WHERE account_id = NEW.account_id AND asset_id = NEW.id
     AND (observation IS NOT NULL OR result IS NOT NULL);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER media_assets_forget_analysis
  AFTER UPDATE OF deleted_at ON media_assets
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION media_analysis_forget();
