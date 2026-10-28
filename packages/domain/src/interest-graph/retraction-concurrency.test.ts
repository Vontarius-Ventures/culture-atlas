import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db, PoolDb, Queryable } from '../db/pool';
import type { GraphNodeDomain, GraphNodeKind, GraphPredicate } from './schema';
import { closeTestDb, getTestDb, insertAccount, testConfig } from '../testing';
import { accountCtx, insertItem, insertReference } from '../test-support/library';
import { recordPreference } from '../services/preferences';
import {
  attachAssertionSupport,
  insertEvidence,
  recordSourceRevision,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from './evidence';
import { createGraphRun, insertGraphRecommendation, insertRecommendationProof, upsertFrontierCandidate } from './store';
import { projectAccountInterestGraph } from './projector';
import { expandAccountInterestGraph } from './expansion';
import { revalidateGraphProof, retractGraphEvidence, retractGraphSourceRevision } from './validity';

/**
 * Discovery scrutiny repairs DISC-SCR-002/003 (VAL-EVID-004's synchronous
 * retraction core): every LIVE frontier state expires on sole-source
 * withdrawal, and overlapping retractions of INDEPENDENT evidence serialize
 * so an unsupported proof cannot remain stored-valid after both commit.
 *
 *  - DISC-SCR-002: normal expansion promotes ranked candidates to
 *    state='admitted' before publication; unmaterialized (no account
 *    discovery item) or diversified-out observations stay admitted and count
 *    as live frontier capacity. Retracting their sole supporting evidence
 *    must expire them in the same transaction, without touching unrelated
 *    candidates or any account's explicit private support.
 *  - DISC-SCR-003: two connections retracting independent evidence A and B of
 *    the same proof each observe the OTHER's withdrawal as uncommitted and
 *    can both keep the proof valid; both commit with all support retracted
 *    while validity_state stays 'valid', and idempotent retries return early
 *    without repairing. The repair locks the affected proofs in one
 *    consistent order before deciding survival, and the barrier regressions
 *    below prove it on two REAL connections (pg_locks-observed waits, never
 *    sleeps), without deadlock and without retry resurrection.
 */

const db = getTestDb();
afterAll(closeTestDb);

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });

// --- Fixture helpers -----------------------------------------------------------------

/** One reviewed evidence row (CC0 museum record) in its own independent source family. */
async function evidence(
  dbh: Queryable,
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
  return { evidenceId: inserted.row.id, revision: inserted.revision, sourceRevisionId: recorded.sourceRevisionId, familyKey: family };
}

type EvidenceFixture = Awaited<ReturnType<typeof evidence>>;

/** A validated CREATED_BY assertion justified by the given independent evidence families. */
async function justifiedAssertion(dbh: Queryable, supports: EvidenceFixture[]) {
  const work = await upsertGraphIdentity(dbh, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: `Work ${randomUUID().slice(0, 8)}`,
    nodeKind: 'work',
    domain: 'art',
    senseKey: 'painting',
  });
  const creator = await upsertGraphIdentity(dbh, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: `Creator ${randomUUID().slice(0, 8)}`,
    nodeKind: 'creator',
    domain: 'art',
    senseKey: 'painter',
  });
  const upserted = await upsertGraphAssertion(dbh, {
    subjectNodeId: work.id,
    predicate: 'CREATED_BY',
    objectNodeId: creator.id,
    status: 'validated',
  });
  for (const support of supports) {
    await attachAssertionSupport(dbh, {
      assertionId: upserted.row.id,
      evidenceId: support.evidenceId,
      derivation: 'primary',
      sourceFamilyKey: support.familyKey,
    });
  }
  // Evidence attachment versions the assertion row; re-read so callers pin
  // the CURRENT revision, exactly like a real publisher would.
  const { rows } = await dbh.query<{ id: string; revision: number }>(
    'SELECT id, revision FROM graph_assertions WHERE id = $1',
    [upserted.row.id],
  );
  return { assertion: rows[0]!, work, creator };
}

/** Account + expansion run + recommendation + proof pinned to the assertion/evidence. */
async function pinnedProof(
  dbh: Queryable,
  assertion: { id: string; revision: number },
  pinned: Array<{ evidenceId: string; revision: number }>,
) {
  const account = await insertAccount(dbh);
  const { rows: itemRows } = await dbh.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title)
     VALUES ($1, 'film', 'watch', $2, 'A card') RETURNING id`,
    [account.accountId, `qloo:${randomUUID()}`],
  );
  const run = await createGraphRun(dbh, {
    ownerAccountId: account.accountId,
    runKind: 'expansion',
    policyVersion: 'graph-policy-1',
  });
  const rec = await insertGraphRecommendation(dbh, {
    ownerAccountId: account.accountId,
    runId: run.id,
    discoveryItemId: itemRows[0]!.id,
    origin: 'catalog',
    title: 'A graph-backed card',
  });
  const proof = await insertRecommendationProof(dbh, {
    ownerAccountId: account.accountId,
    recommendationId: rec.id,
    graphRunId: run.id,
    intent: 'personal',
    reasonTemplate: 'created_by',
    assertions: [{ id: assertion.id, revision: assertion.revision }],
    evidence: pinned.map((p) => ({ id: p.evidenceId, revision: p.revision })),
  });
  return { account, run, rec, proof };
}

/** A live 'admitted' frontier candidate (the state normal expansion leaves
 *  unmaterialized/diversified-out observations in), pinned to the given path. */
async function admittedCandidate(
  dbh: Queryable,
  accountId: string,
  nodeId: string,
  path: { assertionIds: string[]; evidenceIds: string[] },
) {
  const run = await createGraphRun(dbh, {
    ownerAccountId: accountId,
    runKind: 'expansion',
    policyVersion: 'graph-policy-1',
  });
  const upserted = await upsertFrontierCandidate(dbh, {
    ownerAccountId: accountId,
    runId: run.id,
    nodeId,
    dedupeKey: `expansion:personal:node:${nodeId}`,
    expiresInDays: 7,
    pathVersions: {
      template: 'same_creator',
      assertion_ids: path.assertionIds,
      evidence_ids: path.evidenceIds,
    },
  });
  // The engine's own promotion statement: ranked observations become admitted.
  await dbh.query(
    `UPDATE graph_frontier SET state = 'admitted', updated_at = now()
      WHERE id = $1 AND owner_account_id = $2 AND state IN ('active','admitted')`,
    [upserted.row.id, accountId],
  );
  return upserted.row.id;
}

/** A corpus identity with a linked cultural reference (work-like by default). */
async function corpusNode(
  dbh: Queryable,
  over: { kind?: GraphNodeKind; domain?: GraphNodeDomain; sense?: string; name?: string; withReference?: boolean } = {},
) {
  const kind = over.kind ?? 'work';
  // Every identity name is unique: the natural key is (name, kind, domain, sense).
  const name = `${over.name ?? kind}-${randomUUID().slice(0, 6)}`;
  const referenceId = (over.withReference ?? true) ? await insertReference({ name }, dbh) : null;
  const node = await upsertGraphIdentity(dbh, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: name,
    nodeKind: kind,
    domain: over.domain ?? 'art',
    senseKey: over.sense ?? 'painting',
    culturalReferenceId: referenceId,
  });
  return { node, referenceId };
}

/** A validated, currently justified assertion (one reviewed evidence family by default). */
async function justifiedEdge(
  dbh: Queryable,
  input: { subject: string; predicate: GraphPredicate; object: string; subtype?: string | null },
) {
  const support = await evidence(dbh);
  const upserted = await upsertGraphAssertion(dbh, {
    subjectNodeId: input.subject,
    predicate: input.predicate,
    objectNodeId: input.object,
    associationSubtype: input.subtype ?? null,
    status: 'validated',
  });
  await attachAssertionSupport(dbh, {
    assertionId: upserted.row.id,
    evidenceId: support.evidenceId,
    derivation: 'primary',
    sourceFamilyKey: support.familyKey,
  });
  const { rows } = await dbh.query<{ id: string; revision: number }>(
    'SELECT id, revision FROM graph_assertions WHERE id = $1',
    [upserted.row.id],
  );
  return { assertionId: rows[0]!.id, revision: rows[0]!.revision, evidenceId: support.evidenceId };
}

/**
 * Resolves once the backend holds an ungranted lock request — the row-lock
 * wait the serialized retraction takes on the other transaction's proof.
 * Fails honestly if the call never blocks, so a barrier cannot silently
 * pass by racing past the wait (the pre-repair code takes exactly that
 * shortcut).
 */
async function waitForBlockedOn(pool: PoolDb, pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*) AS n FROM pg_locks WHERE pid = $1 AND NOT granted',
      [pid],
    );
    if (Number(rows[0]!.n) > 0) return;
    if (Date.now() >= deadline)
      throw new Error(`backend ${pid} never blocked on the conflicting retraction within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A Db view of one dedicated pool client that joins the CALLER's already-open
 * transaction instead of issuing its own BEGIN/COMMIT: the real retraction
 * function runs its exact production statements while the test holds the
 * commit barrier on that connection.
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

async function frontierState(dbh: Queryable, frontierId: string): Promise<string> {
  const { rows } = await dbh.query<{ state: string }>('SELECT state FROM graph_frontier WHERE id = $1', [frontierId]);
  return rows[0]!.state;
}

async function proofValidity(dbh: Queryable, proofId: string): Promise<string> {
  const { rows } = await dbh.query<{ validity_state: string }>(
    'SELECT validity_state FROM recommendation_graph_proofs WHERE id = $1',
    [proofId],
  );
  return rows[0]!.validity_state;
}

// --- DISC-SCR-002: every live frontier state expires on sole-source withdrawal ----------

describe('frontier retraction covers every live state (DISC-SCR-002)', () => {
  it('a normal-expansion admitted-but-unmaterialized candidate expires synchronously on sole-evidence retraction', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;

    // A saved + projected explicit personal root, two creators, and two
    // candidate works reached through two INDEPENDENT paths. NEITHER
    // candidate has an account discovery item, so publication leaves both
    // in the live 'admitted' state — exactly the engine's unmaterialized
    // candidate shape.
    const root = await corpusNode(db, { kind: 'work', name: 'Root work' });
    const creatorA = await corpusNode(db, { kind: 'creator', sense: 'painter', name: 'Creator A' });
    const creatorB = await corpusNode(db, { kind: 'creator', sense: 'painter', name: 'Creator B' });
    const target = await corpusNode(db, { kind: 'work', name: 'Unmaterialized target' });
    const unrelated = await corpusNode(db, { kind: 'work', name: 'Independent path' });
    const rootItemId = await insertItem({ accountId }, { referenceId: root.referenceId, kind: 'film', category: 'watch' }, db);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: rootItemId });
    const targetEdge = await justifiedEdge(db, { subject: target.node.id, predicate: 'CREATED_BY', object: creatorA.node.id });
    const unrelatedEdge = await justifiedEdge(db, { subject: unrelated.node.id, predicate: 'CREATED_BY', object: creatorB.node.id });
    const rootEdgeA = await justifiedEdge(db, { subject: root.node.id, predicate: 'CREATED_BY', object: creatorA.node.id });
    const rootEdgeB = await justifiedEdge(db, { subject: root.node.id, predicate: 'CREATED_BY', object: creatorB.node.id });
    await projectAccountInterestGraph(db, { accountId, config: graphOn, source: 'mutation_intent' });

    const result = await expandAccountInterestGraph(db, { accountId, config: graphOn });
    expect(result.expanded).toBe(true);
    expect(result.counts.admitted).toBe(2);
    // Unmaterialized: ranked observations without an account discovery item
    // publish nothing and stay in the live 'admitted' frontier state.
    expect(result.counts.recommendationsPublished).toBe(0);
    expect(result.counts.candidatesWithoutItems).toBe(2);

    const { rows: liveRows } = await db.query<{ id: string; state: string; node_id: string; path: { assertion_ids: string[] } }>(
      `SELECT id, state, node_id, path_versions AS path FROM graph_frontier
        WHERE owner_account_id = $1 AND node_id = ANY($2::uuid[]) ORDER BY node_id`,
      [accountId, [target.node.id, unrelated.node.id]],
    );
    expect(liveRows).toHaveLength(2);
    expect(liveRows.map((r) => r.state)).toEqual(['admitted', 'admitted']);
    const targetRow = liveRows.find((r) => r.node_id === target.node.id)!;
    const unrelatedRow = liveRows.find((r) => r.node_id === unrelated.node.id)!;
    // The retraction-relevant control: the two admitted rows pin DISJOINT
    // path dependency sets — the target's path pins the edge whose sole
    // evidence is about to be withdrawn, the unrelated candidate's path pins
    // only its own independent families.
    expect(targetRow.path.assertion_ids).toEqual([rootEdgeA.assertionId, targetEdge.assertionId]);
    expect(unrelatedRow.path.assertion_ids).toEqual([rootEdgeB.assertionId, unrelatedEdge.assertionId]);

    // Retract the SOLE evidence of the target candidate's path.
    const retraction = await retractGraphEvidence(db, {
      evidenceId: targetEdge.evidenceId,
      reason: 'sole source withdrawn',
    });
    expect(retraction.retracted).toBe(true);
    expect(retraction.frontierEntriesExpired).toBe(1);

    // The admitted candidate that pinned the retracted evidence expires in the
    // same transaction — its grounding never outlives the withdrawal.
    expect(await frontierState(db, targetRow.id)).toBe('expired');
    // The unrelated candidate (independent path, independent evidence) and
    // the account's explicit private support are untouched.
    expect(await frontierState(db, unrelatedRow.id)).toBe('admitted');
    const { rows: edgeRows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM personal_interest_edges WHERE owner_account_id = $1',
      [accountId],
    );
    expect(edgeRows[0]!.n).toBeGreaterThan(0);
  });

  it('an admitted candidate whose sole path evidence is withdrawn via source-revision retraction expires too', async () => {
    const account = await insertAccount(db);
    const target = await corpusNode(db, { kind: 'work', name: 'Revision-retracted target' });
    const sole = await evidence(db);
    const { assertion } = await justifiedAssertion(db, [sole]);
    const frontierId = await admittedCandidate(db, account.accountId, target.node.id, {
      assertionIds: [assertion.id],
      evidenceIds: [sole.evidenceId],
    });
    expect(await frontierState(db, frontierId)).toBe('admitted');

    const retraction = await retractGraphSourceRevision(db, {
      sourceRevisionId: sole.sourceRevisionId,
      reason: 'the page was withdrawn by the publisher',
    });
    expect(retraction.retracted).toBe(true);
    expect(retraction.frontierEntriesExpired).toBe(1);
    expect(await frontierState(db, frontierId)).toBe('expired');
  });
});

// --- DISC-SCR-003: overlapping independent-source retractions serialize -----------------

describe('concurrent retraction serialization (DISC-SCR-003)', () => {
  it('two-connection retractions of independent evidence leave the shared proof stored-invalid after both commit', async () => {
    const familyA = await evidence(db);
    const familyB = await evidence(db);
    const { assertion } = await justifiedAssertion(db, [familyA, familyB]);
    const { proof } = await pinnedProof(db, assertion, [familyA, familyB]);
    expect((await revalidateGraphProof(db, { proofId: proof.id })).valid).toBe(true);

    const holder = await db.pool.connect();
    let holderOpen = true;
    try {
      // Connection 1: the REAL retraction of independent family A, held
      // uncommitted inside the caller's open transaction.
      await holder.query('BEGIN');
      const first = await retractGraphEvidence(openTransactionDb(holder), {
        evidenceId: familyA.evidenceId,
        reason: 'gallery record corrected',
      });
      expect(first.retracted).toBe(true);

      const retracer = await db.pool.connect();
      let retracerOpen = true;
      try {
        await retracer.query('BEGIN');
        const pid = (await retracer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        // Connection 2: the REAL retraction of independent family B. It must
        // BLOCK on the proof lock connection 1 still holds — observed in
        // pg_locks, never assumed — instead of reading A as uncommitted-valid
        // and deciding the proof survives.
        const second = retractGraphEvidence(openTransactionDb(retracer), {
          evidenceId: familyB.evidenceId,
          reason: 'mirror page removed',
        });
        void second.catch(() => undefined);
        await waitForBlockedOn(db, pid);

        // Release the barrier: connection 1 commits, connection 2 re-reads
        // the committed withdrawal of A under READ COMMITTED and redecides.
        await holder.query('COMMIT');
        holderOpen = false;
        const secondResult = await second;
        expect(secondResult.retracted).toBe(true);
        await retracer.query('COMMIT');
        retracerOpen = false;

        // Both connections committed with ALL support retracted: the stored
        // proof is durably invalid, not merely invalid at read time.
        expect(await proofValidity(db, proof.id)).toBe('invalid');
        const verdict = await revalidateGraphProof(db, { proofId: proof.id });
        expect(verdict.valid).toBe(false);
        expect(verdict.reason).toBe('evidence_retracted');

        // No idempotent-retry resurrection: a repeated withdrawal neither
        // resurrects the proof nor reports unperformed repair.
        const retry = await retractGraphEvidence(db, { evidenceId: familyA.evidenceId, reason: 'retry after commit' });
        expect(retry.retracted).toBe(false);
        expect(retry.proofsInvalidated).toBe(0);
        expect(await proofValidity(db, proof.id)).toBe('invalid');
      } finally {
        if (retracerOpen) await retracer.query('ROLLBACK').catch(() => undefined);
        retracer.release();
      }
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('two-connection independent source-revision withdrawals leave the shared proof stored-invalid after both commit', async () => {
    const revisionA = await evidence(db);
    const revisionB = await evidence(db);
    const { assertion } = await justifiedAssertion(db, [revisionA, revisionB]);
    const { proof } = await pinnedProof(db, assertion, [revisionA, revisionB]);
    expect((await revalidateGraphProof(db, { proofId: proof.id })).valid).toBe(true);

    const holder = await db.pool.connect();
    let holderOpen = true;
    try {
      await holder.query('BEGIN');
      const first = await retractGraphSourceRevision(openTransactionDb(holder), {
        sourceRevisionId: revisionA.sourceRevisionId,
        reason: 'publisher withdrew the page',
      });
      expect(first.retracted).toBe(true);

      const retracer = await db.pool.connect();
      let retracerOpen = true;
      try {
        await retracer.query('BEGIN');
        const pid = (await retracer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const second = retractGraphSourceRevision(openTransactionDb(retracer), {
          sourceRevisionId: revisionB.sourceRevisionId,
          reason: 'mirror page removed',
        });
        void second.catch(() => undefined);
        await waitForBlockedOn(db, pid);

        await holder.query('COMMIT');
        holderOpen = false;
        const secondResult = await second;
        expect(secondResult.retracted).toBe(true);
        await retracer.query('COMMIT');
        retracerOpen = false;

        expect(await proofValidity(db, proof.id)).toBe('invalid');
        const { rows: revisions } = await db.query<{ validity_state: string }>(
          'SELECT validity_state FROM graph_source_revisions WHERE id = ANY($1::uuid[])',
          [[revisionA.sourceRevisionId, revisionB.sourceRevisionId]],
        );
        expect(revisions.map((r) => r.validity_state)).toEqual(['retracted', 'retracted']);
      } finally {
        if (retracerOpen) await retracer.query('ROLLBACK').catch(() => undefined);
        retracer.release();
      }
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('overlapping retractions of many shared proofs complete without deadlock and invalidate every one', async () => {
    for (let round = 0; round < 3; round++) {
      const familyA = await evidence(db);
      const familyB = await evidence(db);
      const { assertion } = await justifiedAssertion(db, [familyA, familyB]);
      const proofIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        const { proof } = await pinnedProof(db, assertion, [familyA, familyB]);
        proofIds.push(proof.id);
      }

      // Two REAL concurrent retractions on two pool connections at the
      // production READ COMMITTED isolation. A PostgreSQL 40P01 deadlock would
      // reject one of these; the consistent ascending-id proof lock order
      // must let both commit.
      const [a, b] = await Promise.all([
        retractGraphEvidence(db, { evidenceId: familyA.evidenceId, reason: 'concurrent withdrawal a' }),
        retractGraphEvidence(db, { evidenceId: familyB.evidenceId, reason: 'concurrent withdrawal b' }),
      ]);
      expect(a.retracted).toBe(true);
      expect(b.retracted).toBe(true);

      // Whichever withdrawal decided last on each proof saw the other's
      // committed retraction: none may remain stored-valid.
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM recommendation_graph_proofs
          WHERE id = ANY($1::uuid[]) AND validity_state = 'valid'`,
        [proofIds],
      );
      expect(rows[0]!.n).toBe(0);
    }
  });

  it('an idempotent retry REPAIRS a raced stuck-valid proof and live frontier rows instead of skipping them', async () => {
    const familyA = await evidence(db);
    const familyB = await evidence(db);
    const { assertion } = await justifiedAssertion(db, [familyA, familyB]);
    const { proof, account } = await pinnedProof(db, assertion, [familyA, familyB]);
    const target = await corpusNode(db, { kind: 'work', name: 'Raced candidate' });
    const frontierId = await admittedCandidate(db, account.accountId, target.node.id, {
      assertionIds: [assertion.id],
      evidenceIds: [familyA.evidenceId],
    });

    // Fault injection: the exact end state two overlapping pre-repair
    // withdrawals could commit — both families retracted while the proof and
    // the live frontier row survived untouched. (Produced by direct SQL
    // because the repaired writer can no longer reach it; the content columns
    // stay immutable — only the validity status columns flip.)
    await db.query(
      `UPDATE graph_evidence SET validity_state = 'retracted', invalidated_at = now(), invalidation_reason = 'raced withdrawal a' WHERE id = $1`,
      [familyA.evidenceId],
    );
    await db.query(
      `UPDATE graph_evidence SET validity_state = 'retracted', invalidated_at = now(), invalidation_reason = 'raced withdrawal b' WHERE id = $1`,
      [familyB.evidenceId],
    );
    expect(await proofValidity(db, proof.id)).toBe('valid');

    // The idempotent retry of the already-retracted evidence must re-run the
    // dependent revalidation — repairing the raced proof and frontier row —
    // instead of returning early having done nothing.
    const retry = await retractGraphEvidence(db, { evidenceId: familyA.evidenceId, reason: 'retry after race' });
    expect(retry.retracted).toBe(false);
    expect(retry.evidenceRetracted).toBe(0);
    expect(retry.proofsInvalidated).toBe(1);
    expect(retry.frontierEntriesExpired).toBe(1);
    expect(await proofValidity(db, proof.id)).toBe('invalid');
    expect(await frontierState(db, frontierId)).toBe('expired');

    // A second retry is a true no-op, and nothing ever resurrects.
    const again = await retractGraphEvidence(db, { evidenceId: familyA.evidenceId, reason: 'retry after race' });
    expect(again.retracted).toBe(false);
    expect(again.proofsInvalidated).toBe(0);
    expect(again.frontierEntriesExpired).toBe(0);
    expect(await proofValidity(db, proof.id)).toBe('invalid');
  });

  it('an idempotent source-revision retry repairs over the revision FULL evidence set', async () => {
    const revisionA = await evidence(db);
    const revisionB = await evidence(db);
    const { assertion } = await justifiedAssertion(db, [revisionA, revisionB]);
    const { proof } = await pinnedProof(db, assertion, [revisionA, revisionB]);

    // Fault injection: both revisions raced; the proof survived them all.
    await db.query(
      `UPDATE graph_source_revisions SET validity_state = 'retracted', invalidated_at = now(), invalidation_reason = 'raced revision withdrawal a' WHERE id = $1`,
      [revisionA.sourceRevisionId],
    );
    await db.query(
      `UPDATE graph_source_revisions SET validity_state = 'retracted', invalidated_at = now(), invalidation_reason = 'raced revision withdrawal b' WHERE id = $1`,
      [revisionB.sourceRevisionId],
    );
    await db.query(
      `UPDATE graph_evidence SET validity_state = 'retracted', invalidated_at = now(), invalidation_reason = 'raced revision withdrawal' WHERE id = ANY($1::uuid[])`,
      [[revisionA.evidenceId, revisionB.evidenceId]],
    );
    expect(await proofValidity(db, proof.id)).toBe('valid');

    const retry = await retractGraphSourceRevision(db, {
      sourceRevisionId: revisionA.sourceRevisionId,
      reason: 'retry after race',
    });
    expect(retry.retracted).toBe(false);
    expect(retry.evidenceRetracted).toBe(0);
    expect(retry.proofsInvalidated).toBe(1);
    expect(await proofValidity(db, proof.id)).toBe('invalid');

    const again = await retractGraphSourceRevision(db, {
      sourceRevisionId: revisionA.sourceRevisionId,
      reason: 'retry after race',
    });
    expect(again.retracted).toBe(false);
    expect(again.proofsInvalidated).toBe(0);
  });
});
