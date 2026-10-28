import type { Queryable } from '../db/pool';
import type { ItemKind } from '../enums';
import type { OnboardingPickSource } from '../schemas/onboarding';
import { iso } from '../util/time';

/**
 * The authoritative explicit-support reader for the private interest graph
 * (PR 8, package B). A projection is a pure function of CURRENT explicit
 * state, so this reads the authoritative preference rows directly — never
 * preference-event totals, never projection state — which is also why it
 * already reflects removals and exclusions while a projection lags.
 *
 * What counts as confirmed personal intent:
 *  - a saved item backed by an explicit save action (a preference_events
 *    'save' whose canonical key is not superseded by a later 'remove'), or by
 *    membership in an onboarding pick group (the user chose it explicitly);
 *  - one pick group per current pick: a multi-tag image is ONE choice group
 *    over its member saves, never one endorsement per member, and unselected
 *    alternatives contribute nothing.
 *
 * What never counts: exposure-only saved rows. The Interests-board auto-fill
 * (services/collections.ts fillInterestsBoard) saves recommendations without a
 * preference event or pick, and a save event that a later remove superseded
 * does not come back through the auto-fill. Those rows are reported separately
 * as exposureOnlyItemIds so a projection can keep them out of confirmed
 * roots: recommendations never endorse themselves. Exclusions (item hides) are
 * constraints on the excluded canonical key only — never endorsements, never
 * creator/category exclusion, and food exclusions (accounts.preferences) never
 * appear here at all.
 */

export interface ExplicitSave {
  savedItemId: string;
  itemId: string;
  canonicalKey: string;
  kind: ItemKind;
  savedAt: string;
}

export interface ExplicitPickMember {
  itemId: string;
  savedItemId: string;
  canonicalKey: string;
}

export interface ExplicitPickGroup {
  pickId: string;
  source: OnboardingPickSource;
  members: ExplicitPickMember[];
}

export interface ExplicitSupportSnapshot {
  ownerAccountId: string;
  /** Current taste revision the snapshot was read at. */
  tasteRevision: number;
  /** Current explicit saves, newest first. */
  saves: ExplicitSave[];
  /** One entry per current pick with at least one still-saved member. */
  pickGroups: ExplicitPickGroup[];
  /** Canonical keys hidden right now (constraints, never endorsements). */
  exclusions: string[];
  /** Current saved items with no explicit origin (exposure-only: never roots). */
  exposureOnlyItemIds: string[];
}

interface SaveRow {
  saved_item_id: string;
  item_id: string;
  canonical_key: string;
  kind: ItemKind;
  saved_at: Date;
  explicit: boolean;
}

interface GroupRow {
  pick_id: string;
  source: OnboardingPickSource;
  item_id: string;
  saved_item_id: string;
  canonical_key: string;
}

export async function loadExplicitSupport(db: Queryable, ownerAccountId: string): Promise<ExplicitSupportSnapshot> {
  const [saves, groups, exclusions, taste] = await Promise.all([
    db.query<SaveRow>(
      `SELECT si.id AS saved_item_id, di.id AS item_id, di.canonical_key, di.kind, si.saved_at,
              (EXISTS (
                 SELECT 1 FROM preference_events e
                  WHERE e.owner_account_id = $1
                    AND e.action = 'save'
                    AND e.payload->>'canonical_key' = di.canonical_key
                    AND NOT EXISTS (
                        SELECT 1 FROM preference_events r
                         WHERE r.owner_account_id = $1
                           AND r.action = 'remove'
                           AND r.payload->>'canonical_key' = di.canonical_key
                           AND (r.created_at, r.id) > (e.created_at, r.id)))
               OR EXISTS (
                   SELECT 1 FROM onboarding_pick_items pi
                    WHERE pi.account_id = $1 AND pi.discovery_item_id = di.id)) AS explicit
         FROM saved_items si
         JOIN discovery_items di ON di.id = si.discovery_item_id
        WHERE si.owner_account_id = $1
        ORDER BY si.saved_at DESC, si.id`,
      [ownerAccountId],
    ),
    db.query<GroupRow>(
      `SELECT p.id AS pick_id, p.source, pi.discovery_item_id AS item_id, si.id AS saved_item_id, di.canonical_key
         FROM onboarding_picks p
         JOIN onboarding_pick_items pi ON pi.pick_id = p.id
         JOIN saved_items si ON si.discovery_item_id = pi.discovery_item_id AND si.owner_account_id = p.account_id
         JOIN discovery_items di ON di.id = pi.discovery_item_id
        WHERE p.account_id = $1
        ORDER BY p.created_at, p.id, pi.position`,
      [ownerAccountId],
    ),
    db.query<{ canonical_key: string }>(
      'SELECT DISTINCT canonical_key FROM item_exclusions WHERE owner_account_id = $1 ORDER BY canonical_key',
      [ownerAccountId],
    ),
    db.query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [ownerAccountId]),
  ]);

  const pickGroups = new Map<string, ExplicitPickGroup>();
  for (const row of groups.rows) {
    let group = pickGroups.get(row.pick_id);
    if (!group) {
      group = { pickId: row.pick_id, source: row.source, members: [] };
      pickGroups.set(row.pick_id, group);
    }
    group.members.push({ itemId: row.item_id, savedItemId: row.saved_item_id, canonicalKey: row.canonical_key });
  }

  return {
    ownerAccountId,
    tasteRevision: taste.rows[0]?.revision ?? 0,
    saves: saves.rows
      .filter((r) => r.explicit)
      .map((r) => ({
        savedItemId: r.saved_item_id,
        itemId: r.item_id,
        canonicalKey: r.canonical_key,
        kind: r.kind,
        savedAt: iso(r.saved_at),
      })),
    pickGroups: [...pickGroups.values()],
    exclusions: exclusions.rows.map((r) => r.canonical_key),
    exposureOnlyItemIds: saves.rows.filter((r) => !r.explicit).map((r) => r.item_id),
  };
}
