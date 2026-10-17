-- Reconciled with 070/071 (merged from a parallel line). Deployments that
-- applied 070-073 before this file already have media_assets.created_by_agent_connection_id
-- and an owner-scoped unique key on agent_connections, so every object here is
-- guarded and agent-created rows are backfilled before the pairing check.
CREATE UNIQUE INDEX IF NOT EXISTS capture_agent_account_id ON agent_connections(owner_account_id,id);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['media_assets','upload_sessions','media_analysis_requests','capture_work'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_by_agent_connection_id uuid', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS authorization_version bigint', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = t::regclass AND contype = 'f'
         AND confrelid = 'agent_connections'::regclass
         AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (account_id, created_by_agent_connection_id)%'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY(account_id,created_by_agent_connection_id)
        REFERENCES agent_connections(owner_account_id,id)', t);
    END IF;
  END LOOP;
  -- Only the 070/071 line can have written agent creators before this runs. It
  -- recorded the grant version per upload in agent_media_uploads; anything
  -- without a recorded version gets 0, which no live grant matches (fail closed).
  IF to_regclass('agent_media_uploads') IS NOT NULL THEN
    EXECUTE 'UPDATE media_assets m SET authorization_version = u.authorization_version
               FROM agent_media_uploads u JOIN upload_sessions s ON s.id = u.upload_id
              WHERE s.asset_id = m.id AND s.account_id = m.account_id
                AND m.created_by_agent_connection_id IS NOT NULL AND m.authorization_version IS NULL';
  END IF;
  UPDATE media_assets SET authorization_version = 0
   WHERE created_by_agent_connection_id IS NOT NULL AND authorization_version IS NULL;
  FOREACH t IN ARRAY ARRAY['media_assets','upload_sessions','media_analysis_requests','capture_work'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = t::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%created_by_agent_connection_id IS NULL%authorization_version IS NULL%'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CHECK((created_by_agent_connection_id IS NULL)=(authorization_version IS NULL))', t);
    END IF;
  END LOOP;
END $$;
