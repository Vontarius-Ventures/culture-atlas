ALTER TABLE device_commands ADD COLUMN delivery_sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE TABLE device_command_ack_keys (
 account_id uuid NOT NULL,
 installation_id uuid NOT NULL,
 key uuid NOT NULL,
 command_id uuid NOT NULL,
 payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,installation_id,key),
 FOREIGN KEY(account_id,installation_id) REFERENCES mobile_installations(account_id,id),
 FOREIGN KEY(account_id,command_id) REFERENCES device_commands(account_id,id)
);
