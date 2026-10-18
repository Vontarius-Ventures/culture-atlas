-- Spec amendment 2.2, package C (fast two-stage analysis, range 130-139).
-- Stage-2 enrichment vetoes are advisory (FAST-02): a vetoed reference keeps
-- its row, its anchor role and every card it already contributed to; it only
-- gets a lower certainty and leaves the "Explore the references" list.
-- This flag records that advisory decision without reusing 'rejected', which
-- stays reserved for a user's own correction.
ALTER TABLE capture_references
  ADD COLUMN IF NOT EXISTS advisory_veto boolean NOT NULL DEFAULT false;
