import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';
import type { ServiceContext } from '../context';
import type { Db, PoolDb } from '../db/pool';
import { insertItem, insertReference } from '../test-support/library';
import { createIsolatedDatabase, insertAccount, testConfig, testContext } from '../testing';
import { recordPreference } from '../services/preferences';
import { attachAssertionSupport, insertEvidence, recordSourceRevision, upsertGraphAssertion, upsertGraphIdentity } from './evidence';
import { projectAccountInterestGraph } from './projector';
import { retractGraphEvidence, retractGraphSourceRevision, revalidateFrontierPathVersions } from './validity';
import { createGraphRun, upsertFrontierCandidate } from './store';
import { expandAccountInterestGraph, type ExpansionResult } from './expansion';
import type { GraphNodeDomain, GraphNodeKind, GraphPredicate } from './schema';

/**
 * Frontier witness survival and retained-pin refresh (DISC-SCR-015/022,
 * VAL-EVID-004 + VAL-DISC-007).
 *
 *  - DISC-SCR-015: the retraction path used the dependency OVERLAP alone to
 *    expire every live (active/admitted) frontier row, without revalidating
 *    the RECORDED pins. A live row whose recorded path pins two independent
 *    witnesses A/B of a shared assertion expired when only A was withdrawn —
 *    even though B still grounds the recorded path and the same withdrawal
 *    preserved a proof pinning A/B. Repaired contract: overlap only SELECTS
 *    candidates (locked FOR UPDATE in one ascending-id order); a row expires
 *    only when its RECORDED path fails the same live-witness rule the read
 *    path applies — every recorded assertion still justified at its recorded
 *    revision, and at least one recorded evidence witness still live.
 *    Withdrawing every witness still expires the row synchronously, and a
 *    replayed (idempotent) withdrawal cannot expire a surviving row.
 *
 *  - DISC-SCR-022: publication validated the NEWLY PROPOSED observation pins,
 *    but a frontier dedupe conflict RETAINS the stored path_versions and only
 *    refreshes state/score. An admitted diversified-out candidate still
 *    pinning assertion revision 2 was refreshed live after a revision-3
 *    observation passed validation, while its stored pins kept naming
 *    revision 2 — a live row that immediately fails the shared read
 *    validator. Repaired contract: a dedupe refresh of a LIVE row
 *    revalidates the ACTUAL retained pins; a stale retained row is
 *    reconciled to the just-validated observation's coherent pins/roots
 *    (owner-bound, lifetime only shortened), a current retained row keeps
 *    its stored pins/roots untouched, and terminal rows keep their
 *    historical record (never revived, never rewritten).
 *
 * The file runs on ONE isolated database (the documented pattern): the
 * two-connection barrier holds real locks and the engine fixtures are
 * population-heavy, so this file owns its accounts and corpus rows
 * exclusively.
 */

let isoDb: PoolDb;
let dropIso: () => Promise<void>;

beforeAll(async () => {
  const iso = await createIsolatedDatabase('witness');
  isoDb = iso.db;
  dropIso = iso.drop;
});
afterAll(async () => {
  await dropIso();
});

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });

// --- Fixture helpers (all bound to the isolated database) ------------------------

type EvidenceFixture = { evidenceId: string; revision: number; familyKey: string; sourceRevisionId: string };

async function corpusNode(over: { kind?: GraphNodeKind; domain?: GraphNodeDomain; sense?: string; name?: string } = {}) {
  const kind = over.kind ?? 'work';
  const name = `${over.name ?? kind}-${randomUUID().slice(0, 6)}`;
  const referenceId = await insertReference({ name }, isoDb);
  const node = await upsertGraphIdentity(isoDb, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: name,
    nodeKind: kind,
    domain: over.domain ?? 'art',
    senseKey: over.sense ?? 'painting',
    culturalReferenceId: referenceId,
  });
  return { node, referenceId };
}

async function plainNode(over: { kind?: GraphNodeKind; domain?: GraphNodeDomain; sense?: string; name?: string } = {}) {
  const bare = await corpusNode(over);
  return { node: bare.node };
}

/** One reviewed evidence row (CC0 museum record) in its own independent source family. */
async function evidence(): Promise<EvidenceFixture> {
  const family = `artic:${randomUUID()}`;
  const recorded = await recordSourceRevision(isoDb, {
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
  });
  const inserted = await insertEvidence(isoDb, {
    sourceRevisionId: recorded.sourceRevisionId,
    permittedExcerpt: `Reviewed support ${randomUUID().slice(0, 8)}.`,
    validationMethod: 'provider_metadata',
    validationVersion: 'test-1',
    evidenceKind: 'fact',
    reviewedBy: 'corpus review',
    reviewedAt: new Date('2026-10-28T00:00:00Z'),
  });
  return { evidenceId: inserted.row.id, revision: inserted.revision, familyKey: family, sourceRevisionId: recorded.sourceRevisionId };
}

/** A validated CREATED_BY assertion between two nodes, justified by the given independent evidence families. */
async function justifiedAssertionOn(input: { subject: string; object: string }, supports: EvidenceFixture[]) {
  const upserted = await upsertGraphAssertion(isoDb, {
    subjectNodeId: input.subject,
    predicate: 'CREATED_BY',
    objectNodeId: input.object,
    status: 'validated',
  });
  for (const support of supports) {
    await attachAssertionSupport(isoDb, {
      assertionId: upserted.row.id,
      evidenceId: support.evidenceId,
      derivation: 'primary',
      sourceFamilyKey: support.familyKey,
    });
  }
  // Evidence attachment versions the assertion row; pin the CURRENT revision.
  const { rows } = await isoDb.query<{ id: string; revision: number }>(
    'SELECT id, revision FROM graph_assertions WHERE id = $1',
    [upserted.row.id],
  );
  return { assertionId: rows[0]!.id, revision: rows[0]!.revision };
}

/** A validated, currently justified assertion (one reviewed evidence family by default). */
async function justifiedEdge(input: {
  subject: string;
  predicate: GraphPredicate;
  object: string;
  evidence?: EvidenceFixture[];
}) {
  const supports = input.evidence ?? [await evidence()];
  const assertion = await justifiedAssertionOn({ subject: input.subject, object: input.object }, supports);
  return { ...assertion, evidence: supports };
}

/**
 * A live 'admitted' frontier row whose recorded path pins the exact
 * id/revision arrays (the state normal expansion leaves unmaterialized or
 * diversified-out observations in).
 */
async function witnessPathRow(
  accountId: string,
  nodeId: string,
  pins: { assertionIds: string[]; assertionRevisions: number[]; evidenceIds: string[]; evidenceRevisions: number[] },
  over: { pathVersions?: Record<string, unknown> } = {},
): Promise<string> {
  const run = await createGraphRun(isoDb, { ownerAccountId: accountId, runKind: 'expansion', policyVersion: 'graph-policy-1' });
  const upserted = await upsertFrontierCandidate(isoDb, {
    ownerAccountId: accountId,
    runId: run.id,
    nodeId,
    dedupeKey: `witness:${randomUUID()}`,
    expiresInDays: 7,
    pathVersions: over.pathVersions ?? {
      template: 'same_creator',
      intent: 'personal',
      assertion_ids: pins.assertionIds,
      assertion_revisions: pins.assertionRevisions,
      evidence_ids: pins.evidenceIds,
      evidence_revisions: pins.evidenceRevisions,
    },
  });
  // The engine's own promotion statement: ranked observations become admitted.
  await isoDb.query(
    `UPDATE graph_frontier SET state = 'admitted', updated_at = now()
       WHERE id = $1 AND owner_account_id = $2 AND state IN ('active','admitted')`,
    [upserted.row.id, accountId],
  );
  return upserted.row.id;
}

async function savedItem(ctx: ServiceContext, accountId: string, referenceId: string): Promise<string> {
  const itemId = await insertItem({ accountId }, { referenceId, kind: 'film', category: 'watch' }, isoDb);
  await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemId });
  return itemId;
}

async function candidateItem(accountId: string, referenceId: string): Promise<string> {
  return insertItem({ accountId }, { referenceId, kind: 'film', category: 'watch' }, isoDb);
}

async function project(accountId: string) {
  await projectAccountInterestGraph(isoDb, { accountId, config: graphOn, source: 'mutation_intent' });
}

async function expand(accountId: string): Promise<ExpansionResult> {
  return expandAccountInterestGraph(isoDb, { accountId, config: graphOn });
}

/**
 * Four candidates sharing ONE midpoint creator with one saved root: the
 * rail's diversification bound (3 per midpoint) keeps the fourth candidate
 * ADMITTED but UNRANKED — live frontier candidate state, exactly the
 * committing observation class a dedupe refresh hits on its next pass.
 */
async function sharedMidpointCandidates() {
  const principal = await insertAccount(isoDb);
  const accountId = principal.accountId;
  const ctx = testContext(principal, { db: isoDb, config: graphOn });
  const root = await corpusNode({ name: 'Witness root' });
  const creator = await plainNode({ kind: 'creator', sense: 'painter' });
  const rootEdge = await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
  await savedItem(ctx, accountId, root.referenceId!);
  const candidates: Array<{ node: string; itemId: string; edge: Awaited<ReturnType<typeof justifiedEdge>> }> = [];
  for (let i = 0; i < 4; i += 1) {
    const cand = await corpusNode({ name: `Witness candidate ${i}` });
    const edge = await justifiedEdge({ subject: cand.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const itemId = await candidateItem(accountId, cand.referenceId!);
    candidates.push({ node: cand.node.id, itemId, edge });
  }
  await project(accountId);
  return { accountId, rootEdge, candidates };
}

/** The first pass's admitted-unranked candidate (the live frontier row a refresh hits). */
function unrankedCandidateOf<T extends { node: string }>(result: ExpansionResult, candidates: T[]): T {
  const rankedNodes = new Set(result.candidates.map((c) => c.nodeId));
  const unranked = candidates.find((c) => !rankedNodes.has(c.node));
  expect(unranked).toBeDefined();
  return unranked!;
}

interface FrontierRow {
  id: string;
  state: string;
  path: Record<string, unknown>;
}

/** The account's frontier row for one candidate node (its canonical dedupe key). */
async function frontierRow(accountId: string, nodeId: string): Promise<FrontierRow | null> {
  const { rows } = await isoDb.query<FrontierRow>(
    'SELECT id, state, path_versions AS path FROM graph_frontier WHERE owner_account_id = $1 AND dedupe_key = $2',
    [accountId, `expansion:personal:node:${nodeId}`],
  );
  return rows[0] ?? null;
}

async function frontierState(frontierId: string): Promise<string> {
  const { rows } = await isoDb.query<{ state: string }>('SELECT state FROM graph_frontier WHERE id = $1', [frontierId]);
  return rows[0]!.state;
}

async function frontierRoots(frontierId: string): Promise<string[]> {
  const { rows } = await isoDb.query<{ roots: string[] }>(
    `SELECT COALESCE(array_agg(sr.root_id ORDER BY sr.root_id), ARRAY[]::uuid[]) AS roots
       FROM graph_frontier_support_roots sr WHERE sr.frontier_id = $1`,
    [frontierId],
  );
  return rows[0]!.roots;
}

/** The shared read validator applied to a live row's RECORDED pins (the DISC-SCR-022 contract). */
async function frontierPinVerdict(frontierId: string) {
  const { rows } = await isoDb.query<{ path: unknown }>('SELECT path_versions AS path FROM graph_frontier WHERE id = $1', [
    frontierId,
  ]);
  return revalidateFrontierPathVersions(isoDb, { pathVersions: rows[0]!.path });
}

/**
 * Resolves once the backend holds an ungranted lock request — the row-lock
 * wait the serialized retraction takes on the other transaction's frontier
 * row. Fails honestly if the call never blocks, so a barrier cannot silently
 * pass by racing past the wait.
 */
async function waitForBlockedOn(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await isoDb.query<{ n: number }>(
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

// --- DISC-SCR-015: retraction preserves independent live witnesses ----------------

describe('frontier retraction revalidates recorded pins before expiry (DISC-SCR-015)', () => {
  it('an independent surviving witness preserves a shared-assertion path; withdrawing all witnesses expires it synchronously', async () => {
    const account = await insertAccount(isoDb);
    const work = await plainNode({ kind: 'work' });
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const familyA = await evidence();
    const familyB = await evidence();
    const assertion = await justifiedAssertionOn({ subject: work.node.id, object: creator.node.id }, [familyA, familyB]);
    const rowId = await witnessPathRow(account.accountId, work.node.id, {
      assertionIds: [assertion.assertionId],
      assertionRevisions: [assertion.revision],
      evidenceIds: [familyA.evidenceId, familyB.evidenceId],
      evidenceRevisions: [familyA.revision, familyB.revision],
    });

    // Withdrawing ONE witness leaves the recorded path fully grounded: the
    // surviving independent witness B justifies the shared assertion and
    // keeps a live evidence pin. The row must stay live.
    const first = await retractGraphEvidence(isoDb, { evidenceId: familyA.evidenceId, reason: 'mirror page removed' });
    expect(first.retracted).toBe(true);
    expect(first.frontierEntriesExpired).toBe(0);
    expect(await frontierState(rowId)).toBe('admitted');
    expect((await frontierPinVerdict(rowId)).valid).toBe(true);

    // Replay (idempotent retry) of the same withdrawal must not expire the
    // surviving row either: the recorded path still revalidates.
    const retry = await retractGraphEvidence(isoDb, { evidenceId: familyA.evidenceId, reason: 'retry after commit' });
    expect(retry.retracted).toBe(false);
    expect(retry.frontierEntriesExpired).toBe(0);
    expect(await frontierState(rowId)).toBe('admitted');

    // Withdrawing the LAST surviving witness expires the row synchronously,
    // inside the retraction transaction.
    const second = await retractGraphEvidence(isoDb, { evidenceId: familyB.evidenceId, reason: 'sole remaining witness withdrawn' });
    expect(second.retracted).toBe(true);
    expect(second.frontierEntriesExpired).toBe(1);
    expect(await frontierState(rowId)).toBe('expired');
    const verdict = await frontierPinVerdict(rowId);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('evidence_retracted');
  });

  it('a source-revision withdrawal preserves the independent-witness row; withdrawing the survivor revision expires it', async () => {
    const account = await insertAccount(isoDb);
    const work = await plainNode({ kind: 'work' });
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const familyA = await evidence();
    const familyB = await evidence();
    const assertion = await justifiedAssertionOn({ subject: work.node.id, object: creator.node.id }, [familyA, familyB]);
    const rowId = await witnessPathRow(account.accountId, work.node.id, {
      assertionIds: [assertion.assertionId],
      assertionRevisions: [assertion.revision],
      evidenceIds: [familyA.evidenceId, familyB.evidenceId],
      evidenceRevisions: [familyA.revision, familyB.revision],
    });

    // A withdrawn page takes its own evidence with it — the independent
    // family B (a different source revision) still grounds the row.
    const first = await retractGraphSourceRevision(isoDb, {
      sourceRevisionId: familyA.sourceRevisionId,
      reason: 'the page was withdrawn by the publisher',
    });
    expect(first.retracted).toBe(true);
    expect(first.frontierEntriesExpired).toBe(0);
    expect(await frontierState(rowId)).toBe('admitted');

    const second = await retractGraphSourceRevision(isoDb, {
      sourceRevisionId: familyB.sourceRevisionId,
      reason: 'the mirror page was removed too',
    });
    expect(second.retracted).toBe(true);
    expect(second.frontierEntriesExpired).toBe(1);
    expect(await frontierState(rowId)).toBe('expired');
  });

  it('two-connection concurrent independent withdrawals expire every shared row without deadlock', async () => {
    for (let round = 0; round < 3; round++) {
      const account = await insertAccount(isoDb);
      const work = await plainNode({ kind: 'work' });
      const creator = await plainNode({ kind: 'creator', sense: 'painter' });
      const familyA = await evidence();
      const familyB = await evidence();
      const familyC = await evidence();
      const assertionAB = await justifiedAssertionOn({ subject: work.node.id, object: creator.node.id }, [familyA, familyB]);
      const assertionC = await justifiedAssertionOn({ subject: work.node.id, object: creator.node.id }, [familyC]);

      const pinAB = {
        assertionIds: [assertionAB.assertionId],
        assertionRevisions: [assertionAB.revision],
        evidenceIds: [familyA.evidenceId, familyB.evidenceId],
        evidenceRevisions: [familyA.revision, familyB.revision],
      };
      // Three rows pin BOTH witnesses (the raced class), one pins each
      // witness alone, one pins only unrelated evidence, one records no path.
      const bothRows = [
        await witnessPathRow(account.accountId, work.node.id, pinAB),
        await witnessPathRow(account.accountId, work.node.id, pinAB),
        await witnessPathRow(account.accountId, work.node.id, pinAB),
      ];
      const aOnly = await witnessPathRow(account.accountId, work.node.id, {
        assertionIds: [assertionAB.assertionId],
        assertionRevisions: [assertionAB.revision],
        evidenceIds: [familyA.evidenceId],
        evidenceRevisions: [familyA.revision],
      });
      const bOnly = await witnessPathRow(account.accountId, work.node.id, {
        assertionIds: [assertionAB.assertionId],
        assertionRevisions: [assertionAB.revision],
        evidenceIds: [familyB.evidenceId],
        evidenceRevisions: [familyB.revision],
      });
      const cRow = await witnessPathRow(account.accountId, work.node.id, {
        assertionIds: [assertionC.assertionId],
        assertionRevisions: [assertionC.revision],
        evidenceIds: [familyC.evidenceId],
        evidenceRevisions: [familyC.revision],
      });
      const unpinned = await witnessPathRow(account.accountId, work.node.id, {
        assertionIds: [],
        assertionRevisions: [],
        evidenceIds: [],
        evidenceRevisions: [],
      });

      // Two REAL concurrent retractions on two pool connections at the
      // production READ COMMITTED isolation. A PostgreSQL 40P01 deadlock
      // would reject one of these; the consistent ascending-id frontier lock
      // order must let both commit.
      const [a, b] = await Promise.all([
        retractGraphEvidence(isoDb, { evidenceId: familyA.evidenceId, reason: 'concurrent withdrawal a' }),
        retractGraphEvidence(isoDb, { evidenceId: familyB.evidenceId, reason: 'concurrent withdrawal b' }),
      ]);
      expect(a.retracted).toBe(true);
      expect(b.retracted).toBe(true);

      // Whichever withdrawal decided last on each shared row saw the other's
      // committed retraction: no row may stay live on withdrawn support, and
      // each row expired exactly once (the second scan skips the expired
      // tuple under READ COMMITTED).
      expect(a.frontierEntriesExpired + b.frontierEntriesExpired).toBe(5);
      for (const id of bothRows) expect(await frontierState(id)).toBe('expired');
      expect(await frontierState(aOnly)).toBe('expired');
      expect(await frontierState(bOnly)).toBe('expired');
      // Unrelated evidence and unpinned rows were never selected.
      expect(await frontierState(cRow)).toBe('admitted');
      expect(await frontierState(unpinned)).toBe('admitted');
    }
  });

  it('the second withdrawal blocks on the surviving row lock and redecides after the first commits', async () => {
    const account = await insertAccount(isoDb);
    const work = await plainNode({ kind: 'work' });
    const creator = await plainNode({ kind: 'creator', sense: 'painter' });
    const familyA = await evidence();
    const familyB = await evidence();
    const assertion = await justifiedAssertionOn({ subject: work.node.id, object: creator.node.id }, [familyA, familyB]);
    const rowId = await witnessPathRow(account.accountId, work.node.id, {
      assertionIds: [assertion.assertionId],
      assertionRevisions: [assertion.revision],
      evidenceIds: [familyA.evidenceId, familyB.evidenceId],
      evidenceRevisions: [familyA.revision, familyB.revision],
    });

    const holder = await isoDb.pool.connect();
    let holderOpen = true;
    try {
      // Connection 1 holds the REAL withdrawal of A uncommitted: the row
      // must SURVIVE it (B still grounds the recorded path), and the row
      // lock it takes must stay held to its commit.
      await holder.query('BEGIN');
      const first = await retractGraphEvidence(openTransactionDb(holder), {
        evidenceId: familyA.evidenceId,
        reason: 'gallery record corrected',
      });
      expect(first.retracted).toBe(true);
      expect(first.frontierEntriesExpired).toBe(0);

      const retracer = await isoDb.pool.connect();
      let retracerOpen = true;
      try {
        await retracer.query('BEGIN');
        const pid = (await retracer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        // Connection 2: the REAL withdrawal of B. It must BLOCK on the
        // surviving row's lock — observed in pg_locks, never assumed —
        // instead of deciding the row survives on A's uncommitted-valid view.
        const second = retractGraphEvidence(openTransactionDb(retracer), {
          evidenceId: familyB.evidenceId,
          reason: 'mirror page removed',
        });
        void second.catch(() => undefined);
        await waitForBlockedOn(pid);

        // Release the barrier: connection 1 commits its withdrawal of A,
        // connection 2 re-reads the row and every dependency AFTER the wait
        // and sees no surviving witness.
        await holder.query('COMMIT');
        holderOpen = false;
        const secondResult = await second;
        expect(secondResult.retracted).toBe(true);
        expect(secondResult.frontierEntriesExpired).toBe(1);
        await retracer.query('COMMIT');
        retracerOpen = false;

        expect(await frontierState(rowId)).toBe('expired');
        // No idempotent-retry resurrection: the row stays expired.
        const retry = await retractGraphEvidence(isoDb, { evidenceId: familyB.evidenceId, reason: 'retry after commit' });
        expect(retry.retracted).toBe(false);
        expect(retry.frontierEntriesExpired).toBe(0);
        expect(await frontierState(rowId)).toBe('expired');
      } finally {
        if (retracerOpen) await retracer.query('ROLLBACK').catch(() => undefined);
        retracer.release();
      }
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});

// --- DISC-SCR-022: a dedupe refresh validates the retained pins --------------------

describe('a dedupe refresh validates the ACTUAL retained observation pins (DISC-SCR-022)', () => {
  it('a stale retained admitted row is reconciled to the just-validated observation, never left with stale live pins', async () => {
    const fx = await sharedMidpointCandidates();

    // First pass: three ranked cards plus ONE admitted-unranked candidate —
    // the live frontier row the next pass's dedupe refresh will hit.
    const first = await expand(fx.accountId);
    expect(first.expanded).toBe(true);
    expect(first.counts.diversifiedOut).toBe(1);
    const unranked = unrankedCandidateOf(first, fx.candidates);
    const before = await frontierRow(fx.accountId, unranked.node);
    expect(before?.state).toBe('admitted');

    // Revision drift on the retained row: reviewed evidence that exists but
    // is not yet attached. Attaching it re-justifies (strengthens) the
    // walked assertion and bumps its revision — the OLD observation pins
    // revision R, the next pass pins R+1.
    const spare = await evidence();
    await attachAssertionSupport(isoDb, {
      assertionId: unranked.edge.assertionId,
      evidenceId: spare.evidenceId,
      derivation: 'primary',
      sourceFamilyKey: spare.familyKey,
    });

    const second = await expand(fx.accountId);
    expect(second.expanded).toBe(true);
    expect(second.counts.admitted).toBe(4);
    expect(second.counts.stalePinsBlocked).toBe(0);
    expect(second.counts.frontierDeduped).toBeGreaterThanOrEqual(1);

    const after = await frontierRow(fx.accountId, unranked.node);
    expect(after?.state).toBe('admitted');

    // The committed frontier row must satisfy the shared read validator at
    // read time: its ACTUAL stored pins — not the newly proposed ones — are
    // what the refresh validated. (Pre-repair the stored pins kept naming
    // the pre-attach revision and failed here immediately.)
    const verdict = await frontierPinVerdict(after!.id);
    expect(verdict.valid, `stored frontier pins revalidate (${verdict.reason})`).toBe(true);

    // The stored pins are the reconciled observation's coherent set: the
    // walked assertions at their CURRENT revisions, the new evidence family
    // included, and the stale revision gone.
    const { rows: assertionRows } = await isoDb.query<{ id: string; revision: number }>(
      'SELECT id, revision FROM graph_assertions WHERE id = ANY($1::uuid[])',
      [[fx.rootEdge.assertionId, unranked.edge.assertionId]],
    );
    const revisionById = new Map(assertionRows.map((r) => [r.id, r.revision]));
    expect(after!.path.assertion_ids).toEqual([fx.rootEdge.assertionId, unranked.edge.assertionId]);
    expect(after!.path.assertion_revisions).toEqual([
      revisionById.get(fx.rootEdge.assertionId)!,
      revisionById.get(unranked.edge.assertionId)!,
    ]);
    expect(after!.path.assertion_revisions).not.toEqual(before!.path.assertion_revisions);
    expect(after!.path.evidence_ids).toContain(spare.evidenceId);
    expect((await frontierRoots(after!.id)).length).toBeGreaterThan(0);

    // The repair is visible in the pass's honest counts.
    expect(second.counts.frontierReconciled).toBe(1);
  });

  it('a CURRENT retained row keeps its stored pins and roots through an unchanged refresh', async () => {
    const fx = await sharedMidpointCandidates();
    const first = await expand(fx.accountId);
    const unranked = unrankedCandidateOf(first, fx.candidates);
    const before = await frontierRow(fx.accountId, unranked.node);
    expect(before?.state).toBe('admitted');
    const rootsBefore = await frontierRoots(before!.id);

    // Nothing changed: the second pass dedupes, refreshes the live state,
    // and must keep the valid retained pins and stored roots untouched.
    const second = await expand(fx.accountId);
    expect(second.expanded).toBe(true);
    expect(second.counts.frontierDeduped).toBeGreaterThanOrEqual(1);
    expect(second.counts.frontierReconciled ?? 0).toBe(0);

    const after = await frontierRow(fx.accountId, unranked.node);
    expect(after?.state).toBe('admitted');
    expect(after!.path).toEqual(before!.path);
    expect(await frontierRoots(after!.id)).toEqual(rootsBefore);
    expect((await frontierPinVerdict(after!.id)).valid).toBe(true);
  });

  it('a terminal frontier row is never revived or rewritten by a later dedupe refresh', async () => {
    const fx = await sharedMidpointCandidates();
    const first = await expand(fx.accountId);
    const unranked = unrankedCandidateOf(first, fx.candidates);
    const before = await frontierRow(fx.accountId, unranked.node);
    expect(before?.state).toBe('admitted');
    const rootsBefore = await frontierRoots(before!.id);

    // Withdraw the unranked candidate's sole edge evidence: the recorded
    // path loses its grounding (the walked assertion is no longer
    // justified) and the live row expires synchronously in the retraction
    // transaction.
    const retraction = await retractGraphEvidence(isoDb, {
      evidenceId: unranked.edge.evidence[0]!.evidenceId,
      reason: 'sole support withdrawn',
    });
    expect(retraction.retracted).toBe(true);
    expect(retraction.frontierEntriesExpired).toBe(1);
    const expired = await frontierRow(fx.accountId, unranked.node);
    expect(expired?.state).toBe('expired');

    // Re-justify the same assertion with a NEW independent family: the next
    // pass observes the candidate again with fresh pins — but the expired
    // row keeps its terminal history. No revival, no rewrite, no second row.
    const fresh = await evidence();
    await attachAssertionSupport(isoDb, {
      assertionId: unranked.edge.assertionId,
      evidenceId: fresh.evidenceId,
      derivation: 'primary',
      sourceFamilyKey: fresh.familyKey,
    });

    const second = await expand(fx.accountId);
    expect(second.expanded).toBe(true);
    const after = await frontierRow(fx.accountId, unranked.node);
    expect(after?.state).toBe('expired');
    expect(after!.path).toEqual(expired!.path);
    expect(await frontierRoots(after!.id)).toEqual(rootsBefore);
    const { rows: count } = await isoDb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM graph_frontier WHERE owner_account_id = $1 AND dedupe_key = $2',
      [fx.accountId, `expansion:personal:node:${unranked.node}`],
    );
    expect(Number(count[0]!.n)).toBe(1);
  });

  it('reconciliation stays inside the refreshing account own frontier row', async () => {
    const fx = await sharedMidpointCandidates();
    const first = await expand(fx.accountId);
    const unranked = unrankedCandidateOf(first, fx.candidates);
    const before = await frontierRow(fx.accountId, unranked.node);
    expect(before?.state).toBe('admitted');

    // A SECOND account holds its own admitted row for the same candidate
    // node, recording the SAME (about-to-drift) pins. The first account's
    // refresh must never touch it.
    const other = await insertAccount(isoDb);
    const otherRun = await createGraphRun(isoDb, {
      ownerAccountId: other.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const otherRow = await upsertFrontierCandidate(isoDb, {
      ownerAccountId: other.accountId,
      runId: otherRun.id,
      nodeId: unranked.node,
      dedupeKey: `expansion:personal:node:${unranked.node}`,
      expiresInDays: 7,
      pathVersions: { ...before!.path },
    });
    expect(otherRow.created).toBe(true);
    await isoDb.query(
      `UPDATE graph_frontier SET state = 'admitted', updated_at = now()
         WHERE id = $1 AND owner_account_id = $2 AND state IN ('active','admitted')`,
      [otherRow.row.id, other.accountId],
    );

    const spare = await evidence();
    await attachAssertionSupport(isoDb, {
      assertionId: unranked.edge.assertionId,
      evidenceId: spare.evidenceId,
      derivation: 'primary',
      sourceFamilyKey: spare.familyKey,
    });

    const second = await expand(fx.accountId);
    expect(second.counts.frontierReconciled).toBe(1);

    // The refreshing account's row is reconciled to current, valid pins...
    const afterA = await frontierRow(fx.accountId, unranked.node);
    expect(afterA?.state).toBe('admitted');
    expect((await frontierPinVerdict(afterA!.id)).valid).toBe(true);
    expect(afterA!.path.assertion_revisions).not.toEqual(before!.path.assertion_revisions);

    // ...while the other account's row keeps exactly its own stored record:
    // same pins, same state, same (empty) root set. Owner isolation held.
    const afterB = await frontierRow(other.accountId, unranked.node);
    expect(afterB?.state).toBe('admitted');
    expect(afterB!.path).toEqual(before!.path);
    expect(await frontierRoots(afterB!.id)).toEqual([]);
  });
});
