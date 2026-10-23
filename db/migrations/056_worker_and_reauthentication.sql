CREATE TABLE media_worker_capabilities (
 worker_id text PRIMARY KEY CHECK(length(worker_id) BETWEEN 1 AND 200),
 qualified_matrix_version text NOT NULL CHECK(length(qualified_matrix_version) BETWEEN 1 AND 200),
 codecs jsonb NOT NULL,
 heartbeat_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mobile_installations ADD COLUMN authority_ended_at timestamptz;
ALTER TABLE upload_sessions ADD COLUMN authority_ended_at timestamptz;
ALTER TABLE upload_sessions ADD COLUMN pause_reason text CHECK(pause_reason IS NULL OR pause_reason='authority_ended');
ALTER TABLE upload_sessions ADD COLUMN paused_from_state text;
ALTER TABLE upload_sessions DROP CONSTRAINT upload_sessions_state_check;
ALTER TABLE upload_sessions ADD CHECK(state IN ('created','uploading','verifying','committed','aborted','expired','rejected','paused'));
DROP INDEX upload_one_active;
CREATE UNIQUE INDEX upload_one_active ON upload_sessions(account_id,asset_id) WHERE state IN ('created','uploading','verifying','paused','committed');
