import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liftFeatureKill, setFeatureKill } from '../flags/feature-flags';
import type { JobContext } from '../jobs/handler';
import { claimJobs, completeJob } from '../jobs/queue';
import { JobPayloads, type JobRecord } from '../jobs/types';
import { projectInterestGraph } from '../pipeline/project-interest-graph';
import { recordPreference } from '../services/preferences';
import { getTasteRevision, loadFoldSaves } from '../services/taste';
import { insertItem } from '../test-support/library';
import {
  createIsolatedDatabase,
  insertAccount,
  testConfig,
  testContext,
  testProviders,
  type IsolatedDatabase,
} from '../testing';
import { runInterestGraphBackfill } from './backfill';
import { dispatchGraphOutbox } from './dispatch';
import { projectAccountInterestGraph } from './projector';
import { readReconciledInterestGraph } from './read';
import { PROJECTION_SUPPORT_VERSION } from './schema';

/**
 * VAL-PROJ-009 (upgrade reprojection): ready projections built before
 * migration 270 silently omit explicit saves of ownerless shared rows while
 * their applied taste revision matches current authority and every earlier
 * outbox event is done — so no mutation intent ever re-arms them. The upgrade
 * must durably mark such accounts due (bounded versioned completeness, never
 * fabricated event provenance or a blanket reset), and targeted backfill,
 * global backfill and the normal worker dispatch must repair them without a
 * new user mutation, converging idempotently. Already-complete accounts stay
 * stable; disabled accounts stay honestly due.
 *
 * The whole file runs on one private isolated database: global backfill and
 * dispatch sweeps would otherwise see every account the run's shared database
 * accumulated, and the exact due/projected counts these cases assert are only
 * deterministic in a population this file owns.
 */

const flagOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

let iso: IsolatedDatabase;

beforeAll(async () => {
  iso = await createIsolatedDatabase('upgr');
});
afterAll(async () => {
  await iso.drop();
});

// --- Fixtures and helpers -----------------------------------------------------------

async function tasteRevision(accountId: string): Promise<number> {
  return getTasteRevision(iso.db, { kind: 'account', accountId });
}

async function stateRow(accountId: string): Promise<{ state: string; applied: number } | null> {
  const { rows } = await iso.db.query<{ state: string; applied: number }>(
    `SELECT state, applied_taste_revision AS applied FROM personal_graph_state WHERE owner_account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

/** The applied projection's versioned completeness marker (migration 290). */
async function supportVersion(accountId: string): Promise<number | null> {
  const { rows } = await iso.db.query<{ support_version: number }>(
    'SELECT support_version FROM personal_graph_state WHERE owner_account_id = $1',
    [accountId],
  );
  return rows[0]?.support_version ?? null;
}

interface SupportRow {
  edge_item: string | null;
  edge_save: string | null;
  origin_kind: string;
  saved_item_id: string | null;
  originating_event_id: string | null;
  origin: string;
}

async function supportRows(accountId: string): Promise<SupportRow[]> {
  const { rows } = await iso.db.query<SupportRow>(
    `SELECT e.discovery_item_id AS edge_item, e.saved_item_id AS edge_save, s.origin_kind,
            s.saved_item_id, s.originating_event_id, s.dependency_versions->>'origin' AS origin
       FROM personal_interest_support s JOIN personal_interest_edges e ON e.id = s.edge_id
      WHERE s.owner_account_id = $1
      ORDER BY e.discovery_item_id NULLS LAST, e.saved_item_id NULLS LAST, s.origin_kind, s.saved_item_id`,
    [accountId],
  );
  return rows;
}

async function outboxRows(accountId: string): Promise<{ dispatch_state: string; attempts: number }[]> {
  const { rows } = await iso.db.query<{ dispatch_state: string; attempts: number }>(
    'SELECT dispatch_state, attempts FROM graph_outbox WHERE owner_account_id = $1 ORDER BY target_taste_revision',
    [accountId],
  );
  return rows;
}

async function projectionJobs(accountId: string): Promise<{ id: string; state: string; payload: { catch_up?: string } }[]> {
  const { rows } = await iso.db.query<{ id: string; state: string; payload: { catch_up?: string } }>(
    `SELECT id, state, payload FROM jobs WHERE owner_account_id = $1 AND type = 'project_interest_graph' ORDER BY created_at`,
    [accountId],
  );
  return rows;
}

async function runCount(accountId: string): Promise<number> {
  const { rows } = await iso.db.query<{ n: number }>(
    'SELECT count(*) AS n FROM graph_runs WHERE owner_account_id = $1',
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function latestRunSource(accountId: string): Promise<string | null> {
  const { rows } = await iso.db.query<{ source: string | null }>(
    `SELECT budget->>'source' AS source FROM graph_runs WHERE owner_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [accountId],
  );
  return rows[0]?.source ?? null;
}

async function killProjection(accountId: string): Promise<void> {
  await setFeatureKill(iso.db, {
    flag: 'interest_graph_projection_enabled',
    accountId,
    reason: 'upgrade reprojection regression',
    actor: 'test',
  });
}

/**
 * Runs the real `project_interest_graph` handler the way the worker does: a
 * real lease, the real handler code, a real completion. Only heartbeat and
 * deadline plumbing (which the Worker owns) are stubbed; the real Worker loop
 * is exercised in apps/worker graph-projection tests.
 */
async function runProjectionJob(jobId: string): Promise<{ state: string; resultType?: string }> {
  const workerId = `upgrade-test-${randomUUID().slice(0, 8)}`;
  const claimed = await claimJobs(iso.db, {
    workerId,
    limit: 1,
    leaseMs: 60_000,
    ids: [jobId],
    types: ['project_interest_graph'],
  });
  const job = claimed[0];
  if (!job) throw new Error('projection job is not claimable');
  const ctx: JobContext<'project_interest_graph'> = {
    job: job as JobRecord<'project_interest_graph'>,
    payload: JobPayloads.project_interest_graph.parse(job.payload),
    attempt: job.attempt,
    workerId,
    db: iso.db,
    providers: testProviders(),
    config: flagOn,
    signal: new AbortController().signal,
    budget: { qlooRequests: 0, researchRefs: 0, providerRetries: 0, deadlineMs: 60_000 },
    setStage: async () => undefined,
    runStage: (_stage, fn) => fn(),
    ensureActive: async () => undefined,
    trace: async () => undefined,
    log: () => undefined,
  };
  const outcome = await projectInterestGraph(ctx);
  if (outcome.state === 'complete' || outcome.state === 'partial') {
    await completeJob(iso.db, job.id, workerId, job.attempt, outcome);
  }
  return outcome;
}

interface LegacyAccount {
  accountId: string;
  ctx: ReturnType<typeof testContext>;
  owned: string;
  shared: string;
  sharedSaveId: string;
  revision: number;
}

/**
 * The pre-migration-270 upgrade shape, exactly as scrutiny found it: an
 * account whose projection is 'ready' at the CURRENT taste revision with
 * every earlier outbox event done, whose stored support was built by the OLD
 * projector semantics — owned roots project, the explicit save of an ownerless
 * shared row is silently omitted — so no mutation intent will ever re-arm it.
 *
 * The legacy state row is re-created the way the upgrade finds real legacy
 * rows: inserted without naming the completeness marker, so it carries whatever
 * the column default assigns to rows that predate the marker (version 1 after
 * migration 290). Nothing fabricates event history or resets user data.
 */
async function legacyReadyProjection(): Promise<LegacyAccount> {
  const principal = await insertAccount(iso.db);
  const ctx = testContext(principal, { db: iso.db, config: flagOn });
  const accountId = principal.accountId;
  const owned = await insertItem({ accountId }, { title: `Owned ${randomUUID()}` }, iso.db);
  await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: owned });
  const shared = await insertItem(null, { title: `Shared ${randomUUID()}` }, iso.db);
  await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: shared });
  const { rows: saveRows } = await iso.db.query<{ id: string }>(
    'SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
    [accountId, shared],
  );
  const sharedSaveId = saveRows[0]!.id;

  // A projection by CURRENT semantics first: complete support, every intent
  // done, ready state at the current revision.
  await projectAccountInterestGraph(iso.db, { accountId, config: flagOn, source: 'mutation_intent' });

  // Degrade to what pre-270 code actually stored: the shared-row save's
  // private edge and support are absent, everything else stays.
  await iso.db.query('DELETE FROM personal_interest_edges WHERE owner_account_id = $1 AND saved_item_id = $2', [
    accountId,
    sharedSaveId,
  ]);
  await iso.db.query('DELETE FROM personal_graph_state WHERE owner_account_id = $1', [accountId]);
  const revision = await tasteRevision(accountId);
  await iso.db.query(
    `INSERT INTO personal_graph_state
       (owner_account_id, state, applied_taste_revision, target_taste_revision, projection_revision, last_projected_at)
     VALUES ($1, 'ready', $2, $2, 1, now())`,
    [accountId, revision],
  );

  // The defect shape, asserted before any repair: ready, equal revisions,
  // done outbox, shared root omitted.
  const events = await outboxRows(accountId);
  expect(events).toHaveLength(2);
  expect(events.every((e) => e.dispatch_state === 'done' && e.attempts === 0)).toBe(true);
  const state = (await stateRow(accountId))!;
  expect(state).toMatchObject({ state: 'ready', applied: revision });
  expect(await tasteRevision(accountId)).toBe(revision);
  const supports = await supportRows(accountId);
  expect(supports).toHaveLength(1);
  expect(supports[0]).toMatchObject({ edge_item: owned, origin_kind: 'saved_item' });

  return { accountId, ctx, owned, shared, sharedSaveId, revision };
}

// --- Cases --------------------------------------------------------------------------

describe('upgrade reprojection of legacy ready projections (VAL-PROJ-009)', () => {
  it('targeted backfill converges a legacy ready equal-revision projection without a new mutation', async () => {
    const legacy = await legacyReadyProjection();

    const repaired = await runInterestGraphBackfill(iso.db, { config: flagOn, accountIds: [legacy.accountId] });
    expect(repaired).toMatchObject({ state: 'complete', accountsProjected: 1, dueRemaining: 0 });

    // Converged to complete current support: the owned root AND the omitted
    // shared root, the latter as private account-owned support of the
    // account's own save row.
    const supports = await supportRows(legacy.accountId);
    expect(supports).toHaveLength(2);
    const sharedSupport = supports.find((s) => s.edge_save !== null)!;
    expect(sharedSupport).toMatchObject({
      edge_item: null,
      edge_save: legacy.sharedSaveId,
      origin_kind: 'saved_item',
      saved_item_id: legacy.sharedSaveId,
    });
    // Real event provenance survives the repair; nothing was invented.
    const { rows: saveEvents } = await iso.db.query<{ id: string }>(
      `SELECT id FROM preference_events WHERE owner_account_id = $1 AND action = 'save' AND target_id = $2`,
      [legacy.accountId, legacy.shared],
    );
    expect(saveEvents.length).toBeGreaterThan(0);
    expect(sharedSupport.originating_event_id).toBe(saveEvents[0]!.id);
    expect(sharedSupport.origin).toBe('backfill_current_state');

    const state = (await stateRow(legacy.accountId))!;
    expect(state).toMatchObject({ state: 'ready', applied: legacy.revision });
    expect(await tasteRevision(legacy.accountId)).toBe(legacy.revision);
    // The marker is stamped by the repairing pass only.
    expect(await supportVersion(legacy.accountId)).toBe(PROJECTION_SUPPORT_VERSION);
    // The outbox is untouched: repair is current-state, not invented intent.
    expect(await outboxRows(legacy.accountId)).toEqual([
      { dispatch_state: 'done', attempts: 0 },
      { dispatch_state: 'done', attempts: 0 },
    ]);
    // Fresh-fold parity.
    const fold = await loadFoldSaves(iso.db, { kind: 'account', accountId: legacy.accountId });
    expect([...fold].map((s) => s.item_id).sort()).toEqual([legacy.owned, legacy.shared].sort());

    // Replay adds nothing.
    const replay = await runInterestGraphBackfill(iso.db, { config: flagOn, accountIds: [legacy.accountId] });
    expect(replay).toMatchObject({ state: 'complete', accountsProjected: 0, dueRemaining: 0 });
    expect(await supportRows(legacy.accountId)).toEqual(supports);
  });

  it('global backfill repairs the legacy projection and repeated runs converge idempotently', async () => {
    const legacy = await legacyReadyProjection();

    const repaired = await runInterestGraphBackfill(iso.db, { config: flagOn });
    // This file's isolated database holds only this file's accounts, and the
    // earlier cases converged theirs: the legacy account is the only due one.
    expect(repaired).toMatchObject({ state: 'complete', accountsProjected: 1, dueRemaining: 0 });
    expect((await stateRow(legacy.accountId))!.state).toBe('ready');
    const supports = await supportRows(legacy.accountId);
    expect(supports).toHaveLength(2);
    expect(supports.find((s) => s.edge_save === legacy.sharedSaveId)).toBeTruthy();
    expect(await supportVersion(legacy.accountId)).toBe(PROJECTION_SUPPORT_VERSION);
    const runsAfterRepair = await runCount(legacy.accountId);

    // Restart semantics: repeated upgrade/backfill runs never re-project it and
    // never change its support.
    const repeat = await runInterestGraphBackfill(iso.db, { config: flagOn });
    expect(repeat).toMatchObject({ state: 'complete', accountsProjected: 0, dueRemaining: 0 });
    expect(await runCount(legacy.accountId)).toBe(runsAfterRepair);
    expect(await supportRows(legacy.accountId)).toEqual(supports);

    // A direct rebuild is idempotent too: same support content (the trigger's
    // lineage label is informational, so it is the one field allowed to move),
    // still not due.
    await projectAccountInterestGraph(iso.db, { accountId: legacy.accountId, config: flagOn, source: 'mutation_intent' });
    const rebuilt = await supportRows(legacy.accountId);
    expect(rebuilt.map(({ origin: _origin, ...content }) => content)).toEqual(
      supports.map(({ origin: _origin, ...content }) => content),
    );
    const again = await runInterestGraphBackfill(iso.db, { config: flagOn });
    expect(again).toMatchObject({ state: 'complete', accountsProjected: 0, dueRemaining: 0 });
  });

  it('normal dispatch hands the legacy account to the queue as a support-version catch-up', async () => {
    const legacy = await legacyReadyProjection();

    const sweep = await dispatchGraphOutbox(iso.db, { config: flagOn });
    expect(sweep.accounts).toHaveLength(1);
    expect(sweep.accounts[0]).toMatchObject({
      accountId: legacy.accountId,
      eventsDispatched: 0,
      catchUp: 'support_version',
      reused: false,
    });
    // The outbox is never consumed or re-marked by the catch-up.
    expect(await outboxRows(legacy.accountId)).toEqual([
      { dispatch_state: 'done', attempts: 0 },
      { dispatch_state: 'done', attempts: 0 },
    ]);
    // Exactly one catch-up job, labeled for the support-version repair.
    const jobs = await projectionJobs(legacy.accountId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: 'queued', payload: { catch_up: 'support_version' } });
    // The account is honestly queued for the handed-off catch-up work.
    expect((await stateRow(legacy.accountId))!.state).toBe('queued');

    // A repeated sweep while the job is active enqueues nothing.
    const repeat = await dispatchGraphOutbox(iso.db, { config: flagOn });
    expect(repeat.accounts).toEqual([]);
    expect(await projectionJobs(legacy.accountId)).toHaveLength(1);

    // The real handler converges the account and completes the job.
    const outcome = await runProjectionJob(jobs[0]!.id);
    expect(outcome).toMatchObject({ state: 'complete', resultType: 'graph_projection' });
    const supports = await supportRows(legacy.accountId);
    expect(supports).toHaveLength(2);
    expect(supports.find((s) => s.edge_save === legacy.sharedSaveId)).toBeTruthy();
    expect((await stateRow(legacy.accountId))!.state).toBe('ready');
    expect(await supportVersion(legacy.accountId)).toBe(PROJECTION_SUPPORT_VERSION);
    // The catch-up run is labeled honestly, never as a mutation intent.
    expect(await latestRunSource(legacy.accountId)).toBe('support_version_catch_up');
    // The next sweep has nothing left to hand off.
    const done = await dispatchGraphOutbox(iso.db, { config: flagOn });
    expect(done.accounts).toEqual([]);
    expect(await projectionJobs(legacy.accountId)).toHaveLength(1);
  });

  it('killed legacy accounts stay honestly due until they are eligible again', async () => {
    const legacy = await legacyReadyProjection();
    await killProjection(legacy.accountId);

    // Blocked repair leaves the account durably due: the scoped run counts it.
    const blocked = await runInterestGraphBackfill(iso.db, { config: flagOn, accountIds: [legacy.accountId] });
    expect(blocked).toMatchObject({ state: 'complete', accountsProjected: 0, dueRemaining: 1 });
    const sweep = await dispatchGraphOutbox(iso.db, { config: flagOn });
    expect(sweep.accounts).toEqual([]);
    expect(await projectionJobs(legacy.accountId)).toHaveLength(0);
    // The legacy shape is untouched: still ready, still missing the shared root.
    expect((await stateRow(legacy.accountId))!.state).toBe('ready');
    expect((await supportRows(legacy.accountId)).find((s) => s.edge_save !== null)).toBeUndefined();
    expect(await supportVersion(legacy.accountId)).toBe(1);

    // Once eligible, ordinary backfill converges it without a new mutation.
    await liftFeatureKill(iso.db, { flag: 'interest_graph_projection_enabled', accountId: legacy.accountId });
    const unblocked = await runInterestGraphBackfill(iso.db, { config: flagOn, accountIds: [legacy.accountId] });
    expect(unblocked).toMatchObject({ state: 'complete', accountsProjected: 1, dueRemaining: 0 });
    const supports = await supportRows(legacy.accountId);
    expect(supports).toHaveLength(2);
    expect(supports.find((s) => s.edge_save === legacy.sharedSaveId)).toBeTruthy();
    expect(await supportVersion(legacy.accountId)).toBe(PROJECTION_SUPPORT_VERSION);
  });

  it('reconciled reads report the behind-version projection honestly and stop lagging after repair', async () => {
    const legacy = await legacyReadyProjection();

    const before = await readReconciledInterestGraph(iso.db, legacy.accountId);
    expect(before.projection).toMatchObject({
      state: 'ready',
      supportVersion: 1,
      lagging: true,
      pendingEvents: 0,
      appliedTasteRevision: legacy.revision,
      currentTasteRevision: legacy.revision,
    });
    // Authority first: the shared save is still a confirmed interest; only its
    // projected edge decoration is missing.
    const sharedInterest = before.interests.find((i) => i.itemId === legacy.shared)!;
    expect(sharedInterest).toMatchObject({ origin: 'explicit', state: 'confirmed', edgeId: null, savedItemId: legacy.sharedSaveId });

    await runInterestGraphBackfill(iso.db, { config: flagOn, accountIds: [legacy.accountId] });

    const after = await readReconciledInterestGraph(iso.db, legacy.accountId);
    expect(after.projection).toMatchObject({ state: 'ready', lagging: false, supportVersion: PROJECTION_SUPPORT_VERSION });
    expect(after.interests.find((i) => i.itemId === legacy.shared)!.edgeId).toBeTruthy();
    expect(after.interests.find((i) => i.itemId === legacy.owned)!.edgeId).toBeTruthy();
  });

  it('removal and returned Undo after upgrade repair withdraw and restore exactly once', async () => {
    const legacy = await legacyReadyProjection();
    await runInterestGraphBackfill(iso.db, { config: flagOn, accountIds: [legacy.accountId] });
    expect((await supportRows(legacy.accountId)).find((s) => s.edge_save !== null)).toBeTruthy();

    // A real removal now: the save row goes, the private edge cascades at once.
    const remove = await recordPreference(legacy.ctx, {
      action: 'remove',
      target_type: 'discovery_item',
      target_id: legacy.shared,
    });
    expect(remove.undo).toEqual({ action: 'save', target_type: 'discovery_item', target_id: legacy.shared });
    expect((await supportRows(legacy.accountId)).find((s) => s.edge_save !== null)).toBeUndefined();

    await runInterestGraphBackfill(iso.db, { config: flagOn, accountIds: [legacy.accountId] });
    const withdrawn = await supportRows(legacy.accountId);
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]).toMatchObject({ edge_item: legacy.owned });
    expect((await loadFoldSaves(iso.db, { kind: 'account', accountId: legacy.accountId })).map((s) => s.item_id)).toEqual([
      legacy.owned,
    ]);

    // The returned Undo restores the support exactly once, on the new save row.
    await recordPreference(legacy.ctx, remove.undo!);
    await runInterestGraphBackfill(iso.db, { config: flagOn, accountIds: [legacy.accountId] });
    const restored = await supportRows(legacy.accountId);
    expect(restored).toHaveLength(2);
    const sharedSupport = restored.find((s) => s.edge_save !== null)!;
    expect(sharedSupport.edge_save).not.toBe(legacy.sharedSaveId); // a fresh save row
    expect(sharedSupport.origin_kind).toBe('saved_item');

    // Replay adds no support and never accumulates.
    const replay = await runInterestGraphBackfill(iso.db, { config: flagOn, accountIds: [legacy.accountId] });
    expect(replay).toMatchObject({ accountsProjected: 0 });
    expect(await supportRows(legacy.accountId)).toEqual(restored);
    const fold = await loadFoldSaves(iso.db, { kind: 'account', accountId: legacy.accountId });
    expect([...fold].map((s) => s.item_id).sort()).toEqual([legacy.owned, legacy.shared].sort());
  });

  it('already-complete accounts stay stable under global backfill and repeated rebuilds', async () => {
    const principal = await insertAccount(iso.db);
    const ctx = testContext(principal, { db: iso.db, config: flagOn });
    const accountId = principal.accountId;
    const owned = await insertItem({ accountId }, { title: `Stable ${randomUUID()}` }, iso.db);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: owned });
    const shared = await insertItem(null, { title: `Stable shared ${randomUUID()}` }, iso.db);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: shared });
    await projectAccountInterestGraph(iso.db, { accountId, config: flagOn, source: 'mutation_intent' });
    const supports = await supportRows(accountId);
    expect(supports).toHaveLength(2);
    const runs = await runCount(accountId);
    expect(await supportVersion(accountId)).toBe(PROJECTION_SUPPORT_VERSION);

    // A global sweep does not re-project the complete account.
    const global = await runInterestGraphBackfill(iso.db, { config: flagOn });
    expect(global).toMatchObject({ state: 'complete', accountsProjected: 0, dueRemaining: 0 });
    expect(await runCount(accountId)).toBe(runs);
    expect(await supportRows(accountId)).toEqual(supports);

    // A direct rebuild is content-idempotent.
    await projectAccountInterestGraph(iso.db, { accountId, config: flagOn, source: 'mutation_intent' });
    expect(await supportRows(accountId)).toEqual(supports);
    expect(await supportVersion(accountId)).toBe(PROJECTION_SUPPORT_VERSION);
  });

  it('a legacy account with new pending intents converges through the ordinary event path', async () => {
    const legacy = await legacyReadyProjection();
    const fresh = await insertItem({ accountId: legacy.accountId }, { title: `Fresh ${randomUUID()}` }, iso.db);
    await recordPreference(legacy.ctx, { action: 'save', target_type: 'discovery_item', target_id: fresh });

    // The ordinary path owns the account: one event-driven job, no catch-up.
    const sweep = await dispatchGraphOutbox(iso.db, { config: flagOn, ownerAccountId: legacy.accountId });
    expect(sweep.accounts).toHaveLength(1);
    expect(sweep.accounts[0]).toMatchObject({ accountId: legacy.accountId, eventsDispatched: 1, reused: false });
    expect(sweep.accounts[0]!.catchUp).toBeUndefined();
    const jobs = await projectionJobs(legacy.accountId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.catch_up).toBeUndefined();

    // One pass satisfies the new intent and the version gap together.
    const outcome = await runProjectionJob(jobs[0]!.id);
    expect(outcome).toMatchObject({ state: 'complete' });
    const supports = await supportRows(legacy.accountId);
    expect(supports).toHaveLength(3);
    expect(supports.filter((s) => s.edge_item === fresh)).toHaveLength(1);
    expect(supports.find((s) => s.edge_save === legacy.sharedSaveId)).toBeTruthy();
    expect(await supportVersion(legacy.accountId)).toBe(PROJECTION_SUPPORT_VERSION);
    expect((await outboxRows(legacy.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
    const done = await dispatchGraphOutbox(iso.db, { config: flagOn, ownerAccountId: legacy.accountId });
    expect(done.accounts).toEqual([]);
  });
});
