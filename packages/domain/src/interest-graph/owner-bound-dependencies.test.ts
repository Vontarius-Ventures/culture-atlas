import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAccount } from '../testing';
import type { PoolDb } from '../db/pool';
import {
  createGraphRun,
  insertGraphRecommendation,
  insertRecommendationProof,
  loadGraphRunCards,
  upsertFrontierCandidate,
} from './store';

/**
 * Foundation scrutiny repair (VAL-PROJ-001): direct-database owner binding for
 * the optional private dependencies of the graph schema.
 *
 * - A graph_private_links row cannot name a foreign or nonexistent capture
 *   reference with a NULL analysis: reference-bearing links must carry their
 *   analysis, so the owner-bound capture/analysis ancestry foreign keys apply.
 * - Every frontier support root and recommendation-proof support edge lives in
 *   an owner-bound typed relation, composite-bound to its container AND to the
 *   account-owned private edge: an owner-valid container alone is not enough,
 *   even through direct SQL. Pinned public dependencies (assertions/evidence)
 *   remain permitted, owner-scoped readers cannot disclose foreign private
 *   support ids, and valid same-owner/public forms survive deletion and
 *   retraction.
 */

const db = getTestDb();
afterAll(closeTestDb);

// --- Fixtures -----------------------------------------------------------------

async function graphNode(dbh: PoolDb, key = randomUUID()): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO graph_nodes (canonical_key, canonical_name, name_key, node_kind, domain, sense_key)
     VALUES ($1, $2, $3, 'creator', 'art', 'person') RETURNING id`,
    [`atlas:${key}`, `Name ${key}`, `name-${key}`],
  );
  return rows[0]!.id;
}

async function accountItem(dbh: PoolDb, accountId: string, key = randomUUID()): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title)
     VALUES ($1, 'film', 'watch', $2, 'A film') RETURNING id`,
    [accountId, `qloo:${key}`],
  );
  return rows[0]!.id;
}

/** One capture with one analysis and one resolved capture reference, all owned by the account. */
async function captureWithReference(
  dbh: PoolDb,
  accountId: string,
): Promise<{ captureId: string; analysisId: string; referenceId: string }> {
  const c = await dbh.query<{ id: string }>(
    `INSERT INTO captures (owner_account_id, source, image_sha256) VALUES ($1, 'upload', $2) RETURNING id`,
    [accountId, randomUUID()],
  );
  const a = await dbh.query<{ id: string }>(
    `INSERT INTO analyses (capture_id, version, compiler_version) VALUES ($1, 1, 'test') RETURNING id`,
    [c.rows[0]!.id],
  );
  const r = await dbh.query<{ id: string }>(
    `INSERT INTO cultural_references (canonical_name, canonical_key, type) VALUES ($1, $2, 'work') RETURNING id`,
    ['A work', `work:${randomUUID()}`],
  );
  const cr = await dbh.query<{ id: string }>(
    `INSERT INTO capture_references (analysis_id, reference_id, relation) VALUES ($1, $2, 'depicted') RETURNING id`,
    [a.rows[0]!.id, r.rows[0]!.id],
  );
  return { captureId: c.rows[0]!.id, analysisId: a.rows[0]!.id, referenceId: cr.rows[0]!.id };
}

/** One private explicit edge owned by the account (the valid frontier/proof dependency form). */
async function explicitEdge(dbh: PoolDb, accountId: string): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO personal_interest_edges (owner_account_id, node_id, origin, state, policy_version)
     VALUES ($1, $2, 'explicit', 'confirmed', 'graph-policy-1') RETURNING id`,
    [accountId, await graphNode(dbh)],
  );
  return rows[0]!.id;
}

async function frontierRoots(dbh: PoolDb, frontierId: string): Promise<string[]> {
  const { rows } = await dbh.query<{ roots: string[] }>(
    `SELECT COALESCE(array_agg(sr.root_id ORDER BY sr.root_id), ARRAY[]::uuid[]) AS roots
       FROM graph_frontier_support_roots sr WHERE sr.frontier_id = $1`,
    [frontierId],
  );
  return rows[0]!.roots;
}

async function proofSupportEdges(dbh: PoolDb, proofId: string): Promise<string[]> {
  const { rows } = await dbh.query<{ edges: string[] }>(
    `SELECT COALESCE(array_agg(se.support_edge_id ORDER BY se.support_edge_id), ARRAY[]::uuid[]) AS edges
       FROM recommendation_graph_proof_support_edges se WHERE se.proof_id = $1`,
    [proofId],
  );
  return rows[0]!.edges;
}

// --- Private capture-reference ancestry -----------------------------------------

describe('private capture-reference ancestry', () => {
  it('rejects foreign and nonexistent capture references when the analysis is null', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const n = await graphNode(db);
    const capA = await captureWithReference(db, a.accountId);
    const capB = await captureWithReference(db, b.accountId);

    // A foreign capture reference cannot ride on a NULL analysis: MATCH
    // SIMPLE must not be an ownership bypass.
    await expect(
      db.query(
        `INSERT INTO graph_private_links (owner_account_id, capture_id, capture_reference_id, node_id, interpretation)
         VALUES ($1, $2, $3, $4, 'ABOUT')`,
        [a.accountId, capA.captureId, capB.referenceId, n],
      ),
    ).rejects.toThrow(/check/i);
    // Neither can a nonexistent capture reference.
    await expect(
      db.query(
        `INSERT INTO graph_private_links (owner_account_id, capture_id, capture_reference_id, node_id, interpretation)
         VALUES ($1, $2, $3, $4, 'ABOUT')`,
        [a.accountId, capA.captureId, randomUUID(), n],
      ),
    ).rejects.toThrow(/check/i);
    // Nothing was written by either rejected insert.
    const { rows } = await db.query<{ n: string }>(
      'SELECT COUNT(*)::int AS n FROM graph_private_links WHERE owner_account_id = $1',
      [a.accountId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('accepts a reference-bearing link only through owner-bound capture/analysis ancestry', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const n = await graphNode(db);
    const capA = await captureWithReference(db, a.accountId);
    const capB = await captureWithReference(db, b.accountId);

    // The valid same-owner form: A's capture, A's analysis, A's reference.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO graph_private_links (owner_account_id, capture_id, analysis_id, capture_reference_id,
                                         node_id, interpretation)
       VALUES ($1, $2, $3, $4, $5, 'ABOUT') RETURNING id`,
      [a.accountId, capA.captureId, capA.analysisId, capA.referenceId, n],
    );
    expect(rows[0]!.id).toBeTruthy();

    // B's analysis does not belong to A's capture, so B's reference cannot be
    // attached even with an analysis named.
    await expect(
      db.query(
        `INSERT INTO graph_private_links (owner_account_id, capture_id, analysis_id, capture_reference_id,
                                           node_id, interpretation)
         VALUES ($1, $2, $3, $4, $5, 'ABOUT')`,
        [a.accountId, capA.captureId, capB.analysisId, capB.referenceId, n],
      ),
    ).rejects.toThrow(/foreign key/i);
    // A's link cannot sit on B's capture/analysis/reference chain either.
    await expect(
      db.query(
        `INSERT INTO graph_private_links (owner_account_id, capture_id, analysis_id, capture_reference_id,
                                           node_id, interpretation)
         VALUES ($1, $2, $3, $4, $5, 'ABOUT')`,
        [a.accountId, capB.captureId, capB.analysisId, capB.referenceId, n],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

// --- Owner-bound frontier support roots -------------------------------------------

describe('owner-bound frontier support roots', () => {
  it('binds each support root to the frontier row and its account, rejecting foreign and nonexistent ids', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const n = await graphNode(db);
    const edgeA = await explicitEdge(db, a.accountId);
    const edgeB = await explicitEdge(db, b.accountId);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const { rows: frontier } = await db.query<{ id: string }>(
      `INSERT INTO graph_frontier (owner_account_id, run_id, node_id, dedupe_key, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '7 days') RETURNING id`,
      [a.accountId, runA.id, n, `node:${n}`],
    );
    const frontierId = frontier[0]!.id;

    // The valid same-owner root binds.
    await db.query(
      `INSERT INTO graph_frontier_support_roots (frontier_id, owner_account_id, root_id)
       VALUES ($1, $2, $3)`,
      [frontierId, a.accountId, edgeA],
    );
    // Another account's private root is rejected even though the container is
    // owner-valid: owning the frontier row is not ownership of the dependency.
    await expect(
      db.query(
        `INSERT INTO graph_frontier_support_roots (frontier_id, owner_account_id, root_id)
         VALUES ($1, $2, $3)`,
        [frontierId, a.accountId, edgeB],
      ),
    ).rejects.toThrow(/foreign key/i);
    // A nonexistent root id is rejected.
    await expect(
      db.query(
        `INSERT INTO graph_frontier_support_roots (frontier_id, owner_account_id, root_id)
         VALUES ($1, $2, $3)`,
        [frontierId, a.accountId, randomUUID()],
      ),
    ).rejects.toThrow(/foreign key/i);
    // A dependency row must also carry the container's account, not just any
    // valid owner of the root edge.
    await expect(
      db.query(
        `INSERT INTO graph_frontier_support_roots (frontier_id, owner_account_id, root_id)
         VALUES ($1, $2, $3)`,
        [frontierId, b.accountId, edgeB],
      ),
    ).rejects.toThrow(/foreign key/i);

    expect(await frontierRoots(db, frontierId)).toEqual([edgeA]);
  });

  it('writer accepts same-owner roots, rejects foreign roots atomically, and dedupe keeps stored roots', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const edgeA = await explicitEdge(db, a.accountId);
    const edgeA2 = await explicitEdge(db, a.accountId);
    const edgeB = await explicitEdge(db, b.accountId);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const nodeX = await graphNode(db);
    const nodeY = await graphNode(db);

    // Valid same-owner roots attach to the created candidate.
    const up = await upsertFrontierCandidate(db, {
      ownerAccountId: a.accountId,
      runId: runA.id,
      nodeId: nodeX,
      dedupeKey: `node:${nodeX}`,
      expiresInDays: 7,
      supportRootIds: [edgeA, edgeA2],
    });
    expect(up.created).toBe(true);
    expect(up.row.support_root_ids).toEqual([edgeA, edgeA2].sort());
    expect(await frontierRoots(db, up.row.id)).toEqual([edgeA, edgeA2].sort());

    // A foreign root id is rejected and leaves no candidate behind.
    await expect(
      upsertFrontierCandidate(db, {
        ownerAccountId: a.accountId,
        runId: runA.id,
        nodeId: nodeY,
        dedupeKey: `node:${nodeY}`,
        expiresInDays: 7,
        supportRootIds: [edgeB],
      }),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      upsertFrontierCandidate(db, {
        ownerAccountId: a.accountId,
        runId: runA.id,
        nodeId: nodeY,
        dedupeKey: `node:${nodeY}`,
        expiresInDays: 7,
        supportRootIds: [randomUUID()],
      }),
    ).rejects.toThrow(/foreign key/i);
    const leftovers = await db.query<{ n: string }>(
      'SELECT COUNT(*)::int AS n FROM graph_frontier WHERE owner_account_id = $1 AND dedupe_key = $2',
      [a.accountId, `node:${nodeY}`],
    );
    expect(leftovers.rows[0]!.n).toBe(0);

    // A dedupe hit ignores newly offered roots and returns the stored ones.
    const again = await upsertFrontierCandidate(db, {
      ownerAccountId: a.accountId,
      runId: runA.id,
      nodeId: nodeX,
      dedupeKey: `node:${nodeX}`,
      expiresInDays: 7,
      supportRootIds: [edgeB],
    });
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(up.row.id);
    expect(again.row.support_root_ids).toEqual([edgeA, edgeA2].sort());
  });

  it('prunes only the deleted root while the frontier row and other dependencies survive', async () => {
    const a = await insertAccount(db);
    const edgeA = await explicitEdge(db, a.accountId);
    const edgeA2 = await explicitEdge(db, a.accountId);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const nodeX = await graphNode(db);
    const up = await upsertFrontierCandidate(db, {
      ownerAccountId: a.accountId,
      runId: runA.id,
      nodeId: nodeX,
      dedupeKey: `node:${nodeX}`,
      expiresInDays: 7,
      supportRootIds: [edgeA, edgeA2],
    });

    // Withdrawing the support edge removes exactly that dependency row; the
    // candidate and the still-valid root are untouched.
    await db.query('DELETE FROM personal_interest_edges WHERE id = $1', [edgeA2]);
    expect(await frontierRoots(db, up.row.id)).toEqual([edgeA]);
    const { rows } = await db.query<{ n: string }>('SELECT COUNT(*)::int AS n FROM graph_frontier WHERE id = $1', [
      up.row.id,
    ]);
    expect(rows[0]!.n).toBe(1);
  });
});

// --- Owner-bound proof support edges ----------------------------------------------

describe('owner-bound proof support edges', () => {
  async function proofFixture(
    accountId: string,
  ): Promise<{ runId: string; recommendationId: string; assertionId: string; evidenceId: string }> {
    const run = await createGraphRun(db, {
      ownerAccountId: accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const rec = await insertGraphRecommendation(db, {
      ownerAccountId: accountId,
      runId: run.id,
      discoveryItemId: await accountItem(db, accountId),
      origin: 'qloo',
      title: 'A graph-backed card',
      providerQueryIds: [randomUUID()],
    });
    return { runId: run.id, recommendationId: rec.id, assertionId: randomUUID(), evidenceId: randomUUID() };
  }

  it('binds each support edge to the proof row and its account, rejecting foreign and nonexistent ids', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const edgeA = await explicitEdge(db, a.accountId);
    const edgeB = await explicitEdge(db, b.accountId);
    const fix = await proofFixture(a.accountId);
    const { rows: proof } = await db.query<{ id: string }>(
      `INSERT INTO recommendation_graph_proofs (owner_account_id, recommendation_id, graph_run_id,
         proof_version, intent, reason_template, reason_template_version)
       VALUES ($1, $2, $3, 1, 'personal', 'created_by', 'reason-1') RETURNING id`,
      [a.accountId, fix.recommendationId, fix.runId],
    );
    const proofId = proof[0]!.id;

    // The valid same-owner support edge binds; the pinned public dependency
    // arrays remain permitted unchanged.
    await db.query(
      `INSERT INTO recommendation_graph_proof_support_edges (proof_id, owner_account_id, support_edge_id)
       VALUES ($1, $2, $3)`,
      [proofId, a.accountId, edgeA],
    );
    // Another account's private support edge cannot be pinned into an
    // owner-valid proof.
    await expect(
      db.query(
        `INSERT INTO recommendation_graph_proof_support_edges (proof_id, owner_account_id, support_edge_id)
         VALUES ($1, $2, $3)`,
        [proofId, a.accountId, edgeB],
      ),
    ).rejects.toThrow(/foreign key/i);
    // A nonexistent support edge is rejected.
    await expect(
      db.query(
        `INSERT INTO recommendation_graph_proof_support_edges (proof_id, owner_account_id, support_edge_id)
         VALUES ($1, $2, $3)`,
        [proofId, a.accountId, randomUUID()],
      ),
    ).rejects.toThrow(/foreign key/i);
    // The dependency row must carry the proof's account, not just any owner
    // of the edge.
    await expect(
      db.query(
        `INSERT INTO recommendation_graph_proof_support_edges (proof_id, owner_account_id, support_edge_id)
         VALUES ($1, $2, $3)`,
        [proofId, b.accountId, edgeB],
      ),
    ).rejects.toThrow(/foreign key/i);

    expect(await proofSupportEdges(db, proofId)).toEqual([edgeA]);
  });

  it('writer pins same-owner support edges and public dependencies, rejecting foreign ids atomically', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const edgeA = await explicitEdge(db, a.accountId);
    const edgeA2 = await explicitEdge(db, a.accountId);
    const edgeB = await explicitEdge(db, b.accountId);
    const fix = await proofFixture(a.accountId);

    // Valid same-owner private dependencies and pinned public dependencies
    // are both accepted.
    const proof = await insertRecommendationProof(db, {
      ownerAccountId: a.accountId,
      recommendationId: fix.recommendationId,
      graphRunId: fix.runId,
      intent: 'personal',
      reasonTemplate: 'created_by',
      assertions: [{ id: fix.assertionId, revision: 2 }],
      evidence: [{ id: fix.evidenceId, revision: 1 }],
      supportEdgeIds: [edgeA, edgeA2],
    });
    expect(proof.proof_version).toBe(1);
    expect(proof.support_edge_ids).toEqual([edgeA, edgeA2].sort());
    expect(proof.assertion_ids).toEqual([fix.assertionId]);
    expect(proof.evidence_ids).toEqual([fix.evidenceId]);

    // A foreign private support edge is rejected and leaves no proof behind.
    await expect(
      insertRecommendationProof(db, {
        ownerAccountId: a.accountId,
        recommendationId: fix.recommendationId,
        graphRunId: fix.runId,
        intent: 'personal',
        reasonTemplate: 'created_by',
        supportEdgeIds: [edgeB],
      }),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      insertRecommendationProof(db, {
        ownerAccountId: a.accountId,
        recommendationId: fix.recommendationId,
        graphRunId: fix.runId,
        intent: 'personal',
        reasonTemplate: 'created_by',
        supportEdgeIds: [randomUUID()],
      }),
    ).rejects.toThrow(/foreign key/i);
    const { rows } = await db.query<{ n: string }>(
      'SELECT COUNT(*)::int AS n FROM recommendation_graph_proofs WHERE recommendation_id = $1',
      [fix.recommendationId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('owner-scoped readers disclose only own support ids and keep valid forms across deletion and retraction', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const edgeA = await explicitEdge(db, a.accountId);
    const edgeA2 = await explicitEdge(db, a.accountId);
    const edgeB = await explicitEdge(db, b.accountId);
    const fix = await proofFixture(a.accountId);
    const proof = await insertRecommendationProof(db, {
      ownerAccountId: a.accountId,
      recommendationId: fix.recommendationId,
      graphRunId: fix.runId,
      intent: 'personal',
      reasonTemplate: 'created_by',
      assertions: [{ id: fix.assertionId, revision: 2 }],
      evidence: [{ id: fix.evidenceId, revision: 1 }],
      supportEdgeIds: [edgeA, edgeA2],
    });

    // The owner-scoped reader returns the pinned private and public
    // dependencies of the owner's proof only.
    const cards = await loadGraphRunCards(db, { accountId: a.accountId });
    const read = cards.proofs.find((p) => p.id === proof.id);
    expect(read?.support_edge_ids).toEqual([edgeA, edgeA2].sort());
    expect(read?.assertion_ids).toEqual([fix.assertionId]);
    expect(read?.validity_state).toBe('valid');
    // Another account's owner-scoped read never sees the proof or its ids.
    const cardsB = await loadGraphRunCards(db, { accountId: b.accountId });
    expect(cardsB.proofs.map((p) => p.id)).not.toContain(proof.id);
    void edgeB;

    // Deleting one support edge prunes exactly that private dependency.
    await db.query('DELETE FROM personal_interest_edges WHERE id = $1', [edgeA2]);
    const afterDelete = (await loadGraphRunCards(db, { accountId: a.accountId })).proofs.find(
      (p) => p.id === proof.id,
    );
    expect(afterDelete?.support_edge_ids).toEqual([edgeA]);
    // Public dependency pins are untouched by private support deletion.
    expect(afterDelete?.assertion_ids).toEqual([fix.assertionId]);
    expect(afterDelete?.evidence_ids).toEqual([fix.evidenceId]);

    // Retracting the proof invalidates it without destroying the pinned
    // same-owner/private and public forms.
    await db.query(
      `UPDATE recommendation_graph_proofs SET validity_state = 'revoked', invalidated_at = now()
        WHERE id = $1`,
      [proof.id],
    );
    const afterRetract = (await loadGraphRunCards(db, { accountId: a.accountId })).proofs.find(
      (p) => p.id === proof.id,
    );
    expect(afterRetract?.validity_state).toBe('revoked');
    expect(afterRetract?.support_edge_ids).toEqual([edgeA]);
    expect(afterRetract?.assertion_ids).toEqual([fix.assertionId]);
  });

  it('account deletion cascades the dependency rows and leaves other accounts intact', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const edgeA = await explicitEdge(db, a.accountId);
    const edgeB = await explicitEdge(db, b.accountId);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const runB = await createGraphRun(db, {
      ownerAccountId: b.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const nodeX = await graphNode(db);
    const nodeY = await graphNode(db);
    const upA = await upsertFrontierCandidate(db, {
      ownerAccountId: a.accountId,
      runId: runA.id,
      nodeId: nodeX,
      dedupeKey: `node:${nodeX}`,
      expiresInDays: 7,
      supportRootIds: [edgeA],
    });
    const upB = await upsertFrontierCandidate(db, {
      ownerAccountId: b.accountId,
      runId: runB.id,
      nodeId: nodeY,
      dedupeKey: `node:${nodeY}`,
      expiresInDays: 7,
      supportRootIds: [edgeB],
    });
    const fixA = await proofFixture(a.accountId);
    const fixB = await proofFixture(b.accountId);
    const proofA = await insertRecommendationProof(db, {
      ownerAccountId: a.accountId,
      recommendationId: fixA.recommendationId,
      graphRunId: fixA.runId,
      intent: 'personal',
      reasonTemplate: 'created_by',
      supportEdgeIds: [edgeA],
    });
    const proofB = await insertRecommendationProof(db, {
      ownerAccountId: b.accountId,
      recommendationId: fixB.recommendationId,
      graphRunId: fixB.runId,
      intent: 'personal',
      reasonTemplate: 'created_by',
      supportEdgeIds: [edgeB],
    });

    await db.query('DELETE FROM accounts WHERE id = $1', [a.accountId]);

    const count = async (table: string, owner: string) =>
      Number(
        (
          await db.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE owner_account_id = $1`, [
            owner,
          ])
        ).rows[0]!.n,
      );
    for (const table of ['graph_frontier_support_roots', 'recommendation_graph_proof_support_edges']) {
      expect(await count(table, a.accountId)).toBe(0);
      expect(await count(table, b.accountId)).toBeGreaterThan(0);
    }
    expect(await frontierRoots(db, upB.row.id)).toEqual([edgeB]);
    expect(await proofSupportEdges(db, proofB.id)).toEqual([edgeB]);
    void upA;
    void proofA;
  });
});

// --- Storage shape ----------------------------------------------------------------

describe('private dependency storage shape', () => {
  it('leaves no unvalidated private dependency array in storage', async () => {
    // The old UUID-array columns were the unvalidated direct-SQL path; the
    // owner-bound relations replace them.
    const frontier = await db.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'graph_frontier' AND column_name = 'support_root_ids'`,
    );
    expect(frontier.rows[0]!.n).toBe(0);
    const proofs = await db.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'recommendation_graph_proofs' AND column_name = 'support_edge_ids'`,
    );
    expect(proofs.rows[0]!.n).toBe(0);
  });
});
