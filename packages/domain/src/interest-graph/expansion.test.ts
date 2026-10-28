import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context';
import type { PoolDb } from '../db/pool';
import type { GraphNodeDomain, GraphNodeKind, GraphPredicate } from './schema';
import { accountCtx, insertCaptureWithAnalysis, insertItem, insertReference } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { submitCorrection } from '../services/analyses';
import { recordPreference } from '../services/preferences';
import {
  attachAssertionSupport,
  insertEvidence,
  recordSourceRevision,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from './evidence';
import { projectAccountInterestGraph } from './projector';
import { createGraphRun } from './store';
import { currentAssertionJustification } from './validity';
import { EXPANSION_BOUNDS, RANKING_POLICY_VERSION, expandAccountInterestGraph } from './expansion';

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
