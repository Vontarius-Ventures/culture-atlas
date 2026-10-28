import type pg from 'pg';
import type { Db, Queryable } from '../db/pool';
import { activeKills } from '../flags/feature-flags';
import { GRAPH_FRONTIER_MAX_LIFETIME_DAYS, INTEREST_GRAPH_POLICY_VERSION } from './schema';
import { GRAPH_PATH_GRAMMAR_VERSION } from './assertion-policy';
import { validateGraphPath, type ValidatedGraphPath } from './paths';
import { loadExplicitSupport } from './explicit-support';
import {
  createGraphRun,
  insertGraphRecommendation,
  insertRecommendationProof,
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
 * not qualify vision.
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
  frontierExpired: number;
  frontierPruned: number;
}

export interface ExpansionResult {
  expanded: boolean;
  /** Present (with `expanded: false`) while the discovery gate is off. */
  reason?: 'disabled';
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

export interface ExpandAccountInterestGraphInput {
  accountId: string;
  config: DiscoveryGateConfig;
  /** The queue job driving this expansion (recorded on the run). */
  jobId?: string;
  /** Controlled clock for expiry/justification decisions. */
  at?: Date;
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
  return db.transaction(async (rawTx) => {
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
    // Re-check the gate inside the transaction: a kill that landed between
    // the pre-check and this pass must halt publication before any write.
    if (!(await discoveryEnabledForAccount(tx, { accountId: input.accountId, config: input.config }))) {
      return disabledResult();
    }
    return runExpansion(tx, { accountId: input.accountId, jobId: input.jobId, at });
  });
}

function disabledResult(): ExpansionResult {
  return {
    expanded: false,
    reason: 'disabled',
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
    frontierExpired: 0,
    frontierPruned: 0,
  };
}

// --- The expansion pass ----------------------------------------------------------------

async function runExpansion(
  tx: Queryable,
  input: { accountId: string; jobId?: string; at: Date },
): Promise<ExpansionResult> {
  const { accountId, at } = input;
  const counts = emptyCounts();
  const rejections: Record<string, number> = {};
  const noteRejection = (code: string) => {
    rejections[code] = (rejections[code] ?? 0) + 1;
  };

  // Current authoritative explicit state: the relevance half of every
  // admission decision reads THIS, never projection-event totals.
  const snapshot = await loadExplicitSupport(tx, accountId);

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
      for (const e2 of hop2.get(e1.far) ?? []) {
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

  for (const obs of best.values()) {
    const upserted = await upsertFrontierCandidate(tx, {
      ownerAccountId: accountId,
      runId: run.id,
      nodeId: obs.nodeId,
      intent: 'expansion',
      dedupeKey: `expansion:${obs.intent}:node:${obs.nodeId}`,
      supportRootIds: obs.supportEdgeIds,
      score: obs.score,
      pathVersions: {
        template: obs.templateKey,
        grammar_version: obs.grammarVersion,
        ranking_policy_version: RANKING_POLICY_VERSION,
        intent: obs.intent,
        assertion_ids: obs.assertions.map((a) => a.id),
        assertion_revisions: obs.assertions.map((a) => a.revision),
        evidence_ids: obs.evidence.map((e) => e.id),
        evidence_revisions: obs.evidence.map((e) => e.revision),
      },
      expiresInDays: EXPANSION_BOUNDS.frontierLifetimeDays,
      expiresAt: obs.expiresAtCap ?? undefined,
    });
    if (upserted.created) counts.frontierCreated++;
    else counts.frontierDeduped++;
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

  for (const obs of ranked) {
    const meta = nodeMeta.get(obs.nodeId);
    obs.candidateName = meta?.canonical_name ?? '';
    const item = meta?.cultural_reference_id ? itemByReference.get(meta.cultural_reference_id) : undefined;
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

  // --- Complete the run record --------------------------------------------------------
  await tx.query(`UPDATE graph_runs SET budget = $3, updated_at = now() WHERE id = $1 AND owner_account_id = $2`, [
    run.id,
    accountId,
    JSON.stringify({
      source: 'expansion',
      bounds: EXPANSION_BOUNDS,
      ranking_policy_version: RANKING_POLICY_VERSION,
      grammar_version: GRAPH_PATH_GRAMMAR_VERSION,
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

// --- Root resolution --------------------------------------------------------------------

async function graphStateFence(tx: Queryable, accountId: string): Promise<{ inputProjectionRevision: number; inputGeneration: number }> {
  const { rows } = await tx.query<{ projection_revision: number; deletion_generation: number }>(
    'SELECT projection_revision, deletion_generation FROM personal_graph_state WHERE owner_account_id = $1',
    [accountId],
  );
  return { inputProjectionRevision: rows[0]?.projection_revision ?? 0, inputGeneration: rows[0]?.deletion_generation ?? 0 };
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

  // Active shared identities for every cultural reference in play.
  const photoReferenceIds = snapshot.captures.flatMap((c) => c.references.map((r) => r.referenceId));
  const edgeReferenceIds = edges.rows.map((e) => e.reference_id).filter((v): v is string => v != null);
  const nodeByReference = await nodesByReference(tx, [...new Set([...edgeReferenceIds, ...photoReferenceIds])]);

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

async function nodesByReference(tx: Queryable, referenceIds: readonly string[]): Promise<Map<string, string>> {
  if (referenceIds.length === 0) return new Map();
  const { rows } = await tx.query<{ cultural_reference_id: string; id: string }>(
    `SELECT cultural_reference_id, id FROM graph_nodes
      WHERE cultural_reference_id = ANY($1::uuid[]) AND status = 'active'`,
    [[...referenceIds]],
  );
  return new Map(rows.map((r) => [r.cultural_reference_id, r.id]));
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
