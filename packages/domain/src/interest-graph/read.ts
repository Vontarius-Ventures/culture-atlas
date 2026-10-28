import type { Queryable } from '../db/pool';
import type { ItemKind } from '../enums';
import { getTasteRevision } from '../services/taste';
import { countUnsatisfiedGraphOutboxEvents } from './projector';
import { loadExplicitSupport } from './explicit-support';

/**
 * Reconciled interest-graph read (PR 8 package B). Reads honor CURRENT
 * authoritative support even while the projection lags: the explicit roots
 * and derived capture affinities below are computed from the same reader the
 * projector builds from, so a removal or correction is honored before any
 * projector catch-up and a fresh save appears immediately. The private
 * projection decorates the result (stable edge ids, projection status) and
 * reports lag honestly instead of serving stale graph rows.
 */

export interface ProjectionStatus {
  state: 'never_projected' | 'idle' | 'queued' | 'running' | 'ready' | 'failed';
  projectionRevision: number;
  targetTasteRevision: number;
  appliedTasteRevision: number;
  currentTasteRevision: number;
  /** True when committed intents are unsatisfied or the projection is behind. */
  lagging: boolean;
  pendingEvents: number;
  lastProjectedAt: string | null;
  lastGraphRunId: string | null;
}

export interface ReconciledInterestItem {
  itemId: string;
  canonicalKey: string;
  kind: ItemKind;
  origin: 'explicit';
  state: 'confirmed';
  /** Stable projected edge id once the projection has caught up. */
  edgeId: string | null;
  savedItemId: string;
  /** Choice groups currently supporting this root. */
  pickIds: string[];
  /** Present when the root is a saved capture. */
  capturedBy?: { captureId: string; analysisId: string | null };
}

export interface ReconciledDerivedAffinity {
  captureId: string;
  captureItemId: string;
  analysisId: string | null;
  analysisVersion: number | null;
  captureReferenceId: string;
  referenceId: string;
  name: string;
  relation: 'depicted' | 'resembles' | 'user_selected';
  resolutionStatus: 'resolved' | 'user_confirmed';
  isAnchor: boolean;
  /** Shared identity of the referenced work when one exists. */
  nodeId: string | null;
  edgeId: string | null;
  origin: 'derived';
  state: 'tentative' | 'suppressed';
}

export interface ReconciledInterestGraph {
  ownerAccountId: string;
  projection: ProjectionStatus;
  interests: ReconciledInterestItem[];
  derived: ReconciledDerivedAffinity[];
}

interface EdgeRow {
  id: string;
  node_id: string | null;
  discovery_item_id: string | null;
  saved_item_id: string | null;
  origin: string;
  state: string;
}

export async function readReconciledInterestGraph(db: Queryable, accountId: string): Promise<ReconciledInterestGraph> {
  const snapshot = await loadExplicitSupport(db, accountId);
  const referenceIds = snapshot.captures.flatMap((c) => c.references.map((r) => r.referenceId));
  const [state, currentRevision, pendingEvents, edges, nodeRows] = await Promise.all([
    db.query<{
      state: string;
      projection_revision: number;
      target_taste_revision: number;
      applied_taste_revision: number;
      last_projected_at: Date | null;
      last_graph_run_id: string | null;
    }>(
      `SELECT state, projection_revision, target_taste_revision, applied_taste_revision,
              last_projected_at, last_graph_run_id
         FROM personal_graph_state WHERE owner_account_id = $1`,
      [accountId],
    ),
    getTasteRevision(db, { kind: 'account', accountId }),
    countUnsatisfiedGraphOutboxEvents(db, accountId),
    db.query<EdgeRow>(
      `SELECT id, node_id, discovery_item_id, saved_item_id, origin, state
         FROM personal_interest_edges WHERE owner_account_id = $1`,
      [accountId],
    ),
    referenceIds.length > 0
      ? db.query<{ cultural_reference_id: string; id: string }>(
          `SELECT cultural_reference_id, id FROM graph_nodes
            WHERE status = 'active' AND cultural_reference_id = ANY($1::uuid[])`,
          [referenceIds],
        )
      : Promise.resolve({ rows: [] as { cultural_reference_id: string; id: string }[] }),
  ]);

  const row = state.rows[0];
  const applied = row?.applied_taste_revision ?? 0;
  const lagging = pendingEvents > 0 || applied < currentRevision;

  // Projected edge ids by target, for decoration only: authority decides membership.
  // Saves of ownerless shared rows carry their own private saved-item edge.
  const edgeByItem = new Map<string, EdgeRow>();
  const edgeByNode = new Map<string, EdgeRow>();
  const edgeBySavedItem = new Map<string, EdgeRow>();
  for (const edge of edges.rows) {
    if (edge.discovery_item_id) edgeByItem.set(edge.discovery_item_id, edge);
    if (edge.node_id) edgeByNode.set(edge.node_id, edge);
    if (edge.saved_item_id) edgeBySavedItem.set(edge.saved_item_id, edge);
  }
  const nodeByReference = new Map(nodeRows.rows.map((r) => [r.cultural_reference_id, r.id]));

  const hidden = new Set(snapshot.exclusions);
  const canonicalByItem = new Map(snapshot.saves.map((s) => [s.itemId, s.canonicalKey]));
  const pickIdsByItem = new Map<string, string[]>();
  for (const group of snapshot.pickGroups) {
    for (const member of group.members) {
      if (hidden.has(member.canonicalKey)) continue;
      pickIdsByItem.set(member.itemId, [...(pickIdsByItem.get(member.itemId) ?? []), group.pickId]);
    }
  }
  const captureByItem = new Map(snapshot.captures.map((c) => [c.captureItemId, c]));

  const interests: ReconciledInterestItem[] = snapshot.saves
    .filter((s) => !hidden.has(s.canonicalKey))
    .map((s) => {
      const capture = captureByItem.get(s.itemId);
      return {
        itemId: s.itemId,
        canonicalKey: s.canonicalKey,
        kind: s.kind,
        origin: 'explicit' as const,
        state: 'confirmed' as const,
        edgeId: edgeByItem.get(s.itemId)?.id ?? edgeBySavedItem.get(s.savedItemId)?.id ?? null,
        savedItemId: s.savedItemId,
        pickIds: pickIdsByItem.get(s.itemId) ?? [],
        ...(capture ? { capturedBy: { captureId: capture.captureId, analysisId: capture.analysisId } } : {}),
      };
    });

  const derived: ReconciledDerivedAffinity[] = [];
  for (const capture of snapshot.captures) {
    // A hidden capture item is excluded from the account's interests, so its
    // derived affinities are excluded too — exactly like the projector.
    if (hidden.has(canonicalByItem.get(capture.captureItemId) ?? '')) continue;
    for (const ref of capture.references) {
      const nodeId = nodeByReference.get(ref.referenceId) ?? null;
      const edge = nodeId ? edgeByNode.get(nodeId) : undefined;
      derived.push({
        captureId: capture.captureId,
        captureItemId: capture.captureItemId,
        analysisId: capture.analysisId,
        analysisVersion: capture.analysisVersion,
        captureReferenceId: ref.captureReferenceId,
        referenceId: ref.referenceId,
        name: ref.name,
        relation: ref.relation,
        resolutionStatus: ref.resolutionStatus,
        isAnchor: ref.isAnchor,
        nodeId,
        edgeId: edge?.id ?? null,
        origin: 'derived',
        state: edge?.state === 'suppressed' ? 'suppressed' : 'tentative',
      });
    }
  }

  return {
    ownerAccountId: accountId,
    projection: {
      state: (row?.state ?? 'never_projected') as ProjectionStatus['state'],
      projectionRevision: row?.projection_revision ?? 0,
      targetTasteRevision: row?.target_taste_revision ?? 0,
      appliedTasteRevision: applied,
      currentTasteRevision: currentRevision,
      lagging,
      pendingEvents,
      lastProjectedAt: row?.last_projected_at ? row.last_projected_at.toISOString() : null,
      lastGraphRunId: row?.last_graph_run_id ?? null,
    },
    interests,
    derived,
  };
}
