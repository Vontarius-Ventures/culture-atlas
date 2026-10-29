import { z } from 'zod';
import { requireAccountOwner } from '../authz';
import type { ServiceContext } from '../context';
import type { Db, Queryable } from '../db/pool';
import { AppError, invalidInput } from '../errors';
import { INTEREST_GRAPH_POLICY_VERSION } from '../interest-graph/schema';
import { lockAccountPublicationAuthority, graphDiscoveryPausedAt, applyDiscoveryPaused } from '../interest-graph/refresh';
import { readReconciledInterestGraph } from '../interest-graph/read';
import { revalidatePinnedDependencies } from '../interest-graph/validity';
import type { AccountPrincipal } from '../principal';
import type {
  ConnectionEdge,
  ConnectionSource,
  ConnectionSupportRoot,
  InterestGraphSettings,
  InterestGraphSummaryResponse,
  InterestSummaryItem,
  RecommendationConnectionResponse,
  TentativeInterestItem,
  UpdateInterestGraphInterestResponse,
  UpdateInterestGraphSettingsResponse,
} from '../schemas/interest-graph';
import {
  InterestGraphQuery,
  UpdateInterestGraphInterestRequest,
  UpdateInterestGraphSettingsRequest,
} from '../schemas/interest-graph';
import { Uuid } from '../schemas/common';
import { iso } from '../util/time';

/**
 * Typed owner/native interest-graph controls (PR 8 package E; VAL-API-001).
 *
 * Four operations, one authority rule: the caller IS the owner. Browser owner
 * sessions reach them through the shared route contracts, native phones
 * through the four explicitly bridged operations in
 * authz/native-owner.ts (NATIVE_OWNER_V2_GRAPH_OPERATIONS), and agents are
 * refused with scope_denied — no graph scopes or MCP tools exist. There is no
 * account id to name anywhere; cross-owner ids resolve as non-disclosing
 * 404s, and the mutations share ONE optimistic revision
 * (personal_graph_state.suppression_revision) so a stale client conflicts
 * and refreshes instead of overwriting another client's control change.
 *
 * The controls drive the AUTHORITATIVE primitives, never parallel systems:
 * pause/resume is the same graph_refresh_state marker the sweeper and
 * publishers fence on, and suppress/restore writes the same owner-bound
 * personal_edge_suppressions markers the projector's rebuild sweep applies —
 * so a suppression survives rebuilds and restoration frees the edge across
 * them. Explicit (confirmed) edges are never mutated here: suppressing one
 * answers action_required because explicit interests change through the
 * existing save/pick controls.
 */

/** How long a page cursor stays valid; older copies resync instead. */
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

const PageCursor = z.strictObject({
  v: z.literal(1),
  o: z.number().int().nonnegative(),
  owner: Uuid,
  at: z.number().int().nonnegative(),
});

function revisionConflict(current: number): AppError {
  return new AppError('revision_conflict', { details: { current_revision: current } });
}

function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidInput(parsed.error);
  return parsed.data;
}

function requireUuid(id: string): string {
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) throw new AppError('not_found');
  return parsed.data;
}

function encodePageCursor(accountId: string, offset: number, now: Date): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset, owner: accountId, at: now.getTime() }), 'utf8').toString('base64url');
}

function decodePageCursor(cursor: string, accountId: string, now: Date): number {
  let parsed: z.output<typeof PageCursor>;
  try {
    parsed = PageCursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new AppError('invalid_input', { message: 'The cursor is not valid.' });
  }
  // A copied cursor from another owner never serves that owner's page.
  if (parsed.owner !== accountId) throw new AppError('invalid_input', { message: 'The cursor is not valid.' });
  if (now.getTime() - parsed.at > CURSOR_TTL_MS) {
    throw new AppError('cursor_expired', { message: 'This cursor expired. Resync the current state.' });
  }
  return parsed.o;
}

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

function paged<T>(items: readonly T[], offset: number, limit: number, accountId: string, now: Date): Page<T> {
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return { items: slice, next_cursor: next < items.length ? encodePageCursor(accountId, next, now) : null };
}

/** The owner's graph-control settings, as every response echoes back. */
async function settingsFor(db: Queryable, accountId: string, revision: number): Promise<InterestGraphSettings> {
  const pausedAt = await graphDiscoveryPausedAt(db, accountId);
  return { revision, discovery_paused: pausedAt != null, paused_at: pausedAt ? iso(pausedAt) : null };
}

/**
 * Creates (if absent) and locks the account's control-revision row. Callers
 * hold the account publication-authority lock first, mirroring the projector's
 * lock order, so a control mutation serializes with a projection pass.
 */
async function lockControlRevision(tx: Queryable, accountId: string): Promise<number> {
  await tx.query('INSERT INTO personal_graph_state (owner_account_id) VALUES ($1) ON CONFLICT DO NOTHING', [accountId]);
  const { rows } = await tx.query<{ suppression_revision: number }>(
    'SELECT suppression_revision FROM personal_graph_state WHERE owner_account_id = $1 FOR UPDATE',
    [accountId],
  );
  return rows[0]!.suppression_revision;
}

/** Bumps the shared control revision inside the caller's locked transaction. */
async function bumpControlRevision(tx: Queryable, accountId: string): Promise<number> {
  const { rows } = await tx.query<{ suppression_revision: number }>(
    `UPDATE personal_graph_state SET suppression_revision = suppression_revision + 1, updated_at = now()
      WHERE owner_account_id = $1 RETURNING suppression_revision`,
    [accountId],
  );
  return rows[0]!.suppression_revision;
}

/** The control revision without creating state (reads never write). */
async function readControlRevision(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query<{ suppression_revision: number }>(
    'SELECT suppression_revision FROM personal_graph_state WHERE owner_account_id = $1',
    [accountId],
  );
  return rows[0]?.suppression_revision ?? 0;
}

// --- GET /v2/me/interest-graph ---------------------------------------------------

/**
 * The owner's graph summary: settings, honest projection/background status
 * and the two paginated lists (confirmed explicit interests; tentative
 * derived affinities). Pure read: no provider/model calls, no writes, and
 * every row is scoped to the caller's account.
 */
export async function getInterestGraphSummary(ctx: ServiceContext, query: unknown): Promise<InterestGraphSummaryResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const input = parseBody(InterestGraphQuery, query);
  const db = ctx.db;

  const graph = await readReconciledInterestGraph(db, owner.accountId);
  const [revision, titles] = await Promise.all([
    readControlRevision(db, owner.accountId),
    db.query<{ id: string; title: string }>('SELECT id, title FROM discovery_items WHERE id = ANY($1::uuid[])', [
      graph.interests.map((i) => i.itemId),
    ]),
  ]);
  const titleByItem = new Map(titles.rows.map((r) => [r.id, r.title]));

  const interests: InterestSummaryItem[] = [...graph.interests]
    .sort((a, b) => (a.canonicalKey < b.canonicalKey ? -1 : a.canonicalKey > b.canonicalKey ? 1 : a.itemId < b.itemId ? -1 : 1))
    .map((i) => ({
      edge_id: i.edgeId,
      item_id: i.itemId,
      canonical_key: i.canonicalKey,
      kind: i.kind,
      title: titleByItem.get(i.itemId) ?? i.canonicalKey,
      origin: 'explicit' as const,
      state: 'confirmed' as const,
      saved_item_id: i.savedItemId,
      pick_ids: i.pickIds,
      capture_id: i.capturedBy?.captureId ?? null,
      analysis_id: i.capturedBy?.analysisId ?? null,
    }));

  const tentative: TentativeInterestItem[] = [...graph.derived]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.captureId < b.captureId ? -1 : 1))
    .map((d) => ({
      edge_id: d.edgeId!,
      node_id: d.nodeId!,
      name: d.name,
      relation: d.relation,
      resolution_status: d.resolutionStatus,
      is_anchor: d.isAnchor,
      origin: 'derived' as const,
      state: d.state,
      capture_id: d.captureId,
      analysis_id: d.analysisId,
      analysis_version: d.analysisVersion,
      capture_reference_id: d.captureReferenceId,
      reference_id: d.referenceId,
    }))
    .filter((d) => d.edge_id && d.node_id);

  const interestsOffset = input.interests_cursor
    ? decodePageCursor(input.interests_cursor, owner.accountId, ctx.now())
    : 0;
  const tentativeOffset = input.tentative_cursor ? decodePageCursor(input.tentative_cursor, owner.accountId, ctx.now()) : 0;

  return {
    owner_account_id: owner.accountId,
    settings: await settingsFor(db, owner.accountId, revision),
    projection: {
      state: graph.projection.state,
      support_version: graph.projection.supportVersion,
      target_taste_revision: graph.projection.targetTasteRevision,
      applied_taste_revision: graph.projection.appliedTasteRevision,
      current_taste_revision: graph.projection.currentTasteRevision,
      lagging: graph.projection.lagging,
      pending_events: graph.projection.pendingEvents,
      last_projected_at: graph.projection.lastProjectedAt,
    },
    counts: {
      confirmed: interests.length,
      tentative: tentative.filter((t) => t.state === 'tentative').length,
      suppressed: tentative.filter((t) => t.state === 'suppressed').length,
    },
    interests: paged(interests, interestsOffset, input.limit, owner.accountId, ctx.now()),
    tentative: paged(tentative, tentativeOffset, input.limit, owner.accountId, ctx.now()),
  };
}

// --- PATCH /v2/me/interest-graph/settings ------------------------------------------

/**
 * Optimistic desired-state settings mutation. Today the graph setting is the
 * background discovery pause. A retry whose desired state already holds is
 * an idempotent no-op (no bump, no conflict); a stale revision that wants a
 * DIFFERENT state is a typed revision_conflict so the client reloads instead
 * of overwriting another client's change.
 */
export async function updateInterestGraphSettings(ctx: ServiceContext, body: unknown): Promise<UpdateInterestGraphSettingsResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const input = parseBody(UpdateInterestGraphSettingsRequest, body);
  return ctx.db.transaction(async (tx) => applySettings(tx, owner, input));
}

async function applySettings(tx: Db, owner: AccountPrincipal, input: z.output<typeof UpdateInterestGraphSettingsRequest>): Promise<UpdateInterestGraphSettingsResponse> {
  // Account lock first, then the control-revision row: the projector's order,
  // so this mutation serializes with a projection pass (no deadlock either way).
  if (!(await lockAccountPublicationAuthority(tx, owner.accountId))) throw new AppError('not_found');
  const revision = await lockControlRevision(tx, owner.accountId);
  const pausedAt = await graphDiscoveryPausedAt(tx, owner.accountId);
  const current = pausedAt != null;
  if (input.discovery_paused === current) {
    // Desired state already holds (e.g. a retried request): idempotent.
    return { settings: { revision, discovery_paused: current, paused_at: pausedAt ? iso(pausedAt) : null } };
  }
  if (input.expected_revision !== revision) throw revisionConflict(revision);
  await applyDiscoveryPaused(tx, owner.accountId, input.discovery_paused);
  const next = await bumpControlRevision(tx, owner.accountId);
  return { settings: await settingsFor(tx, owner.accountId, next) };
}

// --- PATCH /v2/me/interest-graph/interests/{id} --------------------------------------

/**
 * Tentative-interest suppress/restore. Only derived (tentative) affinities
 * are controllable: the write is the durable owner-bound suppression marker
 * the projector's rebuild sweep applies, so it survives rebuilds and a
 * restoration frees the edge across them. An explicit edge answers
 * action_required (it changes through the existing save/pick controls), and
 * a foreign or missing edge id is a non-disclosing 404.
 */
export async function updateInterestGraphInterest(
  ctx: ServiceContext,
  edgeId: string,
  body: unknown,
): Promise<UpdateInterestGraphInterestResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const id = requireUuid(edgeId);
  const input = parseBody(UpdateInterestGraphInterestRequest, body);
  return ctx.db.transaction(async (tx) => applyInterestState(tx, owner, id, input));
}

async function applyInterestState(
  tx: Db,
  owner: AccountPrincipal,
  edgeId: string,
  input: z.output<typeof UpdateInterestGraphInterestRequest>,
): Promise<UpdateInterestGraphInterestResponse> {
  if (!(await lockAccountPublicationAuthority(tx, owner.accountId))) throw new AppError('not_found');
  const revision = await lockControlRevision(tx, owner.accountId);
  const { rows } = await tx.query<{ id: string; node_id: string | null; origin: string; state: string }>(
    'SELECT id, node_id, origin, state FROM personal_interest_edges WHERE id = $1 AND owner_account_id = $2',
    [edgeId, owner.accountId],
  );
  const edge = rows[0];
  if (!edge) throw new AppError('not_found');
  if (edge.origin !== 'derived' || !edge.node_id) {
    throw new AppError('action_required', {
      message: 'Confirmed interests change through saving or removing the item, not through the graph.',
    });
  }
  const { rows: markerRows } = await tx.query<{ active: boolean }>(
    'SELECT (restored_at IS NULL) AS active FROM personal_edge_suppressions WHERE owner_account_id = $1 AND node_id = $2',
    [owner.accountId, edge.node_id],
  );
  const markerActive = markerRows[0]?.active === true;
  const satisfied =
    input.state === 'suppressed' ? markerActive && edge.state === 'suppressed' : !markerActive && edge.state === 'tentative';
  if (satisfied) {
    // Desired state already holds (e.g. a retried request): idempotent.
    return {
      edge_id: edge.id,
      node_id: edge.node_id,
      state: edge.state as 'suppressed' | 'tentative',
      settings: await settingsFor(tx, owner.accountId, revision),
    };
  }
  if (input.expected_revision !== revision) throw revisionConflict(revision);
  if (input.state === 'suppressed') {
    // The marker is keyed by target identity (not edge row id), so it
    // survives rebuilds until restored; re-suppression re-arms it.
    await tx.query(
      `INSERT INTO personal_edge_suppressions (owner_account_id, node_id, policy_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_account_id, node_id)
         DO UPDATE SET restored_at = NULL, suppressed_at = now()`,
      [owner.accountId, edge.node_id, INTEREST_GRAPH_POLICY_VERSION],
    );
  } else {
    await tx.query(
      `UPDATE personal_edge_suppressions SET restored_at = now()
        WHERE owner_account_id = $1 AND node_id = $2 AND restored_at IS NULL`,
      [owner.accountId, edge.node_id],
    );
  }
  await tx.query(
    'UPDATE personal_interest_edges SET state = $3, updated_at = now() WHERE id = $1 AND owner_account_id = $2',
    [edge.id, owner.accountId, input.state],
  );
  const next = await bumpControlRevision(tx, owner.accountId);
  return {
    edge_id: edge.id,
    node_id: edge.node_id,
    state: input.state,
    settings: await settingsFor(tx, owner.accountId, next),
  };
}

// --- GET /v2/me/recommendations/{id}/connection -------------------------------------

interface OwnedRecommendation {
  id: string;
  display_reason: string | null;
  origin: RecommendationConnectionResponse['origin'];
  graph_run_id: string | null;
  source_ids: string[];
}

async function loadOwnedRecommendation(db: Queryable, accountId: string, id: string): Promise<OwnedRecommendation> {
  const { rows } = await db.query<OwnedRecommendation & { owned: boolean }>(
    `SELECT r.id, r.display_reason, r.origin, r.graph_run_id, r.source_ids,
            ((r.owner_account_id IS NOT NULL AND r.owner_account_id = $2)
              OR c.owner_account_id = $2 OR dj.owner_account_id = $2
              OR pl.owner_account_id = $2 OR ts.owner_account_id = $2) AS owned
       FROM recommendations r
       LEFT JOIN analyses a ON a.id = r.analysis_id
       LEFT JOIN captures c ON c.id = a.capture_id
       LEFT JOIN discovery_jobs dj ON dj.id = r.discovery_job_id
       LEFT JOIN plans pl ON pl.id = r.plan_id
       LEFT JOIN taste_seed_runs ts ON ts.id = r.taste_seed_run_id
      WHERE r.id = $1`,
    [id, accountId],
  );
  const row = rows[0];
  // Cross-owner ids are indistinguishable from missing ones.
  if (!row || !row.owned) throw new AppError('not_found');
  return row;
}

/** Shared assertion rows with named endpoints (public cultural facts only). */
async function loadConnectionEdges(db: Queryable, assertionIds: readonly string[]): Promise<ConnectionEdge[]> {
  if (assertionIds.length === 0) return [];
  const { rows } = await db.query<{
    predicate: ConnectionEdge['predicate'];
    association_subtype: string | null;
    subject_id: string;
    subject_name: string;
    object_id: string;
    object_name: string;
  }>(
    `SELECT a.predicate, a.association_subtype,
            s.id AS subject_id, s.canonical_name AS subject_name,
            o.id AS object_id, o.canonical_name AS object_name
       FROM graph_assertions a
       JOIN graph_nodes s ON s.id = a.subject_node_id
       JOIN graph_nodes o ON o.id = a.object_node_id
      WHERE a.id = ANY($1::uuid[])`,
    [[...assertionIds]],
  );
  return rows.slice(0, 10).map((r) => ({
    subject: { node_id: r.subject_id, name: r.subject_name },
    predicate: r.predicate,
    object: { node_id: r.object_id, name: r.object_name },
    association_subtype: r.association_subtype,
  }));
}

/** Permitted source links behind pinned evidence (url/title/publisher + bounded excerpt). */
async function loadConnectionSources(db: Queryable, evidenceIds: readonly string[]): Promise<ConnectionSource[]> {
  if (evidenceIds.length === 0) return [];
  const { rows } = await db.query<{
    id: string;
    url: string;
    title: string | null;
    publisher: string | null;
    locator: string | null;
    excerpt: string | null;
    retrieved_at: Date;
  }>(
    `SELECT ev.id, sr.url, src.title, src.publisher,
            COALESCE(sr.locator, ev.locator) AS locator,
            ev.permitted_excerpt AS excerpt, sr.retrieved_at
       FROM graph_evidence ev
       JOIN graph_source_revisions sr ON sr.id = ev.source_revision_id
       JOIN sources src ON src.id = sr.source_id
      WHERE ev.id = ANY($1::uuid[])`,
    [[...evidenceIds]],
  );
  return rows
    .slice(0, 10)
    .filter((r) => z.url().safeParse(r.url).success)
    .map((r) => ({ ...r, retrieved_at: iso(r.retrieved_at) }));
}

/** Legacy source links (the same DTO the item detail's why_this serves). */
async function loadLegacySources(db: Queryable, sourceIds: readonly string[]): Promise<ConnectionSource[]> {
  if (sourceIds.length === 0) return [];
  const { rows } = await db.query<{ id: string; url: string; title: string | null; publisher: string | null; retrieved_at: Date }>(
    'SELECT id, url, title, publisher, retrieved_at FROM sources WHERE id = ANY($1::uuid[])',
    [[...sourceIds]],
  );
  return rows
    .filter((r) => z.url().safeParse(r.url).success)
    .map((r) => ({ id: r.id, url: r.url, title: r.title, publisher: r.publisher, locator: null, excerpt: null, retrieved_at: iso(r.retrieved_at) }));
}

const SUPPORT_ORIGIN_BY_KIND = {
  saved_item: 'explicit_save',
  pick_group: 'pick_group',
  capture_reference: 'capture_reference',
  analysis: 'analysis',
} as const;

/** The owner's own current support edges behind the relevance half (no scores). */
async function loadSupportRoots(db: Queryable, accountId: string, edgeIds: readonly string[]): Promise<ConnectionSupportRoot[]> {
  if (edgeIds.length === 0) return [];
  const { rows } = await db.query<{ edge_id: string; label: string | null; origin_kind: string | null }>(
    `SELECT e.id AS edge_id,
            COALESCE(i.title, n.canonical_name, si_item.title) AS label,
            (SELECT s.origin_kind FROM personal_interest_support s
              WHERE s.edge_id = e.id AND s.active ORDER BY s.created_at LIMIT 1) AS origin_kind
       FROM personal_interest_edges e
       LEFT JOIN discovery_items i ON i.id = e.discovery_item_id
       LEFT JOIN graph_nodes n ON n.id = e.node_id
       LEFT JOIN saved_items si ON si.id = e.saved_item_id
       LEFT JOIN discovery_items si_item ON si_item.id = si.discovery_item_id
      WHERE e.owner_account_id = $1 AND e.id = ANY($2::uuid[])`,
    [accountId, [...edgeIds]],
  );
  return rows
    .filter((r) => r.origin_kind !== null)
    .slice(0, 20)
    .map((r) => ({
      edge_id: r.edge_id,
      origin: SUPPORT_ORIGIN_BY_KIND[r.origin_kind as keyof typeof SUPPORT_ORIGIN_BY_KIND] ?? 'explicit_save',
      label: r.label ?? '',
    }));
}

function unavailable(
  rec: OwnedRecommendation,
  over: { provenance: 'graph_run' | 'scoped_discovery'; intent: 'personal' | 'photo' | null; reason: string },
): RecommendationConnectionResponse {
  return {
    recommendation_id: rec.id,
    origin: rec.origin,
    provenance: over.provenance,
    state: 'unavailable',
    intent: over.intent,
    graph_run_id: rec.graph_run_id,
    // No substitution: an invalid pinned proof never serves another reason.
    reason: { text: null, template: null },
    path: null,
    sources: [],
    support: null,
    unavailable_reason: over.reason,
  };
}

/**
 * The owner's "Why this" for one recommendation. A valid pinned proof serves
 * the shared cultural path (named assertion edges), the permitted source
 * links and — for account graph runs — the owner's own current support roots;
 * an invalid pinned proof is honestly unavailable; a legacy recommendation
 * serves its actual pre-graph record and is never retroactively graph-proven.
 */
export async function getRecommendationConnection(ctx: ServiceContext, recommendationId: string): Promise<RecommendationConnectionResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const id = requireUuid(recommendationId);
  const db = ctx.db;
  const rec = await loadOwnedRecommendation(db, owner.accountId, id);

  if (rec.graph_run_id) {
    const { rows: proofs } = await db.query<{
      proof_version: number;
      assertion_ids: string[];
      assertion_revisions: number[];
      evidence_ids: string[];
      evidence_revisions: number[];
      support_edge_ids: string[];
      intent: 'personal' | 'photo';
      reason_template: string;
    }>(
      `SELECT p.proof_version, p.assertion_ids, p.assertion_revisions, p.evidence_ids, p.evidence_revisions,
              p.intent, p.reason_template,
              COALESCE(se.edges, ARRAY[]::uuid[]) AS support_edge_ids
         FROM recommendation_graph_proofs p
         LEFT JOIN (SELECT proof_id, array_agg(support_edge_id ORDER BY support_edge_id) AS edges
                      FROM recommendation_graph_proof_support_edges GROUP BY proof_id) se
           ON se.proof_id = p.id
        WHERE p.recommendation_id = $1 AND p.owner_account_id = $2
        ORDER BY p.proof_version DESC LIMIT 1`,
      [id, owner.accountId],
    );
    const proof = proofs[0];
    // A graph-published card without a pinned proof cannot honestly explain
    // itself: never fall back to the bare display reason.
    if (!proof) return unavailable(rec, { provenance: 'graph_run', intent: null, reason: 'proof_missing' });
    const verdict = await revalidatePinnedDependencies(db, {
      assertions: proof.assertion_ids.map((aid, i) => ({ id: aid, revision: proof.assertion_revisions[i]! })),
      evidence: proof.evidence_ids.map((eid, i) => ({ id: eid, revision: proof.evidence_revisions[i]! })),
      at: ctx.now(),
    });
    if (!verdict.valid) return unavailable(rec, { provenance: 'graph_run', intent: proof.intent, reason: verdict.reason ?? 'invalid' });
    const [path, sources, support] = await Promise.all([
      loadConnectionEdges(db, proof.assertion_ids),
      loadConnectionSources(db, proof.evidence_ids),
      loadSupportRoots(db, owner.accountId, proof.support_edge_ids),
    ]);
    return {
      recommendation_id: rec.id,
      origin: rec.origin,
      provenance: 'graph_run',
      state: 'connected',
      intent: proof.intent,
      graph_run_id: rec.graph_run_id,
      reason: { text: rec.display_reason, template: proof.reason_template },
      path,
      sources,
      support: { roots: support },
      unavailable_reason: null,
    };
  }

  const { rows: scopedProofs } = await db.query<{
    assertion_ids: string[];
    assertion_revisions: number[];
    evidence_ids: string[];
    evidence_revisions: number[];
    reason_template: string;
  }>(
    `SELECT assertion_ids, assertion_revisions, evidence_ids, evidence_revisions, reason_template
       FROM scoped_discovery_result_proofs
      WHERE recommendation_id = $1 AND owner_account_id = $2`,
    [id, owner.accountId],
  );
  const scoped = scopedProofs[0];
  if (scoped) {
    const verdict = await revalidatePinnedDependencies(db, {
      assertions: scoped.assertion_ids.map((aid, i) => ({ id: aid, revision: scoped.assertion_revisions[i]! })),
      evidence: scoped.evidence_ids.map((eid, i) => ({ id: eid, revision: scoped.evidence_revisions[i]! })),
      at: ctx.now(),
    });
    if (!verdict.valid) return unavailable(rec, { provenance: 'scoped_discovery', intent: null, reason: verdict.reason ?? 'invalid' });
    const [path, sources] = await Promise.all([loadConnectionEdges(db, scoped.assertion_ids), loadConnectionSources(db, scoped.evidence_ids)]);
    // Scoped admission never uses account-wide support: the granted origin
    // itself is the context, so the support half stays empty by design.
    return {
      recommendation_id: rec.id,
      origin: rec.origin,
      provenance: 'scoped_discovery',
      state: 'connected',
      intent: null,
      graph_run_id: null,
      reason: { text: rec.display_reason, template: scoped.reason_template },
      path,
      sources,
      support: null,
      unavailable_reason: null,
    };
  }

  // Legacy pre-graph record: honest origin and reason, never a fabricated
  // graph provenance (graph_run_id stays null, no path/support halves).
  return {
    recommendation_id: rec.id,
    origin: rec.origin,
    provenance: 'legacy',
    state: 'connected',
    intent: null,
    graph_run_id: null,
    reason: { text: rec.display_reason, template: null },
    path: null,
    sources: await loadLegacySources(db, rec.source_ids),
    support: null,
    unavailable_reason: null,
  };
}
