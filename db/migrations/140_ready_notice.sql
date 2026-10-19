-- Spec amendment 2.2, screen 17 on native (phase 3 integration, range 140-149).
-- An analysis remembers the enrolled phone that asked for it, so the worker can
-- send that phone a silent wake when the reading is published ("only for
-- analyses the user started"). Web, agent and backfill requests leave it NULL.
-- Revoking or deleting the installation never deletes the analysis.
ALTER TABLE media_analysis_requests
  ADD COLUMN started_by_installation_id uuid;
ALTER TABLE media_analysis_requests
  ADD CONSTRAINT media_analysis_requests_installation_fk
  FOREIGN KEY (account_id, started_by_installation_id)
  REFERENCES mobile_installations (account_id, id)
  ON DELETE SET NULL (started_by_installation_id);
