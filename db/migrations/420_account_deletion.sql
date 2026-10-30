-- Account deletion lifecycle (VAL-DELETE-002/003/004).
--
-- Acceptance marks the account in ONE transaction: `accounts.deleted_at` is the
-- tombstone every publication fence checks (the same accounts row lock the
-- graph pause/publication fences take), while all the account's credentials,
-- jobs and graph flags are revoked or cancelled around it. The hard row purge
-- happens later in the durable `purge_account` job, so the tombstone also
-- covers the whole pending window.
--
-- `account_deletions` deliberately has NO foreign key to `accounts`: it is the
-- durable cleanup record that must OUTLIVE the account row the cleanup
-- deletes. It stores the random account id, the status token's SHA-256 (the
-- only credential it keeps; it restores no authority), timestamps, the honest
-- per-step progress and the last attempt's error code — never taste, photo,
-- library or collection data.

ALTER TABLE accounts ADD COLUMN deleted_at timestamptz;

CREATE INDEX accounts_deleted_at_idx ON accounts (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE account_deletions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No FK on purpose: this row survives the account row's hard delete.
  account_id             uuid NOT NULL UNIQUE,
  -- SHA-256 of the one-time status capability token (never the token itself).
  status_token_hash      text NOT NULL UNIQUE,
  requested_at           timestamptz NOT NULL,
  accepted_at            timestamptz NOT NULL,
  requested_by_session_id uuid,
  -- 'pending'   accepted; the cleanup job is queued or about to be re-armed.
  -- 'purging'   a cleanup attempt is running right now.
  -- 'failed'    the last attempt failed; the work is still owed and retried.
  -- 'complete'  every required private store is gone (the only success).
  cleanup_state          text NOT NULL DEFAULT 'pending'
                         CHECK (cleanup_state IN ('pending', 'purging', 'failed', 'complete')),
  -- Honest progress: a step appears only after it is done, in run order.
  completed_steps        text[] NOT NULL DEFAULT '{}',
  attempts               integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at        timestamptz,
  last_error_code        text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 100),
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- The sweeper's work list: deletions whose cleanup is still owed.
CREATE INDEX account_deletions_owed_idx
  ON account_deletions (accepted_at)
  WHERE cleanup_state IN ('pending', 'failed');
