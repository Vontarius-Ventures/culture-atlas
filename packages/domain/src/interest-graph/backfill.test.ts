import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { submitCorrection } from '../services/analyses';
import { fillInterestsBoard } from '../services/collections';
import { createPick, deletePick } from '../services/onboarding';
import { recordPreference } from '../services/preferences';
import { loadFoldSaves } from '../services/taste';
import { accountCtx, ctxFor, insertCaptureWithAnalysis, insertItem, insertReference } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { runInterestGraphBackfill } from './backfill';
import { loadExplicitSupport } from './explicit-support';

/**
 * VAL-PROJ-009: checkpointed current-state backfill. Accounts that gathered
 * explicit state while the projection flag was off are rebuilt from CURRENT
 * authority (active saves, grouped picks, exclusions, current corrected
 * capture anchors), never from invented event provenance, and labeled
 * backfill_current_state. Resume/replay adds no support, mutations during
 * backfill force reconciliation before readiness, and projection-only shadow
 * never changes live recommendations.
 */

const db = getTestDb();
afterAll(closeTestDb);

const flagOff = testConfig();
const flagOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

async function tasteRevision(accountId: string): Promise<number> {
  const { rows } = await db.query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [
    accountId,
  ]);
  return rows[0]?.revision ?? 0;
}

async function stateRow(accountId: string): Promise<{ state: string; applied: number } | null> {
  const { rows } = await db.query<{ state: string; applied: number }>(
    `SELECT state, applied_taste_revision AS applied FROM personal_graph_state WHERE owner_account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

async function edgeTargets(
  accountId: string,
): Promise<{ item: string | null; node: string | null; save: string | null; origin: string; state: string }[]> {
  const { rows } = await db.query<{ item: string | null; node: string | null; save: string | null; origin: string; state: string }>(
    `SELECT discovery_item_id AS item, node_id AS node, saved_item_id AS save, origin, state
       FROM personal_interest_edges WHERE owner_account_id = $1
      ORDER BY discovery_item_id NULLS LAST, saved_item_id NULLS LAST`,
    [accountId],
  );
  return rows;
}

interface SupportRow {
  edge_item: string;
  origin_kind: string;
  pick_id: string | null;
  origin: string;
  originating_event_id: string | null;
  capture_reference_id: string | null;
  analysis_version: string | null;
}

async function supportContent(accountId: string): Promise<SupportRow[]> {
  const { rows } = await db.query<SupportRow>(
    `SELECT e.discovery_item_id AS edge_item, s.origin_kind, s.pick_id,
            s.dependency_versions->>'origin' AS origin, s.originating_event_id,
            s.capture_reference_id, s.dependency_versions->>'analysis_version' AS analysis_version
       FROM personal_interest_support s JOIN personal_interest_edges e ON e.id = s.edge_id
      WHERE s.owner_account_id = $1
      ORDER BY e.discovery_item_id, e.node_id, s.origin_kind, s.saved_item_id, s.pick_id, s.capture_reference_id`,
    [accountId],
  );
  return rows;
}

async function unsatisfiedEvents(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM graph_outbox WHERE owner_account_id = $1 AND dispatch_state IN ('pending','dispatched')`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function captureReference(analysisId: string, referenceId: string, resolution = 'resolved'): Promise<void> {
  await db.query(
    `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor)
     VALUES ($1, $2, 'resembles', 0.8, $3, false)`,
    [analysisId, referenceId, resolution],
  );
}

async function backfillState(): Promise<{
  state: string;
  checkpoint: string | null;
  accounts_projected: number;
  finished: string | null;
}> {
  const { rows } = await db.query<{ state: string; checkpoint: string | null; accounts_projected: number; finished: string | null }>(
    `SELECT state, last_owner_account_id AS checkpoint, accounts_projected, finished_at::text AS finished
       FROM graph_backfill_state WHERE id = 1`,
  );
  return rows[0] ?? { state: 'absent', checkpoint: null, accounts_projected: 0, finished: null };
}

/** One account whose history predates the projection flag entirely. */
async function legacyAccount() {
  const { principal, ctx } = await accountCtx({ config: flagOff });
  const keep = await insertItem({ accountId: principal.accountId }, { title: 'Keeper' });
  await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: keep });
  const removed = await insertItem({ accountId: principal.accountId }, { title: 'Gone' });
  await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: removed });
  await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: removed });
  const exposure = await insertItem({ accountId: principal.accountId }, { kind: 'film' });
  await fillInterestsBoard(db, principal.accountId, [exposure]);
  await createPick(ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
  // Pick member saves are keyed by their discovery items; the projection and
  // preferences never use saved_items row ids.
  const members = (await loadExplicitSupport(db, principal.accountId)).pickGroups[0]!.members;
  const hiddenId = members[0]!.itemId;
  const visibleId = members[1]!.itemId;
  await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: hiddenId });
  const keptRef = await insertReference({ name: 'Kept lamp' });
  const droppedRef = await insertReference({ name: 'Dropped guess' });
  const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
  await captureReference(cap.analysisId, keptRef);
  await captureReference(cap.analysisId, droppedRef);
  await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
  await submitCorrection(ctx, {
    id: cap.captureId,
    body: { expected_analysis_version: 1, reject_reference_ids: [droppedRef] },
  });
  // No intent rows exist: the flag was off for the whole history.
  const { rows: events } = await db.query<{ n: number }>('SELECT count(*) AS n FROM graph_outbox WHERE owner_account_id = $1', [
    principal.accountId,
  ]);
  expect(Number(events[0]!.n)).toBe(0);
  return {
    principal,
    ctx,
    keep,
    hiddenId,
    visibleId,
    keptRef,
    cap,
  };
}

describe('checkpointed current-state backfill (VAL-PROJ-009)', () => {
  it('rebuilds current authority with backfill lineage, not invented event provenance', async () => {
    const legacy = await legacyAccount();

    const result = await runInterestGraphBackfill(db, { config: flagOn, accountIds: [legacy.principal.accountId] });
    expect(result.state).toBe('complete');
    expect(result.accountsProjected).toBe(1);
    expect(await backfillState()).toMatchObject({ state: 'complete' });
    expect((await backfillState()).finished).toBeTruthy();

    const revision = await tasteRevision(legacy.principal.accountId);
    const state = (await stateRow(legacy.principal.accountId))!;
    expect(state).toMatchObject({ state: 'ready', applied: revision });
    expect(await unsatisfiedEvents(legacy.principal.accountId)).toBe(0);

    // Roots: the independent save, the visible pick member and the capture
    // item. The hidden member, the removed save and the exposure-only row
    // never became roots.
    const edges = await edgeTargets(legacy.principal.accountId);
    const rootItems = edges.filter((e) => e.item !== null).map((e) => e.item);
    expect(rootItems.sort()).toEqual([legacy.keep, legacy.visibleId, legacy.cap.itemId].sort());
    for (const e of edges) {
      expect(e).toMatchObject({ origin: 'explicit', state: 'confirmed' });
    }

    // The pick group contributes its own support to the visible member only.
    const content = await supportContent(legacy.principal.accountId);
    const pickSupport = content.filter((s) => s.origin_kind === 'pick_group');
    expect(pickSupport).toHaveLength(1);
    expect(pickSupport[0]!.edge_item).toBe(legacy.visibleId);

    // Backfill lineage is labeled current-state; the real save event is kept
    // where provenance survives, never invented where it does not.
    expect(content.every((s) => s.origin === 'backfill_current_state')).toBe(true);
    const keepSupport = content.find((s) => s.edge_item === legacy.keep && s.origin_kind === 'saved_item')!;
    const { rows: saveEvents } = await db.query<{ id: string }>(
      `SELECT id FROM preference_events WHERE owner_account_id = $1 AND action = 'save' AND target_id = $2`,
      [legacy.principal.accountId, legacy.keep],
    );
    expect(saveEvents.length).toBeGreaterThan(0);
    expect(keepSupport.originating_event_id).toBe(saveEvents[0]!.id);
    const refSupport = content.find((s) => s.origin_kind === 'capture_reference')!;
    expect(refSupport.capture_reference_id).toBeTruthy();
    expect(refSupport.analysis_version).toBe('1');
    expect(refSupport.originating_event_id).toBeNull();

    // The run records the backfill source and current input revisions.
    const { rows: runs } = await db.query<{ run_kind: string; state: string; published: boolean; budget: { source?: string }; input: number }>(
      `SELECT run_kind, state, published, budget, input_taste_revision AS input
         FROM graph_runs WHERE owner_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [legacy.principal.accountId],
    );
    expect(runs[0]).toMatchObject({ run_kind: 'projection', state: 'complete', published: true });
    expect(runs[0]!.budget).toMatchObject({ source: 'backfill_current_state' });
    expect(runs[0]!.input).toBe(revision);

    // Shadow: live recommendations, provider queries and feed snapshots are untouched.
    for (const table of ['recommendations', 'provider_queries', 'feed_snapshots']) {
      const { rows } = await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE owner_account_id = $1`, [
        legacy.principal.accountId,
      ]);
      expect(Number(rows[0]!.n)).toBe(0);
    }
  });

  it('resumes from its checkpoint and replay adds no support', async () => {
    const accounts: Array<{ accountId: string; item: string }> = [];
    for (let i = 0; i < 3; i++) {
      const { principal, ctx } = await accountCtx({ config: flagOff });
      const item = await insertItem({ accountId: principal.accountId }, { title: `Legacy ${randomUUID()}` });
      await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
      accounts.push({ accountId: principal.accountId, item });
    }
    const scope = accounts.map((a) => a.accountId);

    const interrupted = await runInterestGraphBackfill(db, { config: flagOn, accountIds: scope, maxAccounts: 2 });
    expect(interrupted).toMatchObject({ state: 'incomplete', accountsProjected: 2 });
    const partial = await backfillState();
    expect(partial.state).toBe('running');
    expect(partial.accounts_projected).toBeGreaterThanOrEqual(2);
    const readySoFar = (await Promise.all(accounts.map((a) => stateRow(a.accountId)))).filter((s) => s?.state === 'ready');
    expect(readySoFar).toHaveLength(2);
    // The durable checkpoint names the last account the interrupted run projected.
    expect(accounts.map((a) => a.accountId)).toContain(partial.checkpoint);

    const resumed = await runInterestGraphBackfill(db, { config: flagOn, accountIds: scope });
    expect(resumed.state).toBe('complete');
    expect(resumed.accountsProjected).toBeGreaterThanOrEqual(1);
    for (const a of accounts) {
      expect((await stateRow(a.accountId))?.state).toBe('ready');
    }

    // Replay of a complete backfill re-projects nothing and adds no support.
    const before = await Promise.all(accounts.map((a) => supportContent(a.accountId)));
    const replay = await runInterestGraphBackfill(db, { config: flagOn, accountIds: scope });
    expect(replay.state).toBe('complete');
    expect(replay.accountsProjected).toBe(0);
    const after = await Promise.all(accounts.map((a) => supportContent(a.accountId)));
    expect(after).toEqual(before);
  });

  it('mutations during backfill force reconciliation before readiness', async () => {
    const legacy = await legacyAccount();
    await runInterestGraphBackfill(db, { config: flagOn, accountIds: [legacy.principal.accountId] });
    expect((await stateRow(legacy.principal.accountId))!.state).toBe('ready');

    // A new explicit mutation lands after the account was backfilled. Its
    // committed intent makes the projection lag current authority: the
    // account is honestly due until a run reconciles it.
    const late = await insertItem({ accountId: legacy.principal.accountId }, { title: 'Late save' });
    await recordPreference(ctxFor(legacy.principal, { config: flagOn }), {
      action: 'save',
      target_type: 'discovery_item',
      target_id: late,
    });
    const lagging = (await stateRow(legacy.principal.accountId))!;
    expect(lagging.applied).toBeLessThan(await tasteRevision(legacy.principal.accountId));
    expect(await unsatisfiedEvents(legacy.principal.accountId)).toBe(1);

    const pass = await runInterestGraphBackfill(db, { config: flagOn, accountIds: [legacy.principal.accountId] });
    expect(pass.accountsProjected).toBe(1);
    expect((await stateRow(legacy.principal.accountId))!.state).toBe('ready');
    expect((await stateRow(legacy.principal.accountId))!.applied).toBe(await tasteRevision(legacy.principal.accountId));
    expect(await unsatisfiedEvents(legacy.principal.accountId)).toBe(0);
    const rootItems = (await edgeTargets(legacy.principal.accountId)).map((e) => e.item);
    expect(rootItems).toContain(late);
  });

  it('skips accounts the flag is off for and leaves them due', async () => {
    const { principal, ctx } = await accountCtx({ config: flagOff });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });

    const result = await runInterestGraphBackfill(db, { config: flagOff, accountIds: [principal.accountId] });
    expect(result.state).toBe('complete');
    expect(result.accountsProjected).toBe(0);
    expect(await stateRow(principal.accountId)).toBeNull();

    // Once the operator opts in, the same account backfills from current state.
    const enabled = await runInterestGraphBackfill(db, { config: flagOn, accountIds: [principal.accountId] });
    expect(enabled.accountsProjected).toBe(1);
    expect((await stateRow(principal.accountId))?.state).toBe('ready');
    expect((await edgeTargets(principal.accountId)).map((e) => e.item)).toEqual([item]);
  });

  it('a removed pick keeps only its surviving member support across backfill', async () => {
    const { principal, ctx } = await accountCtx({ config: flagOff });
    const pick = await createPick(ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    await deletePick(ctx, pick.pick.id);
    await runInterestGraphBackfill(db, { config: flagOn, accountIds: [principal.accountId] });
    // The deleted pick withdrew both member saves; the empty group is gone.
    expect((await edgeTargets(principal.accountId)).map((e) => e.item)).toEqual([]);
    expect((await supportContent(principal.accountId)).filter((s) => s.origin_kind === 'pick_group')).toHaveLength(0);
  });

  it('backfill includes explicit saves of ownerless shared rows as private support', async () => {
    // History that predates the projection flag: an explicit save of an
    // ownerless shared sample row must backfill as private account-owned
    // support, never be dropped for lack of an item owner.
    const { principal, ctx } = await accountCtx({ config: flagOff });
    const shared = await insertItem(null, { title: 'Shared sample' });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: shared });
    const saveId = (
      await db.query<{ id: string }>('SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2', [
        principal.accountId,
        shared,
      ])
    ).rows[0]!.id;
    expect(await unsatisfiedEvents(principal.accountId)).toBe(0);

    const result = await runInterestGraphBackfill(db, { config: flagOn, accountIds: [principal.accountId] });
    expect(result).toMatchObject({ state: 'complete', accountsProjected: 1 });
    const edges = await edgeTargets(principal.accountId);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ item: null, node: null, save: saveId, origin: 'explicit', state: 'confirmed' });
    const content = await supportContent(principal.accountId);
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ origin_kind: 'saved_item', origin: 'backfill_current_state' });

    // Replay adds no support; removal withdraws it; a returned Undo restores
    // exactly once. Fresh-fold parity holds at every step.
    const replay = await runInterestGraphBackfill(db, { config: flagOn, accountIds: [principal.accountId] });
    expect(replay).toMatchObject({ state: 'complete', accountsProjected: 0 });
    expect(await supportContent(principal.accountId)).toEqual(content);

    const remove = await recordPreference(ctxFor(principal, { config: flagOn }), {
      action: 'remove',
      target_type: 'discovery_item',
      target_id: shared,
    });
    expect(remove.undo).toEqual({ action: 'save', target_type: 'discovery_item', target_id: shared });
    await runInterestGraphBackfill(db, { config: flagOn, accountIds: [principal.accountId] });
    expect(await edgeTargets(principal.accountId)).toEqual([]);

    await recordPreference(ctxFor(principal, { config: flagOn }), remove.undo!);
    await runInterestGraphBackfill(db, { config: flagOn, accountIds: [principal.accountId] });
    const restored = await edgeTargets(principal.accountId);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ item: null, node: null, origin: 'explicit', state: 'confirmed' });
    const fold = await loadFoldSaves(db, { kind: 'account', accountId: principal.accountId });
    expect(fold.map((s) => s.item_id)).toEqual([shared]);
  });

  it('global mode scans the whole due population from its checkpoint', async () => {
    // The production shape (scripts/graph-backfill.ts): no accountIds. Seed a
    // few due accounts first; the shared test database also holds bare
    // accounts, so the assertions stay bounded to what one capped call does.
    const due: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { principal, ctx } = await accountCtx({ config: flagOff });
      const item = await insertItem({ accountId: principal.accountId }, { title: `Global ${randomUUID()}` });
      await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
      due.push(principal.accountId);
    }
    const bounded = await runInterestGraphBackfill(db, { config: flagOn, maxAccounts: 1, batchSize: 25 });
    expect(bounded.state).toBe('incomplete');
    expect(bounded.accountsProjected).toBe(1);
    const state = await backfillState();
    expect(state.state).toBe('running');
    expect(state.checkpoint).toBeTruthy();
    expect(state.accounts_projected).toBeGreaterThanOrEqual(1);
    // The checkpoint names a real account: resume continues from it.
    const { rows: checkpointAccount } = await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM accounts WHERE id = $1`,
      [state.checkpoint],
    );
    expect(Number(checkpointAccount[0]!.n)).toBe(1);
  });
});
