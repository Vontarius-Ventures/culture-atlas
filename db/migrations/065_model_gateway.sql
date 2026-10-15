-- Independent AI ledger. No media foreign key/cascade: AI pauses cannot remove assets.
-- The singleton row is locked before every budget decision across all workers.
CREATE TABLE model_gateway_control (
  id integer PRIMARY KEY CHECK (id = 1),
  pause jsonb
);
INSERT INTO model_gateway_control (id, pause) VALUES (1, NULL);

CREATE TABLE model_gateway_attempts (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  -- Queue integration supplies verified server-owned identity. Kept independent
  -- of legacy jobs so v2 queue implementation does not change this ledger.
  job_id text NOT NULL CHECK (length(job_id) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('vision_photo','vision_video_frame','research_text','composer')),
  attempt_key text NOT NULL CHECK (length(attempt_key) BETWEEN 1 AND 240),
  state text NOT NULL CHECK (state IN ('reserved','unknown','settled')),
  started_at timestamptz NOT NULL,
  -- Safe operational metadata only: no prompts, outputs, images, keys or error bodies.
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  UNIQUE (account_id, job_id, role, attempt_key)
);
CREATE INDEX model_gateway_attempts_owner_day_idx ON model_gateway_attempts (account_id, started_at);
CREATE INDEX model_gateway_attempts_outstanding_idx ON model_gateway_attempts (state) WHERE state <> 'settled';
