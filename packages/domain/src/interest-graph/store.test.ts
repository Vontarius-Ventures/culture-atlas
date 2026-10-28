import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAccount } from '../testing';
import type { PoolDb } from '../db/pool';
import {
  addEdgeSupport,
  createGraphRun,
  enqueueGraphOutboxEvent,
  graphRunForOwner,
  insertGraphRecommendation,
  insertRecommendationProof,
  latestPublishedGraphRun,
  loadGraphRunCards,
  markGraphOutboxDispatched,
  pendingGraphOutboxEvents,
  purgeAccountGraphState,
  recordGraphProviderQuery,
  setGraphRunState,
  upsertFrontierCandidate,
  upsertPersonalEdge,
} from './store';

/**
 * Typed writer/reader contracts for the interest graph (PR 8 package A):
 * every function is account-scoped, cross-owner ids resolve non-disclosing
 * (not_found), the graph parent writers keep owner joins intact, and cleanup
 * removes every private graph row without touching other accounts.
 */

const db = getTestDb();
afterAll(closeTestDb);

async function accountItem(dbh: PoolDb, accountId: string, key = randomUUID()): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title)
     VALUES ($1, 'film', 'watch', $2, 'A film') RETURNING id`,
    [accountId, `qloo:${key}`],
  );
  return rows[0]!.id;
}

async function savedItem(dbh: PoolDb, accountId: string, itemId: string): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    'INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2) RETURNING id',
    [accountId, itemId],
  );
  return rows[0]!.id;
}

async function graphNode(dbh: PoolDb, key = randomUUID()): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO graph_nodes (canonical_key, canonical_name, name_key, node_kind, domain, sense_key)
     VALUES ($1, $2, $3, 'creator', 'art', 'person') RETURNING id`,
    [`atlas:${key}`, `Name ${key}`, `name-${key}`],
  );
  return rows[0]!.id;
}

describe('graph run contracts', () => {
  it('creates a run and resolves it only for its owner', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const run = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      inputTasteRevision: 4,
      inputProjectionRevision: 2,
      policyVersion: 'graph-policy-1',
      budget: { max_hops: 2 },
    });
    expect(run.id).toBeTruthy();
    expect(run.state).toBe('queued');
    expect(await graphRunForOwner(db, { runId: run.id, ownerAccountId: a.accountId })).toBeTruthy();
    // Cross-owner ids are non-disclosing: the run simply does not exist for B.
    expect(await graphRunForOwner(db, { runId: run.id, ownerAccountId: b.accountId })).toBeNull();
    expect(await graphRunForOwner(db, { runId: randomUUID(), ownerAccountId: a.accountId })).toBeNull();
  });

  it('transitions run state and selects only the latest published success', async () => {
    const a = await insertAccount(db);
    const first = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    await setGraphRunState(db, { runId: first.id, ownerAccountId: a.accountId, state: 'complete', published: true });
    const failed = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    await setGraphRunState(db, { runId: failed.id, ownerAccountId: a.accountId, state: 'failed' });
    const latest = await latestPublishedGraphRun(db, a.accountId);
    expect(latest?.id).toBe(first.id);
    // A queued run, even newer, is never selected over the last success.
    await createGraphRun(db, { ownerAccountId: a.accountId, runKind: 'expansion', policyVersion: 'graph-policy-1' });
    expect((await latestPublishedGraphRun(db, a.accountId))?.id).toBe(first.id);
    // Cross-owner read is non-disclosing.
    const b = await insertAccount(db);
    expect(await latestPublishedGraphRun(db, b.accountId)).toBeNull();
  });
});

describe('graph outbox contracts', () => {
  it('upserts bursts to one row per revision and reads only pending events', async () => {
    const a = await insertAccount(db);
    const r5a = await enqueueGraphOutboxEvent(db, {
      ownerAccountId: a.accountId,
      eventType: 'taste',
      logicalEventKey: 'taste',
      targetTasteRevision: 5,
      jobIntent: 'project_interest_graph',
      payload: { action: 'save' },
    });
    const r5b = await enqueueGraphOutboxEvent(db, {
      ownerAccountId: a.accountId,
      eventType: 'taste',
      logicalEventKey: 'taste',
      targetTasteRevision: 5,
      jobIntent: 'project_interest_graph',
      payload: { action: 'hide' },
    });
    expect(r5b.id).toBe(r5a.id);
    // The burst keeps the newest intent for that revision.
    expect(r5b.payload).toEqual({ action: 'hide' });
    // A newer effective revision is a new durable row.
    const r6 = await enqueueGraphOutboxEvent(db, {
      ownerAccountId: a.accountId,
      eventType: 'taste',
      logicalEventKey: 'taste',
      targetTasteRevision: 6,
      jobIntent: 'project_interest_graph',
      payload: {},
    });
    expect(r6.id).not.toBe(r5a.id);

    const pending = await pendingGraphOutboxEvents(db, { ownerAccountId: a.accountId, limit: 10 });
    expect(pending.map((e) => e.target_taste_revision).sort()).toEqual([5, 6]);
    await markGraphOutboxDispatched(db, pending.map((e) => e.id));
    expect(await pendingGraphOutboxEvents(db, { ownerAccountId: a.accountId, limit: 10 })).toEqual([]);
    // Re-dispatch is idempotent (at-least-once safe).
    await markGraphOutboxDispatched(db, pending.map((e) => e.id));
  });
});

describe('personal edge and support contracts', () => {
  it('upserts one edge per owner target and scopes support rows', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const nodeA = await graphNode(db);
    const nodeShared = await graphNode(db);
    const edge1 = await upsertPersonalEdge(db, {
      ownerAccountId: a.accountId,
      target: { kind: 'node', nodeId: nodeShared },
      origin: 'explicit',
      policyVersion: 'graph-policy-1',
    });
    const edge2 = await upsertPersonalEdge(db, {
      ownerAccountId: a.accountId,
      target: { kind: 'node', nodeId: nodeShared },
      origin: 'explicit',
      policyVersion: 'graph-policy-1',
    });
    expect(edge2.id).toBe(edge1.id);
    expect(edge2.state).toBe('confirmed');
    // The same shared identity is a distinct private edge for another account.
    const edgeB = await upsertPersonalEdge(db, {
      ownerAccountId: b.accountId,
      target: { kind: 'node', nodeId: nodeShared },
      origin: 'derived',
      policyVersion: 'graph-policy-1',
    });
    expect(edgeB.id).not.toBe(edge1.id);
    expect(edgeB.state).toBe('tentative');

    const itemA = await accountItem(db, a.accountId);
    const saved = await savedItem(db, a.accountId, itemA);
    const support = await addEdgeSupport(db, {
      ownerAccountId: a.accountId,
      edgeId: edge1.id,
      originKind: 'saved_item',
      savedItemId: saved,
    });
    expect(support.active).toBe(true);
    void nodeA;
  });
});

describe('graph parent writers and readers', () => {
  it('writes graph-parented cards and reads them only for the owner', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const itemA = await accountItem(db, a.accountId);
    const itemB = await accountItem(db, b.accountId);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const queryA = await recordGraphProviderQuery(db, {
      ownerAccountId: a.accountId,
      runId: runA.id,
      provider: 'qloo',
      operation: 'search',
      sanitizedRequest: { seed: 'art' },
    });
    expect(queryA.id).toBeTruthy();
    const rec = await insertGraphRecommendation(db, {
      ownerAccountId: a.accountId,
      runId: runA.id,
      discoveryItemId: itemA,
      origin: 'qloo',
      title: 'A graph-backed card',
      providerQueryIds: [queryA.id],
    });
    expect(rec.owner_account_id).toBe(a.accountId);

    const proof = await insertRecommendationProof(db, {
      ownerAccountId: a.accountId,
      recommendationId: rec.id,
      graphRunId: runA.id,
      intent: 'personal',
      reasonTemplate: 'created_by',
      assertions: [{ id: randomUUID(), revision: 1 }],
    });
    expect(proof.proof_version).toBe(1);

    const cards = await loadGraphRunCards(db, { accountId: a.accountId });
    expect(cards.recommendations.map((r) => r.id)).toContain(rec.id);
    expect(cards.providerQueries.map((q) => q.id)).toContain(queryA.id);
    expect(cards.proofs.map((p) => p.id)).toContain(proof.id);
    // The owner join hides every graph-parented row from another account.
    const cardsB = await loadGraphRunCards(db, { accountId: b.accountId });
    expect(cardsB.recommendations.map((r) => r.id)).not.toContain(rec.id);

    // Cross-owner writes fail closed (not_found), without leaking existence.
    await expect(
      insertGraphRecommendation(db, {
        ownerAccountId: b.accountId,
        runId: runA.id,
        discoveryItemId: itemB,
        origin: 'qloo',
        title: 'stolen card',
        providerQueryIds: [randomUUID()],
      }),
    ).rejects.toThrow(/not found|not_found/i);
  });
});

describe('frontier contracts', () => {
  it('dedupes candidates per account within the seven-day window', async () => {
    const a = await insertAccount(db);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const n = await graphNode(db);
    const first = await upsertFrontierCandidate(db, {
      ownerAccountId: a.accountId,
      runId: runA.id,
      nodeId: n,
      dedupeKey: `node:${n}`,
      expiresInDays: 7,
    });
    expect(first.created).toBe(true);
    const again = await upsertFrontierCandidate(db, {
      ownerAccountId: a.accountId,
      runId: runA.id,
      nodeId: n,
      dedupeKey: `node:${n}`,
      expiresInDays: 7,
    });
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
  });
});

describe('account cleanup contract', () => {
  it('purges every private graph row for one account and leaves others intact', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const itemA = await accountItem(db, a.accountId);
    const runA = await createGraphRun(db, {
      ownerAccountId: a.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const recA = await insertGraphRecommendation(db, {
      ownerAccountId: a.accountId,
      runId: runA.id,
      discoveryItemId: itemA,
      origin: 'qloo',
      title: 'A card',
      providerQueryIds: [randomUUID()],
    });
    await insertRecommendationProof(db, {
      ownerAccountId: a.accountId,
      recommendationId: recA.id,
      graphRunId: runA.id,
      intent: 'personal',
      reasonTemplate: 'created_by',
    });
    const runB = await createGraphRun(db, {
      ownerAccountId: b.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    await enqueueGraphOutboxEvent(db, {
      ownerAccountId: a.accountId,
      eventType: 'taste',
      logicalEventKey: 'taste',
      targetTasteRevision: 1,
      jobIntent: 'project_interest_graph',
    });

    const purged = await purgeAccountGraphState(db, a.accountId);
    expect(purged.recommendationGraphProofs).toBe(1);
    expect(purged.graphFrontier).toBe(0);
    expect(purged.recommendations).toBe(1);
    expect(purged.providerQueries).toBe(0);
    expect(purged.graphRuns).toBe(1);
    expect(purged.graphOutbox).toBe(1);

    // Nothing graph-owned by A survives; B is untouched.
    const remaining = await db.query<{ n: string }>(
      'SELECT COUNT(*)::int AS n FROM graph_runs WHERE owner_account_id = $1',
      [a.accountId],
    );
    expect(remaining.rows[0]!.n).toBe(0);
    const runsB = await db.query<{ n: string }>(
      'SELECT COUNT(*)::int AS n FROM graph_runs WHERE owner_account_id = $1',
      [b.accountId],
    );
    expect(runsB.rows[0]!.n).toBe(1);
    void runB;
  });
});
