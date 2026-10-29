import type pg from 'pg';
import type { Db, Queryable } from '../db/pool';
import { activeKills } from '../flags/feature-flags';
import { getTasteRevision } from '../services/taste';
import { isDeadlineCanceledStatement } from './budgets';
import { GRAPH_FRONTIER_MAX_LIFETIME_DAYS, INTEREST_GRAPH_POLICY_VERSION } from './schema';
import { GRAPH_PATH_GRAMMAR_VERSION } from './assertion-policy';
import { validateGraphPath, type ValidatedGraphPath } from './paths';
import { loadExplicitSupport, type ExplicitCaptureReference, type ExplicitSupportSnapshot } from './explicit-support';
import { graphDiscoveryPausedAt, lockAccountPublicationAuthority } from './refresh';
import { currentAssertionJustification, frontierPathPins, revalidateFrontierPathVersions, revalidatePinnedDependencies } from './validity';
import { bilaterallyVerifiedReferenceNodes } from './identity-links';
import {
  createGraphRun,
  insertGraphRecommendation,
  insertRecommendationProof,
  reconcileFrontierCandidatePath,
  setGraphRunState,
  upsertFrontierCandidate,
} from './store';

/**
 * Shared evidence admission, versioned ranking and bounded frontier for the
 * interest graph (PR 8 discovery slice, VAL-DISC-001/002/004).
 *
 * One expansion serves BOTH root kinds through one admission pipeline:
 *
 *  - PERSONAL roots are the account's currently authorized explicit interests
 *    (a projected explicit edge whose canonical key is still explicit and not
 *    hidden). Their candidates need BOTH a currently justified cultural
 *    connection (the approved path grammar of VAL-EVID-002 — never "some
 *    bounded graph walk") AND current private relevance (the save is still
 *    explicit right now, checked against authoritative state, so a removed
 *    save is never rescued by still-valid cultural evidence).
 *  - PHOTO roots are the CURRENT authorized (resolved/user-confirmed,
 *    depicted/user-selected) references of the current active analysis of an
 *    explicitly saved capture. Their candidates additionally need a supported
 *    relationship to that very reference; personal appeal only ever ranks
 *    admitted photo candidates, it can never admit one.
 *
 * Cultural connection and private relevance stay DISTINCT everywhere: the
 * rendered reason is the approved template's own bounded meaning (never
 * identity, influence or visual resemblance), while the private support edge
 * and the photo-reference metadata (with its uncertainty) are recorded
 * separately on the frontier candidate and the pinned proof.
 *
 * Unqualified vision stays fail-closed: `visionQualified` is a constant
 * `false` — no qualified visual-resemblance adapter exists, so active private
 * VISUALLY_RESEMBLES links are counted as denied and never become roots,
 * candidates or reasons, and a reference whose relation is `resembles` is a
 * visual claim that never yields a photo root. Enabling the graph flags does
 * not qualify vision. The same photo-root standard governs RETAINED
 * witnesses (DISC-SCR-029): a dedupe refresh keeps a live frontier row's
 * recorded path only while at least one of its stored roots still carries a
 * QUALIFIED live capture-reference witness — currently active, photo-root
 * relation-eligible, and resolved to the identity that grounds the recorded
 * walk. A tuple that merely shares the stored root edge (the projector's
 * reference-after-corpus fallback can place unrelated references on one
 * saved-capture edge) is never authority for the kept cultural path; when no
 * witness qualifies, the refresh atomically reconciles the row's path and
 * roots to a validating current observation.
 *
 * Bounds (VAL-DISC-004): at most two approved relation hops (the grammar
 * admits exactly two-edge compositions), at most 200 distinct assertions
 * traversed, at most 40 candidates evaluated, at most 500 active frontier
 * entries per account (pruning lowest-priority entries after expiring due
 * ones — pruning candidate state never removes confirmed interests), and a
 * seven-day frontier lifetime shortened, never extended, by evidence/rights
 * expiry.
 */

/** Version of the ranking/diversification policy (deterministic inputs + ties). */
export const RANKING_POLICY_VERSION = 'ranking-policy-1';

/** PR 8 operational bounds for one logical expansion. */
export const EXPANSION_BOUNDS = {
  /** Approved relation hops a walk may traverse (the grammar composes exactly two edges). */
  maxHops: 2,
  /** Distinct assertion rows one expansion may traverse. */
  maxAssertionsTraversed: 200,
  /** Root→candidate pairs one expansion may evaluate. */
  maxCandidatesEvaluated: 40,
  /** Hard cap of active (active/admitted) frontier entries per account. */
  maxActiveFrontierEntries: 500,
  /** Deterministic path attempts evaluated per (root, candidate) pair. */
  maxPathsPerCandidate: 8,
  /** Rail diversification: kept candidates per shared midpoint. */
  maxCandidatesPerMidpoint: 3,
  /** Frontier lifetime in days; evidence/rights expiry shortens it. */
  frontierLifetimeDays: GRAPH_FRONTIER_MAX_LIFETIME_DAYS,
} as const;

/** Template specificity: stronger cultural specificity weighs more. */
const TEMPLATE_WEIGHTS: Record<string, number> = {
  same_creator: 0.4,
  shared_subject: 0.35,
  shared_technique: 0.3,
  shared_attribute: 0.25,
  co_documented_association: 0.2,
  shared_audience: 0.15,
};

/** Root relevance weight: explicit interest is strongest; photo weight keeps
 * the reference's authorization uncertainty (confirmed > resolved, anchor > not). */
const PERSONAL_ROOT_WEIGHT = 0.4;
const photoRootWeight = (root: PhotoExpansionRoot) =>
  (root.resolutionStatus === 'user_confirmed' ? 0.3 : 0.25) + (root.isAnchor ? 0.05 : 0);

const round2 = (n: number) => Math.round(n * 100) / 100;

// --- Discovery gate ----------------------------------------------------------------

/** Config subset the gate reads; DomainConfig satisfies it structurally. */
export interface DiscoveryGateConfig {
  INTEREST_GRAPH_PROJECTION_ENABLED?: string;
  INTEREST_GRAPH_DISCOVERY_ENABLED?: string;
  FEATURE_KILL_SWITCHES?: string;
}

const optedIn = (value: string | undefined) => value === 'true' || value === '1';
const csvList = (value: string | undefined) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);

/**
 * The discovery gate from config alone: the discovery opt-in AND the
 * projection opt-in (the flag spec requires projection beneath discovery)
 * AND neither flag present in the environment kill list. Default off.
 */
export function discoveryEnabledInConfig(config: DiscoveryGateConfig): boolean {
  if (!optedIn(config.INTEREST_GRAPH_DISCOVERY_ENABLED)) return false;
  if (!optedIn(config.INTEREST_GRAPH_PROJECTION_ENABLED)) return false;
  const killed = csvList(config.FEATURE_KILL_SWITCHES);
  return !killed.includes('interest_graph_discovery_enabled') && !killed.includes('interest_graph_projection_enabled');
}

/** The discovery flag for one account: config gate AND no database kills. */
export async function discoveryEnabledForAccount(
  db: Queryable,
  input: { accountId: string; config: DiscoveryGateConfig },
): Promise<boolean> {
  if (!discoveryEnabledInConfig(input.config)) return false;
  const killed = await activeKills(db, input.accountId, input.config);
  return !killed.has('interest_graph_discovery_enabled') && !killed.has('interest_graph_projection_enabled');
}

// --- Roots --------------------------------------------------------------------------

export interface PersonalExpansionRoot {
  kind: 'personal';
  nodeId: string;
  /** The projected private edge grounding this root (support/proof dependency). */
  edgeId: string;
  canonicalKey: string;
  itemId: string | null;
}

export interface PhotoExpansionRoot {
  kind: 'photo';
  nodeId: string;
  /** The edge carrying this reference's projected capture-reference support. */
  edgeId: string;
  captureId: string;
  analysisId: string;
  analysisVersion: number | null;
  captureReferenceId: string;
  referenceId: string;
  name: string;
  relation: 'depicted' | 'user_selected';
  resolutionStatus: 'resolved' | 'user_confirmed';
  isAnchor: boolean;
  certainty: number | null;
}

export type ExpansionRoot = PersonalExpansionRoot | PhotoExpansionRoot;

// --- Result contracts ---------------------------------------------------------------

export interface ExpansionRelevance {
  kind: 'personal';
  edgeId: string;
  canonicalKey: string;
  itemId: string | null;
}

export interface PhotoExpansionRelevance {
  kind: 'photo';
  edgeId: string;
  captureId: string;
  analysisId: string;
  analysisVersion: number | null;
  captureReferenceId: string;
  referenceId: string;
  name: string;
  relation: 'depicted' | 'user_selected';
  resolutionStatus: 'resolved' | 'user_confirmed';
  isAnchor: boolean;
  certainty: number | null;
}

export interface ExpansionCandidateObservation {
  nodeId: string;
  candidateName: string;
  intent: 'personal' | 'photo';
  templateKey: string;
  meaning: string;
  /** The rendered cultural connection; the approved template's own wording only. */
  reason: string;
  grammarVersion: string;
  midNodeId: string;
  score: number;
  /** Rank within the intent's rail (assigned only to ranked candidates). */
  rank: number | null;
  recommendationId: string | null;
  proofId: string | null;
  discoveryItemId: string | null;
  /** Walked assertion ids pinned at their exact revisions, in walk order. */
  assertions: Array<{ id: string; revision: number }>;
  /** Reviewed evidence families pinning the connection (≥1 live witness). */
  evidence: Array<{ id: string; revision: number }>;
  supportEdgeIds: string[];
  /** The private relevance basis, distinct from the cultural connection. */
  relevance: ExpansionRelevance | PhotoExpansionRelevance;
}

export interface ExpansionCounts {
  personalRoots: number;
  photoRoots: number;
  /** Projected roots whose authoritative save was removed/hidden (lag window). */
  stalePersonalRoots: number;
  hiddenPersonalRoots: number;
  /** Authoritative saves with no projected edge yet (projection lag). */
  unprojectedPersonalRoots: number;
  /** Roots (or capture saves) with no active shared identity to walk from. */
  unmappedPersonalRoots: number;
  /**
   * Root references resolved through the verified provider-id link (exact
   * confirmed id equality — never a name match) because no durable binding
   * exists yet; the linkage pass materializes those bindings on its next run.
   */
  referencesLinked: number;
  /** Root references whose verified matches are ambiguous (stay unresolved). */
  referenceLinksAmbiguous: number;
  /**
   * Root references whose verified match contradicts an existing durable
   * binding (the identity is already linked to a different reference, or the
   * reference is already held by a different identity): fail closed, nothing
   * resolves and no stored link changes (DISC-SCR-017).
   */
  referenceLinksConflicting: number;
  /**
   * Ranked candidates whose publication item was found through the same
   * verified provider-id link (the account's item on the matching reference).
   */
  candidatesResolvedByLink: number;
  capturesWithoutAnalysis: number;
  /** Authorized references whose relation is a visual claim (disabled). */
  photoReferencesDenied: number;
  photoReferencesUnmapped: number;
  photoReferencesUnprojected: number;
  /** Active private VISUALLY_RESEMBLES links, denied fail-closed. */
  visionLinksDenied: number;
  assertionsTraversed: number;
  candidatesEvaluated: number;
  admitted: number;
  rejected: number;
  diversifiedOut: number;
  candidatesWithoutItems: number;
  recommendationsPublished: number;
  proofsPublished: number;
  frontierCreated: number;
  frontierDeduped: number;
  /**
   * Dedupe refreshes whose RETAINED row failed revalidation and were
   * reconciled to the just-validated observation's pins/roots (DISC-SCR-022):
   * a live frontier row never keeps stale recorded path_versions behind a
   * passing refresh. Counted once per reconciled row and also recorded in
   * `rejections` as `retained_<reason>`.
   */
  frontierReconciled: number;
  frontierExpired: number;
  frontierPruned: number;
  /**
   * Committing observations dropped at the publication pin check: their exact
   * pinned (id, revision) pairs no longer revalidate at the FRESH publication
   * clock (DISC-SCR-009) — a mid-run assertion revision change, a
   * sole-evidence/source withdrawal, or an evidence/rights expiry. Independent
   * currently-valid support publishes; the per-reason drop is also counted in
   * `rejections` as `pinned_<reason>`.
   */
  stalePinsBlocked: number;
}

/**
 * Why an expansion did not publish. 'disabled' comes from the discovery gate;
 * 'lease_lost' from the caller's fence hook; 'deadline_expired' from the
 * logical window of the durable work budget (VAL-DISC-006: the anchored
 * 45-second deadline governs the whole pass, not just handler entry — bounded
 * stage checks, bounded SQL/lock waits and the publication decision all stop
 * at it). Every remaining code comes from the transactional publication fence
 * (VAL-DISC-007): delayed work re-checks current authority inside the
 * publication transaction, and a violation rolls the whole pass back — no
 * run, no frontier entry, no recommendations, no proofs. Rejected work never
 * publishes private results or resurrects withdrawn proofs.
 */
export type ExpansionRejectionReason =
  | 'disabled'
  | 'account_missing'
  | 'paused'
  | 'stale_authority'
  | 'exclusion_landed'
  | 'source_invalidated'
  | 'support_withdrawn'
  | 'lease_lost'
  | 'deadline_expired';

/** Thrown inside the publication transaction to reject the whole pass; the wrapper converts it to a rejection result. */
export class GraphFenceError extends Error {
  constructor(readonly code: Exclude<ExpansionRejectionReason, 'disabled'>) {
    super(`graph expansion fenced: ${code}`);
    this.name = 'GraphFenceError';
  }
}

export interface ExpansionResult {
  expanded: boolean;
  /** Present (with `expanded: false`) when the gate is off or the publication fence rejected the pass. */
  reason?: ExpansionRejectionReason;
  runId: string | null;
  policyVersion: string;
  rankingPolicyVersion: string;
  grammarVersion: string;
  /** Vision qualification is fail-closed: no qualified adapter exists. */
  visionQualified: false;
  counts: ExpansionCounts;
  /** Rejection code → occurrences across evaluated paths (and root guards). */
  rejections: Record<string, number>;
  truncated: { assertions: boolean; candidates: boolean };
  /** The ranked rail, published candidates only, personal then photo order. */
  candidates: ExpansionCandidateObservation[];
}

interface AdmittedObservation extends ExpansionCandidateObservation {
  rank: number | null;
  recommendationId: string | null;
  proofId: string | null;
  discoveryItemId: string | null;
  /** Earliest evidence/rights expiry among the pinned evidence (frontier cap). */
  expiresAtCap: Date | null;
}

export interface ExpansionDeadlineInput {
  /**
   * The ABSOLUTE end of the logical window (VAL-DISC-006): the durable work
   * budget's anchored deadline — never a per-attempt clock. The pass may not
   * execute stages, wait on locks or publish at or after this point.
   */
  at: Date;
  /** The clock stage checks read (default: real time; tests may control it). */
  now?: () => Date;
  /**
   * The worker's cooperative stop: lease loss, cancellation or the
   * per-attempt deadline abort it. A stage check that observes an aborted
   * signal ends the pass before any publication.
   */
  signal?: AbortSignal;
}

export interface ExpandAccountInterestGraphInput {
  accountId: string;
  config: DiscoveryGateConfig;
  /** The queue job driving this expansion (recorded on the run). */
  jobId?: string;
  /** Controlled clock for expiry/justification decisions. */
  at?: Date;
  /**
   * Publication fence hook (VAL-DISC-007): called INSIDE the publication
   * transaction after every internal authority recheck, closest to the
   * commit. The queue handler passes its lease-ownership check here, so work
   * whose lease was lost or superseded cannot publish even when the job row
   * was last seen healthy. Throwing rolls the whole pass back; throw
   * `GraphFenceError` to surface a specific rejection reason.
   */
  fence?: (tx: Queryable) => Promise<void>;
  /**
   * The logical deadline of this expansion (VAL-DISC-006): the queue handler
   * passes the durable work budget's anchored window. Without it the pass is
   * unbounded (direct non-queue callers keep their current semantics); with
   * it every stage check, SQL/lock wait and the publication decision stop at
   * the original anchor, and a pass that exceeds its window is rejected with
   * 'deadline_expired' — nothing publishes.
   */
  deadline?: ExpansionDeadlineInput;
}

// --- Internal row shapes ------------------------------------------------------------

interface ProjectedEdgeRow {
  edge_id: string;
  discovery_item_id: string | null;
  saved_item_id: string | null;
  item_id: string | null;
  canonical_key: string | null;
  reference_id: string | null;
}

interface WalkEdge {
  id: string;
  /** Endpoint this edge is walked from (the root on hop 1, the midpoint on hop 2). */
  near: string;
  /** The other endpoint. */
  far: string;
}

interface EdgeRow {
  id: string;
  subject_node_id: string;
  object_node_id: string;
}

interface CandidatePair {
  root: ExpansionRoot;
  candidateNodeId: string;
  paths: Array<[WalkEdge, WalkEdge]>;
}

// --- Entry point --------------------------------------------------------------------

/**
 * Runs one bounded expansion for one account: resolves eligible roots,
 * walks the shared assertion graph inside the operational bounds, admits
 * candidates through the shared pipeline (approved path grammar + current
 * private relevance, decided separately per root kind), records admitted
 * candidates on the bounded frontier, then applies the versioned ranking
 * policy and publishes recommendations with pinned proofs.
 *
 * Everything commits in one transaction: the run, frontier, recommendations
 * and proofs appear together or not at all. While the discovery gate is off
 * nothing is written at all (fail-closed; legacy paths are untouched).
 *
 * The engine assumes the dispatcher's one-active-expansion-per-account
 * invariant; queue-level enforcement, publication fencing (generation,
 * grants, revisions, lease) and the sweeper live with the worker wiring.
 */
export async function expandAccountInterestGraph(db: Db, input: ExpandAccountInterestGraphInput): Promise<ExpansionResult> {
  const at = input.at ?? new Date();
  // Fast fail-closed path: no transaction, no writes, while the gate is off.
  if (!(await discoveryEnabledForAccount(db, { accountId: input.accountId, config: input.config }))) {
    return disabledResult();
  }
  try {
    return await db.transaction(async (rawTx) => {
      // One client underlies the whole transaction, and shared readers
      // (loadExplicitSupport) fire concurrent queries by design on pools:
      // serialize every query onto that client so a failed query in a
      // concurrent batch cannot strand the client's queue mid-expansion.
      const tail: { p: Promise<unknown> } = { p: Promise.resolve() };
      const tx: Queryable = {
        query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: readonly unknown[]) {
          const p = tail.p.then(() => rawTx.query<R>(text, params));
          tail.p = p.then(
            () => undefined,
            () => undefined,
          );
          return p;
        },
      };
      // The logical window bounds SQL and lock waits too (VAL-DISC-006): a
      // delayed statement or a lock parked on another transaction cannot
      // push this pass past its deadline — the bounded wait fails, the
      // transaction rolls back, and the rejection below is the honest
      // outcome instead of a commit after the window ended.
      if (input.deadline) await boundPassSqlToDeadline(tx, input.deadline);
      // Re-check the gate inside the transaction: a kill that landed between
      // the pre-check and this pass must halt publication before any write.
      if (!(await discoveryEnabledForAccount(tx, { accountId: input.accountId, config: input.config }))) {
        return disabledResult();
      }
      return runExpansion(tx, { accountId: input.accountId, jobId: input.jobId, at, fence: input.fence, deadline: input.deadline });
    });
  } catch (err) {
    // A fence violation rejects the whole pass: the transaction above rolled
    // back, so no run, frontier entry, recommendation or proof row survives.
    // The rejection itself is an honest result, not an internal error.
    if (err instanceof GraphFenceError) return rejectedResult(err.code);
    // A bounded SQL/lock wait that exceeded the logical window (VAL-DISC-006)
    // is the same honest outcome: the statement was canceled by the pass's
    // own deadline, the transaction rolled back, nothing published.
    if (input.deadline && isDeadlineCanceledStatement(err)) return rejectedResult('deadline_expired');
    throw err;
  }
}

/**
 * Bounds every statement and lock wait of the pass to the logical window's
 * CURRENT remaining time: `SET LOCAL` is scoped to this transaction, so
 * pooled clients never leak the limit. Re-issuing it at each stage check
 * (enforceDeadline) tightens the bound as the window drains, so a LATE lock
 * wait ends at the anchored deadline — never a full entry-bound window past
 * it (DISC-SCR-018).
 */
async function boundPassSqlToDeadline(tx: Queryable, deadline: ExpansionDeadlineInput): Promise<void> {
  const deadlineNow = deadline.now ?? (() => new Date());
  const remainingMs = deadline.at.getTime() - deadlineNow().getTime();
  const ms = Math.max(1, Math.ceil(remainingMs));
  await tx.query(`SET LOCAL statement_timeout = ${ms}`);
  await tx.query(`SET LOCAL lock_timeout = ${ms}`);
}

function disabledResult(): ExpansionResult {
  return rejectedResult('disabled');
}

function rejectedResult(reason: ExpansionRejectionReason): ExpansionResult {
  return {
    expanded: false,
    reason,
    runId: null,
    policyVersion: INTEREST_GRAPH_POLICY_VERSION,
    rankingPolicyVersion: RANKING_POLICY_VERSION,
    grammarVersion: GRAPH_PATH_GRAMMAR_VERSION,
    visionQualified: false,
    counts: emptyCounts(),
    rejections: {},
    truncated: { assertions: false, candidates: false },
    candidates: [],
  };
}

function emptyCounts(): ExpansionCounts {
  return {
    personalRoots: 0,
    photoRoots: 0,
    stalePersonalRoots: 0,
    hiddenPersonalRoots: 0,
    unprojectedPersonalRoots: 0,
    unmappedPersonalRoots: 0,
    referencesLinked: 0,
    referenceLinksAmbiguous: 0,
    referenceLinksConflicting: 0,
    candidatesResolvedByLink: 0,
    capturesWithoutAnalysis: 0,
    photoReferencesDenied: 0,
    photoReferencesUnmapped: 0,
    photoReferencesUnprojected: 0,
    visionLinksDenied: 0,
    assertionsTraversed: 0,
    candidatesEvaluated: 0,
    admitted: 0,
    rejected: 0,
    diversifiedOut: 0,
    candidatesWithoutItems: 0,
    recommendationsPublished: 0,
    proofsPublished: 0,
    frontierCreated: 0,
    frontierDeduped: 0,
    frontierReconciled: 0,
    frontierExpired: 0,
    frontierPruned: 0,
    stalePinsBlocked: 0,
  };
}

// --- The expansion pass ----------------------------------------------------------------

/**
 * The frontier's canonical dedupe key for one expansion observation. Shared
 * by the admission loop and the retained-population pre-read (DISC-SCR-024)
 * so the two can never disagree about which stored row a refresh retains.
 */
function frontierDedupeKey(intent: 'personal' | 'photo', nodeId: string): string {
  return `expansion:${intent}:node:${nodeId}`;
}

/**
 * The intent a retained frontier row's own recorded path declares. The row's
 * admission story decides which live authority its roots must still carry
 * (DISC-SCR-028): a PHOTO row's roots are capture-reference support edges
 * whose live capture-analysis authority must hold, while a PERSONAL row's
 * roots are explicit edges whose presence and live state are their authority.
 * Rows recorded without an intent (hand-seeded fixtures) read as personal —
 * the presence-only standard — and still reconcile when their edge is gone.
 */
function recordedFrontierIntent(pathVersions: unknown): 'personal' | 'photo' {
  const recorded = (pathVersions ?? {}) as Record<string, unknown>;
  return recorded.intent === 'photo' ? 'photo' : 'personal';
}

/**
 * The root-side node of a recorded frontier path: the endpoint of the FIRST
 * pinned assertion that is NOT shared with the second — the cultural identity
 * the recorded walk started FROM (DISC-SCR-029). Every engine-admitted path
 * is the two-assertion root→mid→candidate walk, so the single shared
 * endpoint is the midpoint and the OTHER first-assertion endpoint is the
 * root. Any other recorded shape (or a degenerate walk whose first two
 * assertions do not share exactly one node) fails closed: nothing grounds a
 * path the engine's own walk never produced, and the row reconciles to a
 * validating current observation instead.
 */
async function recordedPathRootNodeId(
  tx: Queryable,
  assertions: ReadonlyArray<{ id: string }>,
): Promise<string | null> {
  if (assertions.length !== 2) return null;
  const firstId = assertions[0]!.id;
  const secondId = assertions[1]!.id;
  if (firstId === secondId) return null;
  const { rows } = await tx.query<{ id: string; subject_node_id: string; object_node_id: string }>(
    'SELECT id, subject_node_id, object_node_id FROM graph_assertions WHERE id = ANY($1::uuid[])',
    [[firstId, secondId]],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const first = byId.get(firstId);
  const second = byId.get(secondId);
  if (!first || !second) return null;
  const shared = [first.subject_node_id, first.object_node_id].filter(
    (nodeId) => nodeId === second.subject_node_id || nodeId === second.object_node_id,
  );
  if (shared.length !== 1) return null;
  return first.subject_node_id === shared[0] ? first.object_node_id : first.subject_node_id;
}

/**
 * Resolves a retained frontier row's ACTUAL owner-bound support roots from
 * the live stored row — never the selected observation's roots (DISC-SCR-028:
 * a changed winning photo root leaves the stored row rooted in the OLD
 * capture's support) — and decides whether their support, reference and live
 * capture-analysis authority still hold.
 *
 * A root edge is live iff it still exists in a live state (confirmed or
 * tentative — suppression and the projector's withdrawal sweep both end it).
 * For a PERSONAL row, a live edge is its own authority: its presence and
 * live state are what the admission walked on. For a PHOTO row (DISC-SCR-029)
 * a live capture-reference tuple is a witness for the RECORDED path only
 * when it would still be admitted as a photo root for that very path:
 * the live snapshot still authorizes the exact (capture, active
 * analysis/version, capture_references) dependency, the authorized reference
 * is photo-root relation-eligible (`depicted` or `user_selected` — `resembles`
 * is a visual claim resolveRoots denies), and the reference's resolved ACTIVE
 * identity (the same durable-binding-or-verified-link semantics resolveRoots
 * applies) is the root-side node of the RECORDED walk. Merely sharing the
 * root edge is not authority: the projector's reference-after-corpus
 * fallback can place UNRELATED references on one saved-capture item edge, so
 * a live current tuple on that edge can belong to a subject the recorded
 * path was never grounded in (or to a visual claim no photo root may use).
 * An analysis activation A→B that committed before the pass reads as
 * withdrawn HERE (the snapshot is the same live state the pass walked from),
 * while one landing later is the publication fence's to catch under its
 * capture lock.
 *
 * Returns the root authority entries the publication fence re-checks through
 * the commit — one bare entry per live personal root, one capture-bearing
 * entry per QUALIFYING capture-reference witness of a live photo root — or
 * null when no recorded root's authority still holds: the caller coherently
 * reconciles the row (pins AND roots together) to the just-validated
 * observation instead of committing a refresh with no live private
 * grounding. A row's roots survive on ANY qualifying witness (they are the
 * union of everything that reached it), the same disjunctive support standard
 * the read path applies.
 */
async function liveRetainedRootAuthority(
  tx: Queryable,
  input: {
    accountId: string;
    snapshot: ExplicitSupportSnapshot;
    intent: 'personal' | 'photo';
    rootEdgeIds: readonly string[];
    /** The retained row's RECORDED path pins — the walk its roots must still ground. */
    assertions: ReadonlyArray<{ id: string }>;
  },
): Promise<GraphFenceRetainedRoot[] | null> {
  if (input.rootEdgeIds.length === 0) return null;
  const { rows } = await tx.query<{
    edge_id: string;
    edge_state: string;
    capture_id: string | null;
    analysis_id: string | null;
    capture_reference_id: string | null;
    analysis_version: number | null;
  }>(
    `SELECT e.id AS edge_id, e.state AS edge_state,
            s.capture_id, s.analysis_id, s.capture_reference_id, a.version AS analysis_version
       FROM personal_interest_edges e
       LEFT JOIN personal_interest_support s
              ON s.edge_id = e.id AND s.owner_account_id = e.owner_account_id
             AND s.active AND s.origin_kind = 'capture_reference'
       LEFT JOIN analyses a ON a.id = s.analysis_id
      WHERE e.owner_account_id = $1 AND e.id = ANY($2::uuid[])`,
    [input.accountId, [...new Set(input.rootEdgeIds)]],
  );
  const liveEdgeById = new Map<string, boolean>();
  const tuplesByEdge = new Map<
    string,
    Array<{ captureId: string; analysisId: string; analysisVersion: number; captureReferenceId: string }>
  >();
  for (const row of rows) {
    if (!liveEdgeById.has(row.edge_id)) {
      liveEdgeById.set(row.edge_id, row.edge_state === 'confirmed' || row.edge_state === 'tentative');
      tuplesByEdge.set(row.edge_id, []);
    }
    if (row.capture_id && row.analysis_id && row.capture_reference_id && row.analysis_version != null) {
      tuplesByEdge.get(row.edge_id)!.push({
        captureId: row.capture_id,
        analysisId: row.analysis_id,
        analysisVersion: row.analysis_version,
        captureReferenceId: row.capture_reference_id,
      });
    }
  }
  const liveCaptureById = new Map(input.snapshot.captures.map((c) => [c.captureId, c]));
  const entries: GraphFenceRetainedRoot[] = [];
  if (input.intent !== 'photo') {
    // PERSONAL roots: the live presence and live state of the explicit edge
    // are the authority the recorded path was admitted on.
    for (const edgeId of input.rootEdgeIds) {
      if (liveEdgeById.get(edgeId) !== true) continue; // withdrawn or deleted by the projector
      entries.push({ edgeId });
    }
    return entries.length > 0 ? entries : null;
  }
  // PHOTO roots: collect each live edge's CURRENT authorized tuples, then
  // qualify them against the recorded path's root identity (DISC-SCR-029).
  const candidates: Array<{
    edgeId: string;
    tuple: { captureId: string; analysisId: string; analysisVersion: number; captureReferenceId: string };
    reference: ExplicitCaptureReference;
  }> = [];
  for (const edgeId of input.rootEdgeIds) {
    if (liveEdgeById.get(edgeId) !== true) continue; // withdrawn or deleted by the projector
    for (const tuple of tuplesByEdge.get(edgeId) ?? []) {
      const capture = liveCaptureById.get(tuple.captureId);
      if (!capture) continue; // unsaved or deleted: withdrawn support
      if (capture.analysisId !== tuple.analysisId || capture.analysisVersion !== tuple.analysisVersion) continue;
      const reference = capture.references.find((r) => r.captureReferenceId === tuple.captureReferenceId);
      if (!reference) continue; // no longer authorized: withdrawn support
      candidates.push({ edgeId, tuple, reference });
    }
  }
  // Every live tuple lost its current capture-analysis authorization: the
  // recorded photo path has no live witness at all.
  if (candidates.length === 0) return null;
  const recordedRootNodeId = await recordedPathRootNodeId(tx, input.assertions);
  // A recorded path whose shape is not the engine's own walk grounds nothing:
  // fail closed and let the caller reconcile.
  if (recordedRootNodeId == null) return null;
  const nodeByReference = await nodesByReference(tx, {
    referenceIds: [...new Set(candidates.map((c) => c.reference.referenceId))],
    // Witness qualification, not root resolution: the pass's reported
    // counts keep describing the roots it walked from.
    counts: emptyCounts(),
  });
  for (const candidate of candidates) {
    if (candidate.reference.relation === 'resembles') continue; // a visual claim never yields a photo root
    if (nodeByReference.get(candidate.reference.referenceId) !== recordedRootNodeId) {
      continue; // grounds a different path than the one recorded
    }
    entries.push({ edgeId: candidate.edgeId, capture: candidate.tuple });
  }
  // A photo root edge whose every capture-reference tuple lost its live
  // capture-analysis authority — or whose surviving tuples are unrelated to
  // or ineligible for the recorded path — is a withdrawn root: no entry, and
  // the caller reconciles pins and roots together.
  return entries.length > 0 ? entries : null;
}

async function runExpansion(
  tx: Queryable,
  input: { accountId: string; jobId?: string; at: Date; fence?: (tx: Queryable) => Promise<void>; deadline?: ExpansionDeadlineInput },
): Promise<ExpansionResult> {
  const { accountId, at } = input;
  const counts = emptyCounts();
  const rejections: Record<string, number> = {};
  const noteRejection = (code: string) => {
    rejections[code] = (rejections[code] ?? 0) + 1;
  };

  // The logical window governs every stage of the pass (VAL-DISC-006): the
  // stage checks below end a pass whose anchored deadline passed or whose
  // worker grant died, and the publication fence has the last word. Throwing
  // GraphFenceError rolls the whole transaction back — nothing survives.
  // Each check ALSO re-tightens the SQL bound to the CURRENT remainder
  // (DISC-SCR-018): the entry bound alone would let a LATE lock wait run a
  // full window past the anchor before a later check rolled it back — the
  // refreshes make every later statement and lock wait end at the anchored
  // deadline instead.
  const deadline = input.deadline;
  const deadlineNow = deadline?.now ?? (() => new Date());
  const enforceDeadline = async () => {
    if (!deadline) return;
    if (deadline.signal?.aborted) throw new GraphFenceError('deadline_expired');
    if (deadlineNow().getTime() >= deadline.at.getTime()) throw new GraphFenceError('deadline_expired');
    await boundPassSqlToDeadline(tx, deadline);
  };
  await enforceDeadline();

  // Early authority checks (cheap, fail fast): the account must exist, and a
  // paused account publishes nothing (pause stops expansion dispatch AND
  // publication, never projection). Both are re-checked at the publication
  // fence below, so a pause landing mid-pass is still caught.
  const account = await tx.query<{ id: string }>('SELECT id FROM accounts WHERE id = $1', [accountId]);
  if (account.rows.length === 0) return rejectedResult('account_missing');
  if ((await graphDiscoveryPausedAt(tx, accountId)) != null) return rejectedResult('paused');

  // Current authoritative explicit state: the relevance half of every
  // admission decision reads THIS, never projection-event totals.
  const snapshot = await loadExplicitSupport(tx, accountId);
  await enforceDeadline();

  const run = await createGraphRun(tx, {
    ownerAccountId: accountId,
    runKind: 'expansion',
    jobId: input.jobId,
    inputTasteRevision: snapshot.tasteRevision,
    ...(await graphStateFence(tx, accountId)),
    policyVersion: INTEREST_GRAPH_POLICY_VERSION,
    budget: {
      source: 'expansion',
      bounds: EXPANSION_BOUNDS,
      ranking_policy_version: RANKING_POLICY_VERSION,
      grammar_version: GRAPH_PATH_GRAMMAR_VERSION,
    },
  });
  await setGraphRunState(tx, { runId: run.id, ownerAccountId: accountId, state: 'running' });

  const roots = await resolveRoots(tx, { accountId, snapshot, counts });
  const truncated = { assertions: false, candidates: false };
  await enforceDeadline();

  // --- Bounded walk ---------------------------------------------------------------
  const rootNodeIds = [...new Set(roots.map((r) => r.nodeId))];
  const rootNodeSet = new Set(rootNodeIds);
  const seen = new Set<string>();
  const hop1 = new Map<string, WalkEdge[]>();
  const hop2 = new Map<string, WalkEdge[]>();

  if (rootNodeIds.length > 0) {
    const hop1Rows = await traversalRows(tx, rootNodeIds, [], EXPANSION_BOUNDS.maxAssertionsTraversed, at);
    counts.assertionsTraversed = hop1Rows.length;
    truncated.assertions = hop1Rows.length === EXPANSION_BOUNDS.maxAssertionsTraversed;
    for (const row of hop1Rows) {
      seen.add(row.id);
      addOrientation(hop1, row, rootNodeSet);
    }
    await enforceDeadline();
    const midIds = [...new Set([...hop1.values()].flat().map((e) => e.far))];
    const remaining = EXPANSION_BOUNDS.maxAssertionsTraversed - seen.size;
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
    await enforceDeadline();
  }

  // --- Candidate pairs (deterministic order) --------------------------------------
  // Roots walk personal-first, then by node id; candidates by node id; paths
  // by (edge1 id, edge2 id). Candidates that are themselves roots never get
  // recommended back (and recommendation cards are never expansion roots).
  const sortedRoots = [...roots].sort((a, b) =>
    a.kind === b.kind ? a.nodeId.localeCompare(b.nodeId) : a.kind === 'personal' ? -1 : 1,
  );
  const pairs: CandidatePair[] = [];
  for (const root of sortedRoots) {
    const byCandidate = new Map<string, Array<[WalkEdge, WalkEdge]>>();
    for (const e1 of hop1.get(root.nodeId) ?? []) {
      // Second hops from the midpoint come from BOTH loaded layers:
      //  - edges loaded in hop two (oriented from the midpoint), and
      //  - REUSED edges already loaded in hop one and oriented from the
      //    midpoint (only midpoints that are themselves roots have hop-one
      //    orientations). Adding a legitimate creator/photo root must not
      //    erase an existing supported two-hop connection just because its
      //    second edge entered hop one; reuse still counts each distinct
      //    assertion once (the row is already in `seen`).
      const secondHops = [...(hop2.get(e1.far) ?? []), ...(hop1.get(e1.far) ?? [])];
      for (const e2 of secondHops) {
        if (e2.id === e1.id) continue;
        if (e2.far === root.nodeId) continue;
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
      pairs.push({ root, candidateNodeId, paths: paths.slice(0, EXPANSION_BOUNDS.maxPathsPerCandidate) });
    }
  }

  // --- Shared admission: cultural evidence, then relevance already resolved ------
  // The root's private relevance was decided at resolution (against current
  // authority); here the approved path grammar decides the cultural evidence.
  // Only a path that validates BOTH ways yields an admitted observation.
  const admitted: AdmittedObservation[] = [];
  for (const pair of pairs) {
    if (counts.candidatesEvaluated >= EXPANSION_BOUNDS.maxCandidatesEvaluated) {
      truncated.candidates = true;
      break;
    }
    await enforceDeadline();
    counts.candidatesEvaluated++;
    let obs: AdmittedObservation | null = null;
    for (const [e1, e2] of pair.paths) {
      const validation = await validateGraphPath(tx, {
        rootNodeId: pair.root.nodeId,
        candidateNodeId: pair.candidateNodeId,
        assertionIds: [e1.id, e2.id],
        at,
      });
      if (validation.path) {
        obs = await observationFromPath(tx, pair.root, validation.path, at);
        break; // first admitted path in deterministic order
      }
      noteRejection(validation.rejection!.code);
    }
    if (obs) admitted.push(obs);
    else counts.rejected++;
  }

  // --- Best observation per (intent, candidate) ------------------------------------
  const best = new Map<string, AdmittedObservation>();
  for (const obs of admitted) {
    const key = `${obs.intent}:${obs.nodeId}`;
    const prev = best.get(key);
    if (!prev || betterObservation(obs, prev)) best.set(key, obs);
  }
  counts.admitted = best.size;

  // --- Versioned ranking + diversification ------------------------------------------
  // Deterministic: score DESC, candidate node id ASC; at most
  // maxCandidatesPerMidpoint kept per shared midpoint so one creator never
  // fills the rail, and no unsupported filler is ever added to complete it.
  const ranked: AdmittedObservation[] = [];
  for (const intent of ['personal', 'photo'] as const) {
    const observations = [...best.values()]
      .filter((o) => o.intent === intent)
      .sort((a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
    const perMid = new Map<string, number>();
    for (const obs of observations) {
      const n = (perMid.get(obs.midNodeId) ?? 0) + 1;
      perMid.set(obs.midNodeId, n);
      if (n > EXPANSION_BOUNDS.maxCandidatesPerMidpoint) {
        counts.diversifiedOut++;
        continue;
      }
      ranked.push(obs);
    }
  }
  // Rank within each intent's rail, in rail order.
  for (const intent of ['personal', 'photo'] as const) {
    let rank = 1;
    for (const obs of ranked.filter((o) => o.intent === intent)) obs.rank = rank++;
  }

  // --- Publication pins: exact revisions at a fresh clock (DISC-SCR-009) --------
  // Every COMMITTING observation — ranked cards AND admitted-unranked frontier
  // candidates alike — revalidates its exact pinned (id, revision) pairs at a
  // FRESH publication clock inside this transaction, under the same
  // live-witness rule the read path applies. Checking only the ranked
  // assertions' CURRENT justification at the run-start clock (the old fence
  // shape) discarded the pinned revisions, never validated the pinned evidence
  // rows, and never looked at unranked candidates, so an assertion revision
  // change, a sole-evidence/source withdrawal or an evidence/rights expiry
  // that landed mid-pass published stale output that was already invalid the
  // moment it was stored. Stale observations are dropped BEFORE any write —
  // their frontier record, card and proof never exist — while independent
  // currently-valid support publishes.
  //
  // The pinned dependency rows are locked FOR SHARE in ONE consistent
  // ascending-id order and held to this transaction's commit, coordinating
  // with the retraction path's ordering (it withdraws the same rows in the
  // same ascending order): a withdrawal or revision change either commits
  // before these locked reads — visible here, so the observation is dropped —
  // or waits for this commit, and its dependent scan then invalidates
  // whatever this pass published. Nothing can slip between the validation
  // and the commit.
  await enforceDeadline();
  // The FRESH publication clock for every committing pin decision in this
  // pass: the pre-write pin validation below, and the retained-pin
  // revalidation of the dedupe refreshes in the frontier loop (DISC-SCR-022),
  // both decide at this one instant.
  let publishAt = at;
  if (best.size > 0) {
    const publishClock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    publishAt = publishClock.rows[0]!.now;
    // DISC-SCR-024: the dependency population this pass protects is not
    // only the newly selected observations. A dedupe refresh RETAINS the
    // stored row and its recorded path, which can be a DIFFERENT
    // still-valid path than every newly selected observation (a changed
    // winning root leaves the old root edge pinned by the stored row
    // alone). Those RETAINED-ONLY assertion/evidence rows join the same
    // FOR SHARE pin locks and the final publication fence — otherwise the
    // retained revalidation in the frontier loop is an unlocked read, and a
    // concurrent corpus support addition can bump the retained-only
    // assertion's revision after that read but before the commit, leaving
    // a live admitted row that immediately fails the shared read
    // validator. The live rows the loop will refresh are pre-read here:
    // the only writer of a live row's recorded path is this engine (one
    // active expansion per account), retraction changes state only, and
    // this loop's own reconciliation pins only already-locked
    // new-observation dependencies — so the pre-read set is exactly the
    // retained population the upserts will return. Rows that expire or
    // are pruned before their loop iteration merely lock pins that do not
    // commit (a harmless superset).
    const dedupeKeys = [...new Set([...best.values()].map((o) => frontierDedupeKey(o.intent, o.nodeId)))];
    const { rows: retainedRows } = await tx.query<{ path_versions: unknown }>(
      `SELECT path_versions FROM graph_frontier
        WHERE owner_account_id = $1 AND dedupe_key = ANY($2::text[]) AND state IN ('active','admitted')`,
      [accountId, dedupeKeys],
    );
    const retainedPins = retainedRows.map((row) => frontierPathPins(row.path_versions));
    await enforceDeadline();
    const pinAssertionIds = [
      ...new Set([
        ...[...best.values()].flatMap((o) => o.assertions.map((a) => a.id)),
        ...retainedPins.flatMap((pins) => pins.assertions.map((a) => a.id)),
      ]),
    ].sort();
    const pinEvidenceIds = [
      ...new Set([
        ...[...best.values()].flatMap((o) => o.evidence.map((e) => e.id)),
        ...retainedPins.flatMap((pins) => pins.evidence.map((e) => e.id)),
      ]),
    ].sort();
    if (pinAssertionIds.length > 0) {
      await tx.query(`SELECT id FROM graph_assertions WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`, [
        pinAssertionIds,
      ]);
    }
    // DISC-SCR-025: the evidence pin lock is a SECOND independent wait inside
    // this one pin stage — the bound is re-tightened to the CURRENT remainder
    // so the time the assertion wait consumed cannot widen this one.
    await enforceDeadline();
    if (pinEvidenceIds.length > 0) {
      await tx.query(`SELECT id FROM graph_evidence WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`, [
        pinEvidenceIds,
      ]);
    }
    await enforceDeadline();
    const dropped = new Set<string>();
    for (const obs of best.values()) {
      const verdict = await revalidatePinnedDependencies(tx, {
        assertions: obs.assertions,
        evidence: obs.evidence,
        at: publishAt,
      });
      if (verdict.valid) continue;
      dropped.add(`${obs.intent}:${obs.nodeId}`);
      noteRejection(`pinned_${verdict.reason ?? 'evidence_missing'}`);
      counts.stalePinsBlocked++;
    }
    if (dropped.size > 0) {
      for (const key of dropped) best.delete(key);
      for (let i = ranked.length - 1; i >= 0; i -= 1) {
        const obs = ranked[i]!;
        if (dropped.has(`${obs.intent}:${obs.nodeId}`)) ranked.splice(i, 1);
      }
      // The published rails keep dense, deterministic ranks after the drop.
      for (const intent of ['personal', 'photo'] as const) {
        let rank = 1;
        for (const obs of ranked.filter((o) => o.intent === intent)) obs.rank = rank++;
      }
    }
  }

  // --- Bounded frontier: expire due, evict to capacity, then record admissions ------
  const expired = await tx.query(
    `UPDATE graph_frontier SET state = 'expired', updated_at = now()
      WHERE owner_account_id = $1 AND state IN ('active','admitted') AND expires_at <= $2::timestamptz`,
    [accountId, at],
  );
  counts.frontierExpired = expired.rowCount ?? 0;

  const { rows: activeRows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM graph_frontier
      WHERE owner_account_id = $1 AND state IN ('active','admitted')`,
    [accountId],
  );
  const over = Number(activeRows[0]!.n) + best.size - EXPANSION_BOUNDS.maxActiveFrontierEntries;
  if (over > 0) {
    // Evict the lowest-priority active entries: pruning candidate state
    // touches only graph_frontier rows, never confirmed interests.
    const pruned = await tx.query(
      `WITH over AS (
         SELECT id FROM graph_frontier
          WHERE owner_account_id = $1 AND state IN ('active','admitted')
          ORDER BY score ASC NULLS FIRST, updated_at ASC, id ASC
          LIMIT $2::int
       )
       UPDATE graph_frontier f SET state = 'pruned', updated_at = now()
         FROM over WHERE f.id = over.id RETURNING f.id`,
      [accountId, over],
    );
    counts.frontierPruned = pruned.rowCount ?? 0;
  }

  // The retained-only dependency populations this pass is COMMITTING
  // (DISC-SCR-024): a dedupe refresh that KEEPS its valid recorded path
  // commits those pins — paths absent from every newly selected observation
  // — so they join the final publication fence's dependency population like
  // every other committing observation.
  const retainedCommitting: Array<{
    assertions: ReadonlyArray<{ id: string }>;
    evidence: ReadonlyArray<{ id: string }>;
    roots: ReadonlyArray<GraphFenceRetainedRoot>;
  }> = [];
  for (const obs of best.values()) {
    const pathVersions = {
      template: obs.templateKey,
      grammar_version: obs.grammarVersion,
      ranking_policy_version: RANKING_POLICY_VERSION,
      intent: obs.intent,
      assertion_ids: obs.assertions.map((a) => a.id),
      assertion_revisions: obs.assertions.map((a) => a.revision),
      evidence_ids: obs.evidence.map((e) => e.id),
      evidence_revisions: obs.evidence.map((e) => e.revision),
    };
    const upserted = await upsertFrontierCandidate(tx, {
      ownerAccountId: accountId,
      runId: run.id,
      nodeId: obs.nodeId,
      intent: 'expansion',
      dedupeKey: frontierDedupeKey(obs.intent, obs.nodeId),
      supportRootIds: obs.supportEdgeIds,
      score: obs.score,
      pathVersions,
      expiresInDays: EXPANSION_BOUNDS.frontierLifetimeDays,
      expiresAt: obs.expiresAtCap ?? undefined,
    });
    if (upserted.created) counts.frontierCreated++;
    else {
      counts.frontierDeduped++;
      // DISC-SCR-022: a dedupe hit RETAINS the stored row and only refreshes
      // its live state, so the refresh must validate the ACTUAL retained
      // observation pins — not just this pass's newly proposed pins, which
      // the pre-write check above already validated. An admitted
      // diversified-out candidate still pinning assertion revision R would
      // otherwise be refreshed live after a revision-R+1 observation passed,
      // while its stored path_versions keep naming R — a committed frontier
      // row that immediately fails the same shared read validator at read
      // time. Terminal rows keep their historical record: never revived,
      // never rewritten, never refreshed.
      if (upserted.row.state === 'active' || upserted.row.state === 'admitted') {
        const retained = await revalidateFrontierPathVersions(tx, {
          pathVersions: upserted.row.path_versions,
          at: publishAt,
        });
        // DISC-SCR-028/029: the retained pins revalidated, but the stored row's
        // private support roots are its OWN — a changed winning root does NOT
        // re-pin them (a valid dedupe hit keeps the recorded roots; only a
        // failed retained path reconciles). Resolve the ACTUAL owner-bound
        // roots from the live stored row and check their support, reference
        // and live capture-analysis authority — and for a PHOTO row, that
        // each live capture-reference witness is still photo-root
        // relation-eligible and its resolved identity grounds the RECORDED
        // path's root: a capture that abandoned the recorded subject (or a
        // replacement reference unrelated to it, or a visual claim no photo
        // root may use) is withdrawn authority, and the refresh must
        // reconcile the row coherently (path AND roots together, exactly like
        // the failed-pins path) instead of committing a live admitted row
        // rooted in authority the capture abandoned. Roots that still hold
        // join the publication fence below as the row's OWN relevance-bearing
        // population — never the selected winner's.
        const pins = frontierPathPins(upserted.row.path_versions);
        const retainedRoots = retained.valid
          ? await liveRetainedRootAuthority(tx, {
              accountId,
              snapshot,
              intent: recordedFrontierIntent(upserted.row.path_versions),
              rootEdgeIds: upserted.row.support_root_ids,
              assertions: pins.assertions.map((a) => ({ id: a.id })),
            })
          : null;
        if (!retained.valid || retainedRoots == null) {
          // Reconcile, don't overwrite blind: the retained grounding no
          // longer holds (its pins, or its private roots' live authority),
          // but THIS observation's pins just revalidated at the fresh
          // publication clock, so the candidate survives on the newly
          // validated coherent path — pins and the private roots it was
          // reached from, owner-bound, lifetime only shortened by the new
          // grounding's evidence/rights expiry cap.
          await reconcileFrontierCandidatePath(tx, {
            ownerAccountId: accountId,
            frontierId: upserted.row.id,
            pathVersions,
            supportRootIds: obs.supportEdgeIds,
            expiresAtCap: obs.expiresAtCap,
          });
          counts.frontierReconciled++;
          noteRejection(
            `retained_${retained.valid ? 'root_support_withdrawn' : (retained.reason ?? 'evidence_missing')}`,
          );
        } else {
          // DISC-SCR-024: the retained path revalidated UNDER the shared
          // FOR SHARE pin locks this pass holds through its commit, so the
          // pins it keeps are a committing dependency population — carried
          // into the publication fence even though no newly selected
          // observation names them.
          retainedCommitting.push({
            assertions: pins.assertions.map((a) => ({ id: a.id })),
            evidence: pins.evidence.map((e) => ({ id: e.id })),
            // DISC-SCR-028: the retained row's ACTUAL private root authority
            // joins the fence's relevance-bearing population — its support
            // edges, and for photo roots its capture-reference support and
            // live capture-analysis authority under the capture lock.
            roots: retainedRoots,
          });
        }
      }
    }
    // Refresh the admission record without regressing terminal states: a
    // published/expired/pruned entry keeps its historical record.
    await tx.query(
      `UPDATE graph_frontier SET score = $3, state = 'admitted', updated_at = now()
        WHERE id = $1 AND owner_account_id = $2 AND state IN ('active','admitted')`,
      [upserted.row.id, accountId, obs.score],
    );
  }

  // --- Publication: candidate cards with pinned proofs ------------------------------
  const candidateNodes = await tx.query<{ id: string; canonical_name: string; cultural_reference_id: string | null }>(
    `SELECT id, canonical_name, cultural_reference_id FROM graph_nodes WHERE id = ANY($1::uuid[])`,
    [[...new Set(ranked.map((o) => o.nodeId))]],
  );
  const nodeMeta = new Map(candidateNodes.rows.map((r) => [r.id, r]));
  const referenceIds = [...new Set(candidateNodes.rows.map((r) => r.cultural_reference_id).filter((v): v is string => v != null))];
  const itemByReference = new Map<string, { id: string; title: string }>();
  if (referenceIds.length > 0) {
    const items = await tx.query<{ id: string; title: string; reference_id: string }>(
      `SELECT id, title, reference_id FROM discovery_items
        WHERE owner_account_id = $1 AND reference_id = ANY($2::uuid[])
        ORDER BY id`,
      [accountId, referenceIds],
    );
    for (const item of items.rows) {
      if (!itemByReference.has(item.reference_id)) itemByReference.set(item.reference_id, { id: item.id, title: item.title });
    }
  }

  // Candidates whose corpus identity has NO durable reference binding
  // materialize through the SAME verified provider-id link that resolves
  // roots: the identity's CONFIRMED provider id must equal an account item's
  // reference id (exact equality, never a name match) — and the pair must
  // satisfy the DURABLE linker's full bilateral rules (DISC-SCR-017): GLOBAL
  // one-to-one cardinality in BOTH directions, an ACTIVE identity and
  // compatible existing bindings on both sides. One identity matching two
  // references, one reference matched by two identities anywhere, an
  // identity durably linked elsewhere or a reference durably held by a
  // DIFFERENT identity materializes nothing — the honest
  // candidatesWithoutItems count reports it.
  const unboundNodeIds = [
    ...new Set(candidateNodes.rows.filter((r) => r.cultural_reference_id == null).map((r) => r.id)),
  ];
  const itemByLinkedNode = new Map<string, { id: string; title: string }>();
  if (unboundNodeIds.length > 0) {
    // Only ACTIVE identities resolve a card through the link — the same
    // active requirement the root reader enforces.
    const linkedRefs = await tx.query<{ node_id: string; reference_id: string }>(
      `SELECT DISTINCT x.node_id, cr.id AS reference_id
         FROM graph_external_ids x
         JOIN graph_nodes n ON n.id = x.node_id AND n.status = 'active'
         JOIN cultural_references cr
           ON (cr.external_ids ->> x.provider) = x.external_id
              OR cr.canonical_key = (x.provider || ':' || x.external_id)
        WHERE x.match_status = 'confirmed'
          AND x.node_id = ANY($1::uuid[])`,
      [unboundNodeIds],
    );
    const refsByNode = new Map<string, Set<string>>();
    for (const row of linkedRefs.rows) {
      const refs = refsByNode.get(row.node_id) ?? new Set<string>();
      refs.add(row.reference_id);
      refsByNode.set(row.node_id, refs);
    }
    // One identity matching two references materializes neither; the
    // surviving (identity → sole reference) pairs then pass the same
    // bilateral gate the root fallback uses, so a reference durably held by
    // a different identity fails closed here exactly as the durable linker
    // would refuse the bind.
    const soleReferencePairs = [...refsByNode]
      .filter(([, refs]) => refs.size === 1)
      .map(([nodeId, refs]) => ({ nodeId, referenceId: [...refs][0]! }));
    if (soleReferencePairs.length > 0) {
      const verdict = await bilaterallyVerifiedReferenceNodes(tx, {
        referenceIds: soleReferencePairs.map((pair) => pair.referenceId),
      });
      const acceptedReferenceIds = [...verdict.acceptedByReference.keys()];
      const itemsByReference = new Map<string, { id: string; title: string }>();
      if (acceptedReferenceIds.length > 0) {
        const items = await tx.query<{ id: string; title: string; reference_id: string }>(
          `SELECT id, title, reference_id FROM discovery_items
            WHERE owner_account_id = $1 AND reference_id = ANY($2::uuid[])
            ORDER BY id`,
          [accountId, acceptedReferenceIds],
        );
        for (const item of items.rows) {
          if (!itemsByReference.has(item.reference_id)) itemsByReference.set(item.reference_id, { id: item.id, title: item.title });
        }
      }
      for (const { nodeId, referenceId } of soleReferencePairs) {
        if (verdict.acceptedByReference.get(referenceId) !== nodeId) continue;
        const item = itemsByReference.get(referenceId);
        if (item) itemByLinkedNode.set(nodeId, item);
      }
    }
  }

  for (const obs of ranked) {
    await enforceDeadline();
    const meta = nodeMeta.get(obs.nodeId);
    obs.candidateName = meta?.canonical_name ?? '';
    const directItem = meta?.cultural_reference_id ? itemByReference.get(meta.cultural_reference_id) : undefined;
    const item = directItem ?? itemByLinkedNode.get(obs.nodeId);
    if (!directItem && item) counts.candidatesResolvedByLink++;
    if (!item) {
      counts.candidatesWithoutItems++;
      continue;
    }
    obs.discoveryItemId = item.id;
    const rec = await insertGraphRecommendation(tx, {
      ownerAccountId: accountId,
      runId: run.id,
      discoveryItemId: item.id,
      origin: 'catalog',
      title: item.title,
      rank: obs.rank ?? 0,
      displayReason: obs.reason,
    });
    const proof = await insertRecommendationProof(tx, {
      ownerAccountId: accountId,
      recommendationId: rec.id,
      graphRunId: run.id,
      intent: obs.intent,
      reasonTemplate: obs.templateKey,
      reasonTemplateVersion: obs.grammarVersion,
      assertions: obs.assertions,
      evidence: obs.evidence,
      supportEdgeIds: obs.supportEdgeIds,
    });
    obs.recommendationId = rec.id;
    obs.proofId = proof.id;
    counts.recommendationsPublished++;
    counts.proofsPublished++;
    await tx.query(
      `UPDATE graph_frontier SET state = 'published', updated_at = now()
        WHERE id = (SELECT id FROM graph_frontier WHERE owner_account_id = $1 AND dedupe_key = $2)
          AND owner_account_id = $1 AND state IN ('active','admitted')`,
      [accountId, `expansion:${obs.intent}:node:${obs.nodeId}`],
    );
  }

  // --- Publication fence: delayed work re-checks current authority (VAL-DISC-007) ---
  // Every check below reads CURRENT committed state inside this transaction:
  // a concurrent commit that landed after the pass began is visible to these
  // statements (READ COMMITTED), so stale work is rejected and rolled back
  // rather than publishing. Pre-dispatch checks alone are insufficient — this
  // is the last word before the run is marked complete. This final stage
  // check also re-tightens the SQL bound to the CURRENT remainder, so the
  // fence's own lock waits end at the anchored deadline (DISC-SCR-018).
  await enforceDeadline();
  const violation = await checkGraphPublicationFence(tx, {
    accountId,
    start: {
      projectionRevision: run.input_projection_revision,
      generation: run.input_generation,
      tasteRevision: snapshot.tasteRevision,
    },
    ranked,
    // Admitted-unranked candidates commit frontier rows without a card: their
    // pins get the same last-word dependency recheck (DISC-SCR-009), and
    // their FULL relevance/support authority — roots, support edges and,
    // for photo observations, the capture locks and the live analysis
    // reread — fences through the commit exactly like a ranked card's
    // (DISC-SCR-027). The full observation objects carry all of it.
    admittedUnranked: [...best.values()].filter((o) => !ranked.includes(o)),
    // Retained-only pins a dedupe refresh KEEPS commit with this pass too
    // (DISC-SCR-024): the same last-word dependency recheck covers them.
    retainedFrontier: retainedCommitting,
    // The fence's own successive lock waits each re-tighten to the CURRENT
    // remainder through this hook (DISC-SCR-025).
    bound: enforceDeadline,
  });
  if (violation) throw new GraphFenceError(violation);
  // The caller's fence hook runs last, closest to the commit: the queue
  // handler rechecks its lease ownership here, so work published after a lost
  // or superseded lease cannot exist.
  await input.fence?.(tx);

  // --- Complete the run record --------------------------------------------------------
  await tx.query(`UPDATE graph_runs SET budget = $3, updated_at = now() WHERE id = $1 AND owner_account_id = $2`, [
    run.id,
    accountId,
    JSON.stringify({
      source: 'expansion',
      bounds: EXPANSION_BOUNDS,
      ranking_policy_version: RANKING_POLICY_VERSION,
      grammar_version: GRAPH_PATH_GRAMMAR_VERSION,
      // The pass's due-marker coverage bound: the attempt-start clock whose
      // markers this pass's authority read covered. A redelivery of a
      // committed pass consumes exactly this bound — never more, so a marker
      // stamped after the pass's read stays due for the next window.
      due_until: at.toISOString(),
      counts,
      rejections,
      truncated,
      // Vision stays unqualified: the constant is the honest operational state.
      vision: { qualified: false, links_denied: counts.visionLinksDenied, visual_references_denied: counts.photoReferencesDenied },
      roots: { personal: counts.personalRoots, photo: counts.photoRoots },
    }),
  ]);
  await setGraphRunState(tx, { runId: run.id, ownerAccountId: accountId, state: 'complete', published: true });

  return {
    expanded: true,
    runId: run.id,
    policyVersion: INTEREST_GRAPH_POLICY_VERSION,
    rankingPolicyVersion: RANKING_POLICY_VERSION,
    grammarVersion: GRAPH_PATH_GRAMMAR_VERSION,
    visionQualified: false,
    counts,
    rejections,
    truncated,
    candidates: ranked,
  };
}

// --- Publication fence (VAL-DISC-007) --------------------------------------------------

/**
 * One ACTUAL owner-bound private support root of a retained frontier row, as
 * the publication fence re-checks it (DISC-SCR-028). A valid dedupe refresh
 * KEEPS the stored row's roots — they can differ from every newly selected
 * observation's (a changed winning photo root) — so the fence must see the
 * row's OWN root authority, never the selected winner's. A photo root entry
 * is already QUALIFIED evidence (DISC-SCR-029): the engine's resolver only
 * emits capture-bearing entries whose live tuple is photo-root
 * relation-eligible and whose resolved identity grounds the recorded path's
 * root node — the fence re-decides that qualification at the fresh
 * publication clock, because a live tuple on the retained edge is not by
 * itself a witness for the recorded cultural path.
 */
export interface GraphFenceRetainedRoot {
  /** The retained row's stored support-root edge (owner-bound). */
  edgeId: string;
  /**
   * The root edge's live capture-reference authority at the refresh read:
   * present when the root edge carries an ACTIVE capture_reference support
   * row (a photo root). The fence re-checks that the exact support row is
   * still active on that edge and that the LIVE capture still explicitly
   * saves, still activates exactly this analysis/version and still
   * authorizes exactly this capture_references row — under the same capture
   * row lock the selected photo observations take, so real
   * activation/deletion writers are ordered with the publication commit —
   * AND that the live reference still passes the photo-root relation and
   * identity-grounding qualification for the entry's recorded path. Absent
   * for personal roots (an explicit edge): its live presence is its
   * authority.
   */
  capture?: {
    captureId: string;
    analysisId: string;
    analysisVersion: number;
    captureReferenceId: string;
  };
}

/**
 * One relevance-bearing COMMITTING observation as the publication fence
 * re-checks it: the pinned shared dependencies (assertions/evidence) plus
 * the private relevance/support authority its commit pins. Ranked cards and
 * admitted-unranked frontier survivors carry the SAME shape (DISC-SCR-027):
 * a frontier row without a card is still private support committed against
 * live account, root and capture authority.
 */
export interface GraphFenceCommittingObservation {
  intent: 'personal' | 'photo';
  /** Walked assertion ids pinned at their exact revisions, in walk order. */
  assertions: ReadonlyArray<{ id: string }>;
  /** The observation's pinned evidence rows (the live-witness recheck). */
  evidence: ReadonlyArray<{ id: string }>;
  /** The private support edges the commit pins (the withdrawal recheck). */
  supportEdgeIds: readonly string[];
  /** The private relevance basis, distinct from the cultural connection. */
  relevance: ExpansionRelevance | PhotoExpansionRelevance;
}

export interface GraphPublicationFenceInput {
  accountId: string;
  /** The authority versions the pass read at its start. */
  start: { projectionRevision: number; generation: number; tasteRevision: number };
  /** The ranked observations about to be published (empty when no card publishes). */
  ranked: ReadonlyArray<GraphFenceCommittingObservation>;
  /**
   * The admitted-unranked observations about to commit frontier candidate
   * rows without a card (diversified-out candidates). They carry the SAME
   * full relevance/support authority as ranked observations (DISC-SCR-027):
   * their pinned assertions/evidence get the last-word dependency recheck
   * (DISC-SCR-009), and their roots and photo captures join the exclusion,
   * support-withdrawal and live capture-authority checks through the commit —
   * a pass whose rails emptied mid-pass (every ranked candidate's pinned
   * revision changed while an admitted-unranked survivor remained) fences
   * its whole committing population, never just the cards. Before this, a
   * ranked-empty pass with an admitted-unranked photo survivor took no
   * capture lock and ran no live photo check, so a real analysis activation
   * could land between the fence and the commit and the pass published
   * obsolete analysis-A-rooted private frontier support.
   */
  admittedUnranked?: ReadonlyArray<GraphFenceCommittingObservation>;
  /**
   * The RETAINED-ONLY frontier populations this pass commits
   * (DISC-SCR-024/028): dedupe-refreshed live rows whose VALID retained pins
   * are KEPT — recorded paths that can differ from every newly selected
   * observation (a changed winning root), so they appear in no `ranked` or
   * `admittedUnranked` entry. They get the same last-word dependency
   * recheck: a late expiry or invalidation of a retained pin rejects the
   * whole pass instead of committing an immediately invalid live row. And
   * because a valid dedupe hit PRESERVES the stored row's private support
   * roots (only a failed retained path reconciles them), each entry also
   * carries the row's ACTUAL owner-bound roots with their live
   * capture-reference authority (`roots`, DISC-SCR-028): their support edges
   * join the support-withdrawal check, and their captures join the same
   * capture lock and live capture-analysis reread the selected photo
   * observations take — so a real analysis activation or capture deletion is
   * ordered with the publication commit for the RETAINED population too, and
   * a changed-winning-photo-root refresh can no longer commit a live
   * admitted row rooted in authority its capture abandoned after the fence.
   * The photo-root entries are QUALIFIED witnesses (DISC-SCR-029): the
   * engine emits only tuples that are photo-root relation-eligible and whose
   * resolved identity grounds the recorded path's root node, and the fence
   * re-decides that qualification at the fresh publication clock — a live
   * tuple on the retained edge that is unrelated to or ineligible for the
   * recorded path is withdrawn authority, not support.
   * A row whose every root lost its authority reconciles at the refresh
   * itself and carries no entry here.
   */
  retainedFrontier?: ReadonlyArray<{
    assertions: ReadonlyArray<{ id: string }>;
    evidence: ReadonlyArray<{ id: string }>;
    roots?: ReadonlyArray<GraphFenceRetainedRoot>;
  }>;
  /**
   * Re-tightens the SQL bound to the window's CURRENT remainder before EACH
   * of the fence's own lock waits — the account publication-authority lock
   * and the committing photo observations' capture lock (DISC-SCR-025). The
   * engine's stage check bounds the fence's FIRST wait; a bound computed
   * before an earlier wait must never be reused by a later one, or the
   * fence's successive waits could cumulatively run past the anchored
   * deadline before any later check rolls the pass back. Absent keeps default
   * statement limits (direct race-matrix callers).
   */
  bound?: () => Promise<void>;
}

/**
 * The transactional publication fence: re-reads CURRENT committed authority
 * and reports the first violation, or null when the pass may publish. The
 * expansion engine calls it inside the publication transaction right before
 * the run is completed (pre-dispatch checks alone are insufficient); it is
 * exported so the race-matrix tests can drive each check directly.
 *
 * Violations map exactly to the VAL-DISC-007 causes: account deletion
 * ('account_missing'), taste/projection change or deletion-generation change
 * ('stale_authority'), discovery pause ('paused'), an exclusion landing on a
 * root about to publish ('exclusion_landed'), source invalidation of a pinned
 * assertion or loss of every pinned live evidence witness
 * ('source_invalidated') and withdrawn support for a root
 * ('support_withdrawn'). Lease loss is the caller's fence hook, run after this.
 *
 * Dependency checks read the database's OWN clock (DISC-SCR-009), never the
 * run-start clock the engine was given: a sole-evidence/source withdrawal or
 * an evidence/rights expiry that committed mid-pass — including during the
 * drift window after the pre-write pin validation — is decided by the
 * publication instant. Exact (id, revision) pin agreement and per-observation
 * dropping already happened before the writes; a violation found here is a
 * late landing, and the whole pass is rejected so the next window rebuilds
 * from current state.
 */
export async function checkGraphPublicationFence(
  tx: Queryable,
  input: GraphPublicationFenceInput,
): Promise<Exclude<ExpansionRejectionReason, 'disabled' | 'lease_lost'> | null> {
  const { accountId } = input;

  // Account deletion is about the account row itself (the state row also
  // cascades away, but a never-projected account has no state row either).
  // The LOCKED read doubles as the consistent per-account publication-
  // authority lock (DISC-SCR-008): pause/resume take the same row lock before
  // writing the refresh state, so a pause either commits before this read
  // (and is seen below) or waits for this transaction's commit — it can no
  // longer land between the pause check and the publication commit. FOR NO
  // KEY UPDATE keeps the ordering off foreign-key key-share work (projection
  // passes, support removal, cleanup), which are never blocked by it.
  // DISC-SCR-025: the bound is re-tightened HERE, immediately before this
  // wait — the first of the fence's several independent lock waits.
  await input.bound?.();
  const present = await lockAccountPublicationAuthority(tx, accountId);
  if (!present) return 'account_missing';
  const { rows: state } = await tx.query<{ projection_revision: number; deletion_generation: number }>(
    'SELECT projection_revision, deletion_generation FROM personal_graph_state WHERE owner_account_id = $1',
    [accountId],
  );
  const stateRow = state[0];
  if (stateRow) {
    if (stateRow.projection_revision !== input.start.projectionRevision || stateRow.deletion_generation !== input.start.generation) {
      return 'stale_authority';
    }
  } else if (input.start.projectionRevision > 0 || input.start.generation > 0) {
    // The state row existed when the pass began (non-zero versions were read)
    // and is gone now: a reset/deletion landed mid-pass.
    return 'stale_authority';
  }
  // A never-projected account (all-zero start versions, no state row) may
  // still run a fenced pass: its authority comparison continues below.
  // A taste change committed mid-pass (the projector has not caught up yet)
  // still invalidates the roots this pass walked: fresh support arrived.
  const tasteRevision = await getTasteRevision(tx, { kind: 'account', accountId });
  if (tasteRevision !== input.start.tasteRevision) return 'stale_authority';
  if ((await graphDiscoveryPausedAt(tx, accountId)) != null) return 'paused';

  // DISC-SCR-027: the relevance-bearing committing population is BOTH the
  // ranked cards AND the admitted-unranked frontier survivors. A
  // diversified-out candidate commits the same private relevance, support
  // roots and (for photo observations) capture authority a ranked card does,
  // so every check below runs over the whole committing population — never
  // just `input.ranked`. Before this, a pass whose rails emptied mid-pass
  // (e.g. every ranked candidate's pinned assertion revision changed while an
  // admitted-unranked photo candidate survived) took no capture lock and ran
  // no live photo check: real activateAnalysis(A→B) — which changes neither
  // the taste nor the projection revision — could commit between the fence
  // and the publication commit, and the pass published obsolete A-rooted
  // private frontier support with no recommendation card ever emitted.
  const committingRooted: ReadonlyArray<GraphFenceCommittingObservation> = [
    ...input.ranked,
    ...(input.admittedUnranked ?? []),
  ];
  // DISC-SCR-028: the retained rows that KEEP their stored roots are a
  // relevance-bearing committing population of their OWN. A changed winning
  // photo root leaves the stored row rooted in the OLD capture's support, so
  // checking only the selected observations' relevance (the new winner Y)
  // fenced Y while the committed row still carried X/A-rooted private
  // support. The actual retained roots join every check below; a retained
  // row whose every root lost its authority reconciles at the refresh itself
  // and never reaches the fence. DISC-SCR-029: a retained row that KEEPS its
  // roots also keeps its RECORDED cultural path, so its photo roots must be
  // QUALIFIED witnesses — still photo-root relation-eligible, and their
  // resolved identity still the recorded walk's root node — never merely a
  // live tuple on the stored edge.
  const retainedRooted = (input.retainedFrontier ?? []).filter((row) => (row.roots?.length ?? 0) > 0);
  const retainedPhotoRoots = retainedRooted.flatMap((row) => row.roots!).filter((root) => root.capture != null);
  if (committingRooted.length > 0 || retainedRooted.length > 0) {
    // Exclusions: a hide landing on a personal root about to publish.
    const personalKeys = committingRooted
      .filter((o) => o.relevance.kind === 'personal')
      .map((o) => (o.relevance as ExpansionRelevance).canonicalKey);
    if (personalKeys.length > 0) {
      const { rows: hidden } = await tx.query<{ canonical_key: string }>(
        'SELECT DISTINCT canonical_key FROM item_exclusions WHERE owner_account_id = $1 AND canonical_key = ANY($2::text[])',
        [accountId, personalKeys],
      );
      if (hidden.length > 0) return 'exclusion_landed';
    }

    // Support withdrawal: the private support edges a commit pins must still
    // be present and non-suppressed (explicit edges are confirmed; derived
    // edges — e.g. a saved capture's projected reference support — are
    // tentative while active), and a photo root's capture-reference support
    // must still be active (capture deletion/correction withdrew it).
    const edgeIds = [...new Set(committingRooted.flatMap((o) => o.supportEdgeIds))];
    if (edgeIds.length > 0) {
      const { rows: edges } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM personal_interest_edges
          WHERE owner_account_id = $1 AND id = ANY($2::uuid[]) AND state IN ('confirmed','tentative')`,
        [accountId, edgeIds],
      );
      if (Number(edges[0]!.n) !== edgeIds.length) return 'support_withdrawn';
    }
    const photoReferenceIds = committingRooted
      .filter((o) => o.relevance.kind === 'photo')
      .map((o) => (o.relevance as PhotoExpansionRelevance).captureReferenceId);
    if (photoReferenceIds.length > 0) {
      const { rows: active } = await tx.query<{ capture_reference_id: string }>(
        `SELECT DISTINCT capture_reference_id FROM personal_interest_support
          WHERE owner_account_id = $1 AND origin_kind = 'capture_reference' AND active
            AND capture_reference_id = ANY($2::uuid[])`,
        [accountId, [...new Set(photoReferenceIds)]],
      );
      if (active.length !== new Set(photoReferenceIds).size) return 'support_withdrawn';
    }

    // DISC-SCR-007: projected support lags by design — analysis activation
    // deliberately does not bump the taste revision — so the decisive photo
    // check re-reads the AUTHORITATIVE live state: the capture must still be
    // explicitly saved, its CURRENT active analysis must be the exact
    // analysis/version the root walked, and the exact capture_references row
    // must still be one of that analysis's currently authorized references. A
    // mid-pass activation A→B (before any projection catches up) fences the
    // stale A-rooted pass here instead of publishing it.
    //
    // DISC-SCR-020: that live check is ORDERED with its real writers through
    // this commit. The writers — activateAnalysis's pointer move and a
    // capture's soft deletion — are UPDATEs of the captures row, so holding
    // that row's lock from before the authoritative re-read makes the order
    // deterministic: a writer either commits before this read (the fence
    // reads its result below and rejects the stale A-rooted pass) or queues
    // for this transaction's commit (the pass published under exactly the
    // capture authority it walked, and the activation lands after). Only
    // live rows are locked: an already-deleted capture locks nothing and the
    // re-read reports it as withdrawn support below, while a deletion of a
    // locked live capture queues behind the publication like an activation.
    // The lock is per-capture (never per-account), so other accounts'
    // captures never wait; the wait itself is bounded by the pass's
    // deadline-tightened lock_timeout. DISC-SCR-025: that bound is
    // re-tightened HERE, immediately before this SECOND independent wait of
    // the fence — the time the account-authority wait consumed above must not
    // widen this wait's allowance past the anchored deadline. DISC-SCR-027:
    // the locked/reread population is EVERY committing photo observation,
    // ranked cards AND admitted-unranked frontier survivors — the fence is
    // the last word for the whole private authority the pass commits.
    // DISC-SCR-028: the RETAINED photo roots' captures join the same lock and
    // reread — the fence is also the last word for the stored roots a
    // changed-winning-root dedupe refresh keeps, never just the newly
    // selected observations'.
    const photoCommitting = committingRooted.filter((o) => o.relevance.kind === 'photo');
    const captureIds = [
      ...new Set([
        ...photoCommitting.map((o) => (o.relevance as PhotoExpansionRelevance).captureId),
        ...retainedPhotoRoots.map((root) => root.capture!.captureId),
      ]),
    ];
    if (captureIds.length > 0) {
      await input.bound?.();
      await tx.query(`SELECT id FROM captures WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL FOR NO KEY UPDATE`, [
        captureIds,
      ]);
      const live = await loadExplicitSupport(tx, accountId);
      const liveByCapture = new Map(live.captures.map((c) => [c.captureId, c]));
      for (const obs of photoCommitting) {
        const relevance = obs.relevance as PhotoExpansionRelevance;
        const capture = liveByCapture.get(relevance.captureId);
        if (!capture) return 'support_withdrawn';
        if (capture.analysisId !== relevance.analysisId || capture.analysisVersion !== relevance.analysisVersion) {
          return 'support_withdrawn';
        }
        if (!capture.references.some((r) => r.captureReferenceId === relevance.captureReferenceId)) {
          return 'support_withdrawn';
        }
      }
      // DISC-SCR-028: the retained rows' ACTUAL stored roots. A retained row
      // keeps its roots while ANY one of them still holds its full live
      // authority: the edge is still present in a live state (confirmed or
      // tentative — suppression and the projector's withdrawal sweep both end
      // it), and for a photo root the exact capture_reference support row is
      // still ACTIVE on that edge while the LIVE capture still explicitly
      // saves, still activates exactly the support's analysis/version and
      // still authorizes exactly that capture_references row. The
      // account-authority lock held above fences the projector (the only
      // writer of these rows — its pass takes the same lock first), and the
      // capture lock just taken fences the real activation/deletion writers,
      // so a writer either commits before these reads (rejected here) or
      // queues for this publication commit.
      if (retainedRooted.length > 0) {
        const rootEdgeIds = [...new Set(retainedRooted.flatMap((row) => row.roots!.map((root) => root.edgeId)))];
        const { rows: rootEdges } = await tx.query<{ id: string }>(
          `SELECT id FROM personal_interest_edges
            WHERE owner_account_id = $1 AND id = ANY($2::uuid[]) AND state IN ('confirmed','tentative')`,
          [accountId, rootEdgeIds],
        );
        const liveEdgeIds = new Set(rootEdges.map((row) => row.id));
        let activePairs = new Set<string>();
        const liveReferenceByCaptureRefId = new Map<string, ExplicitCaptureReference>();
        if (retainedPhotoRoots.length > 0) {
          const { rows: supportRows } = await tx.query<{ edge_id: string; capture_reference_id: string }>(
            `SELECT edge_id, capture_reference_id FROM personal_interest_support
              WHERE owner_account_id = $1 AND active AND origin_kind = 'capture_reference'
                AND edge_id = ANY($2::uuid[])`,
            [accountId, [...new Set(retainedPhotoRoots.map((root) => root.edgeId))]],
          );
          activePairs = new Set(supportRows.map((row) => `${row.edge_id}:${row.capture_reference_id}`));
          // DISC-SCR-029: the LIVE authorized reference each retained photo
          // root's tuple names — the fence's fresh reread of what the entry
          // claims, before deciding whether that claim still grounds the
          // recorded path.
          for (const root of retainedPhotoRoots) {
            const capture = liveByCapture.get(root.capture!.captureId);
            const reference = capture?.references.find((r) => r.captureReferenceId === root.capture!.captureReferenceId);
            if (reference) liveReferenceByCaptureRefId.set(root.capture!.captureReferenceId, reference);
          }
        }
        const nodeByLiveReference =
          liveReferenceByCaptureRefId.size > 0
            ? await nodesByReference(tx, {
                referenceIds: [...new Set([...liveReferenceByCaptureRefId.values()].map((r) => r.referenceId))],
                // The fence validates, it never reports root resolution.
                counts: emptyCounts(),
              })
            : new Map<string, string>();
        for (const retained of retainedRooted) {
          let recordedRootNodeId: string | null | undefined;
          let grounded = false;
          for (const root of retained.roots!) {
            if (!liveEdgeIds.has(root.edgeId)) continue;
            const authority = root.capture;
            if (!authority) {
              grounded = true; // a personal root: live presence is its authority
              break;
            }
            if (!activePairs.has(`${root.edgeId}:${authority.captureReferenceId}`)) continue;
            const capture = liveByCapture.get(authority.captureId);
            if (!capture) continue;
            if (capture.analysisId !== authority.analysisId || capture.analysisVersion !== authority.analysisVersion) {
              continue;
            }
            // DISC-SCR-029: the tuple's live reference must still be photo-root
            // relation-eligible (`resembles` never qualifies), and its
            // resolved ACTIVE identity — the same durable-binding-or-
            // verified-link resolution resolveRoots applies — must still be
            // the root-side node of the RECORDED walk. This is the fence's
            // last word on whether the kept path is still grounded in the
            // identity the pass's resolver qualified: a tuple that is merely
            // live on the retained edge (unrelated to the recorded path, or a
            // visual claim) rejects the pass instead of committing stale
            // path authority through the commit.
            const reference = liveReferenceByCaptureRefId.get(authority.captureReferenceId);
            if (!reference || reference.relation === 'resembles') continue;
            if (recordedRootNodeId === undefined) {
              recordedRootNodeId = await recordedPathRootNodeId(tx, retained.assertions);
            }
            if (recordedRootNodeId == null) continue;
            if (nodeByLiveReference.get(reference.referenceId) !== recordedRootNodeId) continue;
            grounded = true;
            break;
          }
          if (!grounded) return 'support_withdrawn';
        }
      }
    }
  }

  // Source invalidation at the FRESH publication clock (DISC-SCR-009), over
  // EVERY committing observation — ranked cards, admitted-unranked frontier
  // candidates, and the RETAINED-ONLY pins a dedupe refresh keeps
  // (DISC-SCR-024) alike. Exact (id, revision) pin agreement and the
  // per-observation drop already happened before the writes (the pinned rows
  // are locked FOR SHARE through this commit, so their STATE cannot have
  // changed since); what can still land in the drift window before the commit
  // is time itself: an evidence/rights expiry. Both checks reuse the read
  // path's own rules — a pinned assertion must still be currently justified,
  // and every committing observation must retain at least one currently-valid
  // pinned evidence row as a live grounding witness — so publication-time and
  // read-time validity agree on every emitted proof and committed frontier
  // row. A violation found here is a late landing and rejects the whole pass
  // (the next window rebuilds).
  const committing: ReadonlyArray<{ assertions: ReadonlyArray<{ id: string }>; evidence: ReadonlyArray<{ id: string }> }> = [
    ...input.ranked,
    ...(input.admittedUnranked ?? []),
    ...(input.retainedFrontier ?? []),
  ];
  if (committing.length > 0) {
    const { rows: clockRows } = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const fenceAt = clockRows[0]!.now;
    const assertionIds = [...new Set(committing.flatMap((o) => o.assertions.map((a) => a.id)))];
    for (const assertionId of assertionIds) {
      const justification = await currentAssertionJustification(tx, { assertionId, at: fenceAt });
      if (!justification.justified) return 'source_invalidated';
    }
    const evidenceIds = [...new Set(committing.flatMap((o) => o.evidence.map((e) => e.id)))];
    const liveById = new Map<string, boolean>();
    if (evidenceIds.length > 0) {
      const { rows: evidenceRows } = await tx.query<{ id: string; live: boolean }>(
        `SELECT e.id,
                (e.validity_state = 'valid'
                  AND (e.expires_at IS NULL OR e.expires_at > $2)
                  AND (r.rights_expires_at IS NULL OR r.rights_expires_at > $2)) AS live
           FROM graph_evidence e
           JOIN graph_source_revisions r ON r.id = e.source_revision_id
          WHERE e.id = ANY($1::uuid[])`,
        [evidenceIds, fenceAt],
      );
      for (const row of evidenceRows) liveById.set(row.id, row.live);
    }
    for (const obs of committing) {
      if (obs.evidence.length === 0) continue;
      if (!obs.evidence.some((e) => liveById.get(e.id) === true)) return 'source_invalidated';
    }
  }
  return null;
}

// --- Root resolution --------------------------------------------------------------------

async function graphStateFence(tx: Queryable, accountId: string): Promise<{ inputProjectionRevision: number; inputGeneration: number }> {
  const { rows } = await tx.query<{ projection_revision: number; deletion_generation: number }>(
    'SELECT projection_revision, deletion_generation FROM personal_graph_state WHERE owner_account_id = $1',
    [accountId],
  );
  return { inputProjectionRevision: rows[0]?.projection_revision ?? 0, inputGeneration: rows[0]?.deletion_generation ?? 0 };
}

/**
 * The account's CURRENT authority versions: taste revision, projection
 * revision and deletion generation. The research handler captures these at
 * run start (persisted on its run) and its storage fence compares the
 * current values against that ORIGINAL capture before any write (DISC-SCR-011).
 */
export async function currentAccountAuthorityVersions(
  db: Queryable,
  accountId: string,
): Promise<{ tasteRevision: number; projectionRevision: number; generation: number }> {
  const tasteRevision = await getTasteRevision(db, { kind: 'account', accountId });
  const { inputProjectionRevision, inputGeneration } = await graphStateFence(db, accountId);
  return { tasteRevision, projectionRevision: inputProjectionRevision, generation: inputGeneration };
}

/**
 * The LOCKED account authority-version read for the research publication
 * fence (DISC-SCR-021): the same versions `currentAccountAuthorityVersions`
 * returns, read under row locks on the EXACT rows the real writers update,
 * so the comparison against a run's ORIGINAL versions is ordered with every
 * actual writer through the caller's commit:
 *
 *  - bumpTasteRevision — the decisive statement of every
 *    save/remove/hide/unhide/correct — locks the taste_profiles row in its
 *    ON CONFLICT DO UPDATE;
 *  - the projector pass bumps projection_revision (and a deletion-generation
 *    advance bumps deletion_generation) inside the personal_graph_state row,
 *    locked here when it exists.
 *
 * A writer therefore either commits before this read (the fence sees the new
 * version and rejects stale proposals) or queues for the publication commit
 * (the published proposals held their input authority through commit). It
 * can no longer land between the comparison and the storage commit.
 *
 * ABSENT authority rows are guarded without inventing projection state:
 *  - a fresh account has NO taste_profiles row yet, and a lock on a missing
 *    row locks nothing — the row is MATERIALIZED (revision 0) so the FIRST
 *    writer's INSERT contends on the same unique key. A revision-0 row is
 *    semantically identical to an absent one for every reader, so no reader
 *    changes behavior;
 *  - the personal_graph_state row is NOT materialized (a fabricated
 *    behind-version row would enter the dispatch catch-up population and
 *    fake a projection-completeness marker). Instead the projector's pass
 *    takes the per-account publication-authority lock (the accounts row)
 *    FIRST — the same lock this fence's caller already holds through its
 *    commit — so a FIRST projection queues behind the publication at its
 *    first statement, and a pass already holding the row is what this locked
 *    read queues behind.
 *
 * Lock order: the caller takes the per-account publication-authority lock
 * (the accounts row) FIRST, then this helper locks state and taste. Any
 * account-scoped writer that needs several of these rows must take the
 * account row first, the same protocol pause/resume, both publishers and the
 * projector pass use.
 */
export async function lockAccountAuthorityVersions(
  db: Queryable,
  accountId: string,
  /**
   * Re-tightens the SQL bound to the window's CURRENT remainder before EACH
   * of this helper's own lock waits — the state row, the materializing taste
   * insert and the taste row (DISC-SCR-025): one bound computed before an
   * earlier wait must never be reused by a later one, or successive waits
   * inside this single helper could cumulatively run past the anchor.
   */
  bound?: () => Promise<void>,
): Promise<{ tasteRevision: number; projectionRevision: number; generation: number }> {
  await bound?.();
  const { rows: state } = await db.query<{ projection_revision: number; deletion_generation: number }>(
    'SELECT projection_revision, deletion_generation FROM personal_graph_state WHERE owner_account_id = $1 FOR NO KEY UPDATE',
    [accountId],
  );
  await bound?.();
  await db.query('INSERT INTO taste_profiles (owner_account_id, revision) VALUES ($1, 0) ON CONFLICT (owner_account_id) DO NOTHING', [
    accountId,
  ]);
  await bound?.();
  const { rows: taste } = await db.query<{ revision: number }>(
    'SELECT revision FROM taste_profiles WHERE owner_account_id = $1 FOR NO KEY UPDATE',
    [accountId],
  );
  return {
    tasteRevision: taste[0]?.revision ?? 0,
    projectionRevision: state[0]?.projection_revision ?? 0,
    generation: state[0]?.deletion_generation ?? 0,
  };
}

/**
 * Resolves the two root kinds from CURRENT state. Personal roots must be
 * explicit right now (authoritative snapshot) AND have a projected private
 * edge (the owner-bound dependency frontier/proof rows pin). Photo roots are
 * only CURRENT authorized (resolved/user-confirmed) references with the
 * about-subject/documented relations of the CURRENT active analysis of an
 * explicitly saved capture; `resembles` is a visual claim and stays denied.
 */
async function resolveRoots(
  tx: Queryable,
  input: { accountId: string; snapshot: Awaited<ReturnType<typeof loadExplicitSupport>>; counts: ExpansionCounts },
): Promise<ExpansionRoot[]> {
  const { accountId, snapshot, counts } = input;

  // Authoritative explicit keys (saves + pick members) and current hides.
  const explicitKeys = new Set(snapshot.saves.map((s) => s.canonicalKey));
  for (const group of snapshot.pickGroups) {
    for (const member of group.members) explicitKeys.add(member.canonicalKey);
  }
  const hidden = new Set(snapshot.exclusions);

  // Projected explicit edges (the private dependency rows for roots).
  const edges = await tx.query<ProjectedEdgeRow>(
    `SELECT e.id AS edge_id, e.discovery_item_id, e.saved_item_id,
            COALESCE(di.id, dsi.id) AS item_id,
            COALESCE(di.canonical_key, dsi.canonical_key) AS canonical_key,
            COALESCE(di.reference_id, dsi.reference_id) AS reference_id
       FROM personal_interest_edges e
       LEFT JOIN discovery_items di ON di.id = e.discovery_item_id
       LEFT JOIN saved_items si ON si.id = e.saved_item_id
       LEFT JOIN discovery_items dsi ON dsi.id = si.discovery_item_id
      WHERE e.owner_account_id = $1 AND e.origin = 'explicit' AND e.state = 'confirmed'
      ORDER BY e.id`,
    [accountId],
  );

  // Active shared identities for every cultural reference in play. A durable
  // binding resolves directly; references with NO binding at all resolve
  // through the verified provider-id link (exact confirmed id equality, the
  // same linkage admission materializes), so real saved/photo subjects reach
  // the corpus even when they appeared after the last linkage pass. A
  // reference bound to a non-active identity stays unmapped (its binding
  // needs repair, not a runtime override), and ambiguous verified matches
  // stay unresolved.
  const photoReferenceIds = snapshot.captures.flatMap((c) => c.references.map((r) => r.referenceId));
  const edgeReferenceIds = edges.rows.map((e) => e.reference_id).filter((v): v is string => v != null);
  const nodeByReference = await nodesByReference(tx, {
    referenceIds: [...new Set([...edgeReferenceIds, ...photoReferenceIds])],
    counts,
  });

  const roots: ExpansionRoot[] = [];
  const coveredKeys = new Set<string>();
  for (const edge of edges.rows) {
    const canonicalKey = edge.canonical_key;
    if (canonicalKey) coveredKeys.add(canonicalKey);
    if (!canonicalKey) {
      counts.unmappedPersonalRoots++;
      continue;
    }
    // The relevance decision, separate from cultural evidence: an edge whose
    // save is no longer explicit (removed) or is hidden is not a root now.
    if (hidden.has(canonicalKey)) {
      counts.hiddenPersonalRoots++;
      continue;
    }
    if (!explicitKeys.has(canonicalKey)) {
      counts.stalePersonalRoots++;
      continue;
    }
    const nodeId = edge.reference_id ? nodeByReference.get(edge.reference_id) : undefined;
    if (!nodeId) {
      counts.unmappedPersonalRoots++;
      continue;
    }
    counts.personalRoots++;
    roots.push({
      kind: 'personal',
      nodeId,
      edgeId: edge.edge_id,
      canonicalKey,
      itemId: edge.item_id,
    });
  }
  // Authoritative explicit saves with no projected edge yet: honest lag, no
  // admission from support the private graph does not currently hold.
  for (const save of snapshot.saves) {
    if (hidden.has(save.canonicalKey) || coveredKeys.has(save.canonicalKey)) continue;
    if (!explicitKeys.has(save.canonicalKey)) continue;
    counts.unprojectedPersonalRoots++;
  }

  // Photo roots: only current authorized about-subject/documented references.
  const authorizedReferenceIds = snapshot.captures.flatMap((c) =>
    c.analysisId ? c.references.map((r) => r.captureReferenceId) : [],
  );
  const supportEdgeByReference = await captureReferenceSupportEdges(tx, accountId, authorizedReferenceIds);
  for (const capture of snapshot.captures) {
    if (!capture.analysisId) {
      counts.capturesWithoutAnalysis++;
      continue;
    }
    for (const ref of capture.references) {
      if (ref.relation === 'resembles') {
        // A visual-resemblance claim: disabled until an independently
        // qualified compatible adapter and evidence exist (never here).
        counts.photoReferencesDenied++;
        continue;
      }
      const nodeId = nodeByReference.get(ref.referenceId);
      if (!nodeId) {
        counts.photoReferencesUnmapped++;
        continue;
      }
      const edgeId = supportEdgeByReference.get(ref.captureReferenceId);
      if (!edgeId) {
        counts.photoReferencesUnprojected++;
        continue;
      }
      counts.photoRoots++;
      roots.push({
        kind: 'photo',
        nodeId,
        edgeId,
        captureId: capture.captureId,
        analysisId: capture.analysisId,
        analysisVersion: capture.analysisVersion,
        captureReferenceId: ref.captureReferenceId,
        referenceId: ref.referenceId,
        name: ref.name,
        relation: ref.relation,
        resolutionStatus: ref.resolutionStatus,
        isAnchor: ref.isAnchor,
        certainty: ref.certainty,
      });
    }
  }

  // Vision stays fail-closed: active private VISUALLY_RESEMBLES links never
  // become roots or reasons; they are counted as denied. Enabling the graph
  // flags does not qualify vision.
  const visionLinks = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM graph_private_links
      WHERE owner_account_id = $1 AND active AND interpretation = 'VISUALLY_RESEMBLES'`,
    [accountId],
  );
  counts.visionLinksDenied = Number(visionLinks.rows[0]!.n);

  return roots;
}

/**
 * Resolves cultural references to ACTIVE shared identities. A durable
 * binding is authoritative; only references with no binding at all fall back
 * to the verified provider-id link (a name never links) — and that fallback
 * accepts a pair ONLY when the DURABLE linker would bind the same pair
 * (DISC-SCR-017): exact confirmed provider-id equality, GLOBAL one-to-one
 * cardinality in BOTH directions, an active identity and compatible existing
 * bindings on both sides. Inverse ambiguity outside this root set (the
 * identity matched by another reference anywhere) and competing durable
 * bindings on either side fail closed without changing any stored link.
 * Ambiguous verified matches stay unresolved, and the run's counts report
 * resolutions, ambiguities and conflicts honestly.
 */
async function nodesByReference(
  tx: Queryable,
  input: { referenceIds: readonly string[]; counts: ExpansionCounts },
): Promise<Map<string, string>> {
  const unique = [...new Set(input.referenceIds)];
  if (unique.length === 0) return new Map();
  const bound = await tx.query<{ cultural_reference_id: string; id: string }>(
    `SELECT cultural_reference_id, id FROM graph_nodes
      WHERE cultural_reference_id = ANY($1::uuid[]) AND status = 'active'`,
    [unique],
  );
  const byReference = new Map(bound.rows.map((r) => [r.cultural_reference_id, r.id]));
  // References bound to a non-active identity keep their (stale) binding: the
  // fallback below only applies to references with no binding row at all.
  const { rows: anyBinding } = await tx.query<{ cultural_reference_id: string }>(
    `SELECT cultural_reference_id FROM graph_nodes WHERE cultural_reference_id = ANY($1::uuid[])`,
    [unique],
  );
  const boundReferenceIds = new Set(anyBinding.map((r) => r.cultural_reference_id));
  const unbound = unique.filter((id) => !boundReferenceIds.has(id));
  if (unbound.length === 0) return byReference;
  // The read-time fallback binds NOTHING durably: it resolves roots only
  // through the durable linker's own bilateral rules, so an identity already
  // claimed elsewhere (by another reference's provider id, or by a competing
  // durable binding) never becomes a root and never publishes from the
  // wrong identity.
  const verdict = await bilaterallyVerifiedReferenceNodes(tx, { referenceIds: unbound });
  input.counts.referenceLinksAmbiguous += verdict.ambiguousReferenceIds.length;
  input.counts.referenceLinksConflicting += verdict.conflictingReferenceIds.length;
  for (const [referenceId, nodeId] of verdict.acceptedByReference) {
    byReference.set(referenceId, nodeId);
    input.counts.referencesLinked++;
  }
  return byReference;
}

async function captureReferenceSupportEdges(
  tx: Queryable,
  accountId: string,
  captureReferenceIds: readonly string[],
): Promise<Map<string, string>> {
  if (captureReferenceIds.length === 0) return new Map();
  const { rows } = await tx.query<{ capture_reference_id: string; edge_id: string }>(
    `SELECT capture_reference_id, edge_id FROM personal_interest_support
      WHERE owner_account_id = $1 AND origin_kind = 'capture_reference' AND active
        AND capture_reference_id = ANY($2::uuid[])`,
    [accountId, [...captureReferenceIds]],
  );
  return new Map(rows.map((r) => [r.capture_reference_id, r.edge_id]));
}

// --- Walk helpers -------------------------------------------------------------------------

async function traversalRows(
  tx: Queryable,
  endpointIds: readonly string[],
  excludeIds: readonly string[],
  limit: number,
  at: Date,
): Promise<EdgeRow[]> {
  const { rows } = await tx.query<EdgeRow>(
    `SELECT a.id, a.subject_node_id, a.object_node_id
       FROM graph_assertions a
      WHERE a.status = 'validated'
        AND a.invalidated_at IS NULL
        AND (a.valid_from IS NULL OR a.valid_from <= $2::timestamptz)
        AND (a.subject_node_id = ANY($1::uuid[]) OR a.object_node_id = ANY($1::uuid[]))
        AND a.id <> ALL($3::uuid[])
      ORDER BY a.id
      LIMIT $4::int`,
    [[...endpointIds], at, [...excludeIds], limit],
  );
  return rows;
}

/** Records an edge under every endpoint it is walked from (near → far). */
function addOrientation(map: Map<string, WalkEdge[]>, row: EdgeRow, nearSet: Set<string>): void {
  if (nearSet.has(row.subject_node_id)) {
    const list = map.get(row.subject_node_id) ?? [];
    list.push({ id: row.id, near: row.subject_node_id, far: row.object_node_id });
    map.set(row.subject_node_id, list);
  }
  if (nearSet.has(row.object_node_id)) {
    const list = map.get(row.object_node_id) ?? [];
    list.push({ id: row.id, near: row.object_node_id, far: row.subject_node_id });
    map.set(row.object_node_id, list);
  }
}

// --- Observation building -------------------------------------------------------------------

/** Deterministic best-observation comparison: score, template, then walk ids. */
function betterObservation(a: AdmittedObservation, b: AdmittedObservation): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.templateKey !== b.templateKey) return a.templateKey < b.templateKey;
  return a.assertions.map((x) => x.id).join(',') < b.assertions.map((x) => x.id).join(',');
}

async function observationFromPath(
  tx: Queryable,
  root: ExpansionRoot,
  path: ValidatedGraphPath,
  at: Date,
): Promise<AdmittedObservation> {
  const intent: 'personal' | 'photo' = root.kind;
  const score = round2(
    (TEMPLATE_WEIGHTS[path.templateKey] ?? 0) + (root.kind === 'personal' ? PERSONAL_ROOT_WEIGHT : photoRootWeight(root)),
  );

  // Pin the exact revisions of the walked assertions.
  const assertionRows = await tx.query<{ id: string; revision: number }>(
    'SELECT id, revision FROM graph_assertions WHERE id = ANY($1::uuid[])',
    [path.assertionIds],
  );
  const byId = new Map(assertionRows.rows.map((r) => [r.id, r.revision]));
  const assertions = path.assertionIds.map((id) => ({ id, revision: byId.get(id) ?? 0 }));

  // Pin the reviewed, currently-valid supporting evidence behind the walked
  // edges (the proof's live grounding witnesses), with the earliest expiry as
  // the frontier lifetime cap.
  const evidenceRows = await tx.query<{ evidence_id: string; revision: number; evidence_expires_at: Date | null; rights_expires_at: Date | null }>(
    `SELECT DISTINCT s.evidence_id, r.revision, e.expires_at AS evidence_expires_at, r.rights_expires_at
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
    [path.assertionIds, at],
  );
  const evidence = evidenceRows.rows.map((r) => ({ id: r.evidence_id, revision: r.revision }));
  let expiresAtCap: Date | null = null;
  for (const row of evidenceRows.rows) {
    const earliest = [row.evidence_expires_at, row.rights_expires_at].filter((v): v is Date => v != null);
    for (const candidate of earliest) {
      if (!expiresAtCap || candidate < expiresAtCap) expiresAtCap = candidate;
    }
  }

  const supportEdgeIds = [root.edgeId];
  const relevance: ExpansionRelevance | PhotoExpansionRelevance =
    root.kind === 'personal'
      ? { kind: 'personal', edgeId: root.edgeId, canonicalKey: root.canonicalKey, itemId: root.itemId }
      : {
          kind: 'photo',
          edgeId: root.edgeId,
          captureId: root.captureId,
          analysisId: root.analysisId,
          analysisVersion: root.analysisVersion,
          captureReferenceId: root.captureReferenceId,
          referenceId: root.referenceId,
          name: root.name,
          relation: root.relation,
          resolutionStatus: root.resolutionStatus,
          isAnchor: root.isAnchor,
          certainty: root.certainty,
        };

  return {
    nodeId: path.candidateNodeId,
    candidateName: '',
    intent,
    templateKey: path.templateKey,
    meaning: path.meaning,
    reason: path.reason,
    grammarVersion: path.grammarVersion,
    midNodeId: path.midNodeId,
    score,
    rank: null,
    recommendationId: null,
    proofId: null,
    discoveryItemId: null,
    assertions,
    evidence,
    supportEdgeIds,
    relevance,
    expiresAtCap,
  };
}
