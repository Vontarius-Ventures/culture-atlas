-- Interest graph, PR 8 package A: private, account-owned graph state. Every
-- row belongs to exactly one account and cascades with it. Composite foreign
-- keys make cross-account private links impossible at the database level:
-- edges, support rows and observation links can only reference their owner's
-- saves, picks, captures, analyses and items. Edges are rebuildable
-- projections of current explicit state, never a second ledger of truth.

-- Owner-scoped unique keys reused by the composite foreign keys below.
ALTER TABLE discovery_items    ADD CONSTRAINT discovery_items_id_owner_key UNIQUE (id, owner_account_id);
ALTER TABLE captures           ADD CONSTRAINT captures_id_owner_key UNIQUE (id, owner_account_id);
ALTER TABLE analyses           ADD CONSTRAINT analyses_id_capture_key UNIQUE (id, capture_id);
ALTER TABLE capture_references ADD CONSTRAINT capture_references_id_analysis_key UNIQUE (id, analysis_id);

-- One projection state row per account: target/applied taste revisions, the
-- monotonic projection revision, the deletion/reset generation fence and the
-- current projection state.
CREATE TABLE personal_graph_state (
  owner_account_id        uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  target_taste_revision   integer NOT NULL DEFAULT 0 CHECK (target_taste_revision >= 0),
  applied_taste_revision  integer NOT NULL DEFAULT 0 CHECK (applied_taste_revision >= 0),
  projection_revision     integer NOT NULL DEFAULT 0 CHECK (projection_revision >= 0),
  deletion_generation     integer NOT NULL DEFAULT 0 CHECK (deletion_generation >= 0),
  state                   text NOT NULL DEFAULT 'idle'
                          CHECK (state IN ('idle','queued','running','ready','failed')),
  suppression_revision    integer NOT NULL DEFAULT 0 CHECK (suppression_revision >= 0),
  last_error_code         text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 100),
  last_projected_at       timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (applied_taste_revision <= target_taste_revision)
);

-- A personal interest edge: exactly one target form (a shared canonical
-- identity, or one of the account's own discovery items). Explicit edges are
-- confirmed until withdrawn; derived edges are tentative and bounded.
CREATE TABLE personal_interest_edges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  node_id             uuid REFERENCES graph_nodes(id) ON DELETE CASCADE,
  discovery_item_id   uuid,
  origin              text NOT NULL CHECK (origin IN ('explicit','derived')),
  state               text NOT NULL DEFAULT 'tentative' CHECK (state IN ('confirmed','tentative','suppressed')),
  strength            real CHECK (strength IS NULL OR (strength >= 0 AND strength <= 1)),
  support_summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version      text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 64),
  revision            integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  first_supported_at  timestamptz NOT NULL DEFAULT now(),
  last_supported_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_account_id),
  CHECK (num_nonnulls(node_id, discovery_item_id) = 1),
  CHECK (origin <> 'explicit' OR state = 'confirmed'),
  FOREIGN KEY (discovery_item_id, owner_account_id)
    REFERENCES discovery_items(id, owner_account_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX personal_interest_edges_node_idx
  ON personal_interest_edges (owner_account_id, node_id) WHERE node_id IS NOT NULL;
CREATE UNIQUE INDEX personal_interest_edges_item_idx
  ON personal_interest_edges (owner_account_id, discovery_item_id) WHERE discovery_item_id IS NOT NULL;

-- One support row = one named contribution to one edge. Exactly one source
-- kind is present per row, and every source is composite-bound to the owner.
CREATE TABLE personal_interest_support (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  edge_id               uuid NOT NULL,
  origin_kind           text NOT NULL
                        CHECK (origin_kind IN ('saved_item','pick_group','capture_reference','analysis')),
  saved_item_id         uuid,
  pick_id               uuid,
  capture_id            uuid,
  analysis_id           uuid,
  capture_reference_id  uuid,
  -- Originating preference event when known (informational lineage).
  originating_event_id  uuid REFERENCES preference_events(id) ON DELETE SET NULL,
  dependency_versions   jsonb NOT NULL DEFAULT '{}'::jsonb,
  weight                real CHECK (weight IS NULL OR weight >= 0),
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_account_id),
  FOREIGN KEY (edge_id, owner_account_id)
    REFERENCES personal_interest_edges(id, owner_account_id) ON DELETE CASCADE,
  FOREIGN KEY (saved_item_id, owner_account_id)
    REFERENCES saved_items(id, owner_account_id) ON DELETE CASCADE,
  FOREIGN KEY (pick_id, owner_account_id)
    REFERENCES onboarding_picks(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (capture_id, owner_account_id)
    REFERENCES captures(id, owner_account_id) ON DELETE CASCADE,
  FOREIGN KEY (analysis_id, capture_id)
    REFERENCES analyses(id, capture_id) ON DELETE CASCADE,
  FOREIGN KEY (capture_reference_id, analysis_id)
    REFERENCES capture_references(id, analysis_id) ON DELETE CASCADE,
  CHECK (
    (origin_kind = 'saved_item' AND saved_item_id IS NOT NULL
       AND pick_id IS NULL AND capture_id IS NULL AND analysis_id IS NULL AND capture_reference_id IS NULL)
    OR (origin_kind = 'pick_group' AND pick_id IS NOT NULL
       AND saved_item_id IS NULL AND capture_id IS NULL AND analysis_id IS NULL AND capture_reference_id IS NULL)
    OR (origin_kind = 'capture_reference' AND capture_reference_id IS NOT NULL AND analysis_id IS NOT NULL
       AND capture_id IS NOT NULL AND saved_item_id IS NULL AND pick_id IS NULL)
    OR (origin_kind = 'analysis' AND analysis_id IS NOT NULL AND capture_id IS NOT NULL
       AND saved_item_id IS NULL AND pick_id IS NULL AND capture_reference_id IS NULL)
  )
);
CREATE INDEX personal_interest_support_edge_idx ON personal_interest_support (edge_id) WHERE active;
CREATE INDEX personal_interest_support_owner_idx ON personal_interest_support (owner_account_id, created_at DESC);

-- Suppression markers for tentative derived edges, keyed by target identity
-- (not edge row id) so a marker survives projection rebuilds until restored.
CREATE TABLE personal_edge_suppressions (
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  node_id          uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  policy_version   text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 64),
  suppressed_at    timestamptz NOT NULL DEFAULT now(),
  restored_at      timestamptz,
  PRIMARY KEY (owner_account_id, node_id)
);

-- Private observation links: what an account's capture analysis resolved.
-- Never copied into shared assertion text; capture or analysis deletion
-- withdraws the link.
CREATE TABLE graph_private_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  capture_id           uuid NOT NULL,
  analysis_id          uuid,
  capture_reference_id uuid,
  node_id              uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  interpretation       text NOT NULL
                       CHECK (interpretation IN ('VISUALLY_RESEMBLES','ABOUT','DOCUMENTED_ASSOCIATION')),
  certainty            real CHECK (certainty IS NULL OR (certainty >= 0 AND certainty <= 1)),
  analysis_version     integer CHECK (analysis_version IS NULL OR analysis_version >= 1),
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_account_id),
  FOREIGN KEY (capture_id, owner_account_id)
    REFERENCES captures(id, owner_account_id) ON DELETE CASCADE,
  FOREIGN KEY (analysis_id, capture_id)
    REFERENCES analyses(id, capture_id) ON DELETE CASCADE,
  FOREIGN KEY (capture_reference_id, analysis_id)
    REFERENCES capture_references(id, analysis_id) ON DELETE CASCADE,
  -- A private visual interpretation requires the analysis it came from.
  CHECK (interpretation <> 'VISUALLY_RESEMBLES' OR analysis_id IS NOT NULL)
);
CREATE INDEX graph_private_links_owner_idx ON graph_private_links (owner_account_id, capture_id);
