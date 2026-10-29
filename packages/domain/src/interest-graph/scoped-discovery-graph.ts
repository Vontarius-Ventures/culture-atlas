import type { Db, Queryable } from '../db/pool';
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
import { validateGraphPath, type ValidatedGraphPath } from './paths';
import { lockScopedPublicationAuthority, type ScopedDiscoveryGrantAuthority } from './scoped-discovery';
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
 *   - Roots are ONLY the origin item's own current qualified identities —
 *     its cultural reference, its resolved anchors, and (for a capture
 *     origin) the ACTIVE analysis's `depicted`/`user_selected` resolved or
 *     user-confirmed references. Visual-resemblance references never root a
 *     scoped walk (enabling the graph does not qualify vision). Account-wide
 *     support, other collections' items and global taste never participate,
 *     and the legacy account-feed fallback never fills this branch's results.
 *   - Admission is the one shared rule: the approved path grammar
 *     (`validateGraphPath`) over reviewed, currently-justified shared
 *     evidence. No live model, no paid research, no provider call at all.
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
 * (lockScopedPublicationAuthority, called first inside the publication
 * transaction) holds the initiating connection and origin collection locks
 * through the commit and rejects stale authority; the job-liveness fence
 * (`ensureActive`) and the scoped parent's own deletion fence stay in place.
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
 * The origin item's CURRENT qualified root references: its own cultural
 * reference, its resolved anchors, and — for a capture origin — the ACTIVE
 * analysis's `depicted`/`user_selected` resolved or user-confirmed
 * references. `resembles` never qualifies (a visual-resemblance claim is
 * disabled until an independently qualified compatible adapter and evidence
 * exist), and rejected/unmatched references never qualify.
 */
async function qualifiedOriginRootReferences(tx: Queryable, originItemId: string): Promise<QualifiedRootReference[]> {
  const { rows } = await tx.query<QualifiedRootReference>(
    `SELECT r.id, r.canonical_key, r.canonical_name, r.type, r.external_ids
       FROM (
         SELECT di.reference_id AS rid
           FROM discovery_items di
          WHERE di.id = $1 AND di.reference_id IS NOT NULL
         UNION
         SELECT a.rid
           FROM discovery_items di, unnest(di.resolved_anchor_ids) AS a(rid)
          WHERE di.id = $1
         UNION
         SELECT cr.reference_id
           FROM discovery_items di
           JOIN captures c ON c.id = di.capture_id AND c.deleted_at IS NULL
           JOIN capture_references cr ON cr.analysis_id = c.active_analysis_id
          WHERE di.id = $1
            AND cr.relation IN ('depicted', 'user_selected')
            AND cr.resolution_status IN ('resolved', 'user_confirmed')
       ) x
       JOIN cultural_references r ON r.id = x.rid
      ORDER BY r.id`,
    [originItemId],
  );
  return rows;
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
    /** Job-liveness fence, invoked immediately before any publication write. */
    ensureActive: () => Promise<void>;
    at?: Date;
  },
): Promise<ScopedGraphDiscoveryOutcome> {
  const at = input.at ?? new Date();
  const { authority } = input;
  const owner: Owner = { kind: 'account', accountId: authority.owner_account_id };

  return db.transaction(async (tx) => {
    const counts = emptyCounts();
    const rejections: Record<string, number> = {};
    const noteRejection = (code: string) => {
      rejections[code] = (rejections[code] ?? 0) + 1;
    };
    const truncated = { assertions: false, candidates: false };

    // The scoped parent's own deletion fence: a deleted origin item cascades
    // the discovery job away, and the locked row pins the parent (and its
    // owner) through the commit.
    const parentRow = await tx.query('SELECT 1 FROM discovery_jobs WHERE id = $1 AND owner_account_id = $2 FOR UPDATE', [
      authority.discovery_job_id,
      authority.owner_account_id,
    ]);
    if (!parentRow.rowCount) throw new JobCancelledError('origin deleted');
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
    // The grant publication fence (VAL-DISC-007): lock the initiating
    // connection's row and the origin collection's row FOR SHARE and recheck
    // the pinned epoch against CURRENT live state — liveness, authorization
    // version, per-collection grant epoch, collection ownership and the
    // origin's membership — holding both locks through this commit. A real
    // owner revocation, narrowing, grant replace, membership removal or
    // collection deletion either committed before this read (the work
    // rejects; nothing publishes, and retry/dedupe/regrant cannot adopt the
    // newer epoch) or waits behind it (publisher-first: the results publish
    // under the authority held here, and read-time denial applies after the
    // mutation lands). No work runs under a dead authority.
    await lockScopedPublicationAuthority(tx, { authority });
    const originItemId = origin.rows[0]!.id;
    const originCanonicalKey = origin.rows[0]!.canonical_key;
    await tx.query(`UPDATE discovery_jobs SET status = 'running' WHERE id = $1`, [authority.discovery_job_id]);

    // --- Qualified roots: ONLY this origin's own current identities ----------------
    const rootReferences = await qualifiedOriginRootReferences(tx, originItemId);
    counts.rootReferences = rootReferences.length;
    const resolution = await resolveReferenceNodes(tx, rootReferences.map((r) => r.id));
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
    if (pinAssertionIds.length > 0) {
      await tx.query(`SELECT id FROM graph_assertions WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`, [
        pinAssertionIds,
      ]);
    }
    if (pinEvidenceIds.length > 0) {
      await tx.query(`SELECT id FROM graph_evidence WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`, [
        pinEvidenceIds,
      ]);
    }
    let publishAt = at;
    if (diversified.length > 0) {
      const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      publishAt = clock.rows[0]!.now;
    }
    const publishing: Array<{ obs: ScopedObservation; reference: CandidateReference }> = [];
    for (const obs of diversified) {
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
    const hidden = await hiddenKeys(tx, owner);
    const referenceIds = [...new Set(publishing.map((p) => p.reference.referenceId))];
    const existingItems = new Map<string, { id: string; canonical_key: string }>();
    if (referenceIds.length > 0) {
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
    await input.ensureActive();
    await tx.query('DELETE FROM recommendations WHERE discovery_job_id = $1', [authority.discovery_job_id]);
    const contributingReferenceIds = rootReferences.map((r) => r.id);
    const parent: RecommendationParent = { kind: 'discovery_job', discoveryJobId: authority.discovery_job_id };
    const results: ScopedGraphResult[] = [];
    if (capped.length > 0) {
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
      );
      for (let i = 0; i < capped.length; i += 1) {
        const entry = capped[i]!;
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
    await tx.query(`UPDATE discovery_jobs SET status = $2 WHERE id = $1`, [authority.discovery_job_id, state]);

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
}
