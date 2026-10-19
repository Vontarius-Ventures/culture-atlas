-- Spec amendment 2.2, FAST-02 (review fix): stage 2 never reorders or removes
-- what stage 1 published. An advisory veto only lowers a reference's
-- certainty; the reference stays listed (with its qualifier) in the place it
-- was first shown:
--  * published_certainty keeps the certainty a reference was first listed
--    with, so a later veto does not move it in "Explore the references";
--  * enrichment_added marks references stage 2 added, which are listed after
--    every reference stage 1 published.
ALTER TABLE capture_references
  ADD COLUMN published_certainty real CHECK (published_certainty IS NULL OR (published_certainty >= 0 AND published_certainty <= 1)),
  ADD COLUMN enrichment_added boolean NOT NULL DEFAULT false;
