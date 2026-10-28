import { afterAll, describe, expect, it } from 'vitest';
import { liftFeatureKill, setFeatureKill } from '../flags/feature-flags';
import { createAccount } from '../services/auth';
import { recordPreference } from '../services/preferences';
import { loadFoldSaves } from '../services/taste';
import { accountCtx, anonCtx, ctxFor, insertCaptureWithAnalysis, insertItem, insertReference } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { dispatchGraphOutbox } from './dispatch';
import { projectAccountInterestGraph } from './projector';

/**
 * VAL-PROJ-007 / VAL-PROJ-008: the projector and its outbox dispatch.
 * Duplicate, out-of-order and interrupted delivery rebuild deterministically
 * from current authoritative state under a per-account lock with revision
 * fences: no duplicate support, no revision regression, no resurrection of
 * withdrawn support, and a committed intent never depends on the dispatcher
 * being up. Projection writes only private graph state: live recommendations
 * stay untouched (shadow).
 */

const db = getTestDb();
afterAll(closeTestDb);

const projectionOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

interface StateRow {
  state: string;
  target_taste_revision: number;
  applied_taste_revision: number;
  projection_revision: number;
  last_error_code: string | null;
  last_graph_run_id: string | null;
}

async function stateRow(accountId: string): Promise<StateRow | null> {
  const { rows } = await db.query<StateRow>(
    `SELECT state, target_taste_revision, applied_taste_revision, projection_revision, last_error_code, last_graph_run_id
       FROM personal_graph_state WHERE owner_account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

async function tasteRevision(accountId: string): Promise<number> {
  const { rows } = await db.query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [
    accountId,
  ]);
  return rows[0]?.revision ?? 0;
}

interface SupportShape {
  edgeTarget: string | null;
  originKind: string;
  sourceId: string | null;
  dependencyVersions: Record<string, unknown>;
  originatingEventId: string | null;
}

/** Structural support content: no ids/timestamps, so rebuilds compare equal. */
async function supportShapes(accountId: string): Promise<SupportShape[]> {
  const { rows } = await db.query<{
    edge_item: string | null;
    edge_node: string | null;
    edge_save: string | null;
    origin_kind: string;
    saved_item_id: string | null;
    pick_id: string | null;
    capture_reference_id: string | null;
    dependency_versions: Record<string, unknown>;
    originating_event_id: string | null;
  }>(
    `SELECT e.discovery_item_id AS edge_item, e.node_id AS edge_node, e.saved_item_id AS edge_save, s.origin_kind,
            s.saved_item_id, s.pick_id, s.capture_reference_id, s.dependency_versions,
            s.originating_event_id
       FROM personal_interest_support s
       JOIN personal_interest_edges e ON e.id = s.edge_id
      WHERE s.owner_account_id = $1
      ORDER BY e.discovery_item_id, e.node_id, e.saved_item_id, s.origin_kind, s.saved_item_id, s.pick_id, s.capture_reference_id`,
    [accountId],
  );
  return rows.map((r) => ({
    edgeTarget: r.edge_item ?? r.edge_node ?? r.edge_save,
    originKind: r.origin_kind,
    sourceId: r.saved_item_id ?? r.pick_id ?? r.capture_reference_id,
    dependencyVersions: {
      analysis_id: r.dependency_versions?.analysis_id ?? null,
      analysis_version: r.dependency_versions?.analysis_version ?? null,
      origin: r.dependency_versions?.origin ?? null,
    },
    originatingEventId: r.originating_event_id,
  }));
}

async function edgeCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*) AS n FROM personal_interest_edges WHERE owner_account_id = $1',
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function outboxStates(accountId: string): Promise<{ id: string; dispatch_state: string; target: number }[]> {
  const { rows } = await db.query<{ id: string; dispatch_state: string; target: number }>(
    `SELECT id, dispatch_state, target_taste_revision AS target FROM graph_outbox
      WHERE owner_account_id = $1 ORDER BY target_taste_revision, id`,
    [accountId],
  );
  return rows;
}

async function captureReference(analysisId: string, referenceId: string, resolution = 'resolved'): Promise<void> {
  await db.query(
    `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor)
     VALUES ($1, $2, 'resembles', 0.8, $3, false)`,
    [analysisId, referenceId, resolution],
  );
}

async function dispatch(accountId: string, config = projectionOn) {
  return dispatchGraphOutbox(db, { config, ownerAccountId: accountId });
}

async function project(accountId: string, jobId?: string) {
  return projectAccountInterestGraph(db, { accountId, config: projectionOn, source: 'mutation_intent', jobId });
}

describe('projector: idempotent projection and revision fences (VAL-PROJ-008)', () => {
  it('dispatch hands pending intents to one queue job and the projector applies the current revision', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const film = await insertItem({ accountId: principal.accountId }, { kind: 'film', title: 'Amélie' });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: film });
    const ref = await insertReference({ name: 'Noguchi lamp' });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await captureReference(cap.analysisId, ref);
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });

    const pending = await outboxStates(principal.accountId);
    expect(pending.map((e) => e.dispatch_state)).toEqual(['pending', 'pending']);
    // Nothing has projected yet: no state row exists (mutations never touch
    // it, so they never block on the projector's account lock).
    expect(await stateRow(principal.accountId)).toBeNull();

    const dispatched = await dispatch(principal.accountId);
    expect(dispatched.accounts).toHaveLength(1);
    expect(dispatched.accounts[0]).toMatchObject({ accountId: principal.accountId, reused: false });
    expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'dispatched')).toBe(true);
    const queued = (await stateRow(principal.accountId))!;
    expect(queued.state).toBe('queued');

    const result = await project(principal.accountId, dispatched.accounts[0]!.jobId);
    expect(result.projected).toBe(true);
    expect(result.tailClean).toBe(true);
    expect(result.appliedTasteRevision).toBe(await tasteRevision(principal.accountId));
    expect(result.explicitRoots).toBe(2);

    const state = (await stateRow(principal.accountId))!;
    expect(state).toMatchObject({
      state: 'ready',
      applied_taste_revision: await tasteRevision(principal.accountId),
      target_taste_revision: await tasteRevision(principal.accountId),
      projection_revision: 1,
    });
    expect(state.last_graph_run_id).toBe(result.graphRunId);

    // Edges: the film and the capture item are confirmed explicit roots.
    const { rows: edges } = await db.query<{ discovery_item_id: string; origin: string; state: string }>(
      'SELECT discovery_item_id, origin, state FROM personal_interest_edges WHERE owner_account_id = $1 ORDER BY discovery_item_id',
      [principal.accountId],
    );
    expect(edges).toHaveLength(2);
    for (const e of edges) {
      expect(e).toMatchObject({ origin: 'explicit', state: 'confirmed' });
    }

    // Support: one saved_item per save, plus the capture reference at exact
    // dependency versions; lineage names the real save event where one exists.
    const shapes = await supportShapes(principal.accountId);
    expect(shapes.filter((s) => s.originKind === 'saved_item')).toHaveLength(2);
    const refSupport = shapes.find((s) => s.originKind === 'capture_reference')!;
    expect(refSupport.dependencyVersions).toMatchObject({
      analysis_id: cap.analysisId,
      analysis_version: 1,
      origin: 'mutation_intent',
    });
    const { rows: saveEvents } = await db.query<{ id: string }>(
      `SELECT id FROM preference_events WHERE owner_account_id = $1 AND action = 'save' ORDER BY created_at`,
      [principal.accountId],
    );
    expect(shapes.filter((s) => s.originKind === 'saved_item').map((s) => s.originatingEventId).sort()).toEqual(
      saveEvents.map((e) => e.id).sort(),
    );
    expect(refSupport.originatingEventId).toBeNull();

    // Every committed intent is satisfied and the run is recorded complete.
    expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
    const { rows: runs } = await db.query<{ run_kind: string; state: string; published: boolean; job_id: string }>(
      'SELECT run_kind, state, published, job_id FROM graph_runs WHERE id = $1',
      [result.graphRunId!],
    );
    expect(runs[0]).toMatchObject({
      run_kind: 'projection',
      state: 'complete',
      published: true,
      job_id: dispatched.accounts[0]!.jobId,
    });

    // Shadow: projection published no live recommendations or provider calls.
    const { rows: live } = await db.query<{ n: number }>(
      'SELECT count(*) AS n FROM recommendations WHERE owner_account_id = $1',
      [principal.accountId],
    );
    expect(Number(live[0]!.n)).toBe(0);
  });

  it('replay is idempotent: no duplicate support, no revision change', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const one = await insertItem({ accountId: principal.accountId });
    const two = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: one });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: two });
    await dispatch(principal.accountId);
    const first = await project(principal.accountId);
    expect(first.projected).toBe(true);
    const revision = await tasteRevision(principal.accountId);
    const before = await supportShapes(principal.accountId);

    const replay = await project(principal.accountId);
    expect(replay.projected).toBe(true);
    expect(replay.appliedTasteRevision).toBe(revision);
    expect(await supportShapes(principal.accountId)).toEqual(before);
    expect((await stateRow(principal.accountId))!.projection_revision).toBeGreaterThan(first.projectionRevision);
    // Redelivery of the same events cannot duplicate anything either.
    await db.query(
      `UPDATE graph_outbox SET dispatch_state = 'pending', dispatched_at = NULL, processed_at = NULL
        WHERE owner_account_id = $1`,
      [principal.accountId],
    );
    await dispatch(principal.accountId);
    await project(principal.accountId);
    expect(await supportShapes(principal.accountId)).toEqual(before);
    expect(await edgeCount(principal.accountId)).toBe(2);
  });

  it('out-of-order redelivery converges without regression or withdrawn-support resurrection', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    const saveEvent = (await outboxStates(principal.accountId))[0]!;
    await dispatch(principal.accountId);
    await project(principal.accountId);
    expect(await edgeCount(principal.accountId)).toBe(1);

    await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: item });
    await dispatch(principal.accountId);
    await project(principal.accountId);
    expect(await edgeCount(principal.accountId)).toBe(0);
    const revision = await tasteRevision(principal.accountId);

    // A stale 'save' intent arrives last (out of order): it must not resurrect
    // the withdrawn support nor regress the applied revision.
    await db.query(`UPDATE graph_outbox SET dispatch_state = 'pending', dispatched_at = NULL, processed_at = NULL WHERE id = $1`, [
      saveEvent.id,
    ]);
    const replay = await project(principal.accountId);
    expect(replay.appliedTasteRevision).toBe(revision);
    expect(await edgeCount(principal.accountId)).toBe(0);
    expect(await supportShapes(principal.accountId)).toEqual([]);
    expect((await stateRow(principal.accountId))!.applied_taste_revision).toBe(revision);
    expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
  });

  it('a dispatcher outage loses nothing: pending intents project after restart without a new mutation', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const items = [
      await insertItem({ accountId: principal.accountId }),
      await insertItem({ accountId: principal.accountId }),
      await insertItem({ accountId: principal.accountId }),
    ];
    for (const item of items) {
      await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    }
    // The dispatcher is down: intents accumulate, nothing is applied.
    expect((await stateRow(principal.accountId))?.applied_taste_revision ?? 0).toBe(0);
    expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'pending')).toBe(true);

    const first = await dispatch(principal.accountId);
    const second = await dispatch(principal.accountId);
    // One job per account: while that job covers the intents, a repeat
    // dispatch cannot double-enqueue (the active job owns the account).
    expect(second.accounts).toEqual([]);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM jobs WHERE type = 'project_interest_graph' AND payload->>'account_id' = $1`,
      [principal.accountId],
    );
    expect(Number(rows[0]!.n)).toBe(1);

    await project(principal.accountId, first.accounts[0]!.jobId);
    expect((await stateRow(principal.accountId))!.applied_taste_revision).toBe(await tasteRevision(principal.accountId));
    expect(await edgeCount(principal.accountId)).toBe(3);
    expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
  });

  it('re-arms an account whose queue job terminally failed', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    const first = await dispatch(principal.accountId);
    // The job exhausts its attempts (e.g. a crash loop).
    await db.query(`UPDATE jobs SET state = 'failed', lease_owner = NULL WHERE id = $1`, [first.accounts[0]!.jobId]);

    const rearm = await dispatch(principal.accountId);
    expect(rearm.accounts[0]!.jobId).not.toBe(first.accounts[0]!.jobId);
    expect(rearm.accounts[0]!.reused).toBe(false);
    await project(principal.accountId, rearm.accounts[0]!.jobId);
    expect(await edgeCount(principal.accountId)).toBe(1);
    expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
  });

  it('a mutation committed while the projector is fenced out is reconciled by the outbox tail', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const early = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: early });
    const late = await insertItem({ accountId: principal.accountId });
    await db.query(`INSERT INTO personal_graph_state (owner_account_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      principal.accountId,
    ]);

    // Hold the projector's account lock, as another projector mid-build would.
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT * FROM personal_graph_state WHERE owner_account_id = $1 FOR UPDATE', [
        principal.accountId,
      ]);

      // The projector takes its snapshot, then blocks on the lock.
      const projecting = project(principal.accountId);
      await new Promise((r) => setTimeout(r, 200));

      // A concurrent mutation commits while the projector cannot build.
      await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: late });
      await holder.query('ROLLBACK');

      const result = await projecting;
      expect(result.projected).toBe(true);
      expect(result.tailClean).toBe(true);
      // The first pass could not see the late save; a reconciliation pass
      // caught it through the committed outbox tail before readiness.
      expect(result.passes).toBe(2);
      expect(result.appliedTasteRevision).toBe(await tasteRevision(principal.accountId));
      expect(await edgeCount(principal.accountId)).toBe(2);
      expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
    } finally {
      holder.release();
    }
  });

  it('concurrent projectors serialize on the account lock and converge', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    await dispatch(principal.accountId);

    const [a, b] = await Promise.all([project(principal.accountId), project(principal.accountId)]);
    expect(a.projected).toBe(true);
    expect(b.projected).toBe(true);
    const state = (await stateRow(principal.accountId))!;
    expect(state.applied_taste_revision).toBe(await tasteRevision(principal.accountId));
    expect(state.projection_revision).toBeGreaterThanOrEqual(2);
    expect(await edgeCount(principal.accountId)).toBe(1);
    expect((await supportShapes(principal.accountId)).filter((s) => s.originKind === 'saved_item')).toHaveLength(1);
  });

  it('a kill switch halts projection and lifting it converges', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    await dispatch(principal.accountId);
    await setFeatureKill(db, {
      flag: 'interest_graph_projection_enabled',
      accountId: principal.accountId,
      reason: 'projector test kill',
      actor: 'test',
    });

    const halted = await project(principal.accountId);
    expect(halted).toMatchObject({ projected: false, reason: 'disabled' });
    expect(await edgeCount(principal.accountId)).toBe(0);
    expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'dispatched')).toBe(true);

    await liftFeatureKill(db, { flag: 'interest_graph_projection_enabled', accountId: principal.accountId });
    const resumed = await project(principal.accountId);
    expect(resumed.projected).toBe(true);
    expect(await edgeCount(principal.accountId)).toBe(1);
    expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
  });

  it('hidden canonical keys constrain the projection without deleting the save', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: item });
    await dispatch(principal.accountId);
    await project(principal.accountId);
    expect(await edgeCount(principal.accountId)).toBe(0);
    const { rows: saves } = await db.query<{ n: number }>('SELECT count(*) AS n FROM saved_items WHERE owner_account_id = $1', [
      principal.accountId,
    ]);
    expect(Number(saves[0]!.n)).toBe(1);

    await recordPreference(ctx, { action: 'unhide', target_type: 'discovery_item', target_id: item });
    await dispatch(principal.accountId);
    await project(principal.accountId);
    expect(await edgeCount(principal.accountId)).toBe(1);
  });

  it('explicit saves of ownerless shared rows become private account-owned support', async () => {
    const a = await accountCtx({ config: projectionOn });
    const b = await accountCtx({ config: projectionOn });
    const own = await insertItem({ accountId: a.principal.accountId }, { title: 'Owned film' });
    const shared = await insertItem(null, { title: 'Shared sample' });
    await recordPreference(a.ctx, { action: 'save', target_type: 'discovery_item', target_id: own });
    await recordPreference(a.ctx, { action: 'save', target_type: 'discovery_item', target_id: shared });
    await recordPreference(b.ctx, { action: 'save', target_type: 'discovery_item', target_id: shared });
    await dispatch(a.principal.accountId);
    await dispatch(b.principal.accountId);
    const { rows: nodesBefore } = await db.query<{ n: number }>('SELECT count(*) AS n FROM graph_nodes');
    const aSaveId = (
      await db.query<{ id: string }>('SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2', [
        a.principal.accountId,
        shared,
      ])
    ).rows[0]!.id;

    // Saves of shared catalog rows are real confirmed taste: they project as
    // private support targeting the account's OWN saved_items row, never a
    // forged item owner and never a silently omitted root.
    const result = await project(a.principal.accountId);
    expect(result.projected).toBe(true);
    expect(result.tailClean).toBe(true);
    expect(await edgeCount(a.principal.accountId)).toBe(2);
    const { rows: aEdges } = await db.query<{
      discovery_item_id: string | null;
      saved_item_id: string | null;
      node_id: string | null;
      origin: string;
      state: string;
    }>('SELECT discovery_item_id, saved_item_id, node_id, origin, state FROM personal_interest_edges WHERE owner_account_id = $1', [
      a.principal.accountId,
    ]);
    const aSharedEdge = aEdges.find((e) => e.saved_item_id === aSaveId)!;
    expect(aSharedEdge).toMatchObject({ discovery_item_id: null, node_id: null, origin: 'explicit', state: 'confirmed' });
    expect(aEdges.find((e) => e.discovery_item_id === own)).toMatchObject({ saved_item_id: null, origin: 'explicit', state: 'confirmed' });
    const support = await supportShapes(a.principal.accountId);
    expect(support).toHaveLength(2);
    expect(support.map((s) => s.edgeTarget).sort()).toEqual([own, aSaveId].sort());
    expect(support.every((s) => s.originKind === 'saved_item' && s.dependencyVersions.origin === 'mutation_intent')).toBe(true);

    // No owner is forged onto the shared row and no shared identity or sourced
    // cultural relationship is invented for it.
    const { rows: sharedRow } = await db.query<{ owner_account_id: string | null; is_sample: boolean }>(
      'SELECT owner_account_id, is_sample FROM discovery_items WHERE id = $1',
      [shared],
    );
    expect(sharedRow[0]).toMatchObject({ owner_account_id: null, is_sample: true });
    const { rows: nodesAfter } = await db.query<{ n: number }>('SELECT count(*) AS n FROM graph_nodes');
    expect(Number(nodesAfter[0]!.n)).toBe(Number(nodesBefore[0]!.n));

    // The fold keeps both saves and the projection now covers both.
    const fold = await loadFoldSaves(db, { kind: 'account', accountId: a.principal.accountId });
    expect(fold.map((s) => s.item_id).sort()).toEqual([own, shared].sort());

    // Isolation: the other account's identical shared-row save is an
    // independent private edge; it survives this account's edits untouched.
    const bSaveId = (
      await db.query<{ id: string }>('SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2', [
        b.principal.accountId,
        shared,
      ])
    ).rows[0]!.id;
    expect(bSaveId).not.toBe(aSaveId);
    await project(b.principal.accountId);
    expect(await edgeCount(b.principal.accountId)).toBe(1);
    const { rows: bEdges } = await db.query<{ saved_item_id: string | null }>(
      'SELECT saved_item_id FROM personal_interest_edges WHERE owner_account_id = $1',
      [b.principal.accountId],
    );
    expect(bEdges[0]!.saved_item_id).toBe(bSaveId);

    // Removal withdraws only this account's support; the returned Undo
    // restores it exactly once; the other account keeps hers.
    const remove = await recordPreference(a.ctx, { action: 'remove', target_type: 'discovery_item', target_id: shared });
    expect(remove.undo).toEqual({ action: 'save', target_type: 'discovery_item', target_id: shared });
    await dispatch(a.principal.accountId);
    await project(a.principal.accountId);
    expect(await edgeCount(a.principal.accountId)).toBe(1);
    expect(await edgeCount(b.principal.accountId)).toBe(1);

    await recordPreference(a.ctx, remove.undo!);
    await dispatch(a.principal.accountId);
    const restored = await project(a.principal.accountId);
    expect(restored.projected).toBe(true);
    expect(await edgeCount(a.principal.accountId)).toBe(2);
    expect((await supportShapes(a.principal.accountId)).filter((s) => s.originKind === 'saved_item')).toHaveLength(2);

    // Hiding the shared row stays scoped: it excludes only this account's
    // interest, never the other account's support.
    await recordPreference(a.ctx, { action: 'hide', target_type: 'discovery_item', target_id: shared });
    await dispatch(a.principal.accountId);
    await project(a.principal.accountId);
    expect(await edgeCount(a.principal.accountId)).toBe(1);
    expect(await edgeCount(b.principal.accountId)).toBe(1);
    const { rows: hiddenSave } = await db.query<{ n: number }>(
      'SELECT count(*) AS n FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
      [a.principal.accountId, shared],
    );
    expect(Number(hiddenSave[0]!.n)).toBe(1);

    // Replays keep the same roots: redelivered events rebuild identical
    // private support without inflation.
    await db.query(
      `UPDATE graph_outbox SET dispatch_state = 'pending', dispatched_at = NULL, processed_at = NULL
        WHERE owner_account_id = $1`,
      [a.principal.accountId],
    );
    await dispatch(a.principal.accountId);
    const replay = await project(a.principal.accountId);
    expect(replay.projected).toBe(true);
    expect(replay.tailClean).toBe(true);
    expect(await edgeCount(a.principal.accountId)).toBe(1);
  });

  it('a pending-save pick on a shared row attaches its group support to the private edge', async () => {
    const { principal: anon } = await anonCtx();
    const sample = await insertItem(null, { title: 'Claimed sample' });
    const res = await createAccount(ctxFor(anon, { config: projectionOn }), {
      claim_session: true,
      pending_save: { target_type: 'discovery_item', target_id: sample },
    });
    await dispatch(res.account_id);
    const result = await project(res.account_id);
    expect(result.projected).toBe(true);
    // The shared-row save is a private saved-item root AND carries the
    // pending-save pick group's support on that same private edge.
    expect(await edgeCount(res.account_id)).toBe(1);
    const saveId = (
      await db.query<{ id: string }>('SELECT id FROM saved_items WHERE owner_account_id = $1', [res.account_id])
    ).rows[0]!.id;
    const { rows: edges } = await db.query<{ saved_item_id: string | null; support_summary: { saved_items?: number } }>(
      'SELECT saved_item_id, support_summary FROM personal_interest_edges WHERE owner_account_id = $1',
      [res.account_id],
    );
    expect(edges[0]!.saved_item_id).toBe(saveId);
    expect(edges[0]!.support_summary).toMatchObject({ saved_items: 1 });
    const support = await supportShapes(res.account_id);
    expect(support).toHaveLength(2);
    expect(support.filter((s) => s.originKind === 'saved_item').map((s) => s.edgeTarget)).toEqual([saveId]);
    expect(support.filter((s) => s.originKind === 'pick_group').map((s) => s.edgeTarget)).toEqual([saveId]);
  });

  it('projection failure records an honest error state without touching support', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    await dispatch(principal.accountId);
    // Force an honest failure: break the read the projector depends on.
    await db.query('ALTER TABLE taste_profiles RENAME TO taste_profiles_hidden');
    try {
      await expect(project(principal.accountId)).rejects.toBeTruthy();
      const state = (await stateRow(principal.accountId))!;
      expect(state.state).toBe('failed');
      expect(state.last_error_code).toBeTruthy();
      expect(state.applied_taste_revision).toBe(0);
      expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'dispatched')).toBe(true);
    } finally {
      await db.query('ALTER TABLE taste_profiles_hidden RENAME TO taste_profiles');
    }
    // Recovery: the same events project once the fault clears.
    const recovered = await project(principal.accountId);
    expect(recovered.projected).toBe(true);
    expect(recovered.appliedTasteRevision).toBe(await tasteRevision(principal.accountId));
  });
});

describe('foreign-key failures are classified honestly (VAL-PROJ-008)', () => {
  it('an unrelated FK violation fails projection without pretending the account is deleted', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    await dispatch(principal.accountId);

    // Simulate an FK 23503 whose violated constraint references something
    // OTHER than accounts (here: a support row's composite saved-item FK).
    await db.query(
      `CREATE FUNCTION graph_test_unrelated_fk() RETURNS trigger AS $fn$
         BEGIN
           RAISE EXCEPTION 'simulated non-account foreign key violation'
             USING ERRCODE = '23503',
                   CONSTRAINT = 'personal_interest_support_saved_item_id_owner_account_id_fkey',
                   TABLE = 'personal_interest_support',
                   SCHEMA = current_schema();
           RETURN NEW;
         END $fn$ LANGUAGE plpgsql`,
    );
    await db.query(
      'CREATE TRIGGER graph_test_unrelated_fk BEFORE INSERT ON personal_interest_support FOR EACH ROW EXECUTE FUNCTION graph_test_unrelated_fk()',
    );
    try {
      await expect(project(principal.accountId)).rejects.toThrow(/simulated non-account/);
      const state = (await stateRow(principal.accountId))!;
      expect(state.state).toBe('failed');
      expect(state.last_error_code).toBe('pg_23503');
      expect(state.applied_taste_revision).toBe(0);
      // The intent is retained for an honest retry, not swallowed as deletion.
      expect((await outboxStates(principal.accountId)).every((e) => e.dispatch_state === 'dispatched')).toBe(true);
      expect(await edgeCount(principal.accountId)).toBe(0);
    } finally {
      await db.query('DROP TRIGGER graph_test_unrelated_fk ON personal_interest_support');
      await db.query('DROP FUNCTION graph_test_unrelated_fk');
    }
    // Recovery: the retained events project once the fault clears.
    const recovered = await project(principal.accountId);
    expect(recovered.projected).toBe(true);
    expect(await edgeCount(principal.accountId)).toBe(1);
  });

  it('a genuinely deleted account is the only FK failure classified as account_missing', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    await dispatch(principal.accountId);
    expect((await stateRow(principal.accountId))!.state).toBe('queued');

    // Genuine deletion: the account (and its cascaded graph state) vanish.
    await db.query('DELETE FROM accounts WHERE id = $1', [principal.accountId]);
    const result = await project(principal.accountId);
    expect(result).toMatchObject({ projected: false, reason: 'account_missing' });
    expect(await stateRow(principal.accountId)).toBeNull();
  });
});

describe('dispatch scoping (VAL-PROJ-007)', () => {
  it('never dispatches for accounts the flag is off for', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    const off = testConfig();
    const result = await dispatchGraphOutbox(db, { config: off, ownerAccountId: principal.accountId });
    expect(result.accounts.map((a) => a.accountId)).not.toContain(principal.accountId);
    // With the flag globally on but the account killed, dispatch still skips it.
    await setFeatureKill(db, {
      flag: 'interest_graph_projection_enabled',
      accountId: principal.accountId,
      reason: 'dispatch scope test',
      actor: 'test',
    });
    try {
      const killed = await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
      expect(killed.accounts.map((a) => a.accountId)).not.toContain(principal.accountId);
    } finally {
      await liftFeatureKill(db, { flag: 'interest_graph_projection_enabled', accountId: principal.accountId });
    }
  });

  it('leaves other accounts untouched', async () => {
    const a = await accountCtx({ config: projectionOn });
    const b = await accountCtx({ config: projectionOn });
    const itemA = await insertItem({ accountId: a.principal.accountId });
    await recordPreference(a.ctx, { action: 'save', target_type: 'discovery_item', target_id: itemA });
    const result = await dispatch(a.principal.accountId);
    expect(result.accounts.map((x) => x.accountId)).toEqual([a.principal.accountId]);
    expect((await outboxStates(b.principal.accountId)).length).toBe(0);
    expect(await stateRow(b.principal.accountId)).toBeNull();
  });
});
