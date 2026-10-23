-- Music Mode results feed discovery (additive only).
--
--  * discovery_jobs.source: 'item' is the explicit "Discover more" on an item
--    (results stay on the item page). 'music_mode' is the related discovery a
--    resolved Music Mode artist starts; its results also join the owner's
--    interest feed with the reason "Because you heard <artist>".
--  * source_label keeps the artist name the user heard for that reason text.

ALTER TABLE discovery_jobs
  ADD COLUMN source text NOT NULL DEFAULT 'item' CHECK (source IN ('item', 'music_mode')),
  ADD COLUMN source_label text CHECK (source_label IS NULL OR char_length(source_label) <= 200);

CREATE INDEX discovery_jobs_feed_source_idx ON discovery_jobs (owner_account_id, created_at DESC)
  WHERE source = 'music_mode';
