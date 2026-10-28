-- Interest graph, PR 8 package A: shared canonical cultural identities.
-- A graph node is the Atlas identity for a cultural thing, distinct by
-- normalized name, node kind, domain and sense (same spelling is never
-- identity). Provider ID mappings live in graph_external_ids so a provider row
-- can move between identities without rewriting the node, and ambiguous
-- mappings stay proposals rather than identities. Additive only.

CREATE TABLE graph_nodes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Optional 1:1 reuse of an existing researched reference row.
  cultural_reference_id uuid UNIQUE REFERENCES cultural_references(id) ON DELETE SET NULL,
  -- Stable machine key, e.g. "atlas:<uuid>" or "art:van-gogh|person".
  canonical_key         text NOT NULL UNIQUE CHECK (char_length(canonical_key) BETWEEN 3 AND 300),
  canonical_name        text NOT NULL CHECK (char_length(canonical_name) BETWEEN 1 AND 200),
  -- Lowercased/normalized name used for dedupe (name + kind + domain + sense).
  name_key              text NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 200),
  node_kind             text NOT NULL CHECK (node_kind IN (
                          'object','creator','work','brand','style','tradition','place','cuisine',
                          'technique','attribute','audience')),
  -- Cultural domain of the identity (the reviewed corpus domains first).
  domain                text NOT NULL CHECK (domain IN (
                          'art','sculpture','ceramics','interiors','design','music','film','food','fashion')),
  -- Sense disambiguates same-name identities, e.g. 'brand' vs 'product',
  -- 'mythology' vs 'element'. Never blank.
  sense_key             text NOT NULL CHECK (char_length(sense_key) BETWEEN 1 AND 60),
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','ambiguous','merged','retired')),
  merged_into_id        uuid REFERENCES graph_nodes(id) ON DELETE SET NULL,
  revision              integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Same spelling is not identity: the name alone never dedupes.
  UNIQUE (name_key, node_kind, domain, sense_key),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
CREATE INDEX graph_nodes_reference_idx ON graph_nodes (cultural_reference_id) WHERE cultural_reference_id IS NOT NULL;
CREATE INDEX graph_nodes_name_idx ON graph_nodes (lower(canonical_name));

CREATE TABLE graph_node_aliases (
  node_id    uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  alias      text NOT NULL CHECK (char_length(alias) BETWEEN 1 AND 200),
  alias_key  text NOT NULL CHECK (char_length(alias_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, alias_key)
);

CREATE TABLE graph_external_ids (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id       uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('qloo','wikidata','wikipedia')),
  external_id   text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 255),
  -- A provider ID maps to exactly one identity; ambiguous matches stay proposals.
  match_status  text NOT NULL DEFAULT 'confirmed'
                CHECK (match_status IN ('confirmed','proposed','ambiguous','rejected')),
  match_version text CHECK (match_version IS NULL OR char_length(match_version) <= 64),
  provenance    text CHECK (provenance IS NULL OR char_length(provenance) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id),
  UNIQUE (node_id, provider, external_id)
);
CREATE INDEX graph_external_ids_node_idx ON graph_external_ids (node_id);
