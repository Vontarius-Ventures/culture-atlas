import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';
import type { ServiceContext } from '../context';
import type { Db, PoolDb, Queryable } from '../db/pool';
import { upsertReference } from '../compiler/store';
import type { GraphNodeDomain, GraphNodeKind, GraphPredicate } from './schema';
import { accountCtx, insertCaptureWithAnalysis, insertItem, insertReference } from '../test-support/library';
import { closeTestDb, createIsolatedDatabase, getTestDb, insertAccount, testConfig, testContext } from '../testing';
import { activateAnalysis, submitCorrection } from '../services/analyses';
import { recordPreference } from '../services/preferences';
import {
  attachAssertionSupport,
  bindGraphIdentityReference,
  insertEvidence,
  mapGraphExternalId,
  recordSourceRevision,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from './evidence';
import { admitGraphCorpus } from './corpus';
import { CorpusManifestSchema, type CorpusManifest } from './corpus-manifest';
import { linkGraphReferenceIdentities } from './identity-links';
import { projectAccountInterestGraph } from './projector';
import { pauseGraphDiscovery } from './refresh';
import { createGraphRun } from './store';
import { GRAPH_EXPANSION_DEADLINE_MS } from './budgets';
import { currentAssertionJustification, retractGraphEvidence } from './validity';
import {
  EXPANSION_BOUNDS,
  GraphFenceError,
  RANKING_POLICY_VERSION,
  checkGraphPublicationFence,
  expandAccountInterestGraph,
  type ExpansionResult,
} from './expansion';

/**
 * VAL-DISC-001/002/004 (domain slice): the shared admission pipeline, the
 * versioned ranking policy and the bounded frontier for explicit-interest and
 * active-photo-reference roots.
 *
 *  - Personal-root recommendations require BOTH currently valid cultural
 *    evidence AND currently authorized private relevance; photo-root results
 *    additionally require a supported relationship to the CURRENT authorized
 *    photo reference, and strong personal appeal never rescues an unsupported
 *    photo connection (VAL-DISC-001).
 *  - Photo references never imply rich visual qualification: unresolved or
 *    visual-relation references fabricate nothing, missing analysis is honest
 *    unavailability, and private VISUALLY_RESEMBLES stays fail-closed even
 *    with the graph flags on (VAL-DISC-002).
 *  - Traversal is bounded (two approved hops, 200 assertions, 40 evaluated
 *    candidates, 500 active frontier entries/account, seven-day expiry with
 *    evidence/rights shortening), and pruning never removes confirmed
 *    interests (VAL-DISC-004).
 */

const db = getTestDb();
afterAll(closeTestDb);

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });
const projectionOnly = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

// --- Fixture helpers ------------------------------------------------------------

/** A corpus identity with a linked cultural reference (work-like by default). */
async function corpusNode(
  over: { kind?: GraphNodeKind; domain?: GraphNodeDomain; sense?: string; name?: string; withReference?: boolean } = {},
) {
  const kind = over.kind ?? 'work';
  // Every identity name is unique: the natural key is (name, kind, domain,
  // sense), so a repeated readable name would collide across tests.
  const name = `${over.name ?? kind}-${randomUUID().slice(0, 6)}`;
  const withReference = over.withReference ?? true;
  const referenceId = withReference ? await insertReference({ name }, db) : null;
  const node = await upsertGraphIdentity(db, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: name,
    nodeKind: kind,
    domain: over.domain ?? 'art',
    senseKey: over.sense ?? 'painting',
    culturalReferenceId: referenceId,
  });
  return { node, referenceId };
}

/** A bare identity (no cultural reference): fine for midpoints. */
async function plainNode(
  over: { kind?: GraphNodeKind; domain?: GraphNodeDomain; sense?: string; name?: string } = {},
) {
  return corpusNode({ ...over, withReference: false });
}

/** One reviewed evidence row (CC0 museum record), with optional expiry dates. */
async function evidence(
  dbh: PoolDb = db,
  over: { expiresAt?: Date | null; rightsExpiresAt?: Date | null } = {},
) {
  const family = `artic:${randomUUID()}`;
  const recorded = await recordSourceRevision(dbh, {
    provider: 'artic_open_access',
    url: `https://www.artic.edu/artworks/${randomUUID().slice(0, 8)}`,
    title: 'A reviewed collection record',
    publisher: 'A museum',
    attribution: 'A museum',
    license: 'CC0 1.0',
    sourceFamilyKey: family,
    allowedDisplayMetadata: { title: 'A reviewed collection record', license: 'CC0 1.0' },
    retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
    rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none' },
    documentHash: randomUUID(),
    rightsExpiresAt: over.rightsExpiresAt ?? null,
  });
  const inserted = await insertEvidence(dbh, {
    sourceRevisionId: recorded.sourceRevisionId,
    permittedExcerpt: `Reviewed support ${randomUUID().slice(0, 8)}.`,
    validationMethod: 'provider_metadata',
    validationVersion: 'test-1',
    evidenceKind: 'fact',
    reviewedBy: 'corpus review',
    reviewedAt: new Date('2026-10-28T00:00:00Z'),
    expiresAt: over.expiresAt ?? null,
  });
  return { evidenceId: inserted.row.id, revision: inserted.revision, familyKey: family };
}

/** A validated, currently justified assertion (one reviewed evidence family by default). */
async function justifiedEdge(input: {
  subject: string;
  predicate: GraphPredicate;
  object: string;
  subtype?: string | null;
  evidence?: Array<Awaited<ReturnType<typeof evidence>>>;
}) {
  const supports = input.evidence ?? [await evidence()];
  const upserted = await upsertGraphAssertion(db, {
    subjectNodeId: input.subject,
    predicate: input.predicate,
    objectNodeId: input.object,
    associationSubtype: input.subtype ?? null,
    status: 'validated',
  });
  for (const support of supports) {
    await attachAssertionSupport(db, {
      assertionId: upserted.row.id,
      evidenceId: support.evidenceId,
      derivation: 'primary',
      sourceFamilyKey: support.familyKey,
    });
  }
  // Evidence attachment versions the assertion row; pin the CURRENT revision.
  const { rows } = await db.query<{ id: string; revision: number }>(
    'SELECT id, revision FROM graph_assertions WHERE id = $1',
    [upserted.row.id],
  );
  return { assertionId: rows[0]!.id, revision: rows[0]!.revision, evidence: supports };
}

/** A saved + projected explicit personal root (an owned item on a corpus work). */
async function savedRoot(ctx: ServiceContext, accountId: string) {
  const work = await corpusNode({ kind: 'work' });
  const itemId = await insertItem({ accountId }, { referenceId: work.referenceId, kind: 'film', category: 'watch' }, db);
  await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemId });
  return { node: work.node, referenceId: work.referenceId, itemId };
}

/** An account-owned discovery item for a candidate node (publication target). */
async function candidateItem(accountId: string, referenceId: string | null): Promise<string | null> {
  if (!referenceId) return null;
  return insertItem({ accountId }, { referenceId, kind: 'film', category: 'watch' }, db);
}

/** A saved capture whose active analysis authorizes one depicted reference. */
async function photoCapture(
  ctx: ServiceContext,
  accountId: string,
  over: {
    referenceId: string;
    relation?: 'depicted' | 'resembles' | 'user_selected';
    resolution?: string;
    certainty?: number;
    anchor?: boolean;
    textOnly?: boolean;
  },
) {
  const cap = await insertCaptureWithAnalysis({ accountId }, {}, db);
  await db.query(
    `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor, text_only, read_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      cap.analysisId,
      over.referenceId,
      over.relation ?? 'depicted',
      over.certainty ?? 0.72,
      over.resolution ?? 'resolved',
      // A text-only mention is never an anchor (capture_references CHECK).
      over.anchor ?? !over.textOnly,
      over.textOnly ?? false,
      over.textOnly ? 'read from the photo caption' : null,
    ],
  );
  await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
  return cap;
}

async function project(accountId: string) {
  await projectAccountInterestGraph(db, { accountId, config: graphOn, source: 'mutation_intent' });
}

async function expand(accountId: string, at?: Date) {
  return expandAccountInterestGraph(db, { accountId, config: graphOn, at });
}

async function frontierStates(accountId: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ state: string; n: number }>(
    'SELECT state, count(*)::int AS n FROM graph_frontier WHERE owner_account_id = $1 GROUP BY state',
    [accountId],
  );
  return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
}

async function activeFrontierCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM graph_frontier WHERE owner_account_id = $1 AND state IN ('active','admitted')`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function proofRows(accountId: string) {
  const { rows } = await db.query<{ id: string; recommendation_id: string; intent: string; support_edge_ids: string[] }>(
    `SELECT id, recommendation_id, intent, COALESCE(array_agg(s.support_edge_id) FILTER (WHERE s.support_edge_id IS NOT NULL), ARRAY[]::uuid[]) AS support_edge_ids
       FROM recommendation_graph_proofs p
       LEFT JOIN recommendation_graph_proof_support_edges s ON s.proof_id = p.id AND s.owner_account_id = p.owner_account_id
      WHERE p.owner_account_id = $1
      GROUP BY p.id, p.recommendation_id, p.intent`,
    [accountId],
  );
  return rows;
}

/** The edge carrying one capture reference's projected support. */
async function captureReferenceEdge(accountId: string, captureReferenceId: string): Promise<string | null> {
  const { rows } = await db.query<{ edge_id: string }>(
    `SELECT edge_id FROM personal_interest_support
      WHERE owner_account_id = $1 AND capture_reference_id = $2 AND origin_kind = 'capture_reference' AND active
      LIMIT 1`,
    [accountId, captureReferenceId],
  );
  return rows[0]?.edge_id ?? null;
}

/** Seeds `count` active frontier entries for an account under one expansion run. */
async function seedFrontier(
  accountId: string,
  count: number,
  over: { score?: number; expiresInDays?: number } = {},
): Promise<void> {
  const node = await plainNode({ kind: 'attribute' });
  const run = await createGraphRun(db, { ownerAccountId: accountId, runKind: 'expansion', policyVersion: 'graph-policy-1' });
  await db.query(
    `INSERT INTO graph_frontier (owner_account_id, run_id, node_id, intent, dedupe_key, score, expires_at)
     SELECT $1, $2, $3, 'expansion', 'seed:' || g, $4, now() + make_interval(days => $5::int)
       FROM generate_series(1, $6::int) g`,
    [accountId, run.id, node.node.id, over.score ?? 0.05, over.expiresInDays ?? 7, count],
  );
}

// --- VAL-DISC-001: personal and photo admission remain separate -----------------

describe('shared admission (VAL-DISC-001)', () => {
  it('admits a personal-root candidate only with BOTH current cultural evidence and current private relevance', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work', name: 'Candidate work' });
    const rootEdge = await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const candidateEdge = await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const itemId = await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    const result = await expand(accountId);
    expect(result.expanded).toBe(true);
    expect(result.counts.personalRoots).toBeGreaterThanOrEqual(1);
    expect(result.counts.admitted).toBe(1);

    const admitted = result.candidates;
    expect(admitted).toHaveLength(1);
    const obs = admitted[0]!;
    expect(obs.nodeId).toBe(candidate.node.id);
    expect(obs.intent).toBe('personal');
    expect(obs.templateKey).toBe('same_creator');
    expect(obs.reason).toBe(`By the same creator (${creator.node.canonical_name})`);
    expect(obs.score).toBeCloseTo(0.8, 10);
    expect(obs.rank).toBe(1);
    // The cultural connection and the private relevance are distinct inputs.
    expect(obs.relevance).toMatchObject({ kind: 'personal', canonicalKey: expect.any(String) });
    expect(obs.supportEdgeIds).toHaveLength(1);

    // Pinned dependency rows: both walked assertions at their exact revisions,
    // in the walked root→candidate order.
    expect(obs.assertions).toEqual([
      { id: rootEdge.assertionId, revision: rootEdge.revision },
      { id: candidateEdge.assertionId, revision: candidateEdge.revision },
    ]);
    expect(obs.evidence.length).toBeGreaterThanOrEqual(2);

    // Published rows: recommendation + proof with real provenance, and the
    // proof revalidates against current dependency versions.
    expect(result.counts.recommendationsPublished).toBe(1);
    expect(result.counts.proofsPublished).toBe(1);
    expect(obs.recommendationId).not.toBeNull();
    expect(obs.proofId).not.toBeNull();
    const { rows: recRows } = await db.query<{ discovery_item_id: string; origin: string; rank: number; display_reason: string }>(
      'SELECT discovery_item_id, origin, rank, display_reason FROM recommendations WHERE id = $1',
      [obs.recommendationId],
    );
    expect(recRows[0]).toMatchObject({
      discovery_item_id: itemId,
      origin: 'catalog',
      rank: 1,
      display_reason: obs.reason,
    });
    const proofs = await proofRows(accountId);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({ intent: 'personal' });

    const frontier = await frontierStates(accountId);
    expect(frontier.published).toBe(1);
    const { rows: frontierRoots } = await db.query<{ roots: string[] }>(
      `SELECT COALESCE(array_agg(sr.root_id ORDER BY sr.root_id), ARRAY[]::uuid[]) AS roots
         FROM graph_frontier f
         JOIN graph_frontier_support_roots sr ON sr.frontier_id = f.id AND sr.owner_account_id = f.owner_account_id
        WHERE f.owner_account_id = $1`,
      [accountId],
    );
    expect(frontierRoots[0]!.roots).toEqual(obs.supportEdgeIds);
  });

  it('a stale personal root (save removed while the projection lags) is not rescued by valid cultural evidence', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    // Remove the save but DO NOT re-project: the edge still exists, the
    // authority does not. Evidence stays perfectly valid.
    await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: root.itemId });
    const justification = await currentAssertionJustification(db, { assertionId: (await db.query<{ id: string }>(
      'SELECT id FROM graph_assertions WHERE subject_node_id = $1', [candidate.node.id],
    )).rows[0]!.id });
    expect(justification.justified).toBe(true);

    const result = await expand(accountId);
    // The relevance decision is separate: the cultural evidence alone is not enough.
    expect(result.counts.stalePersonalRoots).toBe(1);
    expect(result.counts.admitted).toBe(0);
    expect(result.candidates).toHaveLength(0);
    expect(result.counts.recommendationsPublished).toBe(0);
    expect(await activeFrontierCount(accountId)).toBe(0);
    expect(await proofRows(accountId)).toHaveLength(0);
  });

  it('an unprojected save is reported honestly and admits nothing', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    // No projection: the save is authoritative but has no private support edge yet.

    const result = await expand(accountId);
    expect(result.counts.unprojectedPersonalRoots).toBe(1);
    expect(result.counts.admitted).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it('photo-root results require a supported path to the current photo reference; strong personal appeal never rescues them', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    // Two personal roots sharing a creator with the personal candidate C.
    const r1 = await savedRoot(ctx, accountId);
    const r2 = await savedRoot(ctx, accountId);
    const sharedCreator = await plainNode({ kind: 'creator', sense: 'painter' });
    const personalCandidate = await corpusNode({ kind: 'work', name: 'Personal favorite' });
    await justifiedEdge({ subject: r1.node.id, predicate: 'CREATED_BY', object: sharedCreator.node.id });
    await justifiedEdge({ subject: r2.node.id, predicate: 'CREATED_BY', object: sharedCreator.node.id });
    await justifiedEdge({ subject: personalCandidate.node.id, predicate: 'CREATED_BY', object: sharedCreator.node.id });
    await candidateItem(accountId, personalCandidate.referenceId);

    // One authorized photo reference P, connected to a DIFFERENT candidate D.
    const photo = await corpusNode({ kind: 'work', name: 'Photo subject' });
    const cap = await photoCapture(ctx, accountId, { referenceId: photo.referenceId! });
    const photoCreator = await plainNode({ kind: 'creator', sense: 'painter', name: 'Photo creator' });
    const photoCandidate = await corpusNode({ kind: 'work', name: 'Photo candidate' });
    await justifiedEdge({ subject: photo.node.id, predicate: 'CREATED_BY', object: photoCreator.node.id });
    await justifiedEdge({ subject: photoCandidate.node.id, predicate: 'CREATED_BY', object: photoCreator.node.id });
    await candidateItem(accountId, photoCandidate.referenceId);
    await project(accountId);

    const result = await expand(accountId);
    expect(result.expanded).toBe(true);
    expect(result.counts.photoRoots).toBe(1);

    const personal = result.candidates.filter((c) => c.intent === 'personal');
    const photoResults = result.candidates.filter((c) => c.intent === 'photo');
    expect(personal.map((c) => c.nodeId)).toEqual([personalCandidate.node.id]);
    // C is the globally strongest candidate (score 0.8 > D's 0.7) but has no
    // supported relationship to the photo reference: it is NOT a photo result.
    expect(photoResults.map((c) => c.nodeId)).toEqual([photoCandidate.node.id]);
    expect(personal[0]!.score).toBeGreaterThan(photoResults[0]!.score);

    // The two intents pin DIFFERENT private support: D's proof grounds on the
    // capture-reference support edge, never on the personal saves.
    const proofs = await proofRows(accountId);
    const photoProof = proofs.find((p) => p.intent === 'photo')!;
    const personalProof = proofs.find((p) => p.intent === 'personal')!;
    expect(photoProof).toBeDefined();
    expect(personalProof).toBeDefined();
    const { rows: refRows } = await db.query<{ id: string }>(
      'SELECT id FROM capture_references WHERE analysis_id = $1 AND reference_id = $2',
      [cap.analysisId, photo.referenceId],
    );
    const referenceEdge = await captureReferenceEdge(accountId, refRows[0]!.id);
    expect(referenceEdge).not.toBeNull();
    expect(photoProof.support_edge_ids).toEqual([referenceEdge]);
    expect(personalProof.support_edge_ids).not.toContain(referenceEdge);
  });

  it('rejected evidence cannot be overridden by preference, and no unsupported filler completes the rail', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const photo = await corpusNode({ kind: 'work' });
    await photoCapture(ctx, accountId, { referenceId: photo.referenceId! });
    const photoCreator = await plainNode({ kind: 'creator', sense: 'painter' });
    await justifiedEdge({ subject: photo.node.id, predicate: 'CREATED_BY', object: photoCreator.node.id });
    // An illegal composition from the photo reference: CREATED_BY forward +
    // DOCUMENTED_ASSOCIATION forward is not an approved path template. The
    // place is a "great" candidate (the user loves the place elsewhere) but
    // two valid edges alone never establish the composed claim.
    const place = await corpusNode({ kind: 'place', domain: 'interiors', sense: 'museum' });
    await justifiedEdge({
      subject: photoCreator.node.id,
      predicate: 'DOCUMENTED_ASSOCIATION',
      object: place.node.id,
      subtype: 'studied_at',
    });
    await candidateItem(accountId, place.referenceId);
    // One honest candidate through an approved template keeps the rail non-empty.
    const honestCandidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: honestCandidate.node.id, predicate: 'CREATED_BY', object: photoCreator.node.id });
    await candidateItem(accountId, honestCandidate.referenceId);
    await project(accountId);

    const result = await expand(accountId);
    expect(result.rejections.unsupported_composition).toBeGreaterThanOrEqual(1);
    expect(result.candidates.map((c) => c.nodeId)).not.toContain(place.node.id);
    expect(result.candidates.map((c) => c.nodeId)).toEqual([honestCandidate.node.id]);
    // The rejected candidate never reaches the ranker's inputs: no frontier
    // entry, no recommendation, no proof.
    const { rows: placeRows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM graph_frontier WHERE owner_account_id = $1 AND node_id = $2',
      [accountId, place.node.id],
    );
    expect(Number(placeRows[0]!.n)).toBe(0);
    const { rows: placeRecs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM recommendations r
         JOIN discovery_items di ON di.id = r.discovery_item_id
        WHERE r.owner_account_id = $1 AND di.reference_id = $2 AND r.graph_run_id IS NOT NULL`,
      [accountId, place.referenceId],
    );
    expect(Number(placeRecs[0]!.n)).toBe(0);
  });

  it('ranking is versioned and deterministic: fixed-input replay reproduces the selection', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);

    // Four same-creator candidates (one is diversified out), one technique,
    // one attribute: distinct templates, exact score ordering with ties.
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const technique = await plainNode({ kind: 'technique' });
    const attribute = await plainNode({ kind: 'attribute' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: root.node.id, predicate: 'USES_TECHNIQUE', object: technique.node.id });
    await justifiedEdge({ subject: root.node.id, predicate: 'HAS_ATTRIBUTE', object: attribute.node.id });
    const sameCreator: string[] = [];
    for (let i = 0; i < 4; i++) {
      const candidate = await corpusNode({ kind: 'work' });
      sameCreator.push(candidate.node.id);
      await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
      await candidateItem(accountId, candidate.referenceId);
    }
    const techniqueCandidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: techniqueCandidate.node.id, predicate: 'USES_TECHNIQUE', object: technique.node.id });
    await candidateItem(accountId, techniqueCandidate.referenceId);
    const attributeCandidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: attributeCandidate.node.id, predicate: 'HAS_ATTRIBUTE', object: attribute.node.id });
    await candidateItem(accountId, attributeCandidate.referenceId);
    await project(accountId);

    const first = await expand(accountId);
    const second = await expand(accountId);

    // Both runs carry the ranking policy version (and the grammar version).
    expect(first.rankingPolicyVersion).toBe(RANKING_POLICY_VERSION);
    expect(first.grammarVersion).toBe('path-grammar-1');
    const { rows: runRows } = await db.query<{ budget: Record<string, unknown> }>(
      'SELECT budget FROM graph_runs WHERE id = $1',
      [first.runId],
    );
    expect(runRows[0]!.budget).toMatchObject({ ranking_policy_version: RANKING_POLICY_VERSION });

    // Identical ranked output: candidates, scores, templates and ranks.
    const shape = (r: typeof first) =>
      r.candidates.map((c) => ({ nodeId: c.nodeId, score: c.score, rank: c.rank, templateKey: c.templateKey }));
    expect(shape(second)).toEqual(shape(first));
    expect(first.candidates.map((c) => c.score)).toEqual([0.8, 0.8, 0.8, 0.7, 0.65]);

    // Tie handling: the same-creator trio orders by candidate node id.
    const keptCreatorIds = first.candidates.filter((c) => c.templateKey === 'same_creator').map((c) => c.nodeId);
    expect(keptCreatorIds).toEqual([...keptCreatorIds].sort((a, b) => (a < b ? -1 : 1)));
    expect(keptCreatorIds).toEqual([...sameCreator].sort((a, b) => (a < b ? -1 : 1)).slice(0, 3));
    expect(first.candidates.filter((c) => c.templateKey === 'shared_technique')).toHaveLength(1);
    expect(first.candidates.filter((c) => c.templateKey === 'shared_attribute')).toHaveLength(1);

    // Diversification bounded the one creator's rail without padding: the
    // fourth same-creator candidate was admitted but not published.
    const diversifiedOut = sameCreator.find((id) => !keptCreatorIds.includes(id))!;
    expect(first.counts.admitted).toBe(6);
    expect(first.counts.diversifiedOut).toBe(1);
    const frontier = await frontierStates(accountId);
    expect(frontier.published).toBe(5);
    expect(frontier.admitted).toBe(1);
    const { rows: diversified } = await db.query<{ node_id: string; state: string }>(
      'SELECT node_id, state FROM graph_frontier WHERE owner_account_id = $1 AND node_id = $2',
      [accountId, diversifiedOut],
    );
    expect(diversified[0]).toMatchObject({ state: 'admitted' });
  });
});

// --- VAL-DISC-002: photo references do not imply rich visual qualification ------

describe('photo-root qualification is fail-closed (VAL-DISC-002)', () => {
  it('an authorized depicted reference yields a supported photo connection with uncertainty preserved', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const photo = await corpusNode({ kind: 'work', name: 'Photo subject' });
    const cap = await photoCapture(ctx, accountId, { referenceId: photo.referenceId!, certainty: 0.72, anchor: true });
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: photo.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    const result = await expand(accountId);
    expect(result.counts.photoRoots).toBe(1);
    expect(result.visionQualified).toBe(false);
    const photoResults = result.candidates.filter((c) => c.intent === 'photo');
    expect(photoResults).toHaveLength(1);
    const obs = photoResults[0]!;
    expect(obs.reason).toBe(`By the same creator (${creator.node.canonical_name})`);

    // The private relevance is the CURRENT authorized reference with its
    // uncertainty intact, kept distinct from the cultural connection.
    const { rows: refRows } = await db.query<{ id: string }>(
      'SELECT id FROM capture_references WHERE analysis_id = $1 AND reference_id = $2',
      [cap.analysisId, photo.referenceId],
    );
    expect(obs.relevance).toMatchObject({
      kind: 'photo',
      captureId: cap.captureId,
      captureReferenceId: refRows[0]!.id,
      relation: 'depicted',
      resolutionStatus: 'resolved',
      isAnchor: true,
      certainty: 0.72,
    });
    // Honest template wording only: no visual-resemblance claim anywhere.
    for (const c of result.candidates) {
      expect(c.reason).not.toMatch(/resembl|visually|palette|looks like|similar to/i);
    }
  });

  it('visual-relation and unresolved references fabricate no photo match', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    // A "resembles" reference is the model's visual-resemblance claim: even
    // resolved and anchored, it is not an authorized photo ROOT, and its
    // cultural neighborhood yields nothing.
    const resembles = await corpusNode({ kind: 'work', name: 'Looks like this' });
    await photoCapture(ctx, accountId, { referenceId: resembles.referenceId!, relation: 'resembles', anchor: true });
    const unresolved = await corpusNode({ kind: 'work' });
    await photoCapture(ctx, accountId, { referenceId: unresolved.referenceId!, resolution: 'unmatched' });
    const textOnly = await corpusNode({ kind: 'work' });
    await photoCapture(ctx, accountId, { referenceId: textOnly.referenceId!, textOnly: true });
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: resembles.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    const result = await expand(accountId);
    expect(result.counts.photoRoots).toBe(0);
    expect(result.counts.photoReferencesDenied).toBe(1);
    expect(result.counts.admitted).toBe(0);
    expect(result.candidates).toHaveLength(0);
    expect(await proofRows(accountId)).toHaveLength(0);
    expect(await activeFrontierCount(accountId)).toBe(0);
  });

  it('a correction that rejects the reference withdraws photo-root admission immediately', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const photo = await corpusNode({ kind: 'work' });
    const cap = await photoCapture(ctx, accountId, { referenceId: photo.referenceId! });
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: photo.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    // The correction is the user's current intent: the reference is rejected
    // before any replacement analysis runs, and no reprojection happened.
    await submitCorrection(ctx, {
      id: cap.captureId,
      body: { expected_analysis_version: 1, reject_reference_ids: [photo.referenceId!] },
    });

    const result = await expand(accountId);
    expect(result.counts.photoRoots).toBe(0);
    expect(result.candidates.filter((c) => c.intent === 'photo')).toHaveLength(0);
    expect(await proofRows(accountId)).toHaveLength(0);
  });

  it('a saved capture without an active analysis is honestly unavailable, not a successful connection', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const photo = await corpusNode({ kind: 'work' });
    const cap = await photoCapture(ctx, accountId, { referenceId: photo.referenceId! });
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: photo.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    // The analysis goes inactive: no authorized active reference remains.
    await db.query('UPDATE captures SET active_analysis_id = NULL WHERE id = $1', [cap.captureId]);

    const result = await expand(accountId);
    expect(result.counts.photoRoots).toBe(0);
    expect(result.counts.capturesWithoutAnalysis).toBe(1);
    expect(result.candidates.filter((c) => c.intent === 'photo')).toHaveLength(0);
    expect(await proofRows(accountId)).toHaveLength(0);
  });

  it('private VISUALLY_RESEMBLES links stay fail-closed even with graph flags on; enabling graph does not qualify vision', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const photo = await corpusNode({ kind: 'work' });
    const cap = await photoCapture(ctx, accountId, { referenceId: photo.referenceId! });
    const resemblanceTarget = await corpusNode({ kind: 'work', name: 'Similar-looking work' });
    // Direct private visual links (the only writer surface today): they must
    // never become roots, candidates or reasons, even with discovery on.
    await db.query(
      `INSERT INTO graph_private_links (owner_account_id, capture_id, analysis_id, node_id, interpretation, certainty, active)
       VALUES ($1, $2, $3, $4, 'VISUALLY_RESEMBLES', 0.9, true)`,
      [accountId, cap.captureId, cap.analysisId, resemblanceTarget.node.id],
    );
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    await justifiedEdge({ subject: resemblanceTarget.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const visualCandidate = await corpusNode({ kind: 'work', name: 'Visual candidate' });
    await justifiedEdge({ subject: visualCandidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, visualCandidate.referenceId);
    await project(accountId);

    const result = await expand(accountId);
    expect(result.expanded).toBe(true);
    expect(result.visionQualified).toBe(false);
    expect(result.counts.visionLinksDenied).toBe(1);
    // The visual target's neighborhood produced nothing: vision stays disabled.
    expect(result.candidates.map((c) => c.nodeId)).not.toContain(visualCandidate.node.id);
    const { rows: visualFrontier } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM graph_frontier WHERE owner_account_id = $1 AND node_id = $2',
      [accountId, visualCandidate.node.id],
    );
    expect(Number(visualFrontier[0]!.n)).toBe(0);
    // No provider or model call happened or was recorded anywhere: the walk
    // is corpus-local and vision stays fail-closed (blocked-call counter).
    const { rows: providerCalls } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM provider_queries WHERE owner_account_id = $1',
      [accountId],
    );
    expect(Number(providerCalls[0]!.n)).toBe(0);
  });
});

// --- VAL-DISC-004: traversal and frontier remain bounded -------------------------

describe('bounded traversal and frontier (VAL-DISC-004)', () => {
  it('traverses at most 200 assertions and reports the truncation honestly', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    // 210 validated assertions touch the root (unjustified: traversal is a
    // bound on walked rows, justification decides at evaluation).
    for (let i = 0; i < 105; i++) {
      const creator = await plainNode({ kind: 'creator', sense: 'painter' });
      await upsertGraphAssertion(db, {
        subjectNodeId: root.node.id,
        predicate: 'CREATED_BY',
        objectNodeId: creator.node.id,
        status: 'validated',
      });
      const extra = await plainNode({ kind: 'work' });
      await upsertGraphAssertion(db, {
        subjectNodeId: root.node.id,
        predicate: 'ABOUT',
        objectNodeId: extra.node.id,
        status: 'validated',
      });
    }
    await project(accountId);

    const result = await expand(accountId);
    expect(result.counts.assertionsTraversed).toBe(EXPANSION_BOUNDS.maxAssertionsTraversed);
    expect(result.truncated.assertions).toBe(true);
    expect(result.counts.candidatesEvaluated).toBe(0);
    expect(result.counts.admitted).toBe(0);
    expect(await activeFrontierCount(accountId)).toBe(0);
    expect(await proofRows(accountId)).toHaveLength(0);
  });

  it('evaluates at most 40 candidates per expansion', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    for (let i = 0; i < 60; i++) {
      const candidate = await corpusNode({ kind: 'work' });
      await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
      await candidateItem(accountId, candidate.referenceId);
    }
    await project(accountId);

    const result = await expand(accountId);
    expect(result.counts.candidatesEvaluated).toBe(EXPANSION_BOUNDS.maxCandidatesEvaluated);
    expect(result.truncated.candidates).toBe(true);
    expect(result.counts.admitted).toBe(EXPANSION_BOUNDS.maxCandidatesEvaluated);
    // All 40 share one midpoint: diversification publishes three, the rest
    // stay admitted candidate state (never confirmed interests).
    expect(result.counts.diversifiedOut).toBe(EXPANSION_BOUNDS.maxCandidatesEvaluated - 3);
    expect(result.counts.recommendationsPublished).toBe(3);
    const frontier = await frontierStates(accountId);
    expect(frontier.published).toBe(3);
    expect(frontier.admitted).toBe(EXPANSION_BOUNDS.maxCandidatesEvaluated - 3);
  });

  it('the active frontier never exceeds 500 entries per account', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    // 498 seeded active entries; this expansion admits 5 more.
    await seedFrontier(accountId, 498, { score: 0.05 });
    const root = await savedRoot(ctx, accountId);
    for (let i = 0; i < 5; i++) {
      const creator = await plainNode({ kind: 'creator', sense: 'painter' });
      const candidate = await corpusNode({ kind: 'work' });
      await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
      await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
      await candidateItem(accountId, candidate.referenceId);
    }
    await project(accountId);

    const { rows: edgesBefore } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM personal_interest_edges WHERE owner_account_id = $1 AND state = 'confirmed'",
      [accountId],
    );
    const { rows: savesBefore } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM saved_items WHERE owner_account_id = $1',
      [accountId],
    );

    const result = await expand(accountId);
    expect(result.counts.admitted).toBe(5);
    expect(result.counts.frontierPruned).toBe(3);
    // The eviction made room exactly: the active frontier peaked at the cap
    // (498 seeded − 3 evicted + 5 admitted = 500). The five published cards
    // then leave the active set, so the durable active count is 495 — never
    // above the 500 cap.
    expect(await activeFrontierCount(accountId)).toBe(495);
    expect(await activeFrontierCount(accountId)).toBeLessThanOrEqual(EXPANSION_BOUNDS.maxActiveFrontierEntries);
    const frontier = await frontierStates(accountId);
    expect(frontier.pruned).toBe(3);
    expect(frontier.published).toBe(5);

    // Pruning candidate state never removes confirmed interests.
    const { rows: edgesAfter } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM personal_interest_edges WHERE owner_account_id = $1 AND state = 'confirmed'",
      [accountId],
    );
    const { rows: savesAfter } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM saved_items WHERE owner_account_id = $1',
      [accountId],
    );
    expect(Number(edgesAfter[0]!.n)).toBe(Number(edgesBefore[0]!.n));
    expect(Number(savesAfter[0]!.n)).toBe(Number(savesBefore[0]!.n));
  });

  it('canonical candidates deduplicate across runs and never become expansion roots', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    const first = await expand(accountId);
    const second = await expand(accountId);

    // One canonical candidate entry per (intent, node): the second run dedupes.
    expect(first.counts.frontierCreated).toBe(1);
    expect(first.counts.frontierDeduped).toBe(0);
    expect(second.counts.frontierDeduped).toBe(1);
    expect(second.counts.frontierCreated).toBe(0);
    const { rows: frontierRows } = await db.query<{ n: number; state: string }>(
      'SELECT count(*)::int AS n, max(state) AS state FROM graph_frontier WHERE owner_account_id = $1 AND node_id = $2',
      [accountId, candidate.node.id],
    );
    expect(Number(frontierRows[0]!.n)).toBe(1);

    // A recommendation is never an expansion root: the candidate's card was
    // not saved, so the second run walks exactly the same roots.
    expect(second.counts.personalRoots).toBe(first.counts.personalRoots);
    expect(second.counts.admitted).toBe(1);
  });

  it('frontier entries expire within seven days (or earlier evidence expiry) and pruning keeps confirmed roots', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    // Seeded entries that are already past their lifetime.
    await seedFrontier(accountId, 5, { expiresInDays: 7 });
    await db.query(
      `UPDATE graph_frontier SET expires_at = now() - interval '1 day'
        WHERE owner_account_id = $1 AND dedupe_key LIKE 'seed:%'`,
      [accountId],
    );
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // evidence expires in 2h
    await justifiedEdge({
      subject: candidate.node.id,
      predicate: 'CREATED_BY',
      object: creator.node.id,
      evidence: [await evidence(db, { expiresAt })],
    });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    const result = await expand(accountId);
    // Overdue entries are expired, not silently dropped or resurrected.
    expect(result.counts.frontierExpired).toBe(5);
    const frontier = await frontierStates(accountId);
    expect(frontier.expired).toBe(5);
    expect(frontier.published).toBe(1);

    // Evidence expiry shortens the new candidate's lifetime below the cap.
    const { rows: entry } = await db.query<{ expires_at: Date }>(
      'SELECT expires_at FROM graph_frontier WHERE owner_account_id = $1 AND node_id = $2',
      [accountId, candidate.node.id],
    );
    expect(entry[0]!.expires_at.getTime()).toBeLessThanOrEqual(expiresAt.getTime());
    expect(entry[0]!.expires_at.getTime()).toBeGreaterThan(Date.now());

    // Confirmed interests survive pruning and expiry untouched.
    const { rows: edges } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM personal_interest_edges WHERE owner_account_id = $1 AND origin = 'explicit' AND state = 'confirmed'",
      [accountId],
    );
    expect(Number(edges[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('a controlled clock past the seven-day lifetime expires entries while confirmed roots survive', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    // Fresh entries inside their lifetime right now: only the controlled
    // clock, eight days ahead, makes them due.
    await seedFrontier(accountId, 5);
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    const at = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const result = await expand(accountId, at);
    expect(result.counts.frontierExpired).toBe(5);
    const frontier = await frontierStates(accountId);
    expect(frontier.expired).toBe(5);
    // The walk itself stays honest under the same clock: the candidate still
    // admits (no evidence expiry involved) and the confirmed root survives.
    expect(result.counts.admitted).toBe(1);
    const { rows: edges } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM personal_interest_edges WHERE owner_account_id = $1 AND origin = 'explicit' AND state = 'confirmed'",
      [accountId],
    );
    expect(Number(edges[0]!.n)).toBe(1);
  });
});

// --- Gating -----------------------------------------------------------------------

describe('expansion gating stays fail-closed', () => {
  it('does nothing while discovery is off, even with projection on', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOnly });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    const result = await expandAccountInterestGraph(db, { accountId, config: projectionOnly });
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(result.runId).toBeNull();
    const { rows: runs } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'",
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(0);
    expect(await activeFrontierCount(accountId)).toBe(0);
    expect(await proofRows(accountId)).toHaveLength(0);
  });

  it('a killed discovery flag disables expansion while leaving the corpus untouched', async () => {
    const { principal, ctx } = await accountCtx({
      config: testConfig({
        INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
        INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
        FEATURE_KILL_SWITCHES: 'interest_graph_discovery_enabled',
      }),
    });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await project(accountId);

    const result = await expandAccountInterestGraph(db, {
      accountId,
      config: testConfig({
        INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
        INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
        FEATURE_KILL_SWITCHES: 'interest_graph_discovery_enabled',
      }),
    });
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(await activeFrontierCount(accountId)).toBe(0);
  });

  it('expansion stays account-scoped: another account keeps an empty frontier', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const other = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    const result = await expand(accountId);
    expect(result.counts.admitted).toBe(1);
    expect(await activeFrontierCount(other.principal.accountId)).toBe(0);
    expect(await proofRows(other.principal.accountId)).toHaveLength(0);
    const { rows: otherRuns } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1",
      [other.principal.accountId],
    );
    expect(Number(otherRuns[0]!.n)).toBe(0);
  });
});

// --- VAL-DISC-007 / VAL-PROJ-010: the publication fence race matrix ------------------

describe('publication fence races (VAL-DISC-007, VAL-PROJ-010)', () => {
  /** A publishable fixture: one admitted candidate with pinned proofs. */
  async function publishableFixture() {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);
    const first = await expand(accountId);
    if (!first.expanded) throw new Error(`fixture did not publish: ${first.reason}`);
    return { accountId, root, candidate, ranked: first.candidates };
  }

  /** The authority versions a pass would have read at its start. */
  async function startVersions(accountId: string) {
    const { rows: state } = await db.query<{ projection_revision: number; deletion_generation: number }>(
      'SELECT projection_revision, deletion_generation FROM personal_graph_state WHERE owner_account_id = $1',
      [accountId],
    );
    return {
      projectionRevision: state[0]!.projection_revision,
      generation: state[0]!.deletion_generation,
      tasteRevision: (await db.query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [accountId]))
        .rows[0]!.revision,
    };
  }

  it('rejects a pass whose account was deleted mid-pass: nothing publishes', async () => {
    const { accountId } = await publishableFixture();
    const start = await startVersions(accountId);
    await db.query('DELETE FROM accounts WHERE id = $1', [accountId]);
    const violation = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked: [] }),
    );
    expect(violation).toBe('account_missing');
  });

  it('rejects a pass whose taste or projection authority moved mid-pass', async () => {
    const { accountId, ranked } = await publishableFixture();
    const start = await startVersions(accountId);

    // A taste change commits mid-pass (the projection has not caught up yet).
    await db.query('UPDATE taste_profiles SET revision = revision + 1 WHERE owner_account_id = $1', [accountId]);
    const tasteViolation = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked }),
    );
    expect(tasteViolation).toBe('stale_authority');

    // A newer projection (or a deletion-reset generation) also invalidates it.
    await db.query('UPDATE taste_profiles SET revision = revision - 1 WHERE owner_account_id = $1', [accountId]);
    await db.query(
      'UPDATE personal_graph_state SET projection_revision = projection_revision + 1 WHERE owner_account_id = $1',
      [accountId],
    );
    const projectionViolation = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked }),
    );
    expect(projectionViolation).toBe('stale_authority');
  });

  it('rejects a pass whose account paused mid-pass', async () => {
    const { accountId, ranked } = await publishableFixture();
    const start = await startVersions(accountId);
    await pauseGraphDiscovery(db, accountId);
    const violation = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked }),
    );
    expect(violation).toBe('paused');
  });

  it('rejects a pass when a hide lands on a personal root mid-pass', async () => {
    const { accountId, ranked } = await publishableFixture();
    const start = await startVersions(accountId);
    const personal = ranked.find((o) => o.relevance.kind === 'personal');
    if (!personal || personal.relevance.kind !== 'personal') throw new Error('fixture lost its personal root');
    await db.query(
      `INSERT INTO item_exclusions (owner_account_id, canonical_key) VALUES ($1, $2)
       ON CONFLICT (owner_account_id, canonical_key) DO NOTHING`,
      [accountId, personal.relevance.canonicalKey],
    );
    const violation = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked }),
    );
    expect(violation).toBe('exclusion_landed');
  });

  it('rejects a pass whose pinned source was retracted mid-pass', async () => {
    const { accountId, ranked } = await publishableFixture();
    const start = await startVersions(accountId);
    const assertionIds = [...new Set(ranked.flatMap((o) => o.assertions.map((a) => a.id)))];
    expect(assertionIds.length).toBeGreaterThan(0);
    const { rows: evidenceRows } = await db.query<{ evidence_id: string }>(
      `SELECT DISTINCT s.evidence_id FROM graph_assertion_support s
        WHERE s.assertion_id = ANY($1::uuid[])`,
      [assertionIds],
    );
    expect(evidenceRows.length).toBeGreaterThan(0);
    // The evidence behind a walked assertion is retracted mid-pass: the
    // justification is gone (the sanctioned invalidation path).
    await retractGraphEvidence(db, { evidenceId: evidenceRows[0]!.evidence_id, reason: 'mid-pass retraction test' });
    const violation = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked }),
    );
    expect(violation).toBe('source_invalidated');
  });

  it('rejects a pass whose private support was withdrawn mid-pass', async () => {
    const { accountId, ranked } = await publishableFixture();
    const start = await startVersions(accountId);
    const edgeIds = [...new Set(ranked.flatMap((o) => [...o.supportEdgeIds]))];
    expect(edgeIds.length).toBeGreaterThan(0);
    // The save's projected support edge is withdrawn mid-pass (removal of the
    // explicit interest withdraws its edge and cascades its support rows).
    await db.query(
      `DELETE FROM personal_interest_edges WHERE owner_account_id = $1 AND id = ANY($2::uuid[])`,
      [accountId, edgeIds],
    );
    const violation = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked }),
    );
    expect(violation).toBe('support_withdrawn');
  });

  it('rejects a pass whose RETAINED-ONLY frontier dependency was retracted mid-pass (DISC-SCR-024)', async () => {
    const { accountId, ranked } = await publishableFixture();
    const start = await startVersions(accountId);
    const assertionIds = [...new Set(ranked.flatMap((o) => o.assertions.map((a) => a.id)))];
    expect(assertionIds.length).toBeGreaterThan(0);
    const { rows: evidenceRows } = await db.query<{ evidence_id: string }>(
      `SELECT DISTINCT s.evidence_id FROM graph_assertion_support s WHERE s.assertion_id = ANY($1::uuid[])`,
      [assertionIds],
    );
    expect(evidenceRows.length).toBeGreaterThan(0);

    // The retained path of a dedupe-refreshed live row pins its own
    // assertion/evidence population — one that no newly selected observation
    // of the pass names (a changed winning root). Its witness is withdrawn
    // mid-pass: the pre-repair fence never looked at this population.
    await retractGraphEvidence(db, { evidenceId: evidenceRows[0]!.evidence_id, reason: 'mid-pass retraction of a retained-only witness' });
    const retainedFrontier = [
      {
        assertions: assertionIds.map((id) => ({ id })),
        evidence: [{ id: evidenceRows[0]!.evidence_id }],
      },
    ];

    // Pre-repair shape: the population was absent from the fence's
    // dependency set, so the pass committed over the withdrawn witness.
    const unseen = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked: [] }),
    );
    expect(unseen).toBeNull();

    // Repaired shape: the same retained population is decided by the
    // last-word fence and rejects the whole pass.
    const seen = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked: [], retainedFrontier }),
    );
    expect(seen).toBe('source_invalidated');
  });

  it('rejects an admitted-unranked personal survivor whose root was hidden mid-pass (DISC-SCR-027 population coherence)', async () => {
    const { accountId, ranked } = await publishableFixture();
    const start = await startVersions(accountId);
    const personal = ranked.find((o) => o.relevance.kind === 'personal');
    if (!personal || personal.relevance.kind !== 'personal') throw new Error('fixture lost its personal root');
    // A pass whose rails emptied mid-pass commits only the diversified-out
    // survivor: its private relevance is the SAME population as a ranked
    // card's, so a hide landing on its root mid-pass must reject the pass
    // (pre-repair the unranked population was invisible to this check and
    // the frontier row committed over the hide).
    await db.query(
      `INSERT INTO item_exclusions (owner_account_id, canonical_key) VALUES ($1, $2)
       ON CONFLICT (owner_account_id, canonical_key) DO NOTHING`,
      [accountId, personal.relevance.canonicalKey],
    );
    const violation = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked: [], admittedUnranked: [personal] }),
    );
    expect(violation).toBe('exclusion_landed');
  });

  it('rejects an admitted-unranked personal survivor whose private support was withdrawn mid-pass (DISC-SCR-027 population coherence)', async () => {
    const { accountId, ranked } = await publishableFixture();
    const start = await startVersions(accountId);
    const personal = ranked.find((o) => o.relevance.kind === 'personal');
    if (!personal || personal.relevance.kind !== 'personal') throw new Error('fixture lost its personal root');
    // The save's projected support edge is withdrawn mid-pass (removal of the
    // explicit interest withdraws its edge and cascades its support rows):
    // the admitted-unranked survivor's frontier row would pin a withdrawn
    // support root, so the whole pass is rejected.
    await db.query(
      `DELETE FROM personal_interest_edges WHERE owner_account_id = $1 AND id = ANY($2::uuid[])`,
      [accountId, [...personal.supportEdgeIds]],
    );
    const violation = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked: [], admittedUnranked: [personal] }),
    );
    expect(violation).toBe('support_withdrawn');
  });

  it('a fence rejection rolls the whole pass back: zero rows survive', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const root = await savedRoot(ctx, accountId);
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);

    const runsBefore = Number(
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1', [accountId])).rows[0]!.n,
    );
    const recsBefore = Number(
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM recommendations WHERE owner_account_id = $1', [accountId]))
        .rows[0]!.n,
    );

    // The lease was lost while this pass was in flight: the handler's fence
    // hook rejects at publication, and the entire transaction rolls back.
    const result = await expandAccountInterestGraph(db, {
      accountId,
      config: graphOn,
      at: new Date(),
      fence: async () => {
        throw new GraphFenceError('lease_lost');
      },
    });
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe('lease_lost');
    expect(result.counts.recommendationsPublished).toBe(0);

    const runsAfter = Number(
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1', [accountId])).rows[0]!.n,
    );
    const recsAfter = Number(
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM recommendations WHERE owner_account_id = $1', [accountId]))
        .rows[0]!.n,
    );
    const frontier = await activeFrontierCount(accountId);
    expect(runsAfter).toBe(runsBefore);
    expect(recsAfter).toBe(recsBefore);
    expect(frontier).toBe(0);
    expect(await proofRows(accountId)).toHaveLength(0);
  });

  it('a clean pass may publish: the fence reports no violation', async () => {
    const { accountId, ranked } = await publishableFixture();
    const start = await startVersions(accountId);
    const violation = await db.transaction(async (tx) =>
      checkGraphPublicationFence(tx, { accountId, start, ranked }),
    );
    expect(violation).toBeNull();
  });
});

// --- Normal corpus admission reaches real application references (DISC-SCR-004/005) ---

describe('corpus admission reaches real application references', () => {
  // This describe runs on ONE isolated database (the documented pattern for
  // global-count determinism): admission's linkage pass tallies every match in
  // its database, and these tests assert exact global counts. It also keeps
  // the shared per-run database's sweeper population untouched.
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeAll(async () => {
    const iso = await createIsolatedDatabase('corpustrav');
    isoDb = iso.db;
    dropIso = iso.drop;
  });
  afterAll(async () => {
    await dropIso();
  });

  /** An account + service context bound to the isolated database. */
  async function isoAccountCtx() {
    const principal = await insertAccount(isoDb);
    return { principal, ctx: testContext(principal, { db: isoDb, config: graphOn }) };
  }

  async function projectIso(accountId: string) {
    await projectAccountInterestGraph(isoDb, { accountId, config: graphOn, source: 'mutation_intent' });
  }

  async function expandIso(accountId: string) {
    return expandAccountInterestGraph(isoDb, { accountId, config: graphOn });
  }

  /** A saved capture whose active analysis authorizes one depicted reference (isolated db). */
  async function photoCaptureIso(
    ctx: ServiceContext,
    accountId: string,
    over: { referenceId: string; resolution?: string; certainty?: number },
  ) {
    const cap = await insertCaptureWithAnalysis({ accountId }, {}, isoDb);
    await isoDb.query(
      `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor, text_only, read_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        cap.analysisId,
        over.referenceId,
        'depicted',
        over.certainty ?? 0.72,
        over.resolution ?? 'resolved',
        true,
        false,
        null,
      ],
    );
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
    return cap;
  }
  /**
   * A reviewed manifest whose three identities carry confirmed Qloo provider
   * mappings (the reviewed-corpus shape a real manifest revision uses to
   * bridge its identities to the application's Qloo-resolved references).
   * Assertions: root work A —CREATED_BY→ shared creator C ←CREATED_BY—
   * candidate work B, the same two-distinct-assertion walk the scrutiny
   * finding described.
   */
  function reviewedManifestWithProviderIds() {
    const suffix = randomUUID().slice(0, 6);
    const workA = `atlas:work:${randomUUID()}`;
    const workB = `atlas:work:${randomUUID()}`;
    const creatorC = `atlas:creator:${randomUUID()}`;
    const ids = { a: `ent-${randomUUID()}`, b: `ent-${randomUUID()}`, c: `ent-${randomUUID()}` };
    const sourceKey = 'source:1';
    const manifest = CorpusManifestSchema.parse({
      manifest_version: 1,
      corpus_version: `corpus-${suffix}`,
      policy_version: 'graph-policy-1',
      domains: ['art'],
      review: {
        reviewed_by: 'test review',
        reviewed_at: '2026-10-28T00:00:00.000Z',
        basis: 'verified against the cited source; provider-id mappings confirmed by entity lookups',
      },
      photo_candidate_inventory: {
        location: 'test research directory',
        status: 'not_a_qualified_holdout',
        note: 'candidate photo inventory is evaluation-planning material, never corpus content',
      },
      provider_policy: { transient_providers: ['qloo'], note: 'Qloo responses stay transient; ids map for traceability only.' },
      identities: [
        { key: workA, name: `Root work ${suffix}`, kind: 'work', domain: 'art', sense: 'painting' },
        { key: workB, name: `Candidate work ${suffix}`, kind: 'work', domain: 'art', sense: 'painting' },
        { key: creatorC, name: `Shared creator ${suffix}`, kind: 'creator', domain: 'art', sense: 'painter' },
      ],
      external_ids: [
        { identity: workA, provider: 'qloo', external_id: ids.a, provenance: 'Qloo entity lookup confirmed id names the root work' },
        { identity: workB, provider: 'qloo', external_id: ids.b, provenance: 'Qloo entity lookup confirmed id names the candidate work' },
        { identity: creatorC, provider: 'qloo', external_id: ids.c, provenance: 'Qloo entity lookup confirmed id names the creator' },
      ],
      sources: [
        {
          key: sourceKey,
          provider: 'artic_open_access',
          url: `https://example.org/${randomUUID()}`,
          family_key: `artic:${randomUUID()}`,
          title: 'A Test Record',
          publisher: 'A Museum',
          attribution: 'A Museum',
          retrieved_at: '2026-10-28T00:00:00.000Z',
          rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none', basis: 'museum open access policy' },
          retention: { content: 'permitted metadata fields only', basis: 'CC0' },
        },
      ],
      assertions: [
        {
          label: 'root-work-created-by-creator',
          subject: workA,
          object: creatorC,
          predicate: 'CREATED_BY',
          evidence: [
            {
              source: sourceKey,
              kind: 'fact',
              derivation: 'primary',
              validation: { method: 'provider_metadata', version: 'source-1' },
              locator: 'artist_display',
              excerpt: 'A Test Creator (Test, 1900-1901)',
            },
          ],
        },
        {
          label: 'candidate-work-created-by-creator',
          subject: workB,
          object: creatorC,
          predicate: 'CREATED_BY',
          evidence: [
            {
              source: sourceKey,
              kind: 'fact',
              derivation: 'primary',
              validation: { method: 'provider_metadata', version: 'source-1' },
              locator: 'artist_display',
              excerpt: 'A Test Creator (Test, 1900-1901)',
            },
          ],
        },
      ],
    });
    return { manifest, ids };
  }

  /** A compiler-shaped reference (Qloo-resolved entity id in key + external ids). */
  async function realReference(providerId: string, type: 'work' | 'creator' = 'work'): Promise<string> {
    return upsertReference(isoDb, {
      canonicalKey: `qloo:${providerId}`,
      name: `Real reference ${providerId.slice(4, 12)}`,
      type,
      externalIds: { qloo: providerId },
    });
  }

  /** An account-owned discovery item on a real reference. */
  async function itemOn(accountId: string, referenceId: string): Promise<string> {
    return insertItem({ accountId }, { referenceId, kind: 'film', category: 'watch' }, isoDb);
  }

  /** The durable cultural-reference bindings of a manifest's identities, by canonical key. */
  async function bindingsByManifestKey(manifest: CorpusManifest): Promise<Map<string, string | null>> {
    const { rows } = await isoDb.query<{ canonical_key: string; cultural_reference_id: string | null }>(
      'SELECT canonical_key, cultural_reference_id FROM graph_nodes WHERE canonical_key = ANY($1::text[])',
      [manifest.identities.map((i) => i.key)],
    );
    return new Map(rows.map((r) => [r.canonical_key, r.cultural_reference_id]));
  }

  it('normal admission links pre-existing real references, and the walk reaches materialized candidates (no hand-prelinked fixtures)', async () => {
    const { manifest, ids } = reviewedManifestWithProviderIds();
    // Real application references exist BEFORE the corpus is admitted.
    const refA = await realReference(ids.a);
    const refB = await realReference(ids.b);

    const first = await admitGraphCorpus(isoDb, manifest);
    // The linkage follows import: both real references are bound to their
    // corpus identities, and replay writes nothing.
    expect(first.referencesLinked).toBe(2);
    expect(first.referenceLinksAmbiguous).toBe(0);
    expect(first.referenceLinksConflicting).toBe(0);
    const bindings = await bindingsByManifestKey(manifest);
    expect(bindings.get(manifest.identities[0]!.key)).toBe(refA);
    expect(bindings.get(manifest.identities[1]!.key)).toBe(refB);
    const replay = await admitGraphCorpus(isoDb, manifest);
    expect(replay.referencesLinked).toBe(0);
    expect(replay.referencesAlreadyLinked).toBe(2);

    const { principal, ctx } = await isoAccountCtx();
    const accountId = principal.accountId;
    const itemA = await itemOn(accountId, refA);
    const itemB = await itemOn(accountId, refB);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemA });
    await projectIso(accountId);

    const result = await expandIso(accountId);
    expect(result.expanded).toBe(true);
    expect(result.counts.personalRoots).toBe(1);
    expect(result.counts.admitted).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(1);
    const obs = result.candidates.find((o) => o.intent === 'personal');
    expect(obs).toBeDefined();
    // The candidate materialized onto the account's real item for work B.
    expect(obs!.discoveryItemId).toBe(itemB);
    expect(obs!.discoveryItemId).not.toBeNull();
    // The walked connection pins exactly the two distinct assertions, once each.
    expect(obs!.assertions).toHaveLength(2);
    const { rows: pinned } = await isoDb.query<{ subject_node_id: string; object_node_id: string }>(
      'SELECT subject_node_id, object_node_id FROM graph_assertions WHERE id = ANY($1::uuid[])',
      [obs!.assertions.map((a) => a.id)],
    );
    expect(pinned).toHaveLength(2);
  });

  it('real references resolved after admission still reach linked nodes and materialize candidates', async () => {
    const { manifest, ids } = reviewedManifestWithProviderIds();
    // The corpus is admitted FIRST (the production shape: references appear
    // over time, after the reviewed corpus landed).
    const admission = await admitGraphCorpus(isoDb, manifest);
    expect(admission.referencesLinked).toBe(0);
    // No reference for these identities exists yet: nothing of theirs is bound.
    const unbound = await bindingsByManifestKey(manifest);
    expect([...unbound.values()].every((v) => v === null)).toBe(true);

    const refA = await realReference(ids.a);
    const refB = await realReference(ids.b);
    const { principal, ctx } = await isoAccountCtx();
    const accountId = principal.accountId;
    const itemA = await itemOn(accountId, refA);
    const itemB = await itemOn(accountId, refB);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemA });
    await projectIso(accountId);

    const result = await expandIso(accountId);
    expect(result.expanded).toBe(true);
    // The saved subject reached its corpus node through the verified
    // provider-id link (exact confirmed id equality, never a name match).
    expect(result.counts.personalRoots).toBe(1);
    expect(result.counts.unmappedPersonalRoots).toBe(0);
    expect(result.counts.referencesLinked).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(1);
    const obs = result.candidates.find((o) => o.intent === 'personal');
    expect(obs).toBeDefined();
    expect(obs!.discoveryItemId).toBe(itemB);
    // The candidate's card materialized through the same verified link.
    expect(result.counts.candidatesResolvedByLink).toBe(1);

    // A later linkage replay durably converges the bindings...
    const pass = await linkGraphReferenceIdentities(isoDb);
    expect(pass.referencesLinked).toBe(2);
    const bindings = await bindingsByManifestKey(manifest);
    expect(bindings.get(manifest.identities[0]!.key)).toBe(refA);
    expect(bindings.get(manifest.identities[1]!.key)).toBe(refB);
    // ...and the next expansion still recommends the same connection.
    const again = await expandIso(accountId);
    expect(again.candidates.map((o) => o.nodeId)).toContain(obs!.nodeId);
    expect(again.counts.unmappedPersonalRoots).toBe(0);
  });

  it('an ambiguous verified candidate link materializes nothing (fail-closed)', async () => {
    const { manifest, ids } = reviewedManifestWithProviderIds();
    await admitGraphCorpus(isoDb, manifest);
    const refA = await realReference(ids.a);
    // The candidate reference carries TWO provider ids (a real compiler
    // shape), and a SECOND identity holds a confirmed mapping on the other
    // provider: the reference now matches two corpus identities.
    const wikidataId = `Q${randomUUID().slice(0, 8).toUpperCase()}`;
    const refB = await upsertReference(isoDb, {
      canonicalKey: `qloo:${ids.b}`,
      name: `Disputed reference ${ids.b.slice(4, 12)}`,
      type: 'work',
      externalIds: { qloo: ids.b, wikidata: wikidataId },
    });
    const competitor = await upsertGraphIdentity(isoDb, {
      canonicalKey: `atlas:work:${randomUUID()}`,
      canonicalName: `Competing work ${randomUUID().slice(0, 6)}`,
      nodeKind: 'work',
      domain: 'art',
      senseKey: 'painting',
    });
    await mapGraphExternalId(isoDb, {
      nodeId: competitor.id,
      provider: 'wikidata',
      externalId: wikidataId,
      matchStatus: 'confirmed',
    });

    const { principal, ctx } = await isoAccountCtx();
    const accountId = principal.accountId;
    const itemA = await itemOn(accountId, refA);
    const itemB = await itemOn(accountId, refB);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemA });
    await projectIso(accountId);

    const result = await expandIso(accountId);
    expect(result.expanded).toBe(true);
    // The root still reaches the corpus (its own verified link is unique)...
    expect(result.counts.personalRoots).toBe(1);
    expect(result.counts.unmappedPersonalRoots).toBe(0);
    expect(result.counts.admitted).toBe(1);
    // ...but the ambiguous candidate link materializes nothing: the walked
    // candidate never claims the account's item on the disputed reference,
    // and the unmaterialized candidate is reported honestly.
    expect(result.counts.candidatesResolvedByLink).toBe(0);
    expect(result.counts.recommendationsPublished).toBe(0);
    expect(result.counts.candidatesWithoutItems).toBe(1);
    // The walked candidate observation is still returned honestly — but it
    // never claims the account's item on the disputed reference.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.discoveryItemId).toBeNull();
    // And durably: no recommendation card ever claims the disputed item.
    const { rows: claimed } = await isoDb.query<{ id: string }>(
      'SELECT id FROM recommendations WHERE discovery_item_id = $1',
      [itemB],
    );
    expect(claimed).toHaveLength(0);

    // The ambiguous link also fails closed durably: the linkage pass (global
    // over this isolated DB; earlier tests' references are already linked)
    // binds THIS test's clean root binding, reports the disputed reference as
    // ambiguous, and binds neither claiming identity.
    const pass = await linkGraphReferenceIdentities(isoDb);
    expect(pass.referencesLinked).toBe(1);
    expect(pass.referenceLinksAmbiguous).toBe(1);
    const bindings = await bindingsByManifestKey(manifest);
    expect(bindings.get(manifest.identities[0]!.key)).toBe(refA);
    expect(bindings.get(manifest.identities[1]!.key)).toBeNull();
    const { rows: competitorRows } = await isoDb.query<{ cultural_reference_id: string | null }>(
      'SELECT cultural_reference_id FROM graph_nodes WHERE id = $1',
      [competitor.id],
    );
    expect(competitorRows[0]!.cultural_reference_id).toBeNull();
  });

  it('an identity claimed by two references anywhere never becomes a root, personal or photo (inverse ambiguity, DISC-SCR-017)', async () => {
    const { manifest, ids } = reviewedManifestWithProviderIds();
    await admitGraphCorpus(isoDb, manifest);
    // TWO differently keyed real references carry the SAME confirmed provider
    // id: the durable linker rejects the identity as ambiguous (one identity
    // matched by two references), so nothing ever binds durably.
    const refA = await realReference(ids.a);
    const refADuplicate = await upsertReference(isoDb, {
      canonicalKey: `work:duplicate-${randomUUID()}`,
      name: `Duplicate provider id ${randomUUID().slice(0, 6)}`,
      type: 'work',
      externalIds: { qloo: ids.a },
    });
    const refB = await realReference(ids.b);

    const { principal, ctx } = await isoAccountCtx();
    const accountId = principal.accountId;
    // The account saves the DUPLICATE-keyed reference's item and authorizes
    // the same reference as a photo subject: both root kinds reach the same
    // read-time fallback.
    const itemADuplicate = await itemOn(accountId, refADuplicate);
    const itemB = await itemOn(accountId, refB);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemADuplicate });
    await photoCaptureIso(ctx, accountId, { referenceId: refADuplicate, resolution: 'user_confirmed', certainty: 0.9 });
    await projectIso(accountId);

    const result = await expandIso(accountId);
    expect(result.expanded).toBe(true);
    // The identity is claimed by a second reference OUTSIDE this root set, so
    // the inverse ambiguity fails closed for BOTH root kinds: no root, no
    // walk, no wrong-identity publication. (The second unmapped personal root
    // is the saved capture's own item edge, which has no cultural reference
    // of its own — the pre-existing honest count for capture saves.)
    expect(result.counts.personalRoots).toBe(0);
    expect(result.counts.photoRoots).toBe(0);
    expect(result.counts.unmappedPersonalRoots).toBe(2);
    expect(result.counts.photoReferencesUnmapped).toBe(1);
    expect(result.counts.referencesLinked).toBe(0);
    expect(result.counts.referenceLinksAmbiguous).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(0);
    expect(result.candidates).toHaveLength(0);
    // Fail closed without changing stored links: the disputed identity stays
    // unbound and neither claiming reference is ever held.
    const bindings = await bindingsByManifestKey(manifest);
    expect(bindings.get(manifest.identities[0]!.key)).toBeNull();
    for (const disputed of [refA, refADuplicate]) {
      const { rows: holders } = await isoDb.query<{ id: string }>(
        'SELECT id FROM graph_nodes WHERE cultural_reference_id = $1',
        [disputed],
      );
      expect(holders).toHaveLength(0);
    }
    // And no wrong-identity card ever claimed the account's items.
    const { rows: claimed } = await isoDb.query<{ id: string }>(
      'SELECT id FROM recommendations WHERE discovery_item_id = ANY($1::uuid[])',
      [[itemADuplicate, itemB]],
    );
    expect(claimed).toHaveLength(0);
  });

  it('an unbound root matching an identity durably bound to a different reference fails closed (competing node binding, DISC-SCR-017)', async () => {
    const { manifest, ids } = reviewedManifestWithProviderIds();
    await admitGraphCorpus(isoDb, manifest);
    // A reviewed direct binding holds the root-side identity to its own
    // reference (no provider ids on it), while a LATER compiler-shaped
    // reference carries the identity's confirmed provider id: the durable
    // linker rejects that pair as a competing binding, and so must reads.
    const held = await upsertReference(isoDb, {
      canonicalKey: `work:reviewed-${randomUUID()}`,
      name: `Reviewed reference ${randomUUID().slice(0, 6)}`,
      type: 'work',
      externalIds: {},
    });
    const { rows: rootRows } = await isoDb.query<{ id: string }>(
      'SELECT id FROM graph_nodes WHERE canonical_key = $1',
      [manifest.identities[0]!.key],
    );
    await bindGraphIdentityReference(isoDb, { nodeId: rootRows[0]!.id, culturalReferenceId: held });
    const refACompeting = await realReference(ids.a);
    const refB = await realReference(ids.b);

    const { principal, ctx } = await isoAccountCtx();
    const accountId = principal.accountId;
    // The account saves the COMPETING reference's item (not the held one).
    const itemACompeting = await itemOn(accountId, refACompeting);
    const itemB = await itemOn(accountId, refB);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemACompeting });
    await projectIso(accountId);

    const result = await expandIso(accountId);
    expect(result.expanded).toBe(true);
    // The verified match contradicts the existing durable binding: the root
    // stays unresolved and nothing publishes from the wrong identity.
    expect(result.counts.personalRoots).toBe(0);
    expect(result.counts.unmappedPersonalRoots).toBe(1);
    expect(result.counts.referencesLinked).toBe(0);
    expect(result.counts.referenceLinksConflicting).toBe(1);
    expect(result.counts.referenceLinksAmbiguous).toBe(0);
    expect(result.counts.recommendationsPublished).toBe(0);
    expect(result.candidates).toHaveLength(0);
    // The durable binding survives untouched and the competing reference is never held.
    const bindings = await bindingsByManifestKey(manifest);
    expect(bindings.get(manifest.identities[0]!.key)).toBe(held);
    const { rows: holders } = await isoDb.query<{ id: string }>(
      'SELECT id FROM graph_nodes WHERE cultural_reference_id = $1',
      [refACompeting],
    );
    expect(holders).toHaveLength(0);
    const { rows: claimed } = await isoDb.query<{ id: string }>(
      'SELECT id FROM recommendations WHERE discovery_item_id = ANY($1::uuid[])',
      [[itemACompeting, itemB]],
    );
    expect(claimed).toHaveLength(0);
  });

  it('an unbound candidate never materializes a reference durably held by a different identity (competing reference binding, DISC-SCR-017)', async () => {
    const { manifest, ids } = reviewedManifestWithProviderIds();
    await admitGraphCorpus(isoDb, manifest);
    const refA = await realReference(ids.a);
    // The candidate reference carries the candidate identity's confirmed
    // provider id, but a DIFFERENT reviewed identity already holds it
    // durably (by review, with no provider-id mapping of its own): the
    // durable linker would reject the candidate pair as competing.
    const refB = await realReference(ids.b);
    const holder = await upsertGraphIdentity(isoDb, {
      canonicalKey: `atlas:work:${randomUUID()}`,
      canonicalName: `Holding identity ${randomUUID().slice(0, 6)}`,
      nodeKind: 'work',
      domain: 'art',
      senseKey: 'painting',
      culturalReferenceId: refB,
    });

    const { principal, ctx } = await isoAccountCtx();
    const accountId = principal.accountId;
    const itemA = await itemOn(accountId, refA);
    const itemB = await itemOn(accountId, refB);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemA });
    await projectIso(accountId);

    const result = await expandIso(accountId);
    expect(result.expanded).toBe(true);
    // The authorized personal root still resolves through the verified link
    // (the positive path is untouched)...
    expect(result.counts.personalRoots).toBe(1);
    expect(result.counts.referencesLinked).toBe(1);
    // ...but the walked candidate never claims the account's item on the
    // held reference: no wrong-identity recommendation is published.
    expect(result.counts.candidatesResolvedByLink).toBe(0);
    expect(result.counts.recommendationsPublished).toBe(0);
    expect(result.counts.candidatesWithoutItems).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.discoveryItemId).toBeNull();
    const { rows: claimed } = await isoDb.query<{ id: string }>(
      'SELECT id FROM recommendations WHERE discovery_item_id = $1',
      [itemB],
    );
    expect(claimed).toHaveLength(0);
    // And no stored link changed: the holder keeps the reference, the corpus
    // candidate stays unbound.
    const { rows: holderRows } = await isoDb.query<{ id: string }>(
      'SELECT id FROM graph_nodes WHERE cultural_reference_id = $1',
      [refB],
    );
    expect(holderRows.map((r) => r.id)).toEqual([holder.id]);
    const bindings = await bindingsByManifestKey(manifest);
    expect(bindings.get(manifest.identities[1]!.key)).toBeNull();
  });

  it('a real authorized photo reference reaches the corpus through normal admission', async () => {
    const { manifest, ids } = reviewedManifestWithProviderIds();
    await admitGraphCorpus(isoDb, manifest);
    const refA = await realReference(ids.a);
    const refB = await realReference(ids.b);

    const { principal, ctx } = await isoAccountCtx();
    const accountId = principal.accountId;
    const itemB = await itemOn(accountId, refB);
    await photoCaptureIso(ctx, accountId, { referenceId: refA, resolution: 'resolved', certainty: 0.72 });
    await projectIso(accountId);

    const result = await expandIso(accountId);
    expect(result.expanded).toBe(true);
    expect(result.counts.photoRoots).toBe(1);
    expect(result.counts.photoReferencesUnmapped).toBe(0);
    expect(result.counts.photoReferencesUnprojected).toBe(0);
    expect(result.counts.referencesLinked).toBe(1);
    const photo = result.candidates.find((o) => o.intent === 'photo');
    expect(photo).toBeDefined();
    expect(photo!.discoveryItemId).toBe(itemB);
    expect(result.counts.recommendationsPublished).toBe(1);
    expect(photo!.assertions).toHaveLength(2);
  });

  it('adding a personal creator root cannot erase the supported two-hop connection (DISC-SCR-005)', async () => {
    const { manifest, ids } = reviewedManifestWithProviderIds();
    await admitGraphCorpus(isoDb, manifest);
    const refA = await realReference(ids.a);
    const refB = await realReference(ids.b);
    const refC = await realReference(ids.c, 'creator');

    const { principal, ctx } = await isoAccountCtx();
    const accountId = principal.accountId;
    const itemA = await itemOn(accountId, refA);
    const itemB = await itemOn(accountId, refB);
    const itemC = await itemOn(accountId, refC);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemA });
    await projectIso(accountId);

    // One root: A→C→B is a valid, supported two-hop connection.
    const before = await expandIso(accountId);
    expect(before.candidates.map((o) => o.nodeId)).toHaveLength(1);
    const candidateNodeId = before.candidates[0]!.nodeId;
    expect(before.counts.assertionsTraversed).toBe(2);

    // A legitimate personal creator root below every bound joins the walk...
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemC });
    await projectIso(accountId);
    const after = await expandIso(accountId);
    expect(after.counts.personalRoots).toBe(2);
    // ...and the existing supported connection survives: the B–C edge loaded
    // in hop one (from root C) is reused as the second hop for root A.
    expect(after.candidates.map((o) => o.nodeId)).toContain(candidateNodeId);
    expect(after.counts.admitted).toBe(1);
    expect(after.counts.recommendationsPublished).toBe(1);
    // Both assertions still count once: distinct rows traversed, not walks.
    expect(after.counts.assertionsTraversed).toBe(2);
    const obs = after.candidates.find((o) => o.nodeId === candidateNodeId)!;
    expect(obs.assertions).toHaveLength(2);
    expect(new Set(obs.assertions.map((a) => a.id)).size).toBe(2);
    // The surviving candidate still materializes onto the same real item.
    expect(obs.discoveryItemId).toBe(itemB);
  });

  it('adding a photo creator root cannot erase the supported two-hop connection (DISC-SCR-005)', async () => {
    const { manifest, ids } = reviewedManifestWithProviderIds();
    await admitGraphCorpus(isoDb, manifest);
    const refA = await realReference(ids.a);
    const refB = await realReference(ids.b);
    const refC = await realReference(ids.c, 'creator');

    const { principal, ctx } = await isoAccountCtx();
    const accountId = principal.accountId;
    const itemA = await itemOn(accountId, refA);
    await itemOn(accountId, refB);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemA });
    await projectIso(accountId);

    const before = await expandIso(accountId);
    expect(before.candidates).toHaveLength(1);
    const candidateNodeId = before.candidates[0]!.nodeId;

    // A legitimate photo root on the creator joins the walk: its B–C edge is
    // loaded in hop one, and the existing A→C→B connection must survive.
    await photoCaptureIso(ctx, accountId, { referenceId: refC, resolution: 'resolved' });
    await projectIso(accountId);
    const after = await expandIso(accountId);
    expect(after.counts.personalRoots).toBe(1);
    expect(after.counts.photoRoots).toBe(1);
    expect(after.candidates.map((o) => o.nodeId)).toContain(candidateNodeId);
    expect(after.candidates.find((o) => o.nodeId === candidateNodeId)!.intent).toBe('personal');
    expect(after.counts.assertionsTraversed).toBe(2);
    expect(after.counts.admitted).toBe(1);
  });
});

// --- The logical deadline governs the whole pass (VAL-DISC-006, DISC-SCR-006) ---

describe('the anchored logical deadline governs the whole expansion pass', () => {
  /** A would-be publishable account: one projected personal root ready to walk. */
  async function deadlineFixture() {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    await savedRoot(ctx, accountId);
    await project(accountId);
    return { accountId };
  }

  it('a pass whose logical window already ended publishes nothing', async () => {
    const { accountId } = await deadlineFixture();
    const runsBefore = Number(
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1', [accountId])).rows[0]!.n,
    );

    // The window ended before this pass started (a delayed claim or a
    // redelivery inheriting an old anchor): the engine enforces the durable
    // boundary for direct callers too — no run, no publication, nothing kept.
    const result = await expandAccountInterestGraph(db, {
      accountId,
      config: graphOn,
      deadline: { at: new Date(Date.now() - 1) },
    });
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe('deadline_expired');

    const runsAfter = Number(
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1', [accountId])).rows[0]!.n,
    );
    expect(runsAfter).toBe(runsBefore);
    expect(await activeFrontierCount(accountId)).toBe(0);
    expect(await proofRows(accountId)).toHaveLength(0);
  });

  it('a pass whose worker signal already aborted publishes nothing', async () => {
    const { accountId } = await deadlineFixture();
    const runsBefore = Number(
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1', [accountId])).rows[0]!.n,
    );
    const controller = new AbortController();
    controller.abort();

    // The worker's cooperative stop (lease loss, cancellation) must halt the
    // engine before any write: the pass never gets to publish on a dead grant.
    const result = await expandAccountInterestGraph(db, {
      accountId,
      config: graphOn,
      deadline: { at: new Date(Date.now() + GRAPH_EXPANSION_DEADLINE_MS), signal: controller.signal },
    });
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe('deadline_expired');
    const runsAfter = Number(
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1', [accountId])).rows[0]!.n,
    );
    expect(runsAfter).toBe(runsBefore);
    expect(await activeFrontierCount(accountId)).toBe(0);
  });
});

// --- Live photo-analysis authority at publication (DISC-SCR-007) ------------------------

describe('live photo-analysis authority at the publication fence (DISC-SCR-007)', () => {
  /**
   * Resolves once at least `atLeast` backends are observed WAITING on a lock
   * whose in-flight query matches `pattern`. Fails honestly on timeout, so a
   * barrier cannot pass by racing past the park.
   */
  async function waitForLockWaiters(pattern: string, atLeast: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND datname = current_database()`,
        [pattern],
      );
      if (Number(rows[0]!.n) >= atLeast) return;
      if (Date.now() >= deadline)
        throw new Error(`expected at least ${atLeast} lock waiter(s) matching ${pattern} within ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * A publishable photo-rooted fixture: one explicitly saved capture whose
   * active analysis A authorizes a depicted corpus reference, projected, with
   * a justified creator path to a materializable candidate.
   */
  async function photoFixture() {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const photo = await corpusNode({ kind: 'work', name: 'Photo subject A' });
    const cap = await photoCapture(ctx, accountId, { referenceId: photo.referenceId!, certainty: 0.72, anchor: true });
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const candidate = await corpusNode({ kind: 'work' });
    await justifiedEdge({ subject: photo.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    await candidateItem(accountId, candidate.referenceId);
    await project(accountId);
    const { rows: refRows } = await db.query<{ id: string }>(
      'SELECT id FROM capture_references WHERE analysis_id = $1 AND reference_id = $2',
      [cap.analysisId, photo.referenceId],
    );
    const captureReferenceA = refRows[0]!;
    // A's projected support is live before the pass.
    expect(await captureReferenceEdge(accountId, captureReferenceA.id)).not.toBeNull();
    return { accountId, captureId: cap.captureId, analysisA: cap.analysisId, captureReferenceA };
  }

  it('activation A→B before projection catches up rejects the stale A-rooted pass', async () => {
    const { accountId, captureId, analysisA, captureReferenceA } = await photoFixture();

    // Another connection holds the account row FOR UPDATE: the pass parks on
    // its graph_runs insert right AFTER reading its authoritative snapshot
    // (analysis A), which is exactly the mid-pass hold the scrutiny gap needs.
    const holder = await db.pool.connect();
    let holderOpen = true;
    let pass: Promise<ExpansionResult> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);

      pass = expandAccountInterestGraph(db, { accountId, config: graphOn, at: new Date() });
      void pass.catch(() => undefined);
      await waitForLockWaiters('%graph_runs%', 1);

      // While the pass is parked (its snapshot walked analysis A), the
      // capture's active analysis switches to a fresh analysis B. Activation
      // deliberately does NOT bump the taste revision, and projection has
      // NOT caught up — the lagging projected support for A is still active.
      const analysisB = (
        await db.query<{ id: string }>(
          `INSERT INTO analyses (capture_id, version, compiler_version, title, interpretation, section_statuses)
           VALUES ($1, 2, 'test', 'A cloudy harbor pier', 'Different references stood out.', '{"observations":"complete"}')
           RETURNING id`,
          [captureId],
        )
      ).rows[0]!;
      expect(analysisB.id).not.toBe(analysisA);
      const otherReference = await insertReference({ name: `Subject B ${randomUUID().slice(0, 6)}` }, db);
      await db.query(
        `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor, text_only, read_text)
         VALUES ($1, $2, 'depicted', 0.9, 'resolved', true, false, NULL)`,
        [analysisB.id, otherReference],
      );
      await db.query('UPDATE captures SET active_analysis_id = $2 WHERE id = $1', [captureId, analysisB.id]);
      // Lagging projection: A's projected support rows are STILL active — a
      // fence that trusts them would publish the stale A-rooted pass.
      expect(await captureReferenceEdge(accountId, captureReferenceA.id)).not.toBeNull();

      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    const result = await pass!;
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe('support_withdrawn');
    // Nothing survived: no run, no recommendation, no proof, no frontier.
    expect(await activeFrontierCount(accountId)).toBe(0);
    expect(await proofRows(accountId)).toHaveLength(0);
    const { rows: recs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM recommendations WHERE owner_account_id = $1 AND graph_run_id IS NOT NULL`,
      [accountId],
    );
    expect(Number(recs[0]!.n)).toBe(0);
    const { rows: runs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'`,
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(0);
    // And the rejection came from LIVE authority, not from projection having
    // caught up: the projected support for A is still there.
    expect(await captureReferenceEdge(accountId, captureReferenceA.id)).not.toBeNull();
  });

  it('unchanged live photo authority publishes through the same held-lock barrier', async () => {
    const { accountId } = await photoFixture();

    const holder = await db.pool.connect();
    let holderOpen = true;
    let pass: Promise<ExpansionResult> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      pass = expandAccountInterestGraph(db, { accountId, config: graphOn, at: new Date() });
      void pass.catch(() => undefined);
      await waitForLockWaiters('%graph_runs%', 1);
      // No activation: the live capture/active-analysis/reference authority
      // the pass walked is still current when the fence re-reads it.
      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    const result = await pass!;
    expect(result.expanded).toBe(true);
    expect(result.counts.photoRoots).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(1);
    const { rows: runs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'`,
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(1);
  });

  // --- DISC-SCR-020: the live capture authority is ordered with activation ------

  /**
   * A Db view of one dedicated pool client that joins the CALLER's
   * already-open transaction instead of issuing its own BEGIN/COMMIT: the
   * real activation runs its exact production statements while the test
   * holds the commit barrier on that connection.
   */
  function openTransactionDb(client: PoolClient): Db {
    const self: Db = {
      inTransaction: true,
      query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
        return client.query<R>(text, params as unknown[] | undefined);
      },
      transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        return fn(self);
      },
    };
    return self;
  }

  /**
   * A serializing Queryable over the caller's transaction handle. The
   * publication fence ends in `loadExplicitSupport`, a shared reader that
   * fires concurrent queries by design on pools; on ONE transaction client
   * those must be queued through a promise chain (exactly what the engine
   * passes the fence), or a failed query can strand the client's queue
   * mid-test.
   */
  function serializedTx(tx: Queryable): Queryable {
    const tail: { p: Promise<unknown> } = { p: Promise.resolve() };
    return {
      query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
        const p = tail.p.then(() => tx.query<R>(text, params));
        tail.p = p.then(
          () => undefined,
          () => undefined,
        );
        return p;
      },
    };
  }

  /** Resolves when `awaitable` does, or fails honestly after `timeoutMs`. */
  async function withDeadline(awaitable: Promise<void>, what: string, timeoutMs = 5_000): Promise<void> {
    let timeout!: ReturnType<typeof setTimeout>;
    const guard = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${what} within ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([awaitable, guard]);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** A fresh analysis B (version 2) with its own authorized depicted reference. */
  async function analysisBWithReference(captureId: string): Promise<string> {
    const analysisB = (
      await db.query<{ id: string }>(
        `INSERT INTO analyses (capture_id, version, compiler_version, title, interpretation, section_statuses)
         VALUES ($1, 2, 'test', 'A cloudy harbor pier', 'Different references stood out.', '{"observations":"complete"}')
         RETURNING id`,
        [captureId],
      )
    ).rows[0]!;
    const otherReference = await insertReference({ name: `Subject B ${randomUUID().slice(0, 6)}` }, db);
    await db.query(
      `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor, text_only, read_text)
       VALUES ($1, $2, 'depicted', 0.9, 'resolved', true, false, NULL)`,
      [analysisB.id, otherReference],
    );
    return analysisB.id;
  }

  it('publisher-first: an activation arriving after the live check queues for the publication commit, then lands (DISC-SCR-020)', async () => {
    const { accountId, captureId, analysisA, captureReferenceA } = await photoFixture();
    const analysisB = await analysisBWithReference(captureId);

    // Park the pass INSIDE its publication transaction, past the fence's
    // live capture check, at the caller's fence hook — the drift window the
    // scrutiny gap needs (an activation arriving here, before the commit,
    // used to be able to land while the pass published stale A-rooted
    // output).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked!: () => void;
    const parkedPastLiveCheck = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const pass = expandAccountInterestGraph(db, {
      accountId,
      config: graphOn,
      at: new Date(),
      fence: async () => {
        parked();
        await gate;
      },
    });
    void pass.catch(() => undefined);
    await withDeadline(parkedPastLiveCheck, 'the pass never reached its post-fence hook');

    // The REAL activation writer arrives after the live check. It must queue
    // for the captures row the publication holds through its commit.
    const activation = db.transaction((tx) => activateAnalysis(tx, { captureId, analysisId: analysisB }));
    void activation.catch(() => undefined);
    try {
      await waitForLockWaiters('%UPDATE captures%', 1);
      // PROOF of held authority: while the publication is parked, the
      // activation has NOT committed — the live pointer is still analysis A.
      const parkedPointer = await db.query<{ active_analysis_id: string | null }>(
        'SELECT active_analysis_id FROM captures WHERE id = $1',
        [captureId],
      );
      expect(parkedPointer.rows[0]!.active_analysis_id).toBe(analysisA);
    } finally {
      release();
    }
    // The publication committed under the authority it walked (A)...
    const result = await pass;
    expect(result.expanded).toBe(true);
    expect(result.counts.photoRoots).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(1);
    const { rows: runs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'`,
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(1);
    // ...and only then did the activation land (B). The delayed activation
    // is the whole point: the pass held the capture authority through its
    // commit instead of publishing while B slipped in underneath.
    expect(await activation).toBe(true);
    const after = await db.query<{ active_analysis_id: string | null }>(
      'SELECT active_analysis_id FROM captures WHERE id = $1',
      [captureId],
    );
    expect(after.rows[0]!.active_analysis_id).toBe(analysisB);
    // Projection never caught up mid-window: A's projected support is still
    // live, and the NEXT refresh walks B.
    expect(await captureReferenceEdge(accountId, captureReferenceA.id)).not.toBeNull();
  });

  it('activation-first: an uncommitted activation holding the capture authority parks the live check; on its commit the stale A-rooted pass is rejected despite lagging projection (DISC-SCR-020)', async () => {
    const { accountId, captureId, captureReferenceA } = await photoFixture();
    const analysisB = await analysisBWithReference(captureId);

    const holder = await db.pool.connect();
    let holderOpen = true;
    let pass: Promise<ExpansionResult> | undefined;
    try {
      await holder.query('BEGIN');
      // The REAL activation writer runs inside the holder's open
      // transaction: the captures row lock is held with the A→B pointer move
      // uncommitted while the pass reaches its live authority check.
      expect(await activateAnalysis(openTransactionDb(holder), { captureId, analysisId: analysisB })).toBe(true);

      pass = expandAccountInterestGraph(db, { accountId, config: graphOn, at: new Date() });
      void pass.catch(() => undefined);
      // The fence's live capture authority read queues behind the writer.
      await waitForLockWaiters('%FROM captures%FOR NO KEY UPDATE%', 1);

      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // Activation-first: the fence read the writer's COMMITTED pointer B, so
    // the stale A-rooted pass is rejected — while projection still lags
    // (A's support edge is live), proving the rejection came from live
    // authority, not from projection having caught up.
    const result = await pass!;
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe('support_withdrawn');
    expect(await activeFrontierCount(accountId)).toBe(0);
    expect(await proofRows(accountId)).toHaveLength(0);
    const { rows: recs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM recommendations WHERE owner_account_id = $1 AND graph_run_id IS NOT NULL`,
      [accountId],
    );
    expect(Number(recs[0]!.n)).toBe(0);
    const { rows: runs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'`,
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(0);
    expect(await captureReferenceEdge(accountId, captureReferenceA.id)).not.toBeNull();
    const after = await db.query<{ active_analysis_id: string | null }>(
      'SELECT active_analysis_id FROM captures WHERE id = $1',
      [captureId],
    );
    expect(after.rows[0]!.active_analysis_id).toBe(analysisB);
  });

  it("the publication fence's successive account-then-capture waits each honor the CURRENT remainder (DISC-SCR-025)", async () => {
    // The publication fence is ONE helper with SEVERAL independent lock
    // waits: the account publication-authority lock, then the ranked photo's
    // capture lock. A bound computed once at fence entry is stale by the
    // second wait — the first wait's consumed time must not widen the second
    // wait's allowance past the anchor. Two connections hold the two waits:
    // the account holder releases INSIDE the window, the capture holder never
    // releases. The pass must reject AT the anchored deadline — never a full
    // entry-bound later, never on the second holder's release.
    const { accountId, captureId } = await photoFixture();
    const deadlineAt = new Date(Date.now() + 4_000);

    const accountHolder = await db.pool.connect();
    const captureHolder = await db.pool.connect();
    let pass: Promise<ExpansionResult> | undefined;
    try {
      // Wait #2 first, on the ground: the capture row lock is held before the
      // pass starts, so the fence's live-capture check deterministically
      // parks on it once the account wait released.
      await captureHolder.query('BEGIN');
      await captureHolder.query('SELECT id FROM captures WHERE id = $1 FOR NO KEY UPDATE', [captureId]);

      // Wait #1: the fence parks on the held account-authority lock (a short
      // wait that fits the fence-entry bound).
      await accountHolder.query('BEGIN');
      await accountHolder.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [accountId]);
      pass = expandAccountInterestGraph(db, {
        accountId,
        config: graphOn,
        at: new Date(),
        deadline: { at: deadlineAt },
      });
      void pass.catch(() => undefined);
      await waitForLockWaiters('%accounts WHERE id = $1 FOR NO KEY UPDATE%', 1);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await accountHolder.query('COMMIT');

      // The pass proceeds past the short first wait and parks on the capture
      // holder's row — a LATE wait, started well after the bound was last
      // computed at the fence's entry.
      await waitForLockWaiters('%FROM captures%FOR NO KEY UPDATE%', 1);

      // The rejection is the typed deadline-expired result and lands AT the
      // anchored deadline: the second wait was bounded by the CURRENT
      // remainder — never by the fence-entry bound (a full window past it)
      // and never by the capture holder's release (which stays held).
      const result = await pass;
      expect(result.expanded).toBe(false);
      expect(result.reason).toBe('deadline_expired');
      expect(Date.now() - deadlineAt.getTime()).toBeLessThanOrEqual(700);
    } finally {
      await accountHolder.query('ROLLBACK').catch(() => undefined);
      await captureHolder.query('ROLLBACK').catch(() => undefined);
      accountHolder.release();
      captureHolder.release();
    }

    // The whole pass rolled back: no run, no recommendation, no proof, no
    // frontier — the successive-wait overrun published nothing.
    const { rows: runs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'`,
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(0);
    expect(await activeFrontierCount(accountId)).toBe(0);
    expect(await proofRows(accountId)).toHaveLength(0);
    const { rows: recs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM recommendations WHERE owner_account_id = $1 AND graph_run_id IS NOT NULL`,
      [accountId],
    );
    expect(Number(recs[0]!.n)).toBe(0);
  });

  // --- DISC-SCR-027: admitted-unranked photo observations fence too ----------

  /**
   * A photo-rooted fixture whose ONE root reaches FOUR same-creator candidates
   * through one shared midpoint: rail diversification
   * (EXPANSION_BOUNDS.maxCandidatesPerMidpoint) ranks three candidates and
   * retains the fourth as ADMITTED-UNRANKED frontier. All four observations
   * score identically (same template, same root), so the rails order by
   * candidate node id ASC: the three smallest node ids are the ranked cards,
   * and the largest is the diversified-out survivor. Returns the three RANKED
   * candidates' second-edge assertions so a mid-pass corpus support addition
   * can bump exactly their revisions — dropping them from the rails without
   * promoting the survivor — plus the survivor's node id.
   */
  async function photoFixtureWithUnrankedSurvivor() {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const photo = await corpusNode({ kind: 'work', name: 'Photo subject A' });
    const cap = await photoCapture(ctx, accountId, { referenceId: photo.referenceId!, certainty: 0.72, anchor: true });
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    await justifiedEdge({ subject: photo.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const candidates: Array<{ nodeId: string; edge: Awaited<ReturnType<typeof justifiedEdge>> }> = [];
    for (let i = 0; i < 4; i += 1) {
      const candidate = await corpusNode({ kind: 'work' });
      const edge = await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
      await candidateItem(accountId, candidate.referenceId);
      candidates.push({ nodeId: candidate.node.id, edge });
    }
    await project(accountId);
    const { rows: refRows } = await db.query<{ id: string }>(
      'SELECT id FROM capture_references WHERE analysis_id = $1 AND reference_id = $2',
      [cap.analysisId, photo.referenceId],
    );
    const captureReferenceA = refRows[0]!;
    // A's projected support is live before the pass.
    expect(await captureReferenceEdge(accountId, captureReferenceA.id)).not.toBeNull();
    const byNode = [...candidates].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
    return {
      accountId,
      captureId: cap.captureId,
      analysisA: cap.analysisId,
      captureReferenceA,
      survivorNodeId: byNode[3]!.nodeId,
      rankedEdges: byNode.slice(0, 3).map((c) => c.edge),
    };
  }

  /**
   * Starts a photo expansion pass and empties its RAILS mid-pass: a real
   * corpus support addition (attachAssertionSupport, the same writer the
   * retained-pin race used) bumps exactly the three ranked candidates'
   * second-edge assertion revisions inside a second connection's OPEN
   * transaction, so the pass parks on its FOR SHARE pin locks; committing
   * that holder makes the pre-write pin validation drop all three ranked
   * observations. The pass continues with ranked EMPTY while the fourth,
   * diversified-out candidate still commits an ADMITTED-UNRANKED frontier
   * row — the exact DISC-SCR-027 committing population. Resolves once the
   * pin-drop holder has committed; `pass` is the still-in-flight expansion
   * (wrapped in an object so awaiting this helper does NOT await the pass
   * itself, which can legitimately stay parked inside its publication
   * transaction).
   */
  async function startEmptyRankedPhotoPass(
    accountId: string,
    rankedEdges: ReadonlyArray<{ assertionId: string }>,
    over: { fence?: (tx: Queryable) => Promise<void> } = {},
  ): Promise<{ pass: Promise<ExpansionResult> }> {
    const supports: Array<Awaited<ReturnType<typeof evidence>>> = [];
    for (let i = 0; i < rankedEdges.length; i += 1) supports.push(await evidence());
    const pinHolder = await db.pool.connect();
    let holderOpen = true;
    let pass: Promise<ExpansionResult> | undefined;
    try {
      await pinHolder.query('BEGIN');
      const holderDb = openTransactionDb(pinHolder);
      for (const [i, edge] of rankedEdges.entries()) {
        await attachAssertionSupport(holderDb, {
          assertionId: edge.assertionId,
          evidenceId: supports[i]!.evidenceId,
          derivation: 'primary',
          sourceFamilyKey: supports[i]!.familyKey,
        });
      }
      pass = expandAccountInterestGraph(db, { accountId, config: graphOn, at: new Date(), fence: over.fence });
      void pass.catch(() => undefined);
      await waitForLockWaiters('%graph_assertions%FOR SHARE%', 1);
      await pinHolder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await pinHolder.query('ROLLBACK').catch(() => undefined);
      pinHolder.release();
    }
    return { pass: pass! };
  }

  it('empty-ranked survivor, activation-first: an activation committed before the fence rejects the stale A-rooted frontier pass despite lagging projection (DISC-SCR-027)', async () => {
    const { accountId, captureId, captureReferenceA, rankedEdges } = await photoFixtureWithUnrankedSurvivor();
    const analysisB = await analysisBWithReference(captureId);

    // The REAL activation writer holds the capture authority open: the A→B
    // pointer move is uncommitted while the pass reaches its publication
    // fence with ranked EMPTY and one admitted-unranked photo survivor.
    const captureHolder = await db.pool.connect();
    let captureOpen = true;
    let pass: Promise<ExpansionResult> | undefined;
    try {
      await captureHolder.query('BEGIN');
      expect(await activateAnalysis(openTransactionDb(captureHolder), { captureId, analysisId: analysisB })).toBe(true);

      ({ pass } = await startEmptyRankedPhotoPass(accountId, rankedEdges));

      // The fence's live capture authority read must cover the
      // admitted-unranked survivor too: it queues behind the writer's row
      // lock (pre-repair, a ranked-empty pass took no capture lock at all
      // and the stale frontier row committed).
      await waitForLockWaiters('%FROM captures%FOR NO KEY UPDATE%', 1);

      await captureHolder.query('COMMIT');
      captureOpen = false;
    } finally {
      if (captureOpen) await captureHolder.query('ROLLBACK').catch(() => undefined);
      captureHolder.release();
    }

    // Activation-first: the fence read the writer's COMMITTED pointer B, so
    // the stale A-rooted pass is rejected — while projection still lags (A's
    // support edge is live), proving the rejection came from live capture
    // authority, not from projection having caught up.
    const result = await pass!;
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe('support_withdrawn');
    // The admitted-unranked photo frontier row did NOT survive: no run, no
    // frontier row, no card, no proof.
    expect(await activeFrontierCount(accountId)).toBe(0);
    expect(await proofRows(accountId)).toHaveLength(0);
    const { rows: recs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM recommendations WHERE owner_account_id = $1 AND graph_run_id IS NOT NULL`,
      [accountId],
    );
    expect(Number(recs[0]!.n)).toBe(0);
    const { rows: runs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'`,
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(0);
    expect(await captureReferenceEdge(accountId, captureReferenceA.id)).not.toBeNull();
    const after = await db.query<{ active_analysis_id: string | null }>(
      'SELECT active_analysis_id FROM captures WHERE id = $1',
      [captureId],
    );
    expect(after.rows[0]!.active_analysis_id).toBe(analysisB);
  });

  it('empty-ranked survivor, publisher-first: an activation arriving after the live check queues for the publication commit, then lands (DISC-SCR-027)', async () => {
    const { accountId, captureId, analysisA, captureReferenceA, rankedEdges, survivorNodeId } =
      await photoFixtureWithUnrankedSurvivor();
    const analysisB = await analysisBWithReference(captureId);

    // Park the pass INSIDE its publication transaction at the caller's fence
    // hook — past the fence's live capture check (which now covers the
    // admitted-unranked survivor), before the commit.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked!: () => void;
    const parkedPastLiveCheck = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const { pass } = await startEmptyRankedPhotoPass(accountId, rankedEdges, {
      fence: async () => {
        parked();
        await gate;
      },
    });
    await withDeadline(parkedPastLiveCheck, 'the pass never reached its post-fence hook');

    // The REAL activation writer arrives after the live check. It must queue
    // for the captures row the publication now HOLDS through its commit.
    const activation = db.transaction((tx) => activateAnalysis(tx, { captureId, analysisId: analysisB }));
    void activation.catch(() => undefined);
    try {
      await waitForLockWaiters('%UPDATE captures%', 1);
      // PROOF of held authority: while the publication is parked, the
      // activation has NOT committed — the live pointer is still analysis A.
      const parkedPointer = await db.query<{ active_analysis_id: string | null }>(
        'SELECT active_analysis_id FROM captures WHERE id = $1',
        [captureId],
      );
      expect(parkedPointer.rows[0]!.active_analysis_id).toBe(analysisA);
    } finally {
      release();
    }

    // The publication committed the admitted-unranked survivor under the
    // authority it walked (A) — with ranked EMPTY the whole way: no card.
    const result = await pass;
    expect(result.expanded).toBe(true);
    expect(result.counts.photoRoots).toBe(1);
    // The fixture shape is pinned: three ranked observations dropped at the
    // pre-write pin validation (their revisions bumped mid-pass) and the
    // fourth stayed diversified-out — never promoted.
    expect(result.counts.stalePinsBlocked).toBe(3);
    expect(result.rejections['pinned_assertion_revision_changed']).toBe(3);
    expect(result.counts.diversifiedOut).toBe(1);
    expect(result.counts.frontierCreated).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(0);
    expect(result.candidates).toHaveLength(0);
    // ...and only then did the activation land (B).
    expect(await activation).toBe(true);
    const after = await db.query<{ active_analysis_id: string | null }>(
      'SELECT active_analysis_id FROM captures WHERE id = $1',
      [captureId],
    );
    expect(after.rows[0]!.active_analysis_id).toBe(analysisB);
    // The survivor's frontier row committed ADMITTED (no card exists),
    // pinned to A's projected capture-reference support root — projection
    // never caught up mid-window, and the NEXT refresh walks B.
    expect(await activeFrontierCount(accountId)).toBe(1);
    const edge = await captureReferenceEdge(accountId, captureReferenceA.id);
    expect(edge).not.toBeNull();
    const { rows: survivor } = await db.query<{ state: string; root_ids: string[] }>(
      `SELECT f.state, COALESCE(array_agg(sr.root_id ORDER BY sr.root_id), ARRAY[]::uuid[]) AS root_ids
         FROM graph_frontier f
         LEFT JOIN graph_frontier_support_roots sr
           ON sr.frontier_id = f.id AND sr.owner_account_id = f.owner_account_id
        WHERE f.owner_account_id = $1 AND f.node_id = $2
        GROUP BY f.id, f.state`,
      [accountId, survivorNodeId],
    );
    expect(survivor[0]!.state).toBe('admitted');
    expect(survivor[0]!.root_ids).toEqual([edge]);
  });

  it('the fence decides the admitted-unranked photo survivor directly: activation A→B rejects what a ranked-empty pass would commit (DISC-SCR-027)', async () => {
    const { accountId, captureId, captureReferenceA } = await photoFixture();
    const analysisB = await analysisBWithReference(captureId);
    const first = await expand(accountId);
    if (!first.expanded) throw new Error(`fixture did not publish: ${first.reason}`);
    const photo = first.candidates.find((o) => o.relevance.kind === 'photo');
    if (!photo) throw new Error('fixture lost its photo candidate');
    const { rows: state } = await db.query<{ projection_revision: number; deletion_generation: number }>(
      'SELECT projection_revision, deletion_generation FROM personal_graph_state WHERE owner_account_id = $1',
      [accountId],
    );
    const start = {
      projectionRevision: state[0]!.projection_revision,
      generation: state[0]!.deletion_generation,
      tasteRevision: (await db.query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [accountId]))
        .rows[0]!.revision,
    };

    // Pre-activation, the admitted-unranked population may commit.
    const clean = await db.transaction(async (tx) =>
      checkGraphPublicationFence(serializedTx(tx), { accountId, start, ranked: [], admittedUnranked: [photo] }),
    );
    expect(clean).toBeNull();

    // The real activation commits mid-pass (no projection catch-up: the
    // projected support for A is still live).
    expect(await db.transaction((tx) => activateAnalysis(tx, { captureId, analysisId: analysisB }))).toBe(true);
    expect(await captureReferenceEdge(accountId, captureReferenceA.id)).not.toBeNull();

    // The same admitted-unranked population is now stale A-rooted support:
    // the fence rejects the whole pass (pre-repair it never looked at this
    // population's relevance and returned null).
    const stale = await db.transaction(async (tx) =>
      checkGraphPublicationFence(serializedTx(tx), { accountId, start, ranked: [], admittedUnranked: [photo] }),
    );
    expect(stale).toBe('support_withdrawn');
  });
});

