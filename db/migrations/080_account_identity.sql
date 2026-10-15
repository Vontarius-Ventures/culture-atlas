-- Verified identity is additive. Never infer verification from legacy demo credentials.
CREATE TABLE account_emails (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE CHECK (char_length(email) BETWEEN 3 AND 254),
  verified_at timestamptz NOT NULL
);
ALTER TABLE sessions ADD COLUMN authenticated_at timestamptz;

CREATE TABLE identity_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  initiating_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('sign_in','verify','recover')),
  destination text NOT NULL CHECK (destination IN ('web','ios','android')),
  token_hash text NOT NULL UNIQUE,
  state_hash text NOT NULL,
  nonce_hash text NOT NULL,
  code_challenge text NOT NULL,
  claim_session boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX identity_challenges_expiry_idx ON identity_challenges(expires_at);

-- A native proof is not an API credential and cannot act before enrollment.
CREATE TABLE native_enrollment_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  authenticated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE native_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  authenticated_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  UNIQUE (account_id,id)
);
CREATE INDEX native_sessions_installation_idx ON native_sessions(account_id,installation_id);
CREATE TABLE native_refresh_tokens (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES native_sessions(id) ON DELETE CASCADE,
  consumed_at timestamptz,
  rotation_key_hash text,
  successor_hash text,
  invalidated_at timestamptz
);
CREATE TABLE native_access_tokens (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES native_sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  refresh_hash text NOT NULL REFERENCES native_refresh_tokens(token_hash) ON DELETE CASCADE,
  used_at timestamptz
);

-- Durable integration outbox. P1 fences capture/upload authority in the SAME
-- transaction using its registered lifecycle hook, then can notify clients.
CREATE TABLE identity_authority_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  installation_id uuid,
  session_id uuid,
  reason text NOT NULL,
  created_at timestamptz NOT NULL
);
