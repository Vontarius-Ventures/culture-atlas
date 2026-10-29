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
import { revalidateGraphProof, retractGraphEvidence } from './validity';
import { expandAccountInterestGraph, type ExpansionResult } from './expansion';
import type { GraphNodeKind, GraphNodeDomain, GraphPredicate } from './schema';

/**
 * Publication-time pinned validity (DISC-SCR-009 / VAL-DISC-007 +
 * VAL-EVID-004).
 *
 * The old publication fence checked only the RANKED observations' assertion
 * justification at the RUN-START clock: it discarded the exact pinned
 * assertion revisions, never validated the pinned evidence rows, and never
 * looked at admitted-unranked frontier candidates at all. An assertion
 * revision change, a sole-evidence/source withdrawal or an evidence/rights
 * expiry that committed DURING a (possibly long, held) pass therefore
 * published stale ranked output and left stale admitted-unranked candidate
 * state — proofs that were already invalid the moment they were stored, so
 * publication-time and read-time validity disagreed.
 *
 * The repaired contract under test:
 *
 *  - every COMMITTING observation (ranked cards AND admitted-unranked
 *    frontier candidates) revalidates its exact (id, revision) pins at a
 *    FRESH publication clock inside the publication transaction, under the
 *    same live-witness rule the read path applies; stale observations are
 *    dropped BEFORE any write, while independent currently-valid support
 *    publishes;
 *  - the pinned dependency rows are locked in one consistent ascending-id
 *    order and held to the commit, so a withdrawal or revision change either
 *    commits before the validation reads (visible: the observation is
 *    dropped) or waits for the publication commit and its dependent scan
 *    then invalidates whatever was published — a two-connection barrier in
 *    either direction cannot produce stale committed output;
 *  - expiry is decided by the publication clock, not the run-start clock:
 *    evidence/rights expiry that passes at the walk clock but has landed by
 *    publication blocks the observation;
 *  - every EMITTED proof revalidates valid at read time, so publication-time
 *    and read-time validity agree. Vision stays fail-closed throughout: pin
 *    validation never qualifies a visual claim.
 *
 * The whole file runs on ONE isolated database (the documented pattern):
 * barrier tests hold real locks and the fixtures are population-heavy, so
 * this file owns its accounts and corpus rows exclusively.
 */

let isoDb: PoolDb;
let dropIso: () => Promise<void>;

beforeAll(async () => {
  const iso = await createIsolatedDatabase('pubpins');
  isoDb = iso.db;
  dropIso = iso.drop;
});
afterAll(async () => {
  await dropIso();
});

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });

// --- Fixture helpers (all bound to the isolated database) ------------------------

type EvidenceFixture = { evidenceId: string; revision: number; familyKey: string };

/** A corpus identity with a linked cultural reference (work-like by default). */
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

/** A bare identity (no cultural reference): fine for midpoints. */
async function plainNode(over: { kind?: GraphNodeKind; domain?: GraphNodeDomain; sense?: string; name?: string } = {}) {
  const bare = await corpusNode(over);
  return { node: bare.node };
}

/** One reviewed evidence row (CC0 museum record), with optional expiry dates. */
async function evidence(over: { expiresAt?: Date | null; rightsExpiresAt?: Date | null } = {}): Promise<EvidenceFixture> {
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
    rightsExpiresAt: over.rightsExpiresAt ?? null,
  });
  const inserted = await insertEvidence(isoDb, {
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

/** A validated, currently justified assertion (independent evidence per edge). */
async function justifiedEdge(input: {
  subject: string;
  predicate: GraphPredicate;
  object: string;
  subtype?: string | null;
  evidence?: EvidenceFixture[];
}) {
  const supports = input.evidence ?? [await evidence()];
  const upserted = await upsertGraphAssertion(isoDb, {
    subjectNodeId: input.subject,
    predicate: input.predicate,
    objectNodeId: input.object,
    associationSubtype: input.subtype ?? null,
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
  return { assertionId: rows[0]!.id, revision: rows[0]!.revision, evidence: supports };
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

async function expand(accountId: string, at?: Date): Promise<ExpansionResult> {
  return expandAccountInterestGraph(isoDb, { accountId, config: graphOn, at });
}

/**
 * Resolves once at least `atLeast` backends are observed WAITING on a lock
 * whose in-flight query matches `pattern` — the park itself is never assumed.
 * Fails honestly on timeout, so a barrier test cannot pass by racing past it.
 */
async function waitForLockWaiters(pattern: string, atLeast: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await isoDb.query<{ n: number }>(
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
 * A Db view of one dedicated pool client that joins the CALLER's already-open
 * transaction instead of issuing its own BEGIN/COMMIT: the real retraction or
 * attachment runs its exact production statements while the test holds the
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

/** The account's frontier row for one candidate node (its canonical dedupe key). */
async function frontierRowFor(accountId: string, nodeId: string) {
  const { rows } = await isoDb.query<{ id: string; state: string }>(
    'SELECT id, state FROM graph_frontier WHERE owner_account_id = $1 AND dedupe_key = $2',
    [accountId, `expansion:personal:node:${nodeId}`],
  );
  return rows[0] ?? null;
}

/** The proof behind one candidate's published card (by its discovery item). */
async function proofByItem(accountId: string, itemId: string) {
  const { rows } = await isoDb.query<{ id: string; validity_state: string }>(
    `SELECT p.id, p.validity_state FROM recommendation_graph_proofs p
       JOIN recommendations r ON r.id = p.recommendation_id
      WHERE p.owner_account_id = $1 AND r.discovery_item_id = $2`,
    [accountId, itemId],
  );
  return rows[0] ?? null;
}

async function allProofs(accountId: string) {
  const { rows } = await isoDb.query<{ id: string; validity_state: string }>(
    'SELECT id, validity_state FROM recommendation_graph_proofs WHERE owner_account_id = $1',
    [accountId],
  );
  return rows;
}

/** Every emitted proof must revalidate valid at read time (agreement contract). */
async function expectEmittedProofsAgree(accountId: string): Promise<void> {
  const proofs = await allProofs(accountId);
  for (const proof of proofs) {
    expect(proof.validity_state, `stored proof ${proof.id}`).toBe('valid');
    const verdict = await revalidateGraphProof(isoDb, { proofId: proof.id });
    expect(verdict.valid, `read-time revalidation of ${proof.id} (${verdict.reason})`).toBe(true);
  }
}

/**
 * Two FULLY independent publishable connections for one account: root A and
 * candidate A share creator C1, root B and candidate B share creator C2, and
 * the two paths share no assertion, evidence or midpoint. A withdrawal or
 * expiry on the A path must never block the B path.
 */
async function twoCandidates(
  over: {
    rootEdgeAExpiry?: { expiresAt?: Date | null; rightsExpiresAt?: Date | null };
    candEdgeAExpiry?: { expiresAt?: Date | null; rightsExpiresAt?: Date | null };
  } = {},
) {
  const principal = await insertAccount(isoDb);
  const accountId = principal.accountId;
  const ctx = testContext(principal, { db: isoDb, config: graphOn });
  const rootA = await corpusNode({ name: 'Pin root A' });
  const candA = await corpusNode({ name: 'Pin candidate A' });
  const creator1 = await plainNode({ kind: 'creator', sense: 'painter' });
  const rootB = await corpusNode({ name: 'Pin root B' });
  const candB = await corpusNode({ name: 'Pin candidate B' });
  const creator2 = await plainNode({ kind: 'creator', sense: 'painter' });
  const rootEdgeA = await justifiedEdge({
    subject: rootA.node.id,
    predicate: 'CREATED_BY',
    object: creator1.node.id,
    evidence: [await evidence(over.rootEdgeAExpiry ?? {})],
  });
  const candEdgeA = await justifiedEdge({
    subject: candA.node.id,
    predicate: 'CREATED_BY',
    object: creator1.node.id,
    evidence: [await evidence(over.candEdgeAExpiry ?? {})],
  });
  const rootEdgeB = await justifiedEdge({
    subject: rootB.node.id,
    predicate: 'CREATED_BY',
    object: creator2.node.id,
  });
  const candEdgeB = await justifiedEdge({
    subject: candB.node.id,
    predicate: 'CREATED_BY',
    object: creator2.node.id,
  });
  await savedItem(ctx, accountId, rootA.referenceId!);
  await savedItem(ctx, accountId, rootB.referenceId!);
  const itemA = await candidateItem(accountId, candA.referenceId!);
  const itemB = await candidateItem(accountId, candB.referenceId!);
  await project(accountId);
  return { accountId, candA: candA.node.id, candB: candB.node.id, itemA, itemB, rootEdgeA, candEdgeA, rootEdgeB, candEdgeB };
}

/**
 * Four candidates sharing ONE midpoint creator with one saved root: the
 * rail's diversification bound (3 per midpoint) keeps the fourth candidate
 * ADMITTED but UNRANKED — frontier candidate state without a card, exactly
 * the committing observation class the old fence never looked at.
 */
async function sharedMidpointCandidates() {
  const principal = await insertAccount(isoDb);
  const accountId = principal.accountId;
  const ctx = testContext(principal, { db: isoDb, config: graphOn });
  const root = await corpusNode({ name: 'Shared midpoint root' });
  const creator = await plainNode({ kind: 'creator', sense: 'painter' });
  await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
  await savedItem(ctx, accountId, root.referenceId!);
  const candidates: Array<{ node: string; itemId: string; edge: Awaited<ReturnType<typeof justifiedEdge>> }> = [];
  for (let i = 0; i < 4; i += 1) {
    const cand = await corpusNode({ name: `Shared midpoint candidate ${i}` });
    const edge = await justifiedEdge({ subject: cand.node.id, predicate: 'CREATED_BY', object: creator.node.id });
    const itemId = await candidateItem(accountId, cand.referenceId!);
    candidates.push({ node: cand.node.id, itemId, edge });
  }
  await project(accountId);
  return { accountId, candidates };
}

// --- Mid-run withdrawals: two-connection barriers --------------------------------

describe('publication pins validate exact revisions at a fresh clock (DISC-SCR-009)', () => {
  it('a sole-evidence withdrawal committed during the pass drops only the stale candidate', async () => {
    const fx = await twoCandidates();

    // Connection 1 holds the REAL withdrawal in flight (uncommitted): the
    // pass must park on the pinned evidence row at its publication pin
    // check, then see the committed withdrawal and drop the stale
    // candidate — never publish it.
    const holder = await isoDb.pool.connect();
    let holderOpen = true;
    let pass: Promise<ExpansionResult> | undefined;
    try {
      await holder.query('BEGIN');
      await retractGraphEvidence(openTransactionDb(holder), {
        evidenceId: fx.candEdgeA.evidence[0]!.evidenceId,
        reason: 'mid-pass withdrawal test',
      });
      pass = expand(fx.accountId);
      void pass.catch(() => undefined);
      await waitForLockWaiters('%FOR SHARE%', 1);
      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      if (pass) await pass.catch(() => undefined);
    }

    const result = await pass!;
    expect(result.expanded).toBe(true);
    // Only the stale candidate is blocked; the independent connection publishes.
    expect(result.candidates.map((c) => c.nodeId)).toEqual([fx.candB]);
    expect(result.candidates[0]!.rank).toBe(1);
    expect(result.counts.stalePinsBlocked).toBe(1);
    expect(result.rejections['pinned_assertion_unjustified'] ?? 0).toBeGreaterThanOrEqual(1);
    // No stale rows anywhere: neither frontier state nor card/proof for A.
    expect(await frontierRowFor(fx.accountId, fx.candA)).toBeNull();
    expect(await proofByItem(fx.accountId, fx.itemA)).toBeNull();
    // The published proof agrees between publication and read time.
    const bProof = await proofByItem(fx.accountId, fx.itemB);
    expect(bProof?.validity_state).toBe('valid');
    await expectEmittedProofsAgree(fx.accountId);
  });

  it('an assertion revision change committed during the pass drops only the stale candidate', async () => {
    const fx = await twoCandidates();
    // Reviewed evidence that exists but is not yet attached: attaching it
    // mid-pass bumps the walked assertion's revision — the old fence checked
    // only current justification (which ATTACHING strengthens) and discarded
    // the pinned revision, so it published an immediately invalid proof.
    const spare = await evidence();

    const holder = await isoDb.pool.connect();
    let holderOpen = true;
    let pass: Promise<ExpansionResult> | undefined;
    try {
      await holder.query('BEGIN');
      await attachAssertionSupport(openTransactionDb(holder), {
        assertionId: fx.candEdgeA.assertionId,
        evidenceId: spare.evidenceId,
        derivation: 'primary',
        sourceFamilyKey: spare.familyKey,
      });
      pass = expand(fx.accountId);
      void pass.catch(() => undefined);
      await waitForLockWaiters('%FOR SHARE%', 1);
      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      if (pass) await pass.catch(() => undefined);
    }

    const result = await pass!;
    expect(result.expanded).toBe(true);
    expect(result.candidates.map((c) => c.nodeId)).toEqual([fx.candB]);
    expect(result.counts.stalePinsBlocked).toBe(1);
    expect(result.rejections['pinned_assertion_revision_changed'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(await frontierRowFor(fx.accountId, fx.candA)).toBeNull();
    expect(await proofByItem(fx.accountId, fx.itemA)).toBeNull();
    // A's assertion is MORE justified now, but the observation pinned the
    // pre-attach revision; B is untouched and publishes.
    const bProof = await proofByItem(fx.accountId, fx.itemB);
    expect(bProof?.validity_state).toBe('valid');
    await expectEmittedProofsAgree(fx.accountId);
  });

  it('publication ordered before an in-flight withdrawal: the withdrawal lands after the commit and repairs', async () => {
    const fx = await twoCandidates();

    // The pass is parked at its publication fence (after the pin check) by a
    // held account lock; the withdrawal then starts while the pass still
    // HOLDS its publication pin locks: it must BLOCK on the pinned evidence
    // row instead of slipping between the validation and the commit.
    const holder = await isoDb.pool.connect();
    let holderOpen = true;
    let pass: Promise<ExpansionResult> | undefined;
    let withdrawal: Promise<Awaited<ReturnType<typeof retractGraphEvidence>>> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [fx.accountId]);
      pass = expand(fx.accountId);
      void pass.catch(() => undefined);
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);

      withdrawal = retractGraphEvidence(isoDb, {
        evidenceId: fx.candEdgeA.evidence[0]!.evidenceId,
        reason: 'publisher-wins withdrawal test',
      });
      void withdrawal.catch(() => undefined);
      await waitForLockWaiters('%UPDATE graph_evidence%', 1);

      await holder.query('COMMIT');
      holderOpen = false;
      const result = await pass!;
      const retr = await withdrawal;
      expect(result.expanded).toBe(true);
      // Both candidates were valid at their publication instant: the
      // withdrawal had not committed yet (it was blocked on the pin lock).
      expect(result.candidates.map((c) => c.nodeId).sort()).toEqual([fx.candA, fx.candB].sort());
      // The withdrawal lands AFTER the commit and its dependent scan repairs
      // the newly committed rows: A's proof is invalidated, while independent
      // B survives untouched.
      expect(retr.retracted).toBe(true);
      expect(retr.proofsInvalidated).toBe(1);
      const aProof = await proofByItem(fx.accountId, fx.itemA);
      expect(aProof?.validity_state).toBe('invalid');
      const bProof = await proofByItem(fx.accountId, fx.itemB);
      expect(bProof?.validity_state).toBe('valid');
      const bVerdict = await revalidateGraphProof(isoDb, { proofId: bProof!.id });
      expect(bVerdict.valid).toBe(true);
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      if (pass) await pass.catch(() => undefined);
      if (withdrawal) await withdrawal.catch(() => undefined);
    }
  });

  // --- Expiry-clock tests: the publication clock, not the run-start clock ----

  it('evidence that expires during the run is blocked at the fresh publication clock', async () => {
    const past = new Date(Date.now() - 60_000);
    const midRun = new Date(Date.now() - 30_000);
    // The A path's sole candidate-edge evidence was valid when the walk read
    // it at the past clock, and has expired by the publication clock.
    const fx = await twoCandidates({ candEdgeAExpiry: { expiresAt: midRun } });
    const result = await expand(fx.accountId, past);
    expect(result.expanded).toBe(true);
    expect(result.candidates.map((c) => c.nodeId)).toEqual([fx.candB]);
    expect(result.counts.stalePinsBlocked).toBe(1);
    expect(result.rejections['pinned_assertion_unjustified'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(await frontierRowFor(fx.accountId, fx.candA)).toBeNull();
    expect(await proofByItem(fx.accountId, fx.itemA)).toBeNull();
    await expectEmittedProofsAgree(fx.accountId);
  });

  it('a candidate whose every pinned evidence row expired mid-run is blocked with the evidence-expiry reason', async () => {
    const past = new Date(Date.now() - 60_000);
    const midRun = new Date(Date.now() - 30_000);
    // Both edges of the A path carry expiring evidence: the observation
    // retains NO live grounding witness at the publication clock, and the
    // exact reason is the evidence expiry itself.
    const fx = await twoCandidates({ rootEdgeAExpiry: { expiresAt: midRun }, candEdgeAExpiry: { expiresAt: midRun } });
    const result = await expand(fx.accountId, past);
    expect(result.expanded).toBe(true);
    expect(result.candidates.map((c) => c.nodeId)).toEqual([fx.candB]);
    expect(result.rejections['pinned_evidence_expired'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(await frontierRowFor(fx.accountId, fx.candA)).toBeNull();
    await expectEmittedProofsAgree(fx.accountId);
  });

  it('source rights that expire during the run are blocked at the fresh publication clock', async () => {
    const past = new Date(Date.now() - 60_000);
    const midRun = new Date(Date.now() - 30_000);
    // The A path's evidence is unexpired as content, but the rights behind
    // both of its revisions lapsed mid-run: rights expiry is a publication
    // clock decision, not a run-start one.
    const fx = await twoCandidates({ rootEdgeAExpiry: { rightsExpiresAt: midRun }, candEdgeAExpiry: { rightsExpiresAt: midRun } });
    const result = await expand(fx.accountId, past);
    expect(result.expanded).toBe(true);
    expect(result.candidates.map((c) => c.nodeId)).toEqual([fx.candB]);
    expect(result.rejections['pinned_rights_expired'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(await frontierRowFor(fx.accountId, fx.candA)).toBeNull();
    expect(await proofByItem(fx.accountId, fx.itemA)).toBeNull();
    await expectEmittedProofsAgree(fx.accountId);
  });

  // --- Admitted-unranked frontier coverage ------------------------------------

  it('a mid-run withdrawal also blocks the stale admitted-unranked frontier candidate', async () => {
    const fx = await sharedMidpointCandidates();

    // First pass: three ranked cards plus ONE admitted-unranked candidate —
    // the committing observation class the old fence never inspected.
    const first = await expand(fx.accountId);
    expect(first.expanded).toBe(true);
    expect(first.counts.admitted).toBe(4);
    expect(first.counts.diversifiedOut).toBe(1);
    expect(first.candidates).toHaveLength(3);
    const rankedNodes = new Set(first.candidates.map((c) => c.nodeId));
    const unranked = fx.candidates.find((c) => !rankedNodes.has(c.node))!;
    expect(unranked).toBeDefined();

    // Clear the unranked candidate's first-pass frontier row so the second
    // pass is the one that would wrongly (re)create it: the in-flight
    // withdrawal then has no earlier row to expire, and only the publication
    // pin check can prevent a stale committed row.
    await isoDb.query('DELETE FROM graph_frontier WHERE owner_account_id = $1 AND dedupe_key = $2', [
      fx.accountId,
      `expansion:personal:node:${unranked.node}`,
    ]);

    const holder = await isoDb.pool.connect();
    let holderOpen = true;
    let pass: Promise<ExpansionResult> | undefined;
    try {
      await holder.query('BEGIN');
      await retractGraphEvidence(openTransactionDb(holder), {
        evidenceId: unranked.edge.evidence[0]!.evidenceId,
        reason: 'mid-pass unranked withdrawal test',
      });
      pass = expand(fx.accountId);
      void pass.catch(() => undefined);
      await waitForLockWaiters('%FOR SHARE%', 1);
      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      if (pass) await pass.catch(() => undefined);
    }

    const second = await pass!;
    expect(second.expanded).toBe(true);
    expect(second.candidates).toHaveLength(3);
    expect(second.counts.admitted).toBe(4);
    expect(second.counts.stalePinsBlocked).toBe(1);
    // The stale unranked candidate never reaches the frontier at all.
    expect(await frontierRowFor(fx.accountId, unranked.node)).toBeNull();
    const { rows: staleLive } = await isoDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_frontier
        WHERE state IN ('active','admitted') AND (path_versions -> 'evidence_ids') ?| ARRAY[$1::text]`,
      [unranked.edge.evidence[0]!.evidenceId],
    );
    expect(Number(staleLive[0]!.n)).toBe(0);
    // The three ranked candidates publish with proofs that agree at read time.
    for (const c of second.candidates) {
      expect(c.discoveryItemId).not.toBeNull();
      const proof = await proofByItem(fx.accountId, c.discoveryItemId!);
      expect(proof?.validity_state).toBe('valid');
    }
    await expectEmittedProofsAgree(fx.accountId);
  });

  // --- Control: unchanged pins publish and both validity views agree ---------

  it('unchanged pins publish and every emitted proof agrees between publication and read time', async () => {
    const fx = await twoCandidates();
    const result = await expand(fx.accountId);
    expect(result.expanded).toBe(true);
    expect(result.candidates.map((c) => c.nodeId).sort()).toEqual([fx.candA, fx.candB].sort());
    expect(result.counts.stalePinsBlocked).toBe(0);
    // Vision stays fail-closed: pin validation never qualifies a visual claim.
    expect(result.visionQualified).toBe(false);
    for (const c of result.candidates) {
      expect(c.reason).not.toMatch(/resembl|visual/i);
    }
    const proofs = await allProofs(fx.accountId);
    expect(proofs).toHaveLength(2);
    await expectEmittedProofsAgree(fx.accountId);
  });
});
