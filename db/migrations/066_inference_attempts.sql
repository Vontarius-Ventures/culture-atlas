-- inference_attempts: the BACKEND-CONTRACTS record for every model-gateway HTTP
-- attempt. Supersedes the jsonb payload table from 065 with typed columns so the
-- ledger can lock and load only the rows a decision needs (today, unsettled,
-- or the target attempt) instead of the whole history.
-- No media foreign key or cascade: AI accounting never blocks or removes assets.
-- Safe operational metadata only: no prompts, outputs, images, keys or error bodies.
CREATE TABLE inference_attempts (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  job_id text NOT NULL CHECK (length(job_id) BETWEEN 1 AND 200),
  asset_id text CHECK (asset_id IS NULL OR length(asset_id) BETWEEN 1 AND 200),
  queue_attempt_id text CHECK (queue_attempt_id IS NULL OR length(queue_attempt_id) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('vision_photo','vision_video_frame','research_text','composer')),
  attempt_key text NOT NULL CHECK (length(attempt_key) BETWEEN 1 AND 240),
  gateway text NOT NULL,
  requested_model text NOT NULL,
  requested_provider text NOT NULL,
  returned_model text,
  -- NULL means the gateway did not disclose the upstream provider; never inferred.
  actual_provider text,
  profile_version text NOT NULL,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  pricing_snapshot_version text NOT NULL,
  response_id text,
  request_id text,
  -- Token usage is nullable: missing usage is unknown, never zero.
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  -- Worst-case reservation against the pricing snapshot (integer millionths of USD).
  reserved_micros bigint NOT NULL CHECK (reserved_micros > 0),
  -- Reconciled actual charge from billing evidence; NULL is unknown.
  cost_micros bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
  state text NOT NULL CHECK (state IN ('reserved','unknown','settled')),
  outcome text NOT NULL CHECK (length(outcome) BETWEEN 1 AND 64),
  usage_day date NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  settled_at timestamptz,
  UNIQUE (account_id, job_id, role, attempt_key),
  CHECK ((state = 'settled') = (cost_micros IS NOT NULL))
);
CREATE INDEX inference_attempts_day_idx ON inference_attempts (usage_day);
CREATE INDEX inference_attempts_account_day_idx ON inference_attempts (account_id, usage_day);
CREATE INDEX inference_attempts_unsettled_idx ON inference_attempts (state) WHERE state <> 'settled';
CREATE INDEX inference_attempts_job_idx ON inference_attempts (account_id, job_id);

-- Carry over any ledger rows written by 065 so reservations and unknown
-- charges stay counted across the upgrade.
INSERT INTO inference_attempts (
  id, account_id, job_id, asset_id, queue_attempt_id, role, attempt_key, gateway,
  requested_model, requested_provider, returned_model, actual_provider,
  profile_version, prompt_version, schema_version, pricing_snapshot_version,
  response_id, request_id, input_tokens, output_tokens, reserved_micros, cost_micros,
  state, outcome, usage_day, started_at, completed_at
)
SELECT
  a.id, a.account_id, a.job_id,
  a.payload #>> '{identity,assetId}', a.payload #>> '{identity,queueAttemptId}',
  a.role, a.attempt_key, COALESCE(a.payload->>'gateway', 'concentrate'),
  COALESCE(a.payload->>'requestedModel', 'unknown'), COALESCE(a.payload->>'requestedProvider', 'unknown'),
  a.payload->>'returnedModel', a.payload->>'actualProvider',
  COALESCE(a.payload->>'profileVersion', 'unknown'), COALESCE(a.payload->>'promptVersion', 'unknown'),
  COALESCE(a.payload->>'schemaVersion', 'unknown'), COALESCE(a.payload->>'pricingSnapshotVersion', 'unknown'),
  a.payload->>'responseId', NULL,
  (a.payload #>> '{usage,inputTokens}')::integer, (a.payload #>> '{usage,outputTokens}')::integer,
  GREATEST(COALESCE((a.payload->>'reservedMicros')::bigint, 1), 1),
  CASE WHEN a.state = 'settled' THEN COALESCE((a.payload->>'costMicros')::bigint, 0) END,
  a.state, LEFT(COALESCE(a.payload->>'outcome', 'migrated'), 64),
  COALESCE((a.payload->>'day')::date, a.started_at::date), a.started_at,
  CASE WHEN a.payload->>'completedAt' IS NOT NULL
       THEN to_timestamp((a.payload->>'completedAt')::double precision / 1000) END
FROM model_gateway_attempts a
ON CONFLICT DO NOTHING;

COMMENT ON TABLE model_gateway_attempts IS
  'Superseded by inference_attempts (066). Retained unchanged for rollback; no longer written.';

-- Durable per-role circuits (auth / unknown model / policy route). Cleared only
-- by an explicit operator resume after re-qualification.
ALTER TABLE model_gateway_control ADD COLUMN IF NOT EXISTS circuits jsonb NOT NULL DEFAULT '{}'::jsonb;
