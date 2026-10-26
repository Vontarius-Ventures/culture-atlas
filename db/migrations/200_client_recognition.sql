-- 200: Music Mode client recognition (ShazamKit on iOS).
-- The analyze-audio request may carry a song the client recognized on-device.
-- It is a hint for the same pipeline (Qloo grounds it; nothing is trusted
-- from the client beyond this shape), so it is stored with the request row.
ALTER TABLE audio_analysis_requests
  ADD COLUMN IF NOT EXISTS client_recognition jsonb;

COMMENT ON COLUMN audio_analysis_requests.client_recognition IS
  'Client-recognized song hint (vendor, artist_name, title, matched_at_ms, vendor_recording_id); resolved only through Qloo search, never trusted directly.';
