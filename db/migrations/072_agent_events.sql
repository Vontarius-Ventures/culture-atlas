CREATE TABLE agent_platform_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 resource_kind text NOT NULL CHECK(resource_kind IN ('media','command','preferences')),
 resource_id uuid NOT NULL,
 status text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_platform_events_account ON agent_platform_events(account_id,sequence);
CREATE INDEX agent_platform_events_retention ON agent_platform_events(created_at);
CREATE FUNCTION record_agent_media_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO agent_platform_events(account_id,resource_kind,resource_id,status)
 VALUES(NEW.account_id,'media',NEW.id,NEW.status);
 RETURN NEW;
END $$;
CREATE TRIGGER agent_media_event AFTER INSERT OR UPDATE OF status,generation,hidden_at
 ON media_assets FOR EACH ROW EXECUTE FUNCTION record_agent_media_event();
CREATE FUNCTION record_agent_command_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO agent_platform_events(account_id,resource_kind,resource_id,status)
 VALUES(NEW.account_id,'command',NEW.id,NEW.state);
 RETURN NEW;
END $$;
CREATE TRIGGER agent_command_event AFTER INSERT OR UPDATE OF state
 ON device_commands FOR EACH ROW EXECUTE FUNCTION record_agent_command_event();
CREATE FUNCTION record_agent_preferences_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO agent_platform_events(account_id,resource_kind,resource_id,status)
 VALUES(NEW.id,'preferences',NEW.id,'changed');
 RETURN NEW;
END $$;
CREATE TRIGGER agent_preferences_event AFTER UPDATE OF preferences_version
 ON accounts FOR EACH ROW EXECUTE FUNCTION record_agent_preferences_event();
