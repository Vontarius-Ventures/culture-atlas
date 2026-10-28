-- Interest graph, PR 8 discovery slice: reviewed evidence admission, immutable
-- evidence content and the durable provider rights policy record.
--
-- Review provenance (VAL-EVID-001): reviewed corpus evidence records who
-- reviewed it and when; machine-extracted proposals stay unreviewed (NULL)
-- until a review admits them, so unreviewed imports are never part of the
-- qualified corpus. A half review (reviewer without a date or vice versa) is
-- invalid.
--
-- Content immutability (VAL-EVID-001): source revisions and evidence rows are
-- append-only. Replacing evidence means a NEW source revision plus a NEW
-- evidence row, so the (evidence id, revision) pair a pinned proof recorded
-- can never be rewritten in place by a later refresh; the guards below make
-- an in-place content rewrite fail loudly instead of silently. Status or
-- validity columns (for the later retraction work) stay updatable.
--
-- Provider rights (VAL-EVID-005): the operational setup records the approved
-- provider privacy settings and storage/display rights WITHOUT secrets. Qloo's
-- response-retention and public-display rights are still undocumented
-- (docs/privacy.md TODOs), so its policy row honestly marks them unresolved:
-- Qloo responses stay transient under the existing adapter semantics (only
-- ids, names and ranks for traceability) and are never admitted as durable
-- graph evidence or displayed assets.

ALTER TABLE graph_evidence
  ADD COLUMN reviewed_by text CHECK (reviewed_by IS NULL OR char_length(reviewed_by) BETWEEN 1 AND 200),
  ADD COLUMN reviewed_at timestamptz;
ALTER TABLE graph_evidence
  ADD CONSTRAINT graph_evidence_review_pair_check
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL));
CREATE INDEX graph_evidence_reviewed_idx ON graph_evidence (reviewed_at) WHERE reviewed_by IS NOT NULL;

CREATE OR REPLACE FUNCTION graph_evidence_immutable_content() RETURNS trigger AS $$
BEGIN
  IF OLD.source_revision_id IS DISTINCT FROM NEW.source_revision_id
     OR OLD.locator IS DISTINCT FROM NEW.locator
     OR OLD.permitted_excerpt IS DISTINCT FROM NEW.permitted_excerpt
     OR OLD.structured_value IS DISTINCT FROM NEW.structured_value
     OR OLD.validation_method IS DISTINCT FROM NEW.validation_method
     OR OLD.validation_version IS DISTINCT FROM NEW.validation_version
     OR OLD.evidence_kind IS DISTINCT FROM NEW.evidence_kind
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.reviewed_by IS DISTINCT FROM NEW.reviewed_by
     OR OLD.reviewed_at IS DISTINCT FROM NEW.reviewed_at THEN
    RAISE EXCEPTION 'graph_evidence content is immutable: admit the corrected extraction as a new evidence row'
      USING HINT = 'Replacement evidence is a new row from a new source revision, never an in-place rewrite.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER graph_evidence_content_guard
  BEFORE UPDATE ON graph_evidence
  FOR EACH ROW EXECUTE FUNCTION graph_evidence_immutable_content();

CREATE OR REPLACE FUNCTION graph_source_revisions_immutable_content() RETURNS trigger AS $$
BEGIN
  IF OLD.source_id IS DISTINCT FROM NEW.source_id
     OR OLD.url IS DISTINCT FROM NEW.url
     OR OLD.locator IS DISTINCT FROM NEW.locator
     OR OLD.revision IS DISTINCT FROM NEW.revision
     OR OLD.document_hash IS DISTINCT FROM NEW.document_hash
     OR OLD.allowed_display_metadata IS DISTINCT FROM NEW.allowed_display_metadata
     OR OLD.retention_policy IS DISTINCT FROM NEW.retention_policy
     OR OLD.source_family_key IS DISTINCT FROM NEW.source_family_key
     OR OLD.rights IS DISTINCT FROM NEW.rights
     OR OLD.rights_expires_at IS DISTINCT FROM NEW.rights_expires_at THEN
    RAISE EXCEPTION 'graph_source_revisions content is immutable: record the re-crawl as a new revision'
      USING HINT = 'A changed document is a new (source, revision) row; evidence pins the exact revision it was read from.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER graph_source_revisions_content_guard
  BEFORE UPDATE ON graph_source_revisions
  FOR EACH ROW EXECUTE FUNCTION graph_source_revisions_immutable_content();

CREATE TABLE provider_rights_policies (
  provider           text PRIMARY KEY CHECK (char_length(provider) BETWEEN 1 AND 100),
  -- May provider responses be retained as durable stored evidence?
  response_retention text NOT NULL CHECK (response_retention IN ('transient_only', 'permitted_documented')),
  -- May provider-derived material be publicly displayed?
  public_display     text NOT NULL CHECK (public_display IN ('owned_or_cleared_only', 'permitted_documented')),
  -- Approved provider privacy settings actually in force (never secrets).
  privacy_settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Are the retention/public-display rights themselves documented yet?
  rights_documented  boolean NOT NULL DEFAULT false,
  -- Honest reporting of what is still unresolved; NULL only when fully documented.
  unresolved_notes   text,
  basis              text NOT NULL CHECK (char_length(basis) BETWEEN 1 AND 1000),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (rights_documented OR unresolved_notes IS NOT NULL)
);

INSERT INTO provider_rights_policies
  (provider, response_retention, public_display, privacy_settings, rights_documented, unresolved_notes, basis)
VALUES
  (
    'qloo',
    'transient_only',
    'owned_or_cleared_only',
    '{
       "sends": ["resolved entity and tag names or ids from the analysis", "category filters"],
       "does_not_receive": ["images", "account ids", "collection names", "private histories", "private interest text"],
       "response_handling": "transient: only ids, names and ranks needed for traceability are stored in provider_queries; raw responses are never persisted",
       "spend": "existing budget ledger and throttles unchanged"
     }'::jsonb,
    false,
    'Qloo response retention and public-display rights are not documented yet (docs/privacy.md and docs/capability-matrix.md TODOs). Operator assurance does not establish storage/display rights: until the terms are recorded, Qloo responses remain transient under the existing adapter semantics and Qloo-derived material is never admitted as durable graph evidence or displayed assets.',
    'docs/privacy.md provider table and the existing Qloo adapter contract (packages/providers/src/qloo); conservative handling until actual terms are recorded.'
  ),
  (
    'wikipedia',
    'permitted_documented',
    'permitted_documented',
    '{
       "sends": ["public reference names (search and page summary requests)", "a descriptive User-Agent"],
       "does_not_receive": ["images or anything private"],
       "retention": "public content; text excerpts stored with attribution under CC BY-SA 4.0"
     }'::jsonb,
    true,
    NULL,
    'Wikipedia text is CC BY-SA 4.0 (attribution and license link required for stored/displayed excerpts); requests are governed by the Wikimedia privacy policy.'
  ),
  (
    'wikidata',
    'permitted_documented',
    'permitted_documented',
    '{
       "sends": ["public entity label lookups"],
       "does_not_receive": ["anything private"],
       "retention": "public structured data under CC0"
     }'::jsonb,
    true,
    NULL,
    'Wikidata structured data is released under CC0 1.0 (wikidata.org statement of license); identity mappings cite the lookup that confirmed each label.'
  ),
  (
    'artic_open_access',
    'permitted_documented',
    'permitted_documented',
    '{
       "sends": ["public collection object page and API reads"],
       "does_not_receive": ["anything private"],
       "retention": "collection metadata released under CC0 (object-page caption metadata and non-description API data)"
     }'::jsonb,
    true,
    NULL,
    'The Art Institute of Chicago open-access policy releases object-page caption metadata under Creative Commons Zero (CC0); AIC API responses state that all non-description data in the response is CC0 1.0. Public-domain images additionally carry the CC0 designation.'
  );
