import { AppError } from '../errors';
import type { Queryable } from '../db/pool';
import {
  GRAPH_FRONTIER_MAX_LIFETIME_DAYS,
  type GraphOutboxRow,
  type GraphProviderQueryRow,
  type GraphRecommendationRow,
  type GraphRunKind,
  type GraphRunRow,
  type PersonalInterestEdgeRow,
  type PersonalInterestSupportOrigin,
  type PersonalInterestSupportRow,
  type ProofDependency,
  type RecommendationGraphProofRow,
} from './schema';

/**
 * Typed, account-scoped writers and readers for the interest graph (PR 8
 * package A). Every function takes the owning account explicitly, resolves
 * cross-owner ids non-disclosing (not_found, never 403), and leans on the
 * composite foreign keys of migrations 210-250 as the last line of defense.
 *
 * These are contract-level operations for the schema slice: projection,
 * expansion and research behavior is built on them by later PR 8 packages
 * under their own flags (all default off).
 */

// --- Graph runs ------------------------------------------------------------------

export interface CreateGraphRunInput {
  ownerAccountId: string;
  runKind: GraphRunKind;
  /** PR 8 policy version that governs the run's decisions. */
  policyVersion: string;
  jobId?: string;
  inputTasteRevision?: number;
  inputProjectionRevision?: number;
  inputGeneration?: number;
  budget?: Record<string, unknown>;
}

export async function createGraphRun(db: Queryable, input: CreateGraphRunInput): Promise<GraphRunRow> {
  const { rows } = await db.query<GraphRunRow>(
    `INSERT INTO graph_runs (owner_account_id, job_id, run_kind, input_taste_revision,
                              input_projection_revision, input_generation, policy_version, budget)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, owner_account_id, job_id, run_kind, input_taste_revision, input_projection_revision,
               input_generation, policy_version, budget, state, published, started_at, finished_at,
               created_at, updated_at`,
    [
      input.ownerAccountId,
      input.jobId ?? null,
      input.runKind,
      input.inputTasteRevision ?? 0,
      input.inputProjectionRevision ?? 0,
      input.inputGeneration ?? 0,
      input.policyVersion,
      JSON.stringify(input.budget ?? {}),
    ],
  );
  return rows[0]!;
}

export async function graphRunForOwner(
  db: Queryable,
  input: { runId: string; ownerAccountId: string },
): Promise<GraphRunRow | null> {
  const { rows } = await db.query<GraphRunRow>(
    `SELECT id, owner_account_id, job_id, run_kind, input_taste_revision, input_projection_revision,
            input_generation, policy_version, budget, state, published, started_at, finished_at,
            created_at, updated_at
       FROM graph_runs WHERE id = $1 AND owner_account_id = $2`,
    [input.runId, input.ownerAccountId],
  );
  return rows[0] ?? null;
}

/**
 * Owner-scoped run lookup that fails closed with a non-disclosing not_found.
 * Storage method is not provenance: callers never use run existence to leak
 * another account's private state.
 */
export async function requireGraphRunForOwner(
  db: Queryable,
  input: { runId: string; ownerAccountId: string; kinds?: readonly GraphRunKind[] },
): Promise<GraphRunRow> {
  const run = await graphRunForOwner(db, input);
  if (!run) throw new AppError('not_found', { message: 'Graph run not found.' });
  if (input.kinds && !input.kinds.includes(run.run_kind)) {
    throw new AppError('invalid_input', { message: 'This graph run cannot own that record.' });
  }
  return run;
}

export async function setGraphRunState(
  db: Queryable,
  input: { runId: string; ownerAccountId: string; state: GraphRunRow['state']; published?: boolean },
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE graph_runs
        SET state = $3,
            published = COALESCE($4, published),
            started_at = CASE WHEN $3 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
            finished_at = CASE WHEN $3 IN ('complete', 'failed', 'cancelled') THEN now() ELSE finished_at END,
            updated_at = now()
      WHERE id = $1 AND owner_account_id = $2`,
    [input.runId, input.ownerAccountId, input.state, input.published ?? null],
  );
  if (rowCount === 0) throw new AppError('not_found', { message: 'Graph run not found.' });
}

/**
 * The latest successfully published compatible run for an account. Newer
 * queued/running/failed runs never replace the last success (PR 8 §Feed).
 */
export async function latestPublishedGraphRun(db: Queryable, accountId: string): Promise<GraphRunRow | null> {
  const { rows } = await db.query<GraphRunRow>(
    `SELECT id, owner_account_id, job_id, run_kind, input_taste_revision, input_projection_revision,
            input_generation, policy_version, budget, state, published, started_at, finished_at,
            created_at, updated_at
       FROM graph_runs
      WHERE owner_account_id = $1 AND state = 'complete' AND published
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [accountId],
  );
  return rows[0] ?? null;
}

// --- Projection outbox -----------------------------------------------------------

export interface EnqueueGraphOutboxEventInput {
  ownerAccountId: string;
  eventType: GraphOutboxRow['event_type'];
  logicalEventKey: string;
  targetTasteRevision: number;
  jobIntent: GraphOutboxRow['job_intent'];
  targetGeneration?: number;
  payload?: Record<string, unknown>;
}

/**
 * Upserts the durable projection intent. A burst of mutations that land on the
 * same effective taste revision collapses into one row (the newest intent
 * wins); a newer revision is a new durable row. Analysis-dependency intents can
 * legitimately land on an already-dispatched/processed (owner, key, revision)
 * row — a correction and the activation of its replacement share one revision —
 * so the conflict RE-ARMS the row as pending: the newest intent is never lost,
 * and replay is safe because dispatch is at-least-once and projection rebuilds
 * from current authoritative state.
 */
export async function enqueueGraphOutboxEvent(db: Queryable, input: EnqueueGraphOutboxEventInput): Promise<GraphOutboxRow> {
  const { rows } = await db.query<GraphOutboxRow>(
    `INSERT INTO graph_outbox (owner_account_id, event_type, logical_event_key, target_taste_revision,
                               target_generation, job_intent, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_account_id, logical_event_key, target_taste_revision)
     DO UPDATE SET event_type = EXCLUDED.event_type,
                  job_intent = EXCLUDED.job_intent,
                  target_generation = EXCLUDED.target_generation,
                  payload = EXCLUDED.payload,
                  dispatch_state = 'pending',
                  dispatched_at = NULL,
                  processed_at = NULL
     RETURNING id, owner_account_id, event_type, logical_event_key, target_taste_revision, target_generation,
               job_intent, payload, dispatch_state, attempts, created_at, dispatched_at, processed_at`,
    [
      input.ownerAccountId,
      input.eventType,
      input.logicalEventKey,
      input.targetTasteRevision,
      input.targetGeneration ?? 0,
      input.jobIntent,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return rows[0]!;
}

export async function pendingGraphOutboxEvents(
  db: Queryable,
  input: { ownerAccountId?: string; limit: number },
): Promise<GraphOutboxRow[]> {
  const ownerFilter = input.ownerAccountId ? 'AND owner_account_id = $2' : '';
  const { rows } = await db.query<GraphOutboxRow>(
    `SELECT id, owner_account_id, event_type, logical_event_key, target_taste_revision, target_generation,
            job_intent, payload, dispatch_state, attempts, created_at, dispatched_at, processed_at
       FROM graph_outbox
      WHERE dispatch_state = 'pending' ${ownerFilter}
      ORDER BY created_at, id
      LIMIT $1`,
    input.ownerAccountId ? [input.limit, input.ownerAccountId] : [input.limit],
  );
  return rows;
}

/** Marks events dispatched (idempotent: only pending rows transition). */
export async function markGraphOutboxDispatched(db: Queryable, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE graph_outbox
        SET dispatch_state = 'dispatched', dispatched_at = now(), attempts = attempts + 1
      WHERE id = ANY($1::uuid[]) AND dispatch_state = 'pending'`,
    [ids],
  );
}

// --- Personal edges and support ---------------------------------------------------

export interface UpsertPersonalEdgeInput {
  ownerAccountId: string;
  /** Exactly one target form: a shared identity or one of the account's items. */
  target: { kind: 'node'; nodeId: string } | { kind: 'item'; discoveryItemId: string };
  origin: 'explicit' | 'derived';
  policyVersion: string;
  strength?: number;
}

/**
 * Upserts one private edge per owner target. An explicit contribution confirms
 * the edge (until withdrawn through the existing save/pick controls); a derived
 * contribution never confirms anything and never downgrades an existing state.
 */
export async function upsertPersonalEdge(db: Queryable, input: UpsertPersonalEdgeInput): Promise<PersonalInterestEdgeRow> {
  const state = input.origin === 'explicit' ? 'confirmed' : 'tentative';
  const select = `id, owner_account_id, node_id, discovery_item_id, origin, state, strength, support_summary,
                  policy_version, revision, first_supported_at, last_supported_at, created_at, updated_at`;
  if (input.target.kind === 'node') {
    const { rows } = await db.query<PersonalInterestEdgeRow>(
      `INSERT INTO personal_interest_edges (owner_account_id, node_id, origin, state, policy_version, strength)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_account_id, node_id) WHERE node_id IS NOT NULL
       DO UPDATE SET updated_at = now(),
                     last_supported_at = now(),
                     revision = personal_interest_edges.revision + 1,
                     origin = CASE WHEN personal_interest_edges.origin = 'explicit' OR EXCLUDED.origin = 'explicit'
                                   THEN 'explicit' ELSE personal_interest_edges.origin END,
                     state = CASE WHEN EXCLUDED.origin = 'explicit' THEN 'confirmed' ELSE personal_interest_edges.state END
       RETURNING ${select}`,
      [input.ownerAccountId, input.target.nodeId, input.origin, state, input.policyVersion, input.strength ?? null],
    );
    return rows[0]!;
  }
  const { rows } = await db.query<PersonalInterestEdgeRow>(
    `INSERT INTO personal_interest_edges (owner_account_id, discovery_item_id, origin, state, policy_version, strength)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_account_id, discovery_item_id) WHERE discovery_item_id IS NOT NULL
     DO UPDATE SET updated_at = now(),
                   last_supported_at = now(),
                   revision = personal_interest_edges.revision + 1,
                   origin = CASE WHEN personal_interest_edges.origin = 'explicit' OR EXCLUDED.origin = 'explicit'
                                 THEN 'explicit' ELSE personal_interest_edges.origin END,
                   state = CASE WHEN EXCLUDED.origin = 'explicit' THEN 'confirmed' ELSE personal_interest_edges.state END
     RETURNING ${select}`,
    [input.ownerAccountId, input.target.discoveryItemId, input.origin, state, input.policyVersion, input.strength ?? null],
  );
  return rows[0]!;
}

export interface AddEdgeSupportInput {
  ownerAccountId: string;
  edgeId: string;
  originKind: PersonalInterestSupportOrigin;
  savedItemId?: string;
  pickId?: string;
  captureId?: string;
  analysisId?: string;
  captureReferenceId?: string;
  originatingEventId?: string;
  dependencyVersions?: Record<string, unknown>;
  weight?: number;
}

/**
 * Adds one named, owner-scoped support contribution. The composite foreign
 * keys of migration 230 reject cross-account sources at the database level;
 * the writer passes them straight through to that guarantee.
 */
export async function addEdgeSupport(
  db: Queryable,
  input: AddEdgeSupportInput,
): Promise<PersonalInterestSupportRow> {
  const { rows } = await db.query<PersonalInterestSupportRow>(
    `INSERT INTO personal_interest_support (owner_account_id, edge_id, origin_kind, saved_item_id, pick_id,
                                            capture_id, analysis_id, capture_reference_id, originating_event_id,
                                            dependency_versions, weight)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, owner_account_id, edge_id, origin_kind, saved_item_id, pick_id, capture_id, analysis_id,
               capture_reference_id, originating_event_id, dependency_versions, weight, active, created_at, updated_at`,
    [
      input.ownerAccountId,
      input.edgeId,
      input.originKind,
      input.savedItemId ?? null,
      input.pickId ?? null,
      input.captureId ?? null,
      input.analysisId ?? null,
      input.captureReferenceId ?? null,
      input.originatingEventId ?? null,
      JSON.stringify(input.dependencyVersions ?? {}),
      input.weight ?? null,
    ],
  );
  return rows[0]!;
}

// --- Frontier ----------------------------------------------------------------------

export interface UpsertFrontierCandidateInput {
  ownerAccountId: string;
  runId: string;
  nodeId: string;
  dedupeKey: string;
  expiresInDays: number;
  intent?: 'expansion' | 'research';
  supportRootIds?: readonly string[];
  score?: number;
}

export interface FrontierUpsertResult {
  created: boolean;
  row: {
    id: string;
    owner_account_id: string;
    run_id: string;
    node_id: string;
    intent: 'expansion' | 'research';
    support_root_ids: string[];
    state: string;
    score: number | null;
    dedupe_key: string;
    expires_at: Date;
    created_at: Date;
  };
}

/**
 * Upserts a candidate: canonical candidates deduplicate per account within the
 * seven-day lifetime window, so refreshes never inflate the frontier.
 */
export async function upsertFrontierCandidate(db: Queryable, input: UpsertFrontierCandidateInput): Promise<FrontierUpsertResult> {
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > GRAPH_FRONTIER_MAX_LIFETIME_DAYS) {
    throw new AppError('invalid_input', {
      message: `Frontier candidates expire within ${GRAPH_FRONTIER_MAX_LIFETIME_DAYS} days.`,
    });
  }
  const run = await requireGraphRunForOwner(db, {
    runId: input.runId,
    ownerAccountId: input.ownerAccountId,
    kinds: input.intent === 'research' ? ['research'] : ['expansion'],
  });
  const { rows } = await db.query<FrontierUpsertResult['row'] & { created: boolean }>(
    `INSERT INTO graph_frontier (owner_account_id, run_id, node_id, intent, support_root_ids, dedupe_key, score, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8))
     ON CONFLICT (owner_account_id, dedupe_key) DO UPDATE SET updated_at = now()
     RETURNING id, owner_account_id, run_id, node_id, intent, support_root_ids, state, score, dedupe_key,
               expires_at, created_at, (xmax = 0) AS created`,
    [
      input.ownerAccountId,
      run.id,
      input.nodeId,
      input.intent ?? 'expansion',
      input.supportRootIds ?? [],
      input.dedupeKey,
      input.score ?? null,
      input.expiresInDays,
    ],
  );
  const { created, ...row } = rows[0]!;
  return { created, row };
}

// --- Graph-parented recommendations and provider queries ----------------------------

export interface InsertGraphRecommendationInput {
  ownerAccountId: string;
  runId: string;
  discoveryItemId: string;
  origin: GraphRecommendationRow['origin'];
  title: string;
  rank?: number;
  providerQueryIds?: readonly string[];
  sourceIds?: readonly string[];
  externalIds?: Record<string, unknown>;
  displayReason?: string;
}

/**
 * Writes a recommendation under its graph-run parent. Only expansion runs own
 * cards, and the discovery item must belong to the same account: the writer
 * checks both and the composite foreign keys of migration 240 enforce them
 * again at the database. Real origins only; there is no 'graph' origin.
 */
export async function insertGraphRecommendation(
  db: Queryable,
  input: InsertGraphRecommendationInput,
): Promise<GraphRecommendationRow> {
  await requireGraphRunForOwner(db, {
    runId: input.runId,
    ownerAccountId: input.ownerAccountId,
    kinds: ['expansion'],
  });
  const item = await db.query<{ id: string }>(
    'SELECT id FROM discovery_items WHERE id = $1 AND owner_account_id = $2',
    [input.discoveryItemId, input.ownerAccountId],
  );
  if (item.rows.length === 0) throw new AppError('not_found', { message: 'Discovery item not found.' });
  const { rows } = await db.query<GraphRecommendationRow>(
    `INSERT INTO recommendations (discovery_item_id, title, origin, rank, provider_query_ids, source_ids,
                                   external_ids, display_reason, graph_run_id, owner_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, owner_account_id, graph_run_id, discovery_item_id, origin, title, rank, created_at`,
    [
      input.discoveryItemId,
      input.title,
      input.origin,
      input.rank ?? 0,
      input.providerQueryIds ?? [],
      input.sourceIds ?? [],
      JSON.stringify(input.externalIds ?? {}),
      input.displayReason ?? null,
      input.runId,
      input.ownerAccountId,
    ],
  );
  return rows[0]!;
}

export interface RecordGraphProviderQueryInput {
  ownerAccountId: string;
  runId: string;
  provider: GraphProviderQueryRow['provider'];
  operation: string;
  sanitizedRequest: Record<string, unknown>;
  results?: unknown;
  status?: 'ok' | 'empty' | 'error';
  errorCode?: string;
  traceId?: string;
}

/**
 * Records a sanitized provider call under its graph-run parent. Expansion and
 * research runs own provider queries; projection runs make no provider calls.
 */
export async function recordGraphProviderQuery(
  db: Queryable,
  input: RecordGraphProviderQueryInput,
): Promise<GraphProviderQueryRow> {
  await requireGraphRunForOwner(db, {
    runId: input.runId,
    ownerAccountId: input.ownerAccountId,
    kinds: ['expansion', 'research'],
  });
  const { rows } = await db.query<GraphProviderQueryRow>(
    `INSERT INTO provider_queries (provider, operation, sanitized_request, results, status, error_code,
                                   trace_id, graph_run_id, owner_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, owner_account_id, graph_run_id, provider, operation, retrieved_at AS created_at`,
    [
      input.provider,
      input.operation,
      JSON.stringify(input.sanitizedRequest),
      input.results === undefined ? null : JSON.stringify(input.results),
      input.status ?? 'ok',
      input.errorCode ?? null,
      input.traceId ?? null,
      input.runId,
      input.ownerAccountId,
    ],
  );
  return rows[0]!;
}

// --- Proofs --------------------------------------------------------------------------

export interface InsertRecommendationProofInput {
  ownerAccountId: string;
  recommendationId: string;
  graphRunId: string;
  /** Personal-root or photo-root intent; the two are never conflated. */
  intent: 'personal' | 'photo';
  reasonTemplate: string;
  reasonTemplateVersion?: string;
  assertions?: readonly ProofDependency[];
  evidence?: readonly ProofDependency[];
  supportEdgeIds?: readonly string[];
}

/**
 * Pins the exact assertion/evidence revisions and private support behind one
 * recommendation of one run. The proof is composite-bound to the
 * recommendation's own graph parent and the owning account.
 */
export async function insertRecommendationProof(
  db: Queryable,
  input: InsertRecommendationProofInput,
): Promise<RecommendationGraphProofRow> {
  const rec = await db.query<{ id: string; graph_run_id: string }>(
    'SELECT id, graph_run_id FROM recommendations WHERE id = $1 AND graph_run_id = $2 AND owner_account_id = $3',
    [input.recommendationId, input.graphRunId, input.ownerAccountId],
  );
  if (rec.rows.length === 0) throw new AppError('not_found', { message: 'Recommendation not found.' });
  const { rows } = await db.query<RecommendationGraphProofRow>(
    `INSERT INTO recommendation_graph_proofs (owner_account_id, recommendation_id, graph_run_id, proof_version,
                                              assertion_ids, assertion_revisions, evidence_ids, evidence_revisions,
                                              support_edge_ids, intent, reason_template, reason_template_version)
     VALUES ($1, $2, $3,
             (SELECT COALESCE(MAX(proof_version), 0) + 1 FROM recommendation_graph_proofs
               WHERE recommendation_id = $2),
             $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, owner_account_id, recommendation_id, graph_run_id, proof_version, assertion_ids,
               assertion_revisions, evidence_ids, evidence_revisions, support_edge_ids, intent, reason_template,
               reason_template_version, validity_state, invalidated_at, created_at, updated_at`,
    [
      input.ownerAccountId,
      input.recommendationId,
      input.graphRunId,
      (input.assertions ?? []).map((a) => a.id),
      (input.assertions ?? []).map((a) => a.revision),
      (input.evidence ?? []).map((e) => e.id),
      (input.evidence ?? []).map((e) => e.revision),
      input.supportEdgeIds ?? [],
      input.intent,
      input.reasonTemplate,
      input.reasonTemplateVersion ?? 'reason-1',
    ],
  );
  return rows[0]!;
}

// --- Owner-joined readers ---------------------------------------------------------------

export interface GraphRunCards {
  recommendations: GraphRecommendationRow[];
  providerQueries: GraphProviderQueryRow[];
  proofs: RecommendationGraphProofRow[];
}

/**
 * Owner-joined read of every graph-parented card, provider query and proof:
 * both the run and the row itself must carry the account. Cross-owner ids
 * simply never appear (non-disclosing).
 */
export async function loadGraphRunCards(db: Queryable, owner: { accountId: string }): Promise<GraphRunCards> {
  const recommendations = await db.query<GraphRecommendationRow>(
    `SELECT r.id, r.owner_account_id, r.graph_run_id, r.discovery_item_id, r.origin, r.title, r.rank, r.created_at
       FROM recommendations r
       JOIN graph_runs gr ON gr.id = r.graph_run_id
      WHERE gr.owner_account_id = $1 AND r.owner_account_id = $1
      ORDER BY r.created_at DESC, r.id`,
    [owner.accountId],
  );
  const providerQueries = await db.query<GraphProviderQueryRow>(
    `SELECT q.id, q.owner_account_id, q.graph_run_id, q.provider, q.operation, q.retrieved_at AS created_at
       FROM provider_queries q
       JOIN graph_runs gr ON gr.id = q.graph_run_id
      WHERE gr.owner_account_id = $1 AND q.owner_account_id = $1
      ORDER BY q.retrieved_at DESC, q.id`,
    [owner.accountId],
  );
  const proofs = await db.query<RecommendationGraphProofRow>(
    `SELECT p.id, p.owner_account_id, p.recommendation_id, p.graph_run_id, p.proof_version, p.assertion_ids,
            p.assertion_revisions, p.evidence_ids, p.evidence_revisions, p.support_edge_ids, p.intent,
            p.reason_template, p.reason_template_version, p.validity_state, p.invalidated_at, p.created_at, p.updated_at
       FROM recommendation_graph_proofs p
       JOIN graph_runs gr ON gr.id = p.graph_run_id
      WHERE p.owner_account_id = $1 AND gr.owner_account_id = $1
      ORDER BY p.created_at DESC, p.id`,
    [owner.accountId],
  );
  return {
    recommendations: recommendations.rows,
    providerQueries: providerQueries.rows,
    proofs: proofs.rows,
  };
}

// --- Cleanup --------------------------------------------------------------------------

export interface PurgedGraphStateCounts {
  recommendationGraphProofs: number;
  graphFrontier: number;
  personalInterestSupport: number;
  personalInterestEdges: number;
  personalEdgeSuppressions: number;
  graphPrivateLinks: number;
  graphOutbox: number;
  personalGraphState: number;
  recommendations: number;
  providerQueries: number;
  graphRuns: number;
}

/**
 * Purges every private graph row one account owns, including its
 * graph-parented cards, queries, proofs and frontier, without touching any
 * other account or shared cultural identity. Account deletion also cascades
 * the same rows (migration 230/240 foreign keys); this is the explicit,
 * countable path for fenced cleanup.
 */
export async function purgeAccountGraphState(db: Queryable, accountId: string): Promise<PurgedGraphStateCounts> {
  const count = async (sql: string): Promise<number> => {
    const { rowCount } = await db.query(sql, [accountId]);
    return rowCount ?? 0;
  };
  const counts: PurgedGraphStateCounts = {
    recommendationGraphProofs: await count('DELETE FROM recommendation_graph_proofs WHERE owner_account_id = $1'),
    graphFrontier: await count('DELETE FROM graph_frontier WHERE owner_account_id = $1'),
    personalInterestSupport: await count('DELETE FROM personal_interest_support WHERE owner_account_id = $1'),
    personalInterestEdges: await count('DELETE FROM personal_interest_edges WHERE owner_account_id = $1'),
    personalEdgeSuppressions: await count('DELETE FROM personal_edge_suppressions WHERE owner_account_id = $1'),
    graphPrivateLinks: await count('DELETE FROM graph_private_links WHERE owner_account_id = $1'),
    graphOutbox: await count('DELETE FROM graph_outbox WHERE owner_account_id = $1'),
    personalGraphState: await count('DELETE FROM personal_graph_state WHERE owner_account_id = $1'),
    recommendations: await count(
      'DELETE FROM recommendations WHERE graph_run_id IS NOT NULL AND owner_account_id = $1',
    ),
    providerQueries: await count(
      'DELETE FROM provider_queries WHERE graph_run_id IS NOT NULL AND owner_account_id = $1',
    ),
    graphRuns: await count('DELETE FROM graph_runs WHERE owner_account_id = $1'),
  };
  return counts;
}
