-- World Sensor import state (sensor-ops stream, range 040-049).
--
-- pending_selection: existing photos the operator explicitly selected when
--   connecting; only these are imported from the photos that already existed.
-- baseline_at: set once every photo that existed at connection time has been
--   classified (selected -> imported, others -> sensor_imports 'skipped').
-- consecutive_failures: drives poll backoff while the relay is offline.
-- last_imported_at: when the last photo was imported (connection settings).

ALTER TABLE sensor_connections
  ADD COLUMN pending_selection    text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN baseline_at          timestamptz,
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN last_imported_at     timestamptz;

-- Finds the active poll job for a connection (one poll chain per connection).
CREATE INDEX jobs_sensor_poll_active_idx
  ON jobs ((payload->>'sensor_connection_id'))
  WHERE type = 'sensor_poll' AND state IN ('queued', 'running');

CREATE INDEX sensor_imports_connection_status_idx
  ON sensor_imports (sensor_connection_id, status, imported_at DESC);
