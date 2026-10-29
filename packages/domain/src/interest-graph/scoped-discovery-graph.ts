import type { Db, Queryable } from '../db/pool';
import { AppError } from '../errors';
import { upsertDiscoveryItem, insertRecommendations, type RecommendationParent } from '../composer/store';
import type { Category, ItemKind, ReferenceType } from '../enums';
import { LIMITS } from '../enums';
import { JobCancelledError } from '../jobs/handler';
import { hiddenKeys } from '../library/access';
import type { Owner } from '../principal';
import { GRAPH_PATH_GRAMMAR_VERSION } from './assertion-policy';
import { verifiedNodeReferenceMatches, bilaterallyVerifiedReferenceNodes } from './identity-links';
import {
  EXPANSION_BOUNDS,
  RANKING_POLICY_VERSION,
  TEMPLATE_WEIGHTS,
  addOrientation,
  resolveReferenceNodes,
  traversalRows,
  type EdgeRow,
  type WalkEdge,
} from './expansion';
import { GraphWorkDeadlineExpiredError, isDeadlineCanceledStatement } from './budgets';
import { validateGraphPath, type ValidatedGraphPath } from './paths';
import { lockScopedPublicationAuthority, scopedWorkWindowEnded, type ScopedDiscoveryGrantAuthority } from './scoped-discovery';
import { revalidatePinnedDependencies } from './validity';

/**
 * The bounded graph-backed execution of the approved grant-scoped Discover
 * more branch (approved 2026-10-29; scoped-discover-graph-results).
 *
 * When the existing selected-collection operation's enqueue pinned a durable
 * grant authority (migration 360) and graph discovery is enabled for the
 * owning account, its `discover_related` job runs THIS pass instead of the
 * provider path:
 *
 *   - Roots are ONLY the origin's own CURRENT qualified identities — its own
 *     cultural reference (the verified subject identity the item was
 *     materialized from), and, for a capture origin, the ACTIVE analysis's
 *     `depicted`/`user_selected` resolved or user-confirmed references.
 *     `resolved_anchor_ids` NEVER roots a walk (DISC-SCR-032): those arrays
 *     are historical contributor unions the real compiler writes onto
 *     RECOMMENDED items from a source photo's contributing references and
 *     merges across analyses, so a film recommended from a Rodin photo is not
 *     Rodin, and an ungranted capture/collection's contributor can never
 *     leak into another context's walk. Visual-resemblance references and
 *     text-only mentions never root a scoped walk, the owner's latest
 *     correction withdraws its rejected references (and its confirmation
 *     restores one — the user is the evidence), exactly like the
 *     account-owned photo-root standard. Account-wide support, other
 *     collections' items and global taste never participate, and the legacy
 *     account-feed fallback never fills this branch's results.
 *   - Admission is the one shared rule: the approved path grammar
 *     (`validateGraphPath`) over reviewed, currently-justified shared
 *     evidence. No live model, no paid research, no provider call at all.
 *   - The photo lineage behind those roots is LOCKED through the commit
 *     (DISC-SCR-037): the pass pins the capture's row FIRST — before the
 *     grant fence's collection lock — reading the live active analysis and
 *     the owner's current correction intent under the lock, and rechecking
 *     the pinned lineage at its final publication boundary. The real
 *     capture writers (`activateAnalysis`'s pointer move, `submitCorrection`
 *     and `deleteCapture`, which all take the capture row lock before
 *     touching anything else) therefore serialize with publication in both
 *     orders: a writer that committed first is the lineage the pass walks
 *     (or rejects honestly), and one arriving mid-pass queues behind the
 *     held lock until the publication commits — never between the locked
 *     read and the commit.
 *   - Publication pins the exact walked assertion/evidence revisions under
 *     FOR SHARE locks at a fresh publication clock (DISC-SCR-009), then
 *     attaches the surviving results to the SCOPED DISCOVERY PARENT ONLY:
 *     recommendations of the pinned discovery job, with per-result pinned
 *     proofs (migration 370). No graph run, frontier, interest edge, feed
 *     snapshot or implicit save is ever written, and the immutable
 *     authority row is only read: replay and dedupe retain the enqueue-time
 *     grant epoch it pinned.
 *
 * The pass deliberately does NOT consult the account discovery pause: that
 * marker stops background expansion/research, while this is the explicit
 * per-origin operation the grant authorizes. The grant publication fence
 * (`lockScopedPublicationAuthority`, called inside the publication
 * transaction — DISC-SCR-040) holds the initiating connection and origin
 * collection locks through the commit, BEFORE the scoped parent's own row
 * lock, so real collection deletion never deadlocks the publication in
 * either order; the scoped parent's deletion fence stays in place. The
 * pass's UNLOCKED liveness callback (`ensureActive`) only stops it early:
 * the queue attempt fence (DISC-SCR-039) locks the execution's own queue
 * row at the tail and revalidates running state, ownership, the pinned
 * attempt, cancellation and the live lease through the commit, so real
 * cancellation, lease transfer, same-worker re-claims and tail-wait lease
 * expiry can never let a stale pass commit private results. The capture
 * lineage lock precedes all of them, matching the capture writers' own lock
 * order (capture row first, then collections, then the deletion cascades
 * that reach the parent).
 *
 * Bounded work (DISC-SCR-035): the immutable authority row's
 * `work_deadline_at` (migration 400) anchors this discovery's ONE work
 * window — the enqueue clock + the architectural 45 seconds, never reset by
 * retry or redelivery. Every statement and lock wait of the pass is bounded
 * to the window's CURRENT remaining time (re-tightened at each stage
 * boundary, so successive waits cannot cumulatively outrun the anchor),
 * and the final publication boundary re-reads the window and the grant's
 * live expiry with the database's own clock AFTER the tail writes (DISC-
 * SCR-038): an expired window or a connection that expired during an
 * intervening wait rolls the whole transaction back — no partial scoped
 * results, no provider fallback, and the typed outcomes stay distinct
 * (logical deadline vs token expiry).
 */

/** Operational bounds of one scoped graph pass: the shared expansion bounds. */
export const SCOPED_DISCOVERY_BOUNDS = {
  /** Distinct assertion rows one pass may traverse (VAL-DISC-004 parity). */
  maxAssertionsTraversed: EXPANSION_BOUNDS.maxAssertionsTraversed,
  /** Root→candidate pairs one pass may evaluate (VAL-DISC-004 parity). */
  maxCandidatesEvaluated: EXPANSION_BOUNDS.maxCandidatesEvaluated,
  /** Deterministic path attempts per (root, candidate) pair. */
  maxPathsPerCandidate: EXPANSION_BOUNDS.maxPathsPerCandidate,
  /** Result diversification: kept candidates per shared midpoint. */
  maxCandidatesPerMidpoint: EXPANSION_BOUNDS.maxCandidatesPerMidpoint,
  /** The scoped result rail cap (the operation's existing cached max). */
  maxResults: LIMITS.relatedCachedMax,
} as const;

/**
 * The origin's explicit-subject weight: the operation names this one item,
 * the same weight class an explicit personal root carries in the expansion
 * ranking, so the same cultural connection ranks identically in both passes.
 */
const SCOPED_ORIGIN_ROOT_WEIGHT = 0.4;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Honest bounded-work counters for one scoped graph pass. */
export interface ScopedGraphCounts {
  /** The origin's current qualified root references. */
  rootReferences: number;
  /** Distinct active shared identities the qualified references resolved to. */
  roots: number;
  /** Root references with no active shared identity (fail closed). */
  rootReferencesUnmapped: number;
  /** Distinct validated assertion rows traversed across both hops. */
  assertionsTraversed: number;
  /** Root→candidate pairs evaluated against the approved path grammar. */
  candidatesEvaluated: number;
  /** Candidates with an approved, currently-justified path. */
  admitted: number;
  /** Candidates whose every path attempt was rejected by the grammar. */
  rejected: number;
  /** Admitted candidates excluded by the owner's current hides. */
  hiddenExcluded: number;
  /** Admitted candidates outside the requested category (the operation's filter). */
  categoryFiltered: number;
  /** Admitted candidates with no application reference to materialize onto. */
  candidatesWithoutReferences: number;
  /** Results materialized onto a newly created owner catalog item. */
  candidatesMaterialized: number;
  /** Candidates resolved to an item through the read-time verified link. */
  candidatesResolvedByLink: number;
  /** Ranked results dropped because their pinned path failed the fresh-clock revalidation. */
  stalePinsDropped: number;
  /** Results attached to the scoped discovery parent. */
  resultsPublished: number;
  /** Pinned per-result proofs written. */
  proofsPublished: number;
}

/** One published scoped result, in rank order. */
export interface ScopedGraphResult {
  recommendationId: string;
  discoveryItemId: string;
  candidateNodeId: string;
  rank: number;
  reason: string;
}

export interface ScopedGraphDiscoveryOutcome {
  /** 'complete' when at least one admitted result attached to the scoped parent. */
  state: 'complete' | 'partial';
  /** The published results, in rank order. */
  results: ScopedGraphResult[];
  counts: ScopedGraphCounts;
  /** Deterministic grammar rejection codes with their counts. */
  rejections: Record<string, number>;
  truncated: { assertions: boolean; candidates: boolean };
  rankingPolicyVersion: string;
  grammarVersion: string;
}

/** The plain item shape a reference type materializes (the app's own catalog taxonomy). */
const REFERENCE_ITEM_SHAPE: Record<ReferenceType, { kind: ItemKind; category: Category | null; subtitle: string }> = {
  object: { kind: 'reference', category: null, subtitle: 'Artwork or object' },
  work: { kind: 'reference', category: null, subtitle: 'Work' },
  creator: { kind: 'artist', category: 'play', subtitle: 'Artist' },
  brand: { kind: 'brand', category: 'wear', subtitle: 'Brand' },
  style: { kind: 'style', category: 'wear', subtitle: 'Style direction' },
  tradition: { kind: 'reference', category: null, subtitle: 'Tradition' },
  place: { kind: 'reference', category: null, subtitle: 'Place' },
  cuisine: { kind: 'food', category: 'eat', subtitle: 'Cuisine' },
};

interface QualifiedRootReference {
  id: string;
  canonical_key: string;
  canonical_name: string;
  type: ReferenceType;
  external_ids: Record<string, unknown>;
}

/**
 * The origin's live photo lineage, pinned under the capture row lock at the
 * START of the pass's publication transaction (DISC-SCR-037): the capture the
 * origin item belongs to (an immutable column, read without a lock only to
 * know WHICH row to lock), its CURRENT active analysis, and the owner's
 * CURRENT correction intent (the latest correction of the capture — its
 * rejected references are withdrawn authorization, its confirmation
 * restores one; the user is the evidence). The FOR NO KEY UPDATE row lock is
 * held to the pass's commit, so every real capture writer —
 * `activateAnalysis`'s pointer move, `submitCorrection` and `deleteCapture`,
 * which all take this row first — serializes with the publication: a writer
 * that committed before the lock is the lineage walked here, and one arriving
 * mid-pass queues behind the publication instead of slipping between this
 * read and the commit. `null` when the origin is not a capture item, its
 * capture is deleted or it has no active analysis: no photo roots then.
 */
interface PhotoOriginLineage {
  captureId: string;
  /** The pinned active analysis: exactly this analysis's references may root the walk. */
  analysisId: string;
  /** References the owner's latest correction rejected (withdrawn authorization). */
  rejectedReferenceIds: string[];
  /** The reference the owner's latest correction confirmed (restores a rejected one). */
  confirmedReferenceId: string | null;
}

/**
 * Locks and pins the origin's photo lineage. The lock order is deliberate:
 * the capture row is locked BEFORE the grant fence's collection lock,
 * because the real deletion writer (deleteCapture) takes the capture row
 * first and then updates affected collection revisions — locking the
 * collection first would be the inverted order and a 40P01 deadlock cycle.
 * The lock wait itself is bounded by the work window's CURRENT remainder
 * (`bound`, DISC-SCR-035), and only a live capture's row is locked: a
 * deleted capture pins nothing and simply contributes no photo roots.
 */
async function lockPhotoOriginLineage(
  tx: Queryable,
  input: { originItemId: string; bound?: () => Promise<void> },
): Promise<PhotoOriginLineage | null> {
  const originItem = await tx.query<{ capture_id: string | null }>(
    'SELECT capture_id FROM discovery_items WHERE id = $1',
    [input.originItemId],
  );
  const captureId = originItem.rows[0]?.capture_id;
  if (!captureId) return null;
  await input.bound?.();
  const capture = await tx.query<{ active_analysis_id: string | null; owner_account_id: string | null }>(
    `SELECT active_analysis_id, owner_account_id
       FROM captures
      WHERE id = $1 AND deleted_at IS NULL
       FOR NO KEY UPDATE`,
    [captureId],
  );
  const row = capture.rows[0];
  if (!row || !row.active_analysis_id) return null;
  let rejectedReferenceIds: string[] = [];
  let confirmedReferenceId: string | null = null;
  if (row.owner_account_id != null) {
    const correction = await tx.query<{
      payload: { reject_reference_ids?: unknown; confirm_reference_id?: unknown };
    }>(
      `SELECT DISTINCT ON (e.target_id) e.payload
         FROM preference_events e
        WHERE e.owner_account_id = $1 AND e.action = 'correct' AND e.target_type = 'capture' AND e.target_id = $2
        ORDER BY e.target_id, e.created_at DESC, e.id DESC`,
      [row.owner_account_id, captureId],
    );
    const payload = correction.rows[0]?.payload;
    rejectedReferenceIds = Array.isArray(payload?.reject_reference_ids)
      ? payload.reject_reference_ids.filter((id): id is string => typeof id === 'string')
      : [];
    confirmedReferenceId = typeof payload?.confirm_reference_id === 'string' ? payload.confirm_reference_id : null;
  }
  return { captureId, analysisId: row.active_analysis_id, rejectedReferenceIds, confirmedReferenceId };
}

/**
 * The origin's CURRENT qualified root references: its OWN cultural reference
 * (the verified subject identity the item was materialized from), and — for
 * a capture origin whose lineage `lockPhotoOriginLineage` pinned — the
 * PINNED active analysis's authorized qualified references
 * (`depicted`/`user_selected`, resolved or user-confirmed, not text-only,
 * not rejected by the owner's latest correction, with that correction's
 * confirmation restoring one). `resembles` never qualifies (a
 * visual-resemblance claim is disabled until an independently qualified
 * compatible adapter and evidence exist), and the historical
 * `resolved_anchor_ids` contributor union is NEVER a root (DISC-SCR-032):
 * the real compiler writes a source photo's contributing references onto a
 * different RECOMMENDED item and merges them across analyses, so they are
 * not the origin's own identity and can carry ungranted contexts.
 */
async function qualifiedOriginRootReferences(
  tx: Queryable,
  input: { originItemId: string; photo: PhotoOriginLineage | null },
): Promise<QualifiedRootReference[]> {
  const branches = [
    `SELECT di.reference_id AS rid
       FROM discovery_items di
      WHERE di.id = $1 AND di.reference_id IS NOT NULL`,
  ];
  const params: unknown[] = [input.originItemId];
  if (input.photo) {
    params.push(input.photo.analysisId, input.photo.rejectedReferenceIds, input.photo.confirmedReferenceId);
    branches.push(
      `SELECT cr.reference_id AS rid
         FROM capture_references cr
        WHERE cr.analysis_id = $2
          AND cr.relation IN ('depicted', 'user_selected')
          AND NOT (cr.reference_id = ANY($3::uuid[]))
          AND (
            cr.reference_id = $4::uuid
            OR (cr.resolution_status IN ('resolved', 'user_confirmed') AND NOT cr.text_only)
          )`,
    );
  }
  const { rows } = await tx.query<QualifiedRootReference>(
    `SELECT r.id, r.canonical_key, r.canonical_name, r.type, r.external_ids
       FROM (${branches.join(' UNION ')}) x
       JOIN cultural_references r ON r.id = x.rid
      ORDER BY r.id`,
    params,
  );
  return rows;
}

interface ScopedObservation {
  nodeId: string;
  rootNodeId: string;
  rootReferenceId: string;
  templateKey: string;
  reason: string;
  grammarVersion: string;
  midNodeId: string;
  score: number;
  assertions: Array<{ id: string; revision: number }>;
  evidence: Array<{ id: string; revision: number }>;
}

/** One admitted candidate's resolved application reference. */
interface CandidateReference {
  referenceId: string;
  canonicalKey: string;
  canonicalName: string;
  type: ReferenceType;
  externalIds: Record<string, unknown>;
  /** True when the reference resolved through the read-time verified link. */
  byLink: boolean;
}

/**
 * The admitted candidates' application references: a corpus identity's
 * durable reference binding, or (only for identities with no binding row at
 * all) the verified provider-id link under the durable linker's full
 * bilateral rules — the same fail-closed resolution expansion applies. An
 * identity matching two references, an ambiguous inverse match or a
 * competing durable binding materializes nothing; the candidate is honestly
 * counted as without a reference.
 */
async function candidateReferences(
  tx: Queryable,
  nodeIds: readonly string[],
): Promise<Map<string, CandidateReference>> {
  const unique = [...new Set(nodeIds)];
  const out = new Map<string, CandidateReference>();
  if (unique.length === 0) return out;
  type ReferenceRow = {
    id: string;
    canonical_key: string;
    canonical_name: string;
    type: ReferenceType;
    external_ids: Record<string, unknown>;
  };
  const { rows: nodes } = await tx.query<{
    id: string;
    cultural_reference_id: string | null;
  }>(`SELECT id, cultural_reference_id FROM graph_nodes WHERE id = ANY($1::uuid[])`, [unique]);
  const boundByNode = new Map(
    nodes.filter((n) => n.cultural_reference_id != null).map((n) => [n.id, n.cultural_reference_id!]),
  );
  const byReferenceId = async (ids: string[]): Promise<Map<string, ReferenceRow>> => {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<ReferenceRow>(
      `SELECT id, canonical_key, canonical_name, type, external_ids FROM cultural_references WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((r) => [r.id, r]));
  };
  const boundRefs = await byReferenceId([...new Set([...boundByNode.values()])]);
  for (const [nodeId, referenceId] of boundByNode) {
    const ref = boundRefs.get(referenceId);
    if (!ref) continue;
    out.set(nodeId, {
      referenceId: ref.id,
      canonicalKey: ref.canonical_key,
      canonicalName: ref.canonical_name,
      type: ref.type,
      externalIds: ref.external_ids ?? {},
      byLink: false,
    });
  }
  // Read-time verified link for identities with no durable binding row.
  const unbound = nodes.filter((n) => n.cultural_reference_id == null).map((n) => n.id);
  if (unbound.length === 0) return out;
  const matches = await verifiedNodeReferenceMatches(tx, { nodeIds: unbound });
  const solePairs: Array<{ nodeId: string; referenceId: string }> = [];
  for (const nodeId of unbound) {
    const refs = matches.get(nodeId) ?? [];
    // One identity matching two references materializes neither.
    if (refs.length === 1) solePairs.push({ nodeId, referenceId: refs[0]! });
  }
  if (solePairs.length === 0) return out;
  // The surviving pairs pass the same bilateral gate the root fallback uses.
  const verdict = await bilaterallyVerifiedReferenceNodes(tx, {
    referenceIds: solePairs.map((p) => p.referenceId),
  });
  const linkedRefs = await byReferenceId([...verdict.acceptedByReference.keys()]);
  for (const pair of solePairs) {
    if (verdict.acceptedByReference.get(pair.referenceId) !== pair.nodeId) continue;
    const ref = linkedRefs.get(pair.referenceId);
    if (!ref) continue;
    out.set(pair.nodeId, {
      referenceId: ref.id,
      canonicalKey: ref.canonical_key,
      canonicalName: ref.canonical_name,
      type: ref.type,
      externalIds: ref.external_ids ?? {},
      byLink: true,
    });
  }
  return out;
}

/** Pins the walked assertions' exact revisions and their live reviewed evidence. */
async function scopedObservationFromPath(
  tx: Queryable,
  input: { rootNodeId: string; rootReferenceId: string; at: Date },
  path: ValidatedGraphPath,
): Promise<ScopedObservation | null> {
  const assertionRows = await tx.query<{ id: string; revision: number }>(
    'SELECT id, revision FROM graph_assertions WHERE id = ANY($1::uuid[])',
    [path.assertionIds],
  );
  const revisionById = new Map(assertionRows.rows.map((r) => [r.id, r.revision]));
  const assertions = path.assertionIds.map((id) => ({ id, revision: revisionById.get(id) ?? 0 }));

  // The live grounding witnesses behind the walked edges: reviewed,
  // currently-valid evidence on currently-valid source revisions, with no
  // passed evidence or rights expiry — the same live-witness set the
  // expansion observation pins. No live witness means no admission.
  const evidenceRows = await tx.query<{ evidence_id: string; revision: number }>(
    `SELECT DISTINCT s.evidence_id, r.revision
       FROM graph_assertion_support s
       JOIN graph_evidence e ON e.id = s.evidence_id
       JOIN graph_source_revisions r ON r.id = e.source_revision_id
      WHERE s.assertion_id = ANY($1::uuid[])
        AND s.role = 'supports'
        AND e.reviewed_by IS NOT NULL AND e.reviewed_at IS NOT NULL
        AND e.validity_state = 'valid' AND r.validity_state = 'valid'
        AND (e.expires_at IS NULL OR e.expires_at > $2::timestamptz)
        AND (r.rights_expires_at IS NULL OR r.rights_expires_at > $2::timestamptz)
      ORDER BY s.evidence_id`,
    [path.assertionIds, input.at],
  );
  if (evidenceRows.rows.length === 0) return null;
  const evidence = evidenceRows.rows.map((r) => ({ id: r.evidence_id, revision: r.revision }));

  return {
    nodeId: path.candidateNodeId,
    rootNodeId: path.rootNodeId,
    rootReferenceId: input.rootReferenceId,
    templateKey: path.templateKey,
    reason: path.reason,
    grammarVersion: path.grammarVersion,
    midNodeId: path.midNodeId,
    score: round2((TEMPLATE_WEIGHTS[path.templateKey] ?? 0) + SCOPED_ORIGIN_ROOT_WEIGHT),
    assertions,
    evidence,
  };
}

/** Deterministic best-observation comparison: score, template, then walk ids. */
function betterObservation(a: ScopedObservation, b: ScopedObservation): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.templateKey !== b.templateKey) return a.templateKey < b.templateKey;
  return a.assertions.map((x) => x.id).join(',') < b.assertions.map((x) => x.id).join(',');
}

function emptyCounts(): ScopedGraphCounts {
  return {
    rootReferences: 0,
    roots: 0,
    rootReferencesUnmapped: 0,
    assertionsTraversed: 0,
    candidatesEvaluated: 0,
    admitted: 0,
    rejected: 0,
    hiddenExcluded: 0,
    categoryFiltered: 0,
    candidatesWithoutReferences: 0,
    candidatesMaterialized: 0,
    candidatesResolvedByLink: 0,
    stalePinsDropped: 0,
    resultsPublished: 0,
    proofsPublished: 0,
  };
}

/**
 * Runs the bounded graph-backed pass for one pinned scoped discovery and
 * attaches its admitted results to the scoped discovery parent.
 *
 * Everything commits in one transaction: the scoped parent's liveness fence,
 * the walk, the pin locks and revalidation, the results and their pinned
 * proofs appear together or not at all. The immutable grant authority row is
 * only READ — retry, redelivery and dedupe retain the enqueue-time epoch it
 * pinned, and a redelivery converges by rebuilding the scoped results from
 * current authority (delete + re-insert) without touching any account-owned
 * graph state.
 */
export async function runScopedGraphDiscovery(
  db: Db,
  input: {
    /** The immutable migration-360 authority this discovery was enqueued under. */
    authority: ScopedDiscoveryGrantAuthority;
    /** The operation's requested category filter, if any. */
    category: Category | null;
    /**
     * Job-liveness fence, invoked immediately before any publication write.
     * An UNLOCKED cooperative check (the real Worker's `stillOwnsJob` read
     * on the pool plus its abort signal): it stops the pass early, but it
     * is not authority through the committing writes — when `queue` is
     * present, the tail's locked queue revalidation below is what actually
     * fences the publication (DISC-SCR-039).
     */
    ensureActive: () => Promise<void>;
    /**
     * The real queue attempt authority of THIS execution (DISC-SCR-039):
     * the worker that claimed the queue job and the attempt it claimed
     * (`authority.job_id` pins the queue job). The production
     * discover_related handler always passes both from its JobContext.
     * When present, the tail publication stage LOCKS the pass's own queue
     * row — FOR NO KEY UPDATE, the compatible strength: it conflicts with
     * every queue writer's row lock (heartbeat, cancel, reclaim, reap and
     * completion all touch the row) while FK-dependent job_stages readers
     * (FOR KEY SHARE) keep flowing — and revalidates under the lock the
     * full attempt authority: still `running`, still this worker, still
     * this attempt (a same-worker re-claim advanced it), not cancelled,
     * and a lease still live at the database's own clock. The lock holds
     * through the commit, so a queue writer that committed before it is
     * the state revalidated (cancellation/lease-transfer-first: the pass
     * rejects and the whole transaction rolls back) and one arriving
     * during the tail writes queues behind the publication and lands
     * after it (publisher-first: no retroactive failure of a committed
     * publication). The pinned lease expiry is rechecked at the final
     * publication boundary: only time can move it while the row is locked.
     * The lock is taken only at the tail — the walk stays
     * heartbeat-friendly — and its waits stay bounded by the work window's
     * current remainder, never a queue heartbeat deadlock. Harnesses
     * running the pass without a real claimed lease omit it and keep the
     * `ensureActive` fence as before.
     */
    queue?: { workerId: string; attempt: number };
    at?: Date;
    /**
     * The clock the deadline stage checks read (default: real time). The
     * FINAL publication boundary always uses the database's own clock.
     */
    now?: () => Date;
    /** The worker's cooperative stop (lease loss, cancellation, per-attempt timer). */
    signal?: AbortSignal;
  },
): Promise<ScopedGraphDiscoveryOutcome> {
  const at = input.at ?? new Date();
  const { authority } = input;
  const owner: Owner = { kind: 'account', accountId: authority.owner_account_id };
  // The anchored end of this discovery's ONE scoped work window (DISC-SCR-
  // 035, migration 400): immutable with the authority row, so this attempt,
  // every retry and every redelivery share it — never a fresh 45 seconds.
  const deadlineAt = authority.work_deadline_at;
  const deadlineNow = input.now ?? (() => new Date());

  try {
    return await db.transaction(async (tx) => {
      const counts = emptyCounts();
      const rejections: Record<string, number> = {};
      const noteRejection = (code: string) => {
        rejections[code] = (rejections[code] ?? 0) + 1;
      };
      const truncated = { assertions: false, candidates: false };

      // The logical window governs every stage of this pass (DISC-SCR-035):
      // each stage check ends a pass whose anchored deadline passed and
      // re-tightens the SQL bound to the CURRENT remainder — the entry bound
      // alone would let a LATE lock wait run a full window past the anchor
      // before a later check rolled it back (the DISC-SCR-018 discipline).
      // `SET LOCAL` is scoped to this transaction, so pooled clients never
      // leak the limit.
      const enforceDeadline = async (): Promise<void> => {
        if (input.signal?.aborted) throw new JobCancelledError('attempt stopped');
        if (deadlineNow().getTime() >= deadlineAt.getTime()) throw new GraphWorkDeadlineExpiredError();
        const ms = Math.max(1, Math.ceil(deadlineAt.getTime() - deadlineNow().getTime()));
        await tx.query(`SET LOCAL statement_timeout = ${ms}`);
        await tx.query(`SET LOCAL lock_timeout = ${ms}`);
      };
      await enforceDeadline();

      // --- The origin's photo lineage lock (DISC-SCR-037) --------------------------
      // Taken BEFORE the grant fence's collection lock and the scoped parent's
      // row lock, because the real capture writers take the capture row
      // FIRST (activateAnalysis's pointer move is a bare captures UPDATE,
      // and deleteCapture locks the capture FOR UPDATE before it updates
      // affected collection revisions and cascades the origin's deletion to
      // the parent): any other order would be a 40P01 deadlock cycle in one
      // of the two commit orders. The pinned lineage — the live active
      // analysis and the owner's current correction intent, read under the
      // lock — is the ONLY photo authority the walk may root from, and the
      // lock holds it through this commit: an activation, correction or
      // deletion either committed before this read (it IS the lineage walked
      // here, or the capture is honestly gone) or queues behind the
      // publication and lands after (publisher-first: the pass published
      // under exactly the lineage it walked, and a redelivery converges on
      // the new state). A non-capture origin pins nothing here.
      const photoLineage = await lockPhotoOriginLineage(tx, {
        originItemId: authority.origin_item_id,
        bound: enforceDeadline,
      });
      await enforceDeadline();

      // The grant publication fence (VAL-DISC-007): lock the initiating
      // connection's row and the origin collection's row FOR SHARE and
      // recheck the pinned epoch against CURRENT live state — liveness,
      // authorization version, per-collection grant epoch, collection
      // ownership and the origin's membership — holding both locks through
      // this commit. A real owner revocation, narrowing, grant replace,
      // membership removal or collection deletion either committed before
      // this read (the work rejects; nothing publishes, and
      // retry/dedupe/regrant cannot adopt the newer epoch) or waits behind
      // it (publisher-first: the results publish under the authority held
      // here, and read-time denial applies after the mutation lands). No
      // work runs under a dead authority. The fence also rechecks the
      // connection's ACTUAL expiry at a fresh database clock after its own
      // lock waits (DISC-SCR-038) and returns the pinned expiry for the
      // pass's final publication boundary.
      //
      // LOCK ORDER (DISC-SCR-040): the fence runs BEFORE the scoped
      // parent's row lock below. The real deleteCollection path locks the
      // collection FOR UPDATE and its DELETE then fires the parent's ON
      // DELETE SET NULL action, which must UPDATE the parent row — so a
      // parent-first pass could hold the parent while waiting on the
      // collection the deleter holds, a 40P01 deadlock cycle in both
      // commit orders. Collection-before-parent matches the deletion path:
      // deletion-first now lets the pass queue on the collection and then
      // honestly reject (the collection is gone), and publisher-first lets
      // the deletion queue behind the publication and land after it —
      // where the durable scoped marker fails the job closed on
      // redelivery. Never a deadlock.
      const fence = await lockScopedPublicationAuthority(tx, { authority, bound: enforceDeadline });
      await enforceDeadline();

      // The scoped parent's own deletion fence: a deleted origin item cascades
      // the discovery job away, and the locked row pins the parent (and its
      // owner) through the commit.
      const parentRow = await tx.query(
        'SELECT 1 FROM discovery_jobs WHERE id = $1 AND owner_account_id = $2 FOR UPDATE',
        [authority.discovery_job_id, authority.owner_account_id],
      );
      if (!parentRow.rowCount) throw new JobCancelledError('origin deleted');
      await enforceDeadline();
      // The origin is the owner's own item OR a validated public sample (the
      // shared ownerless items the owner saved into the granted collection —
      // DISC-SCR-030): never another account's private item and never an
      // arbitrary ownerless row, exactly like the enqueue-time eligibility rule.
      const origin = await tx.query<{ id: string; canonical_key: string }>(
        `SELECT id, canonical_key FROM discovery_items
          WHERE id = $1 AND (owner_account_id = $2 OR (owner_account_id IS NULL AND is_sample))`,
        [authority.origin_item_id, authority.owner_account_id],
      );
      if (!origin.rows[0]) throw new JobCancelledError('origin deleted');
      await enforceDeadline();
      const originItemId = origin.rows[0]!.id;
      const originCanonicalKey = origin.rows[0]!.canonical_key;
      await tx.query(`UPDATE discovery_jobs SET status = 'running' WHERE id = $1`, [authority.discovery_job_id]);

      // --- Qualified roots: ONLY this origin's own current identities ----------------
      // The item's own cultural reference, plus the pinned live photo
      // lineage's authorized qualified references — never the historical
      // `resolved_anchor_ids` contributor union (DISC-SCR-032).
      const rootReferences = await qualifiedOriginRootReferences(tx, {
        originItemId,
        photo: photoLineage,
      });
      counts.rootReferences = rootReferences.length;
      const resolution = await resolveReferenceNodes(tx, rootReferences.map((r) => r.id));
      await enforceDeadline();
      const rootNodeIds: string[] = [];
      const rootReferenceByNode = new Map<string, QualifiedRootReference>();
      for (const ref of rootReferences) {
        const nodeId = resolution.byReference.get(ref.id);
        if (!nodeId) {
          counts.rootReferencesUnmapped++;
          continue;
        }
        if (!rootReferenceByNode.has(nodeId)) {
          rootNodeIds.push(nodeId);
          rootReferenceByNode.set(nodeId, ref);
        }
      }
      counts.roots = rootNodeIds.length;
      const rootNodeSet = new Set(rootNodeIds);

      // --- Bounded two-hop walk (the shared walk primitives and bounds) -------------
      const hop1 = new Map<string, WalkEdge[]>();
      const hop2 = new Map<string, WalkEdge[]>();
      const seen = new Set<string>();
      if (rootNodeIds.length > 0) {
        const hop1Rows: EdgeRow[] = await traversalRows(tx, rootNodeIds, [], SCOPED_DISCOVERY_BOUNDS.maxAssertionsTraversed, at);
        counts.assertionsTraversed = hop1Rows.length;
        truncated.assertions = hop1Rows.length === SCOPED_DISCOVERY_BOUNDS.maxAssertionsTraversed;
        for (const row of hop1Rows) {
          seen.add(row.id);
          addOrientation(hop1, row, rootNodeSet);
        }
        await enforceDeadline();
        const midIds = [...new Set([...hop1.values()].flat().map((e) => e.far))];
        const remaining = SCOPED_DISCOVERY_BOUNDS.maxAssertionsTraversed - seen.size;
        if (midIds.length > 0 && remaining > 0) {
          const midSet = new Set(midIds);
          const hop2Rows = await traversalRows(tx, midIds, [...seen], remaining, at);
          counts.assertionsTraversed += hop2Rows.length;
          if (hop2Rows.length === remaining) truncated.assertions = true;
          for (const row of hop2Rows) {
            seen.add(row.id);
            addOrientation(hop2, row, midSet);
          }
        }
      }
    await enforceDeadline();

      // --- Candidate pairs (deterministic order) ------------------------------------
      const pairs: Array<{ root: string; candidateNodeId: string; paths: Array<[WalkEdge, WalkEdge]> }> = [];
      for (const root of [...rootNodeIds].sort()) {
        const byCandidate = new Map<string, Array<[WalkEdge, WalkEdge]>>();
        for (const e1 of hop1.get(root) ?? []) {
          // Second hops from the midpoint come from both loaded layers,
          // including edges already loaded in hop one and oriented from a
          // midpoint that is itself a root — each distinct assertion still
          // counts once (the row is already in `seen`).
          const secondHops = [...(hop2.get(e1.far) ?? []), ...(hop1.get(e1.far) ?? [])];
          for (const e2 of secondHops) {
            if (e2.id === e1.id) continue;
            if (e2.far === root) continue;
            const paths = byCandidate.get(e2.far);
            if (paths) paths.push([e1, e2]);
            else byCandidate.set(e2.far, [[e1, e2]]);
          }
        }
        for (const candidateNodeId of [...byCandidate.keys()].sort()) {
          if (rootNodeSet.has(candidateNodeId)) {
            noteRejection('candidate_is_root');
            continue;
          }
          const paths = byCandidate.get(candidateNodeId)!.sort((a, b) =>
            a[0].id === b[0].id ? (a[1].id < b[1].id ? -1 : 1) : a[0].id < b[0].id ? -1 : 1,
          );
          pairs.push({ root, candidateNodeId, paths: paths.slice(0, SCOPED_DISCOVERY_BOUNDS.maxPathsPerCandidate) });
        }
      }

      // --- Shared admission: the approved path grammar over current evidence --------
      const admitted: ScopedObservation[] = [];
      for (const pair of pairs) {
        if (counts.candidatesEvaluated >= SCOPED_DISCOVERY_BOUNDS.maxCandidatesEvaluated) {
          truncated.candidates = true;
          break;
        }
        await enforceDeadline();
        counts.candidatesEvaluated++;
        let obs: ScopedObservation | null = null;
        for (const [e1, e2] of pair.paths) {
          const validation = await validateGraphPath(tx, {
            rootNodeId: pair.root,
            candidateNodeId: pair.candidateNodeId,
            assertionIds: [e1.id, e2.id],
            at,
          });
          if (validation.path) {
            obs = await scopedObservationFromPath(
              tx,
              { rootNodeId: pair.root, rootReferenceId: rootReferenceByNode.get(pair.root)!.id, at },
              validation.path,
            );
            // An approved composition with no live grounding witness admits
            // nothing: unreviewed or withdrawn evidence never justifies a
            // scoped reason, exactly as in the expansion admission.
            if (obs) break;
            noteRejection('no_live_evidence');
            continue;
          }
          noteRejection(validation.rejection!.code);
        }
        if (obs) admitted.push(obs);
        else counts.rejected++;
      }

      // --- Best observation per candidate --------------------------------------------
      const best = new Map<string, ScopedObservation>();
      for (const obs of admitted) {
        const prev = best.get(obs.nodeId);
        if (!prev || betterObservation(obs, prev)) best.set(obs.nodeId, obs);
      }
      counts.admitted = best.size;

      // --- Ranking: versioned, deterministic, diversified ----------------------------
      const ranked = [...best.values()].sort(
        (a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
      );
      const perMid = new Map<string, number>();
      const diversified: ScopedObservation[] = [];
      for (const obs of ranked) {
        const n = (perMid.get(obs.midNodeId) ?? 0) + 1;
        perMid.set(obs.midNodeId, n);
        if (n > SCOPED_DISCOVERY_BOUNDS.maxCandidatesPerMidpoint) continue;
        diversified.push(obs);
      }

      // Every surviving candidate's application reference, before the
      // exclusion decisions that depend on its item shape.
      const references = await candidateReferences(tx, diversified.map((o) => o.nodeId));

      // --- Publication pins: exact revisions at a fresh clock (DISC-SCR-009) ----------
      // The pinned dependency rows are locked FOR SHARE in one consistent
      // ascending-id order and held to this transaction's commit, coordinating
      // with the retraction path's ordering: a withdrawal or revision change
      // either commits before these locked reads — visible here, so the result
      // is dropped — or waits for this commit, and its dependent scan then
      // invalidates whatever this pass published. Nothing can slip between the
      // validation and the commit.
      const pinAssertionIds = [...new Set(diversified.flatMap((o) => o.assertions.map((a) => a.id)))].sort();
      const pinEvidenceIds = [...new Set(diversified.flatMap((o) => o.evidence.map((e) => e.id)))].sort();
      await enforceDeadline();
      if (pinAssertionIds.length > 0) {
        await tx.query(`SELECT id FROM graph_assertions WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`, [
          pinAssertionIds,
        ]);
      }
      // The evidence pin lock is a SECOND independent wait inside this one
      // pin stage: the bound is re-tightened to the CURRENT remainder so the
      // time the assertion wait consumed cannot widen this one (DISC-SCR-025).
      await enforceDeadline();
      if (pinEvidenceIds.length > 0) {
        await tx.query(`SELECT id FROM graph_evidence WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`, [
          pinEvidenceIds,
        ]);
      }
      await enforceDeadline();
      let publishAt = at;
      if (diversified.length > 0) {
        const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        publishAt = clock.rows[0]!.now;
      }
      const publishing: Array<{ obs: ScopedObservation; reference: CandidateReference }> = [];
      for (const obs of diversified) {
        // Each candidate's dependency revalidation runs its own real lock
        // waits on the pinned rows (DISC-SCR-041): the bound is re-tightened
        // to the CURRENT remainder at every actual wait, not once for the
        // whole loop, so successive waits cannot cumulatively outrun the
        // anchor while this pass still holds its grant and collection locks.
        await enforceDeadline();
        const reference = references.get(obs.nodeId);
        if (!reference) {
          counts.candidatesWithoutReferences++;
          noteRejection('candidate_without_reference');
          continue;
        }
        // The requested category is the operation's existing filter: a scoped
        // graph result materializes only within it, never padded from outside.
        const shape = REFERENCE_ITEM_SHAPE[reference.type];
        if (input.category && shape.category !== input.category) {
          counts.categoryFiltered++;
          continue;
        }
        const verdict = await revalidatePinnedDependencies(tx, {
          assertions: obs.assertions,
          evidence: obs.evidence,
          at: publishAt,
        });
        if (!verdict.valid) {
          counts.stalePinsDropped++;
          noteRejection(`pinned_${verdict.reason ?? 'dependency_missing'}`);
          continue;
        }
        publishing.push({ obs, reference });
      }

      // --- Results: existing owner items first, materialized catalog items otherwise --
      // Both reads between the per-candidate revalidation and the
      // materialization loop are real lock waits too (DISC-SCR-041): each
      // gets its own remainder-tight bound, so neither inherits the time the
      // candidate loop already consumed.
      await enforceDeadline();
      const hidden = await hiddenKeys(tx, owner);
      const referenceIds = [...new Set(publishing.map((p) => p.reference.referenceId))];
      const existingItems = new Map<string, { id: string; canonical_key: string }>();
      if (referenceIds.length > 0) {
        await enforceDeadline();
        const { rows } = await tx.query<{ id: string; canonical_key: string; reference_id: string }>(
          `SELECT id, canonical_key, reference_id FROM discovery_items
            WHERE owner_account_id = $1 AND reference_id = ANY($2::uuid[])
            ORDER BY id`,
          [authority.owner_account_id, referenceIds],
        );
        for (const row of rows) {
          if (!existingItems.has(row.reference_id)) existingItems.set(row.reference_id, row);
        }
      }
      const finalEntries: Array<{ obs: ScopedObservation; reference: CandidateReference; itemId: string; category: Category | null }> = [];
      for (const { obs, reference } of publishing) {
        // The materialization upsert is a real INSERT ... ON CONFLICT on the
        // (owner, canonical_key) unique index that other scoped jobs and the
        // real compiler write too (DISC-SCR-041): its lock wait is bounded by
        // the window's CURRENT remainder, refreshed at every candidate — one
        // early bound for the whole loop let a first short wait hand the
        // second upsert a stale remainder, parking grant and collection locks
        // past the anchor until the final rollback caught up.
        await enforceDeadline();
        if (reference.byLink) counts.candidatesResolvedByLink++;
        const existing = existingItems.get(reference.referenceId);
        // A candidate hidden by canonical key (its own item's or its
        // reference's) never publishes; hiding is a current constraint.
        if (hidden.has(reference.canonicalKey) || (existing && hidden.has(existing.canonical_key))) {
          counts.hiddenExcluded++;
          continue;
        }
        let itemId = existing?.id ?? null;
        if (!itemId) {
          itemId = await upsertDiscoveryItem(tx, owner, {
            kind: REFERENCE_ITEM_SHAPE[reference.type].kind,
            category: REFERENCE_ITEM_SHAPE[reference.type].category,
            canonical_key: reference.canonicalKey,
            title: reference.canonicalName,
            display_metadata: { subtitle: REFERENCE_ITEM_SHAPE[reference.type].subtitle },
            external_ids: reference.externalIds,
            reference_id: reference.referenceId,
          });
          counts.candidatesMaterialized++;
        }
        // The origin itself is never one of its own results.
        if (itemId === originItemId || reference.canonicalKey === originCanonicalKey) continue;
        finalEntries.push({ obs, reference, itemId, category: REFERENCE_ITEM_SHAPE[reference.type].category });
      }

      // Re-rank after the honest exclusions so published ranks stay dense and
      // deterministic, then cap the rail at the operation's cached max.
      finalEntries.sort(
        (a, b) =>
          b.obs.score - a.obs.score || (a.obs.nodeId < b.obs.nodeId ? -1 : a.obs.nodeId > b.obs.nodeId ? 1 : 0),
      );
      const capped = finalEntries.slice(0, SCOPED_DISCOVERY_BOUNDS.maxResults);

      // --- Attach to the scoped discovery parent ONLY ---------------------------------
      // The tail writes are real lock waits too (a concurrent retraction can
      // hold the rows being replaced): the bound is refreshed here, and the
      // fresh-clock final boundary below rolls the whole pass back if a tail
      // wait outlives the window.
      await enforceDeadline();
      await input.ensureActive();
      // --- The queue attempt fence (DISC-SCR-039) --------------------------------------
      // The pass's unlocked liveness callback above is NOT authority through
      // the committing writes: the real queue writers — cancelJob, the
      // reclaiming claimJobs, reapJobs, the heartbeat and job completion —
      // are single-row jobs UPDATEs that can commit between that read and
      // this commit while a tail write waits on someone else's lock. So the
      // tail first LOCKS this execution's own queue row (FOR NO KEY UPDATE:
      // it conflicts with every queue writer's row lock while
      // FK-dependent job_stages readers keep flowing) and revalidates, under
      // the lock, the FULL attempt authority this execution claimed: the row
      // is still `running`, still owned by this worker, still this attempt
      // (a same-worker re-claim advanced it — a stale pass never publishes
      // over a newer attempt), not cancelled, and its lease is still live
      // at the database's own clock. The lock holds through this commit:
      // a writer that committed before it is the state revalidated here
      // (cancellation/lease-transfer-first: reject and roll the whole
      // transaction back — no stale rows), and one arriving during the tail
      // writes queues behind the publication and lands after it
      // (publisher-first: the pass publishes under exactly the authority
      // it validated, and the later cancellation/reclaim never
      // retroactively fails a committed publication). The guard's lock
      // wait is bounded by the window's CURRENT remainder, so a queue
      // writer can never be starved by a pass that already lost its window.
      let queueLeaseExpiresAt: Date | null = null;
      if (input.queue) {
        const guard = await tx.query<{ lease_expiry: Date }>(
          `SELECT lease_expiry FROM jobs
            WHERE id = $1 AND type = 'discover_related'
              AND state = 'running' AND lease_owner = $2 AND attempt = $3
              AND cancel_requested_at IS NULL
              AND lease_expiry > clock_timestamp()
            FOR NO KEY UPDATE`,
          [authority.job_id, input.queue.workerId, input.queue.attempt],
        );
        if (!guard.rows[0]) throw new JobCancelledError('lease lost');
        queueLeaseExpiresAt = guard.rows[0].lease_expiry;
      }
      await enforceDeadline();
      await tx.query('DELETE FROM recommendations WHERE discovery_job_id = $1', [authority.discovery_job_id]);
      const contributingReferenceIds = rootReferences.map((r) => r.id);
      const parent: RecommendationParent = { kind: 'discovery_job', discoveryJobId: authority.discovery_job_id };
      const results: ScopedGraphResult[] = [];
      if (capped.length > 0) {
        // The tail recommendation writes are a per-row helper loop
        // (DISC-SCR-041): the deadline stage is threaded in so each row's
        // INSERT is bounded by the CURRENT remainder, never one earlier
        // relative timeout for the whole batch.
        const recIds = await insertRecommendations(
          tx,
          parent,
          capped.map((entry, i) => ({
            discovery_item_id: entry.itemId,
            category: entry.category,
            rank: i + 1,
            title: entry.reference.canonicalName,
            external_ids: entry.reference.externalIds,
            display_reason: entry.obs.reason,
            origin: 'catalog' as const,
            provider_query_ids: [],
            contributing_reference_ids: contributingReferenceIds,
            destination_url: null,
          })),
          enforceDeadline,
        );
        for (let i = 0; i < capped.length; i += 1) {
          const entry = capped[i]!;
          // Each proof INSERT is its own real lock wait behind the same
          // re-tightened remainder (DISC-SCR-041), like every materialization
          // wait above.
          await enforceDeadline();
          await tx.query(
            `INSERT INTO scoped_discovery_result_proofs
               (owner_account_id, discovery_job_id, recommendation_id,
                assertion_ids, assertion_revisions, evidence_ids, evidence_revisions,
                reason_template, reason_template_version, root_node_id, mid_node_id, candidate_node_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              authority.owner_account_id,
              authority.discovery_job_id,
              recIds[i],
              entry.obs.assertions.map((a) => a.id),
              entry.obs.assertions.map((a) => a.revision),
              entry.obs.evidence.map((e) => e.id),
              entry.obs.evidence.map((e) => e.revision),
              entry.obs.templateKey,
              entry.obs.grammarVersion,
              entry.obs.rootNodeId,
              entry.obs.midNodeId,
              entry.obs.nodeId,
            ],
          );
          counts.proofsPublished++;
          results.push({
            recommendationId: recIds[i]!,
            discoveryItemId: entry.itemId,
            candidateNodeId: entry.obs.nodeId,
            rank: i + 1,
            reason: entry.obs.reason,
          });
        }
      }
      counts.resultsPublished = results.length;
      const state: 'complete' | 'partial' = results.length > 0 ? 'complete' : 'partial';
      // The terminal status UPDATE is the tail's last real write wait
      // (DISC-SCR-041): bounded by the CURRENT remainder too, before the
      // fresh-clock final boundary below takes the last word.
      await enforceDeadline();
      await tx.query(`UPDATE discovery_jobs SET status = $2 WHERE id = $1`, [authority.discovery_job_id, state]);

      // --- The final publication boundary (DISC-SCR-035/038) ------------------------
      // One fresh database clock has the last word AFTER the tail
      // DELETE/INSERT/proof writes, immediately before this transaction
      // commits: the immutable work window's anchored end, and the
      // initiating connection's live expiry (its row is pinned under the
      // fence's FOR SHARE lock — only time can move it now). A wait that
      // resumed after either one passed rolls the WHOLE pass back — no
      // partial scoped results, no provider fallback — and the two outcomes
      // stay distinct: the logical deadline of the work window versus the
      // grant's own token expiry.
      const finalClock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const finalNow = finalClock.rows[0]!.now;
      if (deadlineAt.getTime() <= finalNow.getTime()) throw new GraphWorkDeadlineExpiredError();
      if (fence.connectionExpiresAt && fence.connectionExpiresAt.getTime() <= finalNow.getTime()) {
        throw new AppError('token_expired');
      }
      // The queue attempt fence gets the same last word (DISC-SCR-039): the
      // pinned lease expiry is the only attempt authority that can still
      // move while the row is locked — only time can move it — so a lease
      // that expired during a tail wait rejects the publication before the
      // commit, exactly like the window and the grant's own expiry above.
      // The three outcomes stay distinct: the work window's logical
      // deadline, the grant's token expiry, and the lost queue lease.
      if (queueLeaseExpiresAt && queueLeaseExpiresAt.getTime() <= finalNow.getTime()) {
        throw new JobCancelledError('lease lost');
      }
      // The pinned photo lineage gets the same last word (DISC-SCR-037): the
      // capture must still be live and still activate exactly the analysis
      // the walk rooted from. The FOR NO KEY UPDATE lock held since the
      // pass's start means no real writer could have changed it in between —
      // this recheck is the boundary's own proof of the selected private
      // root lineage, and any state that slipped past it rolls the whole
      // publication back instead of committing an obsolete rooted path.
      if (photoLineage) {
        const lineage = await tx.query('SELECT 1 FROM captures WHERE id = $1 AND deleted_at IS NULL AND active_analysis_id = $2', [
          photoLineage.captureId,
          photoLineage.analysisId,
        ]);
        if (!lineage.rowCount) throw new JobCancelledError('origin deleted');
      }

      return {
        state,
        results,
        counts,
        rejections,
        truncated,
        rankingPolicyVersion: RANKING_POLICY_VERSION,
        grammarVersion: GRAPH_PATH_GRAMMAR_VERSION,
      };
    });
  } catch (err) {
    // The pass's statement and lock waits are bounded by the work window's
    // CURRENT remaining time (re-tightened at every stage boundary), and
    // that bound IS the deadline: PostgreSQL cancels a statement past it
    // with 57014. Such a cancel is the same deadline fact and must surface
    // as the typed terminal outcome, never a raw database error — but only
    // when the durable window really ended with the database's own clock. A
    // still-live window keeps the raw error exactly what it is, and a caller
    // whose own transaction already aborted keeps its original error.
    if (isDeadlineCanceledStatement(err)) {
      const ended = await scopedWorkWindowEnded(db, { deadlineAt }).then(
        (yes) => yes,
        () => false,
      );
      if (ended) throw new GraphWorkDeadlineExpiredError();
    }
    throw err;
  }
}
