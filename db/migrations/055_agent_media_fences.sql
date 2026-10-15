CREATE UNIQUE INDEX capture_agent_account_id ON agent_connections(owner_account_id,id);
ALTER TABLE media_assets
 ADD COLUMN created_by_agent_connection_id uuid,
 ADD COLUMN authorization_version bigint,
 ADD FOREIGN KEY(account_id,created_by_agent_connection_id) REFERENCES agent_connections(owner_account_id,id),
 ADD CHECK((created_by_agent_connection_id IS NULL)=(authorization_version IS NULL));
ALTER TABLE upload_sessions
 ADD COLUMN created_by_agent_connection_id uuid,
 ADD COLUMN authorization_version bigint,
 ADD FOREIGN KEY(account_id,created_by_agent_connection_id) REFERENCES agent_connections(owner_account_id,id),
 ADD CHECK((created_by_agent_connection_id IS NULL)=(authorization_version IS NULL));
ALTER TABLE media_analysis_requests
 ADD COLUMN created_by_agent_connection_id uuid,
 ADD COLUMN authorization_version bigint,
 ADD FOREIGN KEY(account_id,created_by_agent_connection_id) REFERENCES agent_connections(owner_account_id,id),
 ADD CHECK((created_by_agent_connection_id IS NULL)=(authorization_version IS NULL));
ALTER TABLE capture_work
 ADD COLUMN created_by_agent_connection_id uuid,
 ADD COLUMN authorization_version bigint,
 ADD FOREIGN KEY(account_id,created_by_agent_connection_id) REFERENCES agent_connections(owner_account_id,id),
 ADD CHECK((created_by_agent_connection_id IS NULL)=(authorization_version IS NULL));
