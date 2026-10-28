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
 * roots: recommendations never endorse themselves. Supersession itself is
 * lineage-aware (removeSupersedesSaveSql): an anonymous history and the
 * claiming account are two independent histories, and a claim keeps each
 * surviving explicit save's provenance — the other history's historical
 * removal of the same canonical item withdrew its OWN save, never this one.
 * Exclusions (item hides) are constraints on the excluded canonical key only —
 * never endorsements, never creator/category exclusion, and food exclusions
 * (accounts.preferences) never appear here at all.
 *
 * Capture-derived support (VAL-PROJ-006): a SAVED capture keeps its explicit
 * inspiration save as a confirmed root, while the support derived from it
 * flows only through the capture's CURRENT active analysis and the references
 * the user currently authorized (resolved or user-confirmed). The latest
 * correction of a capture is the user's current intent: its rejections are
 * withdrawn immediately — before the replacement analysis exists — and its
 * confirmation restores a rejected reference (the user is the evidence).
 * Unmatched fallback names, ambiguous matches and text-only mentions never
 * establish facts, an unsaved capture contributes nothing, and a deleted
 * capture (or its withdrawn dependencies) disappears here the moment its
 * authoritative rows do, so lagging reads can never resurrect it.
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

/**
 * One capture-reference dependency of a saved capture: a reference of the
 * CURRENT active analysis that is currently resolved or user-confirmed, with
 * the exact capture_references row it rests on. `captureReferenceId`,
 * `analysisId` and `analysisVersion` are the exact dependency versions a
 * projection records so superseded support is detectable and withdrawable.
 */
export interface ExplicitCaptureReference {
  captureReferenceId: string;
  referenceId: string;
  name: string;
  relation: 'depicted' | 'resembles' | 'user_selected';
  resolutionStatus: 'resolved' | 'user_confirmed';
  isAnchor: boolean;
  certainty: number | null;
}

/**
 * The capture-derived support of one EXPLICITLY SAVED capture (the "Save this
 * inspiration" save). The save itself is a confirmed root in `saves`; the
 * reference dependencies below are DERIVED support, so they follow only the
 * capture's current active analysis and the references the user currently
 * authorized (resolved/user-confirmed, not rejected by the latest correction).
 */
export interface ExplicitCaptureSupport {
  captureId: string;
  captureItemId: string;
  savedItemId: string;
  /** The current active analysis; null while the capture has none. */
  analysisId: string | null;
  analysisVersion: number | null;
  references: ExplicitCaptureReference[];
}

export interface ExplicitSupportSnapshot {
  ownerAccountId: string;
  /** Current taste revision the snapshot was read at. */
  tasteRevision: number;
  /** Current explicit saves, newest first. */
  saves: ExplicitSave[];
  /** One entry per current pick with at least one still-saved member. */
  pickGroups: ExplicitPickGroup[];
  /** Capture-derived dependencies, one entry per explicitly saved live capture. */
  captures: ExplicitCaptureSupport[];
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

interface CaptureRow {
  saved_item_id: string;
  capture_item_id: string;
  capture_id: string;
  analysis_id: string | null;
  analysis_version: number | null;
  capture_reference_id: string | null;
  reference_id: string | null;
  name: string | null;
  relation: 'depicted' | 'resembles' | 'user_selected' | null;
  resolution_status: string | null;
  is_anchor: boolean | null;
  certainty: number | null;
  text_only: boolean | null;
}

interface CorrectionRow {
  capture_id: string;
  payload: {
    reject_reference_ids?: string[];
    confirm_reference_id?: string;
  };
}

/**
 * One remove event `r` supersedes one save event `e` when it actually
 * withdrew that save. Two mechanisms, in order of authority:
 *
 * 1. Per-save lineage (authoritative). Every save event names the
 *    saved_items row it created (`payload.saved_item_id`), every remove
 *    names the row it deleted, and the claim continues an absorbed save's
 *    lineage through the account's merged row. Row identity is exact: it
 *    never depends on transaction timestamps or UUID order, so overlapping
 *    claim/withdrawal transactions cannot mis-order — the remove either
 *    deleted the very row this save created (superseded) or deleted a
 *    different row (this save survives untouched), regardless of which
 *    transaction began first (VAL-PROJ-002/003, VAL-CROSS-001).
 *
 * 2. Legacy histories (events written before per-save lineage). The best
 *    available inference is the previous timestamp+lineage semantics: a
 *    remove supersedes a newer save of the same claimed lineage, and an
 *    account-native remove supersedes a transferred save only from the
 *    claim instant onward. Transaction-start `now()` cannot order
 *    overlapping claim/withdrawal transactions for these rows; that
 *    ambiguity is inherent to the stored history and is documented here,
 *    not "recovered" by invented linkage. The ordinary sequential
 *    lifecycle keeps working exactly as before.
 */
export const removeSupersedesSaveSql = (keySql: string): string => `EXISTS (
                  SELECT 1 FROM preference_events r
                   WHERE r.owner_account_id = $1
                     AND r.action = 'remove'
                     AND r.payload->>'canonical_key' = ${keySql}
                     AND (
                       (r.payload->>'saved_item_id' IS NOT NULL
                          AND r.payload->>'saved_item_id' = e.payload->>'saved_item_id')
                       OR ((r.payload->>'saved_item_id' IS NULL OR e.payload->>'saved_item_id' IS NULL)
                           AND (r.created_at, r.id) > (e.created_at, e.id)
                           AND (r.payload->>'claimed_session_id' IS NOT DISTINCT FROM e.payload->>'claimed_session_id'
                                OR (e.payload->>'claimed_session_id' IS NOT NULL
                                    AND r.payload->>'claimed_session_id' IS NULL
                                    AND r.created_at >= (e.payload->>'claimed_at')::timestamptz)))
                     ))`;

/**
 * A saved item is explicit iff a save event for its canonical key is not
 * superseded by a remove that actually withdrew it (see
 * removeSupersedesSaveSql), or it is an onboarding pick member.
 */
const EXPLICIT_SAVE_SQL = `(EXISTS (
                 SELECT 1 FROM preference_events e
                  WHERE e.owner_account_id = $1
                    AND e.action = 'save'
                    AND e.payload->>'canonical_key' = di.canonical_key
                    AND NOT ${removeSupersedesSaveSql('di.canonical_key')})
               OR EXISTS (
                   SELECT 1 FROM onboarding_pick_items pi
                    WHERE pi.account_id = $1 AND pi.discovery_item_id = di.id))`;

export async function loadExplicitSupport(db: Queryable, ownerAccountId: string): Promise<ExplicitSupportSnapshot> {
  const [saves, groups, captureRows, corrections, exclusions, taste] = await Promise.all([
    db.query<SaveRow>(
      `SELECT si.id AS saved_item_id, di.id AS item_id, di.canonical_key, di.kind, si.saved_at,
              ${EXPLICIT_SAVE_SQL} AS explicit
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
    db.query<CaptureRow>(
      `SELECT si.id AS saved_item_id, di.id AS capture_item_id, c.id AS capture_id,
              a.id AS analysis_id, a.version AS analysis_version,
              cr.id AS capture_reference_id, cr.reference_id, cr.relation, cr.resolution_status,
              cr.is_anchor, cr.certainty, cr.text_only, r.canonical_name AS name
         FROM saved_items si
         JOIN discovery_items di ON di.id = si.discovery_item_id AND di.kind = 'capture'
         JOIN captures c ON c.id = di.capture_id AND c.deleted_at IS NULL
         LEFT JOIN analyses a ON a.id = c.active_analysis_id
         LEFT JOIN capture_references cr ON cr.analysis_id = a.id
         LEFT JOIN cultural_references r ON r.id = cr.reference_id
        WHERE si.owner_account_id = $1 AND ${EXPLICIT_SAVE_SQL}
        ORDER BY si.saved_at DESC, si.id, cr.is_anchor DESC, cr.relation = 'user_selected' DESC, r.canonical_name`,
      [ownerAccountId],
    ),
    db.query<CorrectionRow>(
      `SELECT DISTINCT ON (e.target_id) e.target_id AS capture_id, e.payload
         FROM preference_events e
        WHERE e.owner_account_id = $1 AND e.action = 'correct' AND e.target_type = 'capture'
        ORDER BY e.target_id, e.created_at DESC, e.id DESC`,
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
    captures: captureSupport(captureRows.rows, corrections.rows),
    exclusions: exclusions.rows.map((r) => r.canonical_key),
    exposureOnlyItemIds: saves.rows.filter((r) => !r.explicit).map((r) => r.item_id),
  };
}

/**
 * Assemble per-capture derived support from CURRENT authoritative state:
 *  - only the capture's CURRENT active analysis counts (a replaced version's
 *    rows are superseded immediately, even while a projection lags);
 *  - only resolved/user-confirmed references count: unmatched fallback names,
 *    ambiguous matches, rejected rows and text-only mentions are never facts;
 *  - the LATEST correction of the capture is the user's current intent, so its
 *    rejections withdraw immediately and its confirmation restores the
 *    reference (the user is the evidence), all before the replacement analysis
 *    runs;
 *  - duplicate rows for the same reference collapse to the strongest one.
 */
function captureSupport(rows: readonly CaptureRow[], corrections: readonly CorrectionRow[]): ExplicitCaptureSupport[] {
  const latestCorrection = new Map(corrections.map((c) => [c.capture_id, c.payload]));
  const byCapture = new Map<string, ExplicitCaptureSupport>();
  const byReference = new Map<string, Map<string, ExplicitCaptureReference>>();

  for (const row of rows) {
    let support = byCapture.get(row.capture_id);
    if (!support) {
      support = {
        captureId: row.capture_id,
        captureItemId: row.capture_item_id,
        savedItemId: row.saved_item_id,
        analysisId: row.analysis_id,
        analysisVersion: row.analysis_version,
        references: [],
      };
      byCapture.set(row.capture_id, support);
      byReference.set(row.capture_id, new Map());
    }
    if (!row.capture_reference_id || !row.reference_id || !row.name || !row.relation) continue;

    const correction = latestCorrection.get(row.capture_id);
    if ((correction?.reject_reference_ids ?? []).includes(row.reference_id)) continue;

    const confirmed = correction?.confirm_reference_id;
    const authorized =
      row.reference_id === confirmed ||
      ((row.resolution_status === 'resolved' || row.resolution_status === 'user_confirmed') && !row.text_only);
    if (!authorized) continue;
    const candidate: ExplicitCaptureReference = {
      captureReferenceId: row.capture_reference_id,
      referenceId: row.reference_id,
      name: row.name,
      relation: row.relation,
      resolutionStatus:
        row.resolution_status === 'user_confirmed' || row.reference_id === confirmed ? 'user_confirmed' : 'resolved',
      isAnchor: row.is_anchor ?? false,
      certainty: row.certainty,
    };
    const seen = byReference.get(row.capture_id)!;
    const prev = seen.get(row.reference_id);
    if (!prev || rank(candidate) > rank(prev)) seen.set(row.reference_id, candidate);
  }

  for (const support of byCapture.values()) {
    support.references = [...byReference.get(support.captureId)!.values()].sort(
      (a, b) =>
        Number(b.isAnchor) - Number(a.isAnchor) ||
        Number(b.relation === 'user_selected') - Number(a.relation === 'user_selected') ||
        a.name.localeCompare(b.name),
    );
  }
  return [...byCapture.values()];
}

/** Strongest duplicate wins: user-confirmed over resolved, then user-selected relation. */
function rank(ref: ExplicitCaptureReference): number {
  return (ref.resolutionStatus === 'user_confirmed' ? 2 : 0) + (ref.relation === 'user_selected' ? 1 : 0);
}
