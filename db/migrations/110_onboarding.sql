-- Taste onboarding state and picks (spec amendment 2.2, package A, range 110-119).
--
-- onboarding_states: one row per account once onboarding applies to it. A new
--   account gets required=true at sign-up; an existing account is evaluated
--   ONCE at its next sign-in (fewer than 3 explicit saves -> required). The
--   row is account data and is deleted with the account.
-- onboarding_picks: one counted choice each (a multi-tag image is ONE pick).
-- onboarding_pick_items: the explicit saves behind a pick. A pick counts while
--   at least one of its discovery items is still saved by the account, so an
--   "Unsave everywhere" from Saved for later is reflected without a trigger.
--   created_save records whether the pick created the save (removing the pick
--   then unsaves it) or found it already saved (removing leaves it alone).
-- Food exclusions live in accounts.preferences -> food.exclusions (no table).

CREATE TABLE onboarding_states (
  account_id      uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  required        boolean NOT NULL DEFAULT false,
  origin          text NOT NULL CHECK (origin IN ('sign_up', 'sign_in', 'settings')),
  started_at      timestamptz,
  completed_at    timestamptz,
  catalog_version text CHECK (catalog_version IS NULL OR length(catalog_version) <= 64),
  -- When the sign-up / sign-in rule was evaluated (once per account). Rows
  -- created by Settings -> Taste leave it NULL so the sign-in rule still runs.
  trigger_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (required AND completed_at IS NOT NULL))
);

CREATE TABLE onboarding_picks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('catalog', 'search', 'pending_save')),
  -- 'catalog:<item id>' | 'qloo:<qloo id>' (search) | 'item:<discovery item id>' (pending save)
  choice_key       text NOT NULL CHECK (length(choice_key) <= 300),
  catalog_item_id  text CHECK (catalog_item_id IS NULL OR catalog_item_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  label            text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  category         text CHECK (category IS NULL OR category IN ('wear', 'play', 'watch', 'eat')),
  item_kind        text NOT NULL
                   CHECK (item_kind IN ('capture', 'style', 'brand', 'artist', 'track', 'film', 'food', 'reference')),
  image            jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, choice_key),
  UNIQUE (id, account_id),
  CHECK ((source = 'catalog') = (catalog_item_id IS NOT NULL))
);
CREATE INDEX onboarding_picks_account_idx ON onboarding_picks (account_id, created_at, id);

CREATE TABLE onboarding_pick_items (
  pick_id           uuid NOT NULL,
  account_id        uuid NOT NULL,
  discovery_item_id uuid NOT NULL REFERENCES discovery_items(id) ON DELETE CASCADE,
  position          smallint NOT NULL CHECK (position BETWEEN 0 AND 2),
  created_save      boolean NOT NULL,
  PRIMARY KEY (pick_id, discovery_item_id),
  -- The pick and its items belong to the same account.
  FOREIGN KEY (pick_id, account_id) REFERENCES onboarding_picks(id, account_id) ON DELETE CASCADE
);
CREATE INDEX onboarding_pick_items_item_idx ON onboarding_pick_items (discovery_item_id);
CREATE INDEX onboarding_pick_items_account_idx ON onboarding_pick_items (account_id);
