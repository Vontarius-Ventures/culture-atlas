-- Collection sharing (AGENTS-AND-SHARING "Sharing storage and transport").
-- A share is a read-only audience grant, separate from agent grants. It never
-- conveys device, agent or owner authority. Every table carries the owner and
-- uses owner-composite foreign keys, so a row can never point across accounts.
-- Only hashes of bearer secrets are stored.

CREATE TABLE collection_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Set to NULL (and the share revoked first, see trigger below) when the
  -- collection is deleted, so the revocation and its audit trail survive.
  collection_id uuid,
  audience text NOT NULL CHECK (audience IN ('restricted', 'link')),
  token_hash text UNIQUE,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason IN ('owner', 'collection_deleted', 'replaced')),
  include_media boolean NOT NULL DEFAULT false,
  allow_originals boolean NOT NULL DEFAULT false,
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_account_id, id),
  FOREIGN KEY (collection_id, owner_account_id)
    REFERENCES collections(id, owner_account_id) ON DELETE SET NULL (collection_id),
  -- Link shares are bearer audiences and always expire; restricted shares are
  -- bounded by membership instead and carry no bearer secret.
  CHECK ((audience = 'link') = (token_hash IS NOT NULL)),
  CHECK (audience <> 'link' OR expires_at IS NOT NULL),
  -- Originals are an additional option on top of included media.
  CHECK (NOT allow_originals OR include_media),
  CHECK (collection_id IS NOT NULL OR revoked_at IS NOT NULL)
);
CREATE INDEX collection_shares_collection_idx ON collection_shares (owner_account_id, collection_id, created_at DESC);
-- At most one live restricted audience per collection; invitations attach to it.
CREATE UNIQUE INDEX collection_shares_one_restricted ON collection_shares (collection_id)
  WHERE audience = 'restricted' AND revoked_at IS NULL;

CREATE TABLE collection_share_members (
  share_id uuid NOT NULL,
  owner_account_id uuid NOT NULL,
  verified_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'viewer' CHECK (role = 'viewer'),
  invite_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (share_id, verified_account_id),
  FOREIGN KEY (owner_account_id, share_id) REFERENCES collection_shares(owner_account_id, id) ON DELETE CASCADE,
  -- Owners never become viewers of their own collection.
  CHECK (verified_account_id <> owner_account_id)
);
CREATE INDEX collection_share_members_viewer_idx ON collection_share_members (verified_account_id);

CREATE TABLE share_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL,
  share_id uuid NOT NULL,
  -- HMAC of the normalized recipient email; the address itself is not stored.
  normalized_email_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_account_id, id),
  FOREIGN KEY (owner_account_id, share_id) REFERENCES collection_shares(owner_account_id, id) ON DELETE CASCADE
);
CREATE INDEX share_invites_share_idx ON share_invites (share_id, created_at DESC);

-- A redeemed bearer link becomes an HttpOnly cookie session. The cookie holds
-- a fresh random token (never the link secret); only its hash is stored.
CREATE TABLE share_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL,
  share_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (owner_account_id, share_id) REFERENCES collection_shares(owner_account_id, id) ON DELETE CASCADE
);
CREATE INDEX share_sessions_share_idx ON share_sessions (share_id);

-- Per-address redemption windows (generic limit; addresses are hashed).
CREATE TABLE share_redeem_windows (
  bucket text NOT NULL,
  window_at timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (bucket, window_at)
);

-- Owner-visible audit trail for sharing. Never stores tokens, emails or media.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  actor text NOT NULL CHECK (actor IN ('owner', 'viewer', 'link', 'system')),
  actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  action text NOT NULL,
  share_id uuid,
  collection_id uuid,
  target_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, share_id) REFERENCES collection_shares(owner_account_id, id) ON DELETE CASCADE
);
CREATE INDEX audit_events_account_idx ON audit_events (account_id, created_at DESC, id);

-- Deleting a collection revokes all of its shares, invitations and sessions in
-- the same transaction, before the foreign key detaches the share rows.
CREATE FUNCTION revoke_collection_shares() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_events (account_id, actor, action, share_id, collection_id)
    SELECT owner_account_id, 'system', 'share.revoked_collection_deleted', id, OLD.id
      FROM collection_shares WHERE collection_id = OLD.id AND revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = owner_account_id);
  UPDATE collection_shares SET revoked_at = now(), revoke_reason = 'collection_deleted', updated_at = now(),
         policy_version = policy_version + 1
   WHERE collection_id = OLD.id AND revoked_at IS NULL;
  UPDATE share_invites SET revoked_at = COALESCE(revoked_at, now())
   WHERE share_id IN (SELECT id FROM collection_shares WHERE collection_id = OLD.id);
  UPDATE share_sessions SET revoked_at = COALESCE(revoked_at, now())
   WHERE share_id IN (SELECT id FROM collection_shares WHERE collection_id = OLD.id);
  RETURN OLD;
END $$;
CREATE TRIGGER collection_share_revocation BEFORE DELETE ON collections
  FOR EACH ROW EXECUTE FUNCTION revoke_collection_shares();
