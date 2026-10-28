import { afterAll, describe, expect, it } from 'vitest';
import { liftFeatureKill, setFeatureKill } from '../flags/feature-flags';
import { recordPreference } from '../services/preferences';
import { accountCtx, insertItem } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { dispatchGraphOutbox, markGraphProjectionQueued } from './dispatch';
import { projectAccountInterestGraph, unsatisfiedGraphOutboxEventIds } from './projector';
import { markGraphOutboxDispatched } from './store';

/**
 * VAL-PROJ-007 / VAL-PROJ-008: global outbox dispatch fairness and the
 * dispatcher status race. The batch limit applies to eligible accounts only:
 * a projection-killed account with the oldest due intent can never starve a
 * newer enabled account out of the batch, and killed accounts' intents stay
 * durable and unconsumed until they are eligible again. The dispatcher's
 * post-enqueue status update cannot flip a fully applied, tail-clean
 * projection back to queued — that state is truthful and nothing would ever
 * repair it, because a ready state with no pending intents is never
 * re-dispatched.
 *
 * The global-sweep tests share the run's isolated database with every other
 * file, so they age their accounts' intents deep into the past (deeper than
 * any other file's leftovers) to own the oldest-first candidate order, and
 * their negative assertions are containment-based: another file's leftover
 * account may legitimately be dispatched, but never at the cost of these
 * accounts' fairness or retained intents. Scenarios run in declaration order.
 */

const db = getTestDb();
afterAll(closeTestDb);

const projectionOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

interface StateRow {
  state: string;
  target_taste_revision: number;
  applied_taste_revision: number;
  updated_at: Date;
}

async function stateRow(accountId: string): Promise<StateRow | null> {
  const { rows } = await db.query<StateRow>(
    `SELECT state, target_taste_revision, applied_taste_revision, updated_at
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

interface OutboxRow {
  id: string;
  dispatch_state: string;
  attempts: number;
}

async function outboxRows(accountId: string): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, dispatch_state, attempts FROM graph_outbox
      WHERE owner_account_id = $1 ORDER BY target_taste_revision, id`,
    [accountId],
  );
  return rows;
}

async function projectionJobs(accountId: string): Promise<{ id: string; state: string }[]> {
  const { rows } = await db.query<{ id: string; state: string }>(
    `SELECT id, state FROM jobs WHERE owner_account_id = $1 AND type = 'project_interest_graph' ORDER BY created_at`,
    [accountId],
  );
  return rows;
}

async function edgeCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*) AS n FROM personal_interest_edges WHERE owner_account_id = $1',
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function saveUniqueItem(ctx: Parameters<typeof recordPreference>[0], accountId: string): Promise<string> {
  const item = await insertItem({ accountId });
  await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
  return item;
}

/** Ages an account's intents deep into the past so global sweeps order it first. */
async function ageIntents(accountId: string, minutes: number): Promise<void> {
  await db.query(`UPDATE graph_outbox SET created_at = created_at - make_interval(mins => $2::int) WHERE owner_account_id = $1`, [
    accountId,
    minutes,
  ]);
}

async function killProjection(accountId: string): Promise<void> {
  await setFeatureKill(db, {
    flag: 'interest_graph_projection_enabled',
    accountId,
    reason: 'dispatch fairness regression',
    actor: 'test',
  });
}

async function project(accountId: string, jobId?: string) {
  return projectAccountInterestGraph(db, { accountId, config: projectionOn, source: 'mutation_intent', jobId });
}

describe('global dispatch fairness (VAL-PROJ-007)', () => {
  it('limit 1 dispatches the newer enabled account past an older killed account', async () => {
    const killed = await accountCtx({ config: projectionOn });
    const enabled = await accountCtx({ config: projectionOn });
    await saveUniqueItem(killed.ctx, killed.principal.accountId);
    await ageIntents(killed.principal.accountId, 60);
    await saveUniqueItem(enabled.ctx, enabled.principal.accountId);
    await ageIntents(enabled.principal.accountId, 45);
    await killProjection(killed.principal.accountId);

    // The killed account owns the OLDEST due intent: it must not consume the
    // single batch slot. Eligibility is decided before the limit, so the
    // enabled account is reached on the very first sweep.
    const sweep = await dispatchGraphOutbox(db, { config: projectionOn, limit: 1 });
    expect(sweep.accounts.map((a) => a.accountId)).toEqual([enabled.principal.accountId]);
    expect(sweep.eventsDispatched).toBe(1);

    // The enabled account completes through its dispatched job; the only
    // mutation ever made is the original save.
    const done = await project(enabled.principal.accountId, sweep.accounts[0]!.jobId);
    expect(done.projected).toBe(true);
    expect(done.tailClean).toBe(true);
    expect((await stateRow(enabled.principal.accountId))!.state).toBe('ready');
    expect(await edgeCount(enabled.principal.accountId)).toBe(1);
    expect((await outboxRows(enabled.principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);

    // The killed account's intent stays durable and unconsumed: pending, no
    // attempts, no job, no projection state row. Nothing was dropped to
    // manufacture progress.
    const retained = await outboxRows(killed.principal.accountId);
    expect(retained).toHaveLength(1);
    expect(retained[0]!.dispatch_state).toBe('pending');
    expect(retained[0]!.attempts).toBe(0);
    expect(await projectionJobs(killed.principal.accountId)).toEqual([]);
    expect(await stateRow(killed.principal.accountId)).toBeNull();
  });

  it('repeated sweeps retain killed intents and converge them once the kill is lifted, without a new mutation', async () => {
    const killed = await accountCtx({ config: projectionOn });
    const enabled = await accountCtx({ config: projectionOn });
    await saveUniqueItem(killed.ctx, killed.principal.accountId);
    await ageIntents(killed.principal.accountId, 60);
    await saveUniqueItem(enabled.ctx, enabled.principal.accountId);
    await ageIntents(enabled.principal.accountId, 45);
    await killProjection(killed.principal.accountId);

    const first = await dispatchGraphOutbox(db, { config: projectionOn, limit: 1 });
    expect(first.accounts.map((a) => a.accountId)).toEqual([enabled.principal.accountId]);
    await project(enabled.principal.accountId, first.accounts[0]!.jobId);

    // Sweeps repeat while the kill holds: neither account is claimed again
    // (the enabled one is fully converged, the killed one stays ineligible)
    // and the killed account's intent is never dropped.
    for (let i = 0; i < 2; i++) {
      const sweep = await dispatchGraphOutbox(db, { config: projectionOn, limit: 1 });
      const ids = sweep.accounts.map((a) => a.accountId);
      expect(ids).not.toContain(killed.principal.accountId);
      expect(ids).not.toContain(enabled.principal.accountId);
    }
    expect((await outboxRows(killed.principal.accountId))[0]!.dispatch_state).toBe('pending');

    // The kill is lifted: the retained intent converges through ordinary
    // dispatch and projection with NO new user mutation.
    await liftFeatureKill(db, { flag: 'interest_graph_projection_enabled', accountId: killed.principal.accountId });
    const converge = await dispatchGraphOutbox(db, { config: projectionOn, limit: 1 });
    expect(converge.accounts.map((a) => a.accountId)).toEqual([killed.principal.accountId]);
    const done = await project(killed.principal.accountId, converge.accounts[0]!.jobId);
    expect(done.projected).toBe(true);
    expect(done.tailClean).toBe(true);
    expect((await stateRow(killed.principal.accountId))!.state).toBe('ready');
    expect((await stateRow(killed.principal.accountId))!.applied_taste_revision).toBe(
      await tasteRevision(killed.principal.accountId),
    );
    expect(await edgeCount(killed.principal.accountId)).toBe(1);
    expect((await outboxRows(killed.principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);

    // The enabled account's earlier convergence is untouched.
    expect((await stateRow(enabled.principal.accountId))!.state).toBe('ready');
    expect(await edgeCount(enabled.principal.accountId)).toBe(1);
  });

  it('a killed prefix cannot fill the batch: the limit counts eligible accounts only', async () => {
    const killedAccounts = [];
    for (let i = 0; i < 3; i++) {
      const a = await accountCtx({ config: projectionOn });
      await saveUniqueItem(a.ctx, a.principal.accountId);
      await ageIntents(a.principal.accountId, 60 - i * 5);
      await killProjection(a.principal.accountId);
      killedAccounts.push(a);
    }
    const enabledAccounts = [];
    for (let i = 0; i < 2; i++) {
      const a = await accountCtx({ config: projectionOn });
      await saveUniqueItem(a.ctx, a.principal.accountId);
      await ageIntents(a.principal.accountId, 45 - i * 5);
      enabledAccounts.push(a);
    }

    const sweep = await dispatchGraphOutbox(db, { config: projectionOn, limit: 2 });
    expect(sweep.accounts.map((a) => a.accountId).sort()).toEqual(enabledAccounts.map((a) => a.principal.accountId).sort());
    expect(sweep.eventsDispatched).toBe(2);
    for (const a of killedAccounts) {
      const retained = await outboxRows(a.principal.accountId);
      expect(retained).toHaveLength(1);
      expect(retained[0]!.dispatch_state).toBe('pending');
      expect(retained[0]!.attempts).toBe(0);
      expect(await stateRow(a.principal.accountId)).toBeNull();
    }

    // The two dispatched accounts hold the only eligible work among these
    // five: their active jobs exclude them from re-dispatch, the killed
    // prefix stays ineligible, and their scoped sweeps claim nothing.
    const again = await dispatchGraphOutbox(db, { config: projectionOn, limit: 5 });
    const againIds = again.accounts.map((a) => a.accountId);
    for (const a of killedAccounts) expect(againIds).not.toContain(a.principal.accountId);
    for (const a of enabledAccounts) {
      expect(againIds).not.toContain(a.principal.accountId);
      const scoped = await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: a.principal.accountId });
      expect(scoped.accounts).toEqual([]);
    }
  });

  it('a config-level kill switch leaves intents durable and dispatch resumes when it clears', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    await saveUniqueItem(ctx, principal.accountId);
    const configKilled = testConfig({
      INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
      FEATURE_KILL_SWITCHES: 'interest_graph_projection_enabled',
    });

    const killed = await dispatchGraphOutbox(db, { config: configKilled, ownerAccountId: principal.accountId });
    expect(killed.accounts).toEqual([]);
    expect((await outboxRows(principal.accountId))[0]!.dispatch_state).toBe('pending');
    expect(await projectionJobs(principal.accountId)).toEqual([]);
    expect(await stateRow(principal.accountId)).toBeNull();

    // The operator clears the env kill: the retained intent dispatches and
    // converges normally — it was never consumed or dropped.
    const resumed = await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    expect(resumed.accounts.map((a) => a.accountId)).toEqual([principal.accountId]);
    const done = await project(principal.accountId, resumed.accounts[0]!.jobId);
    expect(done.projected).toBe(true);
    expect((await outboxRows(principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
  });
});

describe('dispatcher status update race (VAL-PROJ-008)', () => {
  it('a dispatcher status update arriving after job completion leaves the ready state truthful', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    await saveUniqueItem(ctx, principal.accountId);
    const target = await tasteRevision(principal.accountId);

    const dispatched = await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    expect(dispatched.accounts).toHaveLength(1);
    expect((await stateRow(principal.accountId))!.state).toBe('queued');

    // The queued job runs to completion BEFORE the dispatcher's separate
    // status update lands (the worker claims jobs concurrently): fully
    // applied, clean outbox tail, state ready.
    const done = await project(principal.accountId, dispatched.accounts[0]!.jobId);
    expect(done.projected).toBe(true);
    expect(done.tailClean).toBe(true);
    const completed = (await stateRow(principal.accountId))!;
    expect(completed.state).toBe('ready');
    expect(completed.applied_taste_revision).toBe(target);
    expect((await outboxRows(principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);

    // The late status update is the dispatcher's own statement with the same
    // handed-off target revision: with the projection fully applied it must
    // leave the ready state — and its row — untouched.
    await markGraphProjectionQueued(db, { accountId: principal.accountId, targetTasteRevision: target });
    const after = (await stateRow(principal.accountId))!;
    expect(after.state).toBe('ready');
    expect(after.updated_at.getTime()).toBe(completed.updated_at.getTime());
    expect(await unsatisfiedGraphOutboxEventIds(db, principal.accountId)).toEqual([]);

    // Nothing is due: a scoped sweep for this account claims no work.
    const sweep = await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    expect(sweep.accounts).toEqual([]);
  });

  it('a parked status update re-evaluates completed work on another connection and stays ready', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    await saveUniqueItem(ctx, principal.accountId);

    // The post-enqueue world: the intent is dispatched and the state row
    // exists, exactly as a mid-dispatch account looks.
    const events = await unsatisfiedGraphOutboxEventIds(db, principal.accountId);
    await markGraphOutboxDispatched(db, events);
    await db.query(`INSERT INTO personal_graph_state (owner_account_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      principal.accountId,
    ]);
    const revision = await tasteRevision(principal.accountId);

    // Connection 1: a projector mid-build holds the account's state row lock.
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT * FROM personal_graph_state WHERE owner_account_id = $1 FOR UPDATE', [
        principal.accountId,
      ]);

      // Connection 2: the dispatcher's status update parks on that lock while
      // the worker finishes its pass. The passed target revision is the
      // handed-off intent's own — what the dispatcher read before enqueueing.
      const parked = markGraphProjectionQueued(db, {
        accountId: principal.accountId,
        targetTasteRevision: revision,
      });
      await new Promise((r) => setTimeout(r, 200));

      // The projection completes under the lock — the exact committed shape
      // of a finished projector pass — and the lock is released.
      await holder.query(`UPDATE graph_outbox SET dispatch_state = 'done', processed_at = now() WHERE owner_account_id = $1`, [
        principal.accountId,
      ]);
      await holder.query(
        `UPDATE personal_graph_state
            SET target_taste_revision = GREATEST(target_taste_revision, $2),
                applied_taste_revision = $2,
                projection_revision = projection_revision + 1,
                state = 'ready',
                last_projected_at = now(),
                updated_at = now()
          WHERE owner_account_id = $1`,
        [principal.accountId, revision],
      );
      await holder.query('COMMIT');
      await parked;

      // The parked statement resumed against the completed world and left
      // the truthful ready state intact with zero pending work.
      expect((await stateRow(principal.accountId))!.state).toBe('ready');
      expect((await outboxRows(principal.accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
      expect(await unsatisfiedGraphOutboxEventIds(db, principal.accountId)).toEqual([]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});
