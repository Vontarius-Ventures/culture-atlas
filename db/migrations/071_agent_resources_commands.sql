CREATE TABLE collection_media_items (
 account_id uuid NOT NULL,
 collection_id uuid NOT NULL,
 asset_id uuid NOT NULL,
 added_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(collection_id,asset_id),
 FOREIGN KEY(collection_id,account_id) REFERENCES collections(id,owner_account_id) ON DELETE CASCADE,
 FOREIGN KEY(account_id,asset_id) REFERENCES media_assets(account_id,id) ON DELETE CASCADE
);
-- Reconciled with 055_agent_media_fences.sql (merged from a parallel line):
-- 055 may already have added the agent creator column and its owner-scoped
-- foreign key. Both are guarded so either application order converges on one
-- column and one foreign key.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS created_by_agent_connection_id uuid;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'media_assets'::regclass AND contype = 'f'
       AND confrelid = 'agent_connections'::regclass
       AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (account_id, created_by_agent_connection_id)%'
  ) THEN
    ALTER TABLE media_assets ADD FOREIGN KEY(account_id,created_by_agent_connection_id)
     REFERENCES agent_connections(owner_account_id,id);
  END IF;
END $$;
CREATE TABLE agent_media_uploads (
 account_id uuid NOT NULL,
 upload_id uuid PRIMARY KEY,
 connection_id uuid NOT NULL,
 destination_collection_id uuid,
 authorization_version integer NOT NULL,
 FOREIGN KEY(account_id,upload_id) REFERENCES upload_sessions(account_id,id),
 FOREIGN KEY(account_id,connection_id) REFERENCES agent_connections(owner_account_id,id),
 FOREIGN KEY(destination_collection_id,account_id) REFERENCES collections(id,owner_account_id)
);
CREATE TABLE device_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL,
 installation_id uuid NOT NULL,
 capture_session_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 authorization_version integer NOT NULL,
 generation integer NOT NULL,
 action text NOT NULL CHECK(action IN ('capture_photo','start_video','stop_video')),
 duration_seconds integer CHECK(duration_seconds BETWEEN 1 AND 60),
 capture_client_id uuid NOT NULL,
 idempotency_key uuid NOT NULL,
 payload_hash text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN
  ('queued','delivered','awaiting_user','executing','succeeded','failed','expired','cancelled','unknown')),
 expires_at timestamptz NOT NULL,
 result_asset_id uuid,
 error_code text,
 ack_sequence bigint NOT NULL DEFAULT -1,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,id),
 UNIQUE(account_id,connection_id,idempotency_key),
 FOREIGN KEY(account_id,installation_id) REFERENCES mobile_installations(account_id,id),
 FOREIGN KEY(account_id,capture_session_id) REFERENCES capture_sessions(account_id,id),
 FOREIGN KEY(account_id,connection_id) REFERENCES agent_connections(owner_account_id,id),
 FOREIGN KEY(account_id,result_asset_id) REFERENCES media_assets(account_id,id)
);
CREATE UNIQUE INDEX device_one_active_start ON device_commands(capture_session_id)
 WHERE action IN ('capture_photo','start_video') AND state IN ('queued','delivered','awaiting_user','executing');
