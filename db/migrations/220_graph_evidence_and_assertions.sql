-- Interest graph, PR 8 package A: durable source revisions, typed evidence and
-- shared assertion contracts. Evidence identity survives replacement of the
-- disposable research `claims` rows: it references immutable source revisions
-- that record permitted excerpt/structured value, rights and expiry. Only
-- shared, public-source facts live in graph_assertions; private interpretations
-- (VISUALLY_RESEMBLES) belong to account-owned graph_private_links (230).
-- Generic RELATED_TO is not an admitted predicate: it can never justify a
-- factual explanation.

CREATE TABLE graph_source_revisions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id                uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  url                      text NOT NULL,
  -- Position inside the document, e.g. "#Materials" or "chapter 2".
  locator                  text CHECK (locator IS NULL OR char_length(locator) <= 300),
  revision                 integer NOT NULL CHECK (revision >= 1),
  -- Version hash of the retrieved document (permits re-crawl comparison).
  document_hash            text CHECK (document_hash IS NULL OR char_length(document_hash) <= 128),
  -- Only display metadata we are permitted to show (title, publisher, license).
  allowed_display_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What may be stored and for how long, from the source's terms.
  retention_policy         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Mirrors and re-crawls of one source family count once for support.
  source_family_key        text NOT NULL CHECK (char_length(source_family_key) BETWEEN 1 AND 300),
  rights                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  rights_expires_at        timestamptz,
  retrieved_at             timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, revision)
);
CREATE INDEX graph_source_revisions_family_idx ON graph_source_revisions (source_family_key);

CREATE TABLE graph_evidence (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_revision_id  uuid NOT NULL REFERENCES graph_source_revisions(id) ON DELETE RESTRICT,
  -- Locator inside the revision (fragment, caption id, table cell).
  locator             text CHECK (locator IS NULL OR char_length(locator) <= 300),
  -- Permitted excerpt only (bounded); content retention obeys source terms.
  permitted_excerpt   text CHECK (permitted_excerpt IS NULL OR char_length(permitted_excerpt) <= 2000),
  structured_value    jsonb,
  validation_method   text NOT NULL
                      CHECK (validation_method IN ('provider_metadata','curated_passage','machine_extraction')),
  validation_version  text NOT NULL CHECK (char_length(validation_version) BETWEEN 1 AND 64),
  -- What the evidence can support: fact, subject matter, audience, visual.
  evidence_kind       text NOT NULL CHECK (evidence_kind IN ('fact','subject_matter','audience','visual')),
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (permitted_excerpt IS NOT NULL OR structured_value IS NOT NULL)
);
CREATE INDEX graph_evidence_revision_idx ON graph_evidence (source_revision_id);

CREATE TABLE graph_assertions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_node_id      uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  predicate            text NOT NULL CHECK (predicate IN (
                         'CREATED_BY','ABOUT','USES_TECHNIQUE','HAS_ATTRIBUTE',
                         'DOCUMENTED_ASSOCIATION','AUDIENCE_AFFINITY')),
  object_node_id       uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  -- Named subtype, required for DOCUMENTED_ASSOCIATION (e.g. 'studied_at').
  association_subtype  text CHECK (association_subtype IS NULL OR char_length(association_subtype) BETWEEN 1 AND 100),
  status               text NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed','validated','disputed','rejected','superseded','retracted')),
  revision             integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  valid_from           timestamptz,
  invalidated_at       timestamptz,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  superseded_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (subject_node_id <> object_node_id),
  CHECK (predicate <> 'DOCUMENTED_ASSOCIATION' OR association_subtype IS NOT NULL),
  CHECK (predicate = 'DOCUMENTED_ASSOCIATION' OR association_subtype IS NULL)
);
-- One asserted relation per (subject, predicate, object, subtype); new
-- evidence or corrections bump the row's revision instead of duplicating it.
CREATE UNIQUE INDEX graph_assertions_natural_key
  ON graph_assertions (subject_node_id, predicate, object_node_id, COALESCE(association_subtype, ''));
CREATE INDEX graph_assertions_subject_idx ON graph_assertions (subject_node_id);
CREATE INDEX graph_assertions_object_idx ON graph_assertions (object_node_id);

CREATE TABLE graph_assertion_support (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assertion_id      uuid NOT NULL REFERENCES graph_assertions(id) ON DELETE CASCADE,
  evidence_id       uuid NOT NULL REFERENCES graph_evidence(id) ON DELETE RESTRICT,
  role              text NOT NULL DEFAULT 'supports' CHECK (role IN ('supports','refutes')),
  -- How this support row was derived; same-family rows count as one support.
  derivation        text NOT NULL DEFAULT 'primary'
                    CHECK (derivation IN ('primary','mirror','refresh','reextraction')),
  source_family_key text NOT NULL CHECK (char_length(source_family_key) BETWEEN 1 AND 300),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assertion_id, evidence_id)
);
CREATE INDEX graph_assertion_support_family_idx ON graph_assertion_support (assertion_id, source_family_key);
