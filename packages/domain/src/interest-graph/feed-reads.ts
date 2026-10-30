import type { Queryable } from '../db/pool';
import type { RecommendationOrigin } from '../enums';
import type { DomainConfig } from '../config';
import { ownerPredicate, type Owner } from '../principal';
import { discoveryEnabledForAccount, type DiscoveryGateConfig } from './expansion';
import { latestPublishedGraphRun } from './store';
import { pinnedAssertionJustification, scopedRecommendationServingVerdicts } from './validity';

/**
 * READ-side integration of graph runs into the feed and the photo capture
 * page (feature feed-proof-snapshot-integration; VAL-FEED-002/VAL-FEED-004
 * and the VAL-EVID-004 read half).
 *
 * The pool only ever admits the LATEST successful compatible run's cards
 * (never a newer queued/running/failed/unpublished run) — but SERVING a
 * position of any snapshot is decided per recommendation against CURRENT
 * authority, exactly like the publication fence decides per observation:
 *
 *  - a graph-run recommendation serves only while its latest pinned proof
 *    currently holds (fresh pinned-dependency revalidation: retraction,
 *    natural evidence/rights expiry and revision drift all withdraw it) AND
 *    the private support it rests on is still live — its pinned support edges
 *    present in a live state (removal or suppression withdraws the card) and,
 *    for a photo card, an ACTIVE capture-reference support row on one of them
 *    that still belongs to the capture's CURRENT active analysis, so capture
 *    deletion/correction withdraws it immediately;
 *  - a scoped Discover-more recommendation serves its reason only while its
 *    pinned scoped proof holds — NOT flag-gated, like scoped-reads: a
 *    published reason must never silently outlive the evidence it rested on;
 *  - graph-run recommendations are flag-gated at READ time: a graph-off
 *    account (rollback) filters graph-only pool members and graph reasons
 *    from its legacy reads, while its legacy pool stays byte-identical.
 *
 * The verdict engine batches the pinned-dependency revalidation over a whole
 * page (one evidence query, one assertion-state query, memoized per-assertion
 * justification, batched support queries) while keeping the exact failure
 * semantics of `revalidatePinnedDependencies`.
 */

// --- Read gate ------------------------------------------------------------------------

export interface FeedGraphReadGate {
  /** The account's graph discovery is live at READ time (flags + kills). */
  enabled: boolean;
  /** The latest COMPLETE, published expansion run (null when none exists). */
  runId: string | null;
}

/**
 * The graph read gate for feed/photo reads: the account's discovery gate AND
 * the latest successful compatible run. Cheap when the config is off —
 * `discoveryEnabledForAccount` short-circuits before any query.
 */
export async function feedGraphReadGate(
  db: Queryable,
  input: { accountId: string; config: DiscoveryGateConfig },
): Promise<FeedGraphReadGate> {
  if (!(await discoveryEnabledForAccount(db, input))) return { enabled: false, runId: null };
  const run = await latestPublishedGraphRun(db, input.accountId);
  return { enabled: true, runId: run?.id ?? null };
}

// --- Graph proof serving verdicts -----------------------------------------------------

export interface GraphServingVerdict {
  serves: boolean;
  reason: string | null;
}

interface ProofRow {
  recommendation_id: string;
  validity_state: 'valid' | 'invalid' | 'revoked' | 'superseded';
  assertion_ids: string[];
  assertion_revisions: number[];
  evidence_ids: string[];
  evidence_revisions: number[];
  intent: 'personal' | 'photo';
  /** The owner-bound mirror rows (the enforced dependency set). */
  support_edge_ids: string[];
  /** The durable publication record (what the proof rested on at insert). */
  pinned_support_edge_ids: string[] | null;
}

/** Live (present, non-suppressed) pinned support edge ids for one owner. */
async function liveEdgeIds(db: Queryable, ownerAccountId: string, edgeIds: readonly string[]): Promise<Set<string>> {
  if (edgeIds.length === 0) return new Set();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM personal_interest_edges
      WHERE owner_account_id = $1 AND id = ANY($2::uuid[]) AND state IN ('confirmed','tentative')`,
    [ownerAccountId, [...new Set(edgeIds)]],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Pinned edges with an ACTIVE capture-reference support row that still
 * belongs to its capture's CURRENT active analysis: capture deletion and
 * correction (a new analysis going active) both withdraw the photo half.
 */
async function edgesWithActiveCaptureReferenceSupport(
  db: Queryable,
  ownerAccountId: string,
  edgeIds: readonly string[],
): Promise<Set<string>> {
  if (edgeIds.length === 0) return new Set();
  const { rows } = await db.query<{ edge_id: string }>(
    `SELECT DISTINCT edge_id FROM personal_interest_support
      WHERE owner_account_id = $1 AND active AND origin_kind = 'capture_reference' AND edge_id = ANY($2::uuid[])
        AND analysis_id = (SELECT active_analysis_id FROM captures WHERE id = personal_interest_support.capture_id)`,
    [ownerAccountId, [...new Set(edgeIds)]],
  );
  return new Set(rows.map((r) => r.edge_id));
}

/**
 * The support edges one proof rests on: the durable publication record when
 * it exists (it survives the edge's deletion, which is what makes withdrawal
 * detectable), the owner-bound mirror rows for proofs predating the record.
 */
function proofSupportEdges(proof: Pick<ProofRow, 'support_edge_ids' | 'pinned_support_edge_ids'>): string[] {
  return proof.pinned_support_edge_ids ?? proof.support_edge_ids;
}

/**
 * Whether one loaded proof's pinned private support is still live: every
 * pinned edge present in a live state (removal and suppression both end it),
 * and for a photo proof at least one pinned edge still carrying an ACTIVE
 * capture-reference support row of the capture's CURRENT active analysis
 * (capture deletion and correction both withdraw the photo half). A proof
 * that pinned no support edge makes no support-liveness claim (legacy
 * compatibility). Shared by the batched verdict engine's semantics and the
 * connection route.
 */
export async function graphProofSupportLive(
  db: Queryable,
  input: { ownerAccountId: string; edgeIds: readonly string[]; intent: 'personal' | 'photo' },
): Promise<boolean> {
  const edges = [...new Set(input.edgeIds)];
  if (edges.length === 0) return true;
  const live = await liveEdgeIds(db, input.ownerAccountId, edges);
  if (live.size !== edges.length) return false;
  if (input.intent === 'photo') {
    const withSupport = await edgesWithActiveCaptureReferenceSupport(db, input.ownerAccountId, edges);
    if (withSupport.size === 0) return false;
  }
  return true;
}

/**
 * Read-time SERVING verdicts for graph-run-parented recommendations, keyed
 * by recommendation id. One batched computation for a whole feed/photo page:
 *
 *  - the LATEST proof version of each recommendation (a graph-published card
 *    without a pinned proof cannot honestly explain itself: `proof_missing`);
 *  - a stored non-valid proof never serves (the durable invalidation record:
 *    `invalidated`/`revoked`/`superseded`);
 *  - a stored-valid proof is revalidated against CURRENT dependency versions
 *    with the exact semantics of `revalidatePinnedDependencies` — the evidence
 *    pass keeps the first concrete failure (sole-source retraction, natural
 *    evidence/rights expiry, revision drift) and requires at least one live
 *    grounding witness, then every pinned assertion must still be `validated`
 *    at its pinned revision and currently justified (assertion state batched,
 *    justification memoized per assertion id);
 *  - and the proof's pinned private support must still be live
 *    (`support_withdrawn`): every pinned edge present in a live state
 *    (removal and suppression both end it) and, for a photo proof, at least
 *    one pinned edge still carrying an ACTIVE capture-reference support row
 *    of the capture's current active analysis. A proof that pinned no
 *    support edges makes no support-liveness claim (legacy compatibility:
 *    pre-280 rows and zero-edge fixtures keep their dependency verdict).
 */
export async function graphRecommendationServingVerdicts(
  db: Queryable,
  input: { ownerAccountId: string; recommendationIds: readonly string[]; at: Date },
): Promise<Map<string, GraphServingVerdict>> {
  const out = new Map<string, GraphServingVerdict>();
  if (input.recommendationIds.length === 0) return out;
  const { rows: proofRows } = await db.query<ProofRow>(
    `SELECT DISTINCT ON (p.recommendation_id)
           p.recommendation_id, p.validity_state,
           p.assertion_ids, p.assertion_revisions, p.evidence_ids, p.evidence_revisions, p.intent,
           COALESCE(se.edges, ARRAY[]::uuid[]) AS support_edge_ids, p.pinned_support_edge_ids
      FROM recommendation_graph_proofs p
      LEFT JOIN LATERAL (
        SELECT array_agg(s.support_edge_id ORDER BY s.support_edge_id) AS edges
          FROM recommendation_graph_proof_support_edges s
         WHERE s.proof_id = p.id AND s.owner_account_id = p.owner_account_id
      ) se ON true
     WHERE p.owner_account_id = $1 AND p.recommendation_id = ANY($2::uuid[])
     ORDER BY p.recommendation_id, p.proof_version DESC`,
    [input.ownerAccountId, [...new Set(input.recommendationIds)]],
  );
  const proofByRec = new Map(proofRows.map((p) => [p.recommendation_id, p]));
  for (const recId of input.recommendationIds) {
    const proof = proofByRec.get(recId);
    if (!proof) {
      out.set(recId, { serves: false, reason: 'proof_missing' });
    } else if (proof.validity_state !== 'valid') {
      const reason = proof.validity_state === 'invalid' ? 'invalidated' : proof.validity_state;
      out.set(recId, { serves: false, reason });
    }
  }
  const candidates = proofRows.filter((p) => p.validity_state === 'valid');
  if (candidates.length === 0) return out;

  // Evidence pass: one batched query, per-proof live-witness counting with the
  // same failure precedence as revalidatePinnedDependencies (first concrete
  // failure in pinned order; zero live witnesses invalidates).
  const allEvidenceIds = [...new Set(candidates.flatMap((p) => p.evidence_ids))];
  const evidenceById = new Map<
    string,
    { revision: number; validity_state: string; expires_at: Date | null; rights_expires_at: Date | null }
  >();
  if (allEvidenceIds.length > 0) {
    const { rows } = await db.query<{
      id: string;
      revision: number;
      validity_state: string;
      expires_at: Date | null;
      rights_expires_at: Date | null;
    }>(
      `SELECT e.id, r.revision, e.validity_state, e.expires_at, r.rights_expires_at
         FROM graph_evidence e
         JOIN graph_source_revisions r ON r.id = e.source_revision_id
        WHERE e.id = ANY($1::uuid[])`,
      [allEvidenceIds],
    );
    for (const row of rows) evidenceById.set(row.id, row);
  }

  // Assertion state pass: one batched query; justification is memoized per
  // assertion id so corpus assertions shared by a page cost one lookup each.
  const allAssertionIds = [...new Set(candidates.flatMap((p) => p.assertion_ids))];
  const assertionById = new Map<string, { revision: number; status: string; invalidated_at: Date | null }>();
  if (allAssertionIds.length > 0) {
    const { rows } = await db.query<{ id: string; revision: number; status: string; invalidated_at: Date | null }>(
      'SELECT id, revision, status, invalidated_at FROM graph_assertions WHERE id = ANY($1::uuid[])',
      [allAssertionIds],
    );
    for (const row of rows) assertionById.set(row.id, row);
  }
  const justificationCache = new Map<string, string | null>();
  const justificationFor = async (assertionId: string): Promise<string | null> => {
    let cached = justificationCache.get(assertionId);
    if (cached === undefined) {
      cached = await pinnedAssertionJustification(db, { assertionId, at: input.at });
      justificationCache.set(assertionId, cached);
    }
    return cached;
  };

  // Support pass: one batched query for live edges, one for active
  // capture-reference support rows of the current active analysis. The
  // pinned set is the durable publication record (mirror rows for proofs
  // predating it), so an edge's deletion stays detectable.
  const allEdgeIds = [...new Set(candidates.flatMap((p) => proofSupportEdges(p)))];
  const [liveEdges, activeSupportEdges] = await Promise.all([
    liveEdgeIds(db, input.ownerAccountId, allEdgeIds),
    edgesWithActiveCaptureReferenceSupport(db, input.ownerAccountId, allEdgeIds),
  ]);

  for (const proof of candidates) {
    // Evidence pass (same precedence as revalidatePinnedDependencies).
    let liveEvidence = 0;
    let evidenceFailure: string | null = null;
    for (let i = 0; i < proof.evidence_ids.length; i++) {
      const current = evidenceById.get(proof.evidence_ids[i]!);
      if (!current) {
        evidenceFailure ??= 'evidence_missing';
        continue;
      }
      if (current.validity_state === 'retracted') {
        evidenceFailure ??= 'evidence_retracted';
        continue;
      }
      if (current.expires_at && current.expires_at <= input.at) {
        evidenceFailure ??= 'evidence_expired';
        continue;
      }
      if (current.rights_expires_at && current.rights_expires_at <= input.at) {
        evidenceFailure ??= 'rights_expired';
        continue;
      }
      const pinnedRevision = proof.evidence_revisions[i] ?? null;
      if (pinnedRevision != null && current.revision !== pinnedRevision) {
        evidenceFailure ??= 'evidence_revision_changed';
        continue;
      }
      liveEvidence += 1;
    }
    if (proof.evidence_ids.length > 0 && liveEvidence === 0) {
      out.set(proof.recommendation_id, { serves: false, reason: evidenceFailure ?? 'evidence_missing' });
      continue;
    }

    // Assertion pass: every pinned assertion must still hold (state batched,
    // justification memoized).
    let failed = false;
    for (let i = 0; i < proof.assertion_ids.length && !failed; i++) {
      const id = proof.assertion_ids[i]!;
      const current = assertionById.get(id);
      if (!current) {
        out.set(proof.recommendation_id, { serves: false, reason: 'assertion_missing' });
        failed = true;
        continue;
      }
      const pinnedRevision = proof.assertion_revisions[i] ?? null;
      if (pinnedRevision != null && current.revision !== pinnedRevision) {
        out.set(proof.recommendation_id, { serves: false, reason: 'assertion_revision_changed' });
        failed = true;
        continue;
      }
      if (current.status !== 'validated') {
        out.set(proof.recommendation_id, { serves: false, reason: 'assertion_not_validated' });
        failed = true;
        continue;
      }
      if (current.invalidated_at) {
        out.set(proof.recommendation_id, { serves: false, reason: 'assertion_invalidated' });
        failed = true;
        continue;
      }
      const rejection = await justificationFor(id);
      if (rejection !== null) {
        out.set(proof.recommendation_id, { serves: false, reason: rejection });
        failed = true;
      }
    }
    if (failed) continue;

    // Support pass: every pinned edge live; photo roots additionally need an
    // ACTIVE capture-reference support row of the current active analysis on
    // one of them. A proof that pinned no support edge makes no claim here.
    const edges = [...new Set(proofSupportEdges(proof))];
    if (edges.length > 0 && edges.some((id) => !liveEdges.has(id))) {
      out.set(proof.recommendation_id, { serves: false, reason: 'support_withdrawn' });
      continue;
    }
    if (proof.intent === 'photo' && edges.length > 0 && !edges.some((id) => activeSupportEdges.has(id))) {
      out.set(proof.recommendation_id, { serves: false, reason: 'support_withdrawn' });
      continue;
    }
    out.set(proof.recommendation_id, { serves: true, reason: null });
  }
  return out;
}

// --- Serving owner-context recommendations ---------------------------------------------

export interface FeedServingRecommendation {
  id: string;
  item_id: string;
  origin: RecommendationOrigin;
  display_reason: string | null;
  created_at: Date;
  parent: 'capture' | 'seed' | 'job' | 'graph_run';
  job_source: string | null;
  job_agent_started: boolean;
  job_scoped: boolean;
}

/**
 * The SERVING owner-context recommendations for the given items, newest first
 * per item. Every owner-context parent kind participates (captures' analyses,
 * taste seeds, discovery jobs — scoped proofs validated, not flag-gated —
 * and account graph runs, flag-gated and proof-validated), so a feed
 * position can be re-decided against CURRENT authority:
 *
 *  - a capture parent must still be undeleted and owner-scoped (SQL);
 *  - a scoped job's recommendation serves only while its pinned scoped proof
 *    currently holds — a retracted/expired scoped "Why this" never surfaces
 *    through feed context;
 *  - a graph-run recommendation serves only while the account's graph read is
 *    enabled (rollback filters graph output from legacy reads) and its own
 *    pinned proof + private support currently hold;
 *  - `notAfter` bounds the candidate set to recommendations that already
 *    existed when a snapshot was created, so an old cursor's context can step
 *    aside only within its own snapshot's recommendations, never to a newer
 *    run's freshly published reason.
 */
export async function feedServingRecommendations(
  db: Queryable,
  input: { owner: Owner; itemIds: readonly string[]; at: Date; graphEnabled: boolean; notAfter?: Date },
): Promise<Map<string, FeedServingRecommendation[]>> {
  const out = new Map<string, FeedServingRecommendation[]>();
  if (input.itemIds.length === 0) return out;
  const owner = input.owner;
  const own = (alias: string) => ownerPredicate(owner, alias, 2).sql;
  const isAccount = owner.kind === 'account';
  const seedOwner = isAccount ? 'ts.owner_account_id = $2' : 'false';
  const graphArm = isAccount ? `OR (r.owner_account_id = $2 AND r.graph_run_id IS NOT NULL)` : '';
  const cutoff = input.notAfter ? ' AND r.created_at <= $3' : '';
  const { rows } = await db.query<Omit<FeedServingRecommendation, 'parent'> & { parent: string }>(
    `SELECT r.id, r.discovery_item_id AS item_id, r.origin, r.display_reason, r.created_at,
            CASE
              WHEN r.analysis_id IS NOT NULL THEN 'capture'
              WHEN r.taste_seed_run_id IS NOT NULL THEN 'seed'
              WHEN r.discovery_job_id IS NOT NULL THEN 'job'
              ELSE 'graph_run'
            END AS parent,
            dj.source AS job_source,
            (dj.agent_connection_id IS NOT NULL) AS job_agent_started,
            COALESCE(dj.scoped_authority_required, false) AS job_scoped
       FROM recommendations r
       LEFT JOIN analyses a ON a.id = r.analysis_id
       LEFT JOIN captures c ON c.id = a.capture_id
       LEFT JOIN discovery_jobs dj ON dj.id = r.discovery_job_id
       LEFT JOIN taste_seed_runs ts ON ts.id = r.taste_seed_run_id
      WHERE r.discovery_item_id = ANY($1::uuid[])
        AND ((c.id IS NOT NULL AND ${own('c')} AND c.deleted_at IS NULL)
          OR (dj.id IS NOT NULL AND ${own('dj')})
          OR (ts.id IS NOT NULL AND ${seedOwner})
          ${graphArm})${cutoff}
      ORDER BY r.created_at DESC, r.id DESC`,
    input.notAfter
      ? [input.itemIds, ...ownerPredicate(owner, '', 2).params, input.notAfter]
      : [input.itemIds, ...ownerPredicate(owner, '', 2).params],
  );

  const graphRecIds = rows.filter((r) => r.parent === 'graph_run').map((r) => r.id);
  const scopedRecIds = rows.filter((r) => r.parent === 'job' && r.job_scoped).map((r) => r.id);
  const [graphVerdicts, scopedVerdicts] = await Promise.all([
    input.graphEnabled
      ? graphRecommendationServingVerdicts(db, {
          ownerAccountId: isAccount ? owner.accountId : '',
          recommendationIds: graphRecIds,
          at: input.at,
        })
      : Promise.resolve(new Map<string, GraphServingVerdict>()),
    scopedRecommendationServingVerdicts(db, { recommendationIds: scopedRecIds, at: input.at }),
  ]);

  for (const row of rows) {
    if (row.parent === 'graph_run') {
      // Flag-gated at read time (rollback filters graph output) and held to
      // its own current pinned proof + live private support.
      if (!input.graphEnabled) continue;
      if (graphVerdicts.get(row.id)?.serves !== true) continue;
    } else if (row.parent === 'job' && row.job_scoped) {
      // NOT flag-gated: a published scoped reason must never silently
      // outlive the evidence it rested on (same rule as scoped-reads). A
      // missing key is a proofless recommendation that always serves.
      if (scopedVerdicts.get(row.id) === false) continue;
    }
    const list = out.get(row.item_id) ?? [];
    list.push(row as FeedServingRecommendation);
    out.set(row.item_id, list);
  }
  return out;
}

/**
 * Whether one serving recommendation is a member of the FEED POOL arms: the
 * pool's own membership rule, mirrored for read-time re-decisions. Plans stay
 * on the plan page; agent-started discovery jobs stay on the item page;
 * but the owner's own collection-scoped provider Discover-more runs
 * (origin qloo/replay, no agent connection) remain pool members exactly as
 * the pool SQL admits them today.
 */
export function poolEligibleRecommendation(rec: FeedServingRecommendation): boolean {
  switch (rec.parent) {
    case 'capture':
    case 'seed':
    case 'graph_run':
      return true;
    case 'job':
      return (
        rec.job_source === 'music_mode' ||
        (!rec.job_agent_started && (rec.origin === 'qloo' || rec.origin === 'replay'))
      );
  }
}

// --- Photo rail ------------------------------------------------------------------------

export interface PhotoGraphRecommendation {
  itemId: string;
  canonicalKey: string;
  recommendationId: string;
  origin: RecommendationOrigin;
  displayReason: string | null;
  rank: number;
}

/**
 * The LATEST published run's photo cards for one capture, bound to the
 * capture's CURRENT active analysis: each card's pinned proof must carry the
 * photo intent with a currently-valid stored state, an ACTIVE capture-
 * reference support row of that analysis must sit on one of its pinned
 * support edges (correction/deletion withdraw it), and the item must not be
 * hidden. Fresh proof revalidation happens per loaded row, so natural expiry
 * and revision drift withdraw cards at read time as well. Graph-off accounts
 * and accounts without a published run get an empty rail (unchanged legacy
 * behavior).
 */
export async function photoGraphRecommendations(
  db: Queryable,
  input: {
    owner: Owner;
    captureId: string;
    activeAnalysisId: string;
    config: DomainConfig;
    at: Date;
  },
): Promise<PhotoGraphRecommendation[]> {
  if (input.owner.kind !== 'account') return [];
  const accountId = input.owner.accountId;
  const gate = await feedGraphReadGate(db, { accountId, config: input.config });
  if (!gate.enabled || !gate.runId) return [];
  const { rows } = await db.query<{
    item_id: string;
    canonical_key: string;
    recommendation_id: string;
    origin: RecommendationOrigin;
    display_reason: string | null;
    rank: number;
  }>(
    `SELECT r.discovery_item_id AS item_id, di.canonical_key, r.id AS recommendation_id,
            r.origin, r.display_reason, r.rank
       FROM recommendations r
       JOIN discovery_items di ON di.id = r.discovery_item_id
       JOIN graph_runs gr ON gr.id = r.graph_run_id
       JOIN LATERAL (
         SELECT p.id AS proof_id, p.intent AS intent, p.validity_state AS validity_state,
                p.pinned_support_edge_ids AS pinned_edges
           FROM recommendation_graph_proofs p
          WHERE p.recommendation_id = r.id AND p.owner_account_id = $1
          ORDER BY p.proof_version DESC LIMIT 1
       ) pr ON true
       JOIN LATERAL (
         SELECT array_agg(s.support_edge_id ORDER BY s.support_edge_id) AS edges
           FROM recommendation_graph_proof_support_edges s
          WHERE s.proof_id = pr.proof_id AND s.owner_account_id = $1
       ) se ON true
       JOIN LATERAL (
         SELECT s.edge_id
           FROM personal_interest_support s
          WHERE s.owner_account_id = $1 AND s.active AND s.origin_kind = 'capture_reference'
            AND s.capture_id = $2 AND s.analysis_id = $3
            AND s.edge_id = ANY(COALESCE(pr.pinned_edges, se.edges, ARRAY[]::uuid[]))
          LIMIT 1
       ) live ON true
      WHERE r.owner_account_id = $1 AND r.graph_run_id = $4
        AND gr.owner_account_id = $1 AND gr.state = 'complete' AND gr.published
        AND pr.intent = 'photo' AND pr.validity_state = 'valid'
        -- Hide takes effect immediately, exactly like the analysis rail.
        AND NOT EXISTS (
          SELECT 1 FROM item_exclusions x
           WHERE x.owner_account_id = $1
             AND (x.discovery_item_id = r.discovery_item_id OR x.canonical_key = di.canonical_key)
        )
      ORDER BY r.rank, r.created_at, r.id`,
    [accountId, input.captureId, input.activeAnalysisId, gate.runId],
  );
  if (rows.length === 0) return [];
  const verdicts = await graphRecommendationServingVerdicts(db, {
    ownerAccountId: accountId,
    recommendationIds: rows.map((r) => r.recommendation_id),
    at: input.at,
  });
  return rows
    .filter((r) => verdicts.get(r.recommendation_id)?.serves === true)
    .map((r) => ({
      itemId: r.item_id,
      canonicalKey: r.canonical_key,
      recommendationId: r.recommendation_id,
      origin: r.origin,
      displayReason: r.display_reason,
      rank: r.rank,
    }));
}
