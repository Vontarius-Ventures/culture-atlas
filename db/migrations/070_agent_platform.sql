-- Additive only: existing scopes, library grants and credentials are unchanged.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
   WHERE conrelid = 'agent_connections'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%scopes%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE agent_connections DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;
ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_scopes_v2 CHECK (
 scopes <@ ARRAY['captures:read','captures:write','collections:read','collections:write',
 'taste:read','taste:write','plans:read','plans:write','setup:read','preferences:read',
 'preferences:write','media:read','media:download','media:write','media:analyze','devices:command']::text[]);
ALTER TABLE agent_connections
 ADD COLUMN authorization_version integer NOT NULL DEFAULT 1,
 ADD COLUMN installation_ids uuid[] NOT NULL DEFAULT '{}',
 ADD CONSTRAINT agent_connections_owner_pair UNIQUE (owner_account_id, id);
ALTER TABLE accounts ADD COLUMN preferences_version integer NOT NULL DEFAULT 1;

CREATE TABLE agent_activity (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL,
 action text NOT NULL,
 target_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (account_id, connection_id) REFERENCES agent_connections(owner_account_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_activity_account_idx ON agent_activity(account_id,created_at DESC,id);

CREATE TABLE agent_rate_windows (
 connection_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
 window_at timestamptz NOT NULL,
 mutation boolean NOT NULL,
 count integer NOT NULL,
 PRIMARY KEY(connection_id,window_at,mutation)
);

-- Clients are operator registered. No public client-credentials or dynamic
-- registration endpoint may create an account principal.
CREATE TABLE agent_oauth_clients (
 id text PRIMARY KEY,
 name text NOT NULL,
 redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) > 0)
);
CREATE TABLE agent_oauth_codes (
 code_hash text PRIMARY KEY,
 client_id text NOT NULL REFERENCES agent_oauth_clients(id),
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL,
 redirect_uri text NOT NULL,
 code_challenge text NOT NULL,
 resource text NOT NULL,
 state_hash text NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 FOREIGN KEY(account_id,connection_id) REFERENCES agent_connections(owner_account_id,id) ON DELETE CASCADE
);
CREATE TABLE agent_oauth_families (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id text NOT NULL REFERENCES agent_oauth_clients(id),
 connection_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
 resource text NOT NULL,
 authorization_version integer NOT NULL,
 created_at timestamptz NOT NULL,
 absolute_expires_at timestamptz NOT NULL,
 idle_expires_at timestamptz NOT NULL,
 revoked_at timestamptz
);
CREATE TABLE agent_oauth_refresh_tokens (
 token_hash text PRIMARY KEY,
 family_id uuid NOT NULL REFERENCES agent_oauth_families(id) ON DELETE CASCADE,
 consumed_at timestamptz
);
CREATE TABLE agent_oauth_access_tokens (
 token_hash text PRIMARY KEY,
 family_id uuid NOT NULL REFERENCES agent_oauth_families(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
