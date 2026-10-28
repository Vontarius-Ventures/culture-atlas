import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  dispatchGraphOutbox,
  enqueueGraphOutboxEvent,
  getJobById,
  preferences,
  PROJECTION_SUPPORT_VERSION,
} from '@culture-atlas/domain';
import { closeTestDb, getTestDb, testConfig } from '@culture-atlas/domain/testing';
import { JOB_HANDLERS } from '@culture-atlas/domain';
import { accountCtx, runJobs, world } from './test-world';
import { Worker } from './worker';

/**
 * VAL-PROJ-007 real-stack evidence: a committed projection intent projects
 * through the real Worker (queue, lease, heartbeat, handler) after the
 * dispatcher returns, without any new user mutation. The projection flag is
 * the only switch; no live provider is involved.
 */

const db = getTestDb();
afterAll(closeTestDb);

const config = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

interface StateRow {
  state: string;
  applied: number;
  projection_revision: number;
}

async function stateRow(accountId: string): Promise<StateRow | null> {
  const { rows } = await db.query<StateRow>(
    `SELECT state, applied_taste_revision AS applied, projection_revision
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

async function unsatisfied(accountId: string): Promise<{ id: string; dispatch_state: string }[]> {
  const { rows } = await db.query<{ id: string; dispatch_state: string }>(
    `SELECT id, dispatch_state FROM graph_outbox WHERE owner_account_id = $1 ORDER BY target_taste_revision`,
    [accountId],
  );
  return rows;
}

async function accountItem(accountId: string): Promise<string> {
  const key = randomUUID();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title)
     VALUES ($1, 'film', 'watch', $2, 'A film') RETURNING id`,
    [accountId, `qloo:${key}`],
  );
  return rows[0]!.id;
}

describe('graph projection through the real worker', () => {
  it('projects committed intents after a dispatcher restart without a new mutation', async () => {
    const { providers } = world({ qloo: null, research: false, composer: false });
    const ctx = await accountCtx(providers, config);
    if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ctx.principal.accountId;
    const item = await accountItem(accountId);
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });

    // The dispatcher is down while the mutation commits: nothing is lost.
    const pending = await unsatisfied(accountId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.dispatch_state).toBe('pending');
    expect(await stateRow(accountId)).toBeNull();

    // The dispatcher returns, hands the intents to the queue, and the real
    // worker projects them to the latest state.
    const dispatched = await dispatchGraphOutbox(db, { config, ownerAccountId: accountId });
    expect(dispatched.accounts).toHaveLength(1);
    await runJobs(ctx, [dispatched.accounts[0]!.jobId]);

    const job = await getJobById(db, dispatched.accounts[0]!.jobId);
    expect(job?.state).toBe('complete');
    expect(job?.result_type).toBe('graph_projection');

    const state = (await stateRow(accountId))!;
    expect(state.state).toBe('ready');
    expect(state.applied).toBe(await tasteRevision(accountId));
    expect(state.projection_revision).toBe(1);
    expect((await unsatisfied(accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);

    const { rows: edges } = await db.query<{ n: number }>(
      'SELECT count(*) AS n FROM personal_interest_edges WHERE owner_account_id = $1',
      [accountId],
    );
    expect(Number(edges[0]!.n)).toBe(1);
  });

  it('one worker job satisfies a burst of intents at the latest revision', async () => {
    const { providers } = world({ qloo: null, research: false, composer: false });
    const ctx = await accountCtx(providers, config);
    if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ctx.principal.accountId;
    const first = await accountItem(accountId);
    const second = await accountItem(accountId);
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: first });
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: second });
    expect((await unsatisfied(accountId)).length).toBe(2);

    const dispatched = await dispatchGraphOutbox(db, { config, ownerAccountId: accountId });
    expect(dispatched.accounts).toHaveLength(1);
    expect(dispatched.eventsDispatched).toBe(2);
    await runJobs(ctx, [dispatched.accounts[0]!.jobId]);

    const state = (await stateRow(accountId))!;
    expect(state.applied).toBe(await tasteRevision(accountId));
    expect((await unsatisfied(accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
    const { rows: edges } = await db.query<{ n: number }>(
      'SELECT count(*) AS n FROM personal_interest_edges WHERE owner_account_id = $1',
      [accountId],
    );
    expect(Number(edges[0]!.n)).toBe(2);
  });

  it('the running worker sweeps committed intents into projection without an explicit dispatch call', async () => {
    const { providers } = world({ qloo: null, research: false, composer: false });
    const ctx = await accountCtx(providers, config);
    if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ctx.principal.accountId;
    const item = await accountItem(accountId);
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    expect((await unsatisfied(accountId)).length).toBe(1);

    // A real Worker with no job filter: its periodic outbox sweep hands the
    // committed intent to the queue and the claimed job projects it. No test
    // calls dispatchGraphOutbox; the dispatcher outage ends when it starts.
    const worker = new Worker({
      db: getTestDb(),
      providers: ctx.providers,
      config,
      handlers: JOB_HANDLERS,
      log: () => undefined,
      heartbeatMs: 1_000,
      graphDispatchEveryMs: 0,
    });
    await worker.drain();

    const state = (await stateRow(accountId))!;
    expect(state.state).toBe('ready');
    expect(state.applied).toBe(await tasteRevision(accountId));
    expect((await unsatisfied(accountId)).every((e) => e.dispatch_state === 'done')).toBe(true);
    const { rows: edges } = await db.query<{ n: number }>(
      'SELECT count(*) AS n FROM personal_interest_edges WHERE owner_account_id = $1',
      [accountId],
    );
    expect(Number(edges[0]!.n)).toBe(1);
    const { rows: queued } = await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM jobs WHERE owner_account_id = $1 AND type = 'project_interest_graph'
        AND state IN ('queued','running')`,
      [accountId],
    );
    expect(Number(queued[0]!.n)).toBe(0);
  });

  it('the sweep leaves intents pending while the projection flag is off', async () => {
    const { providers } = world({ qloo: null, research: false, composer: false });
    // Flag off: the mutation itself writes no intent, so seed the committed
    // intent directly — the durable shape an operator rollback leaves behind.
    const off = testConfig();
    const ctx = await accountCtx(providers, off);
    if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ctx.principal.accountId;
    const item = await accountItem(accountId);
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    await enqueueGraphOutboxEvent(db, {
      ownerAccountId: accountId,
      eventType: 'taste',
      logicalEventKey: 'taste',
      targetTasteRevision: await tasteRevision(accountId),
      jobIntent: 'project_interest_graph',
      payload: { action: 'save' },
    });

    const worker = new Worker({
      db: getTestDb(),
      providers: ctx.providers,
      config: off,
      handlers: JOB_HANDLERS,
      log: () => undefined,
      heartbeatMs: 1_000,
      graphDispatchEveryMs: 0,
    });
    await worker.drain();

    const pending = await unsatisfied(accountId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.dispatch_state).toBe('pending');
    const { rows: jobs } = await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM jobs WHERE owner_account_id = $1 AND type = 'project_interest_graph'`,
      [accountId],
    );
    expect(Number(jobs[0]!.n)).toBe(0);
    expect(await stateRow(accountId)).toBeNull();
  });

  it('the running worker converges a behind-version legacy projection without a new mutation', async () => {
    const { providers } = world({ qloo: null, research: false, composer: false });
    const ctx = await accountCtx(providers, config);
    if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ctx.principal.accountId;
    const owned = await accountItem(accountId);
    const shared = (
      await db.query<{ id: string }>(
        `INSERT INTO discovery_items (owner_account_id, is_sample, kind, category, canonical_key, title)
         VALUES (NULL, true, 'film', 'watch', $1, 'Shared sample') RETURNING id`,
        [`qloo:${randomUUID()}`],
      )
    ).rows[0]!.id;
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: owned });
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: shared });

    // The legacy shape an upgrade finds after migration 270: every earlier
    // intent done, a ready state at the current taste revision, and stored
    // support built by the old semantics that omitted the shared-row save.
    await db.query(`UPDATE graph_outbox SET dispatch_state = 'done', processed_at = now() WHERE owner_account_id = $1`, [
      accountId,
    ]);
    const revision = await tasteRevision(accountId);
    await db.query(
      `INSERT INTO personal_graph_state
         (owner_account_id, state, applied_taste_revision, target_taste_revision, projection_revision, last_projected_at)
       VALUES ($1, 'ready', $2, $2, 1, now())`,
      [accountId, revision],
    );
    const { rows: before } = await db.query<{ n: number }>(
      'SELECT count(*) AS n FROM personal_interest_edges WHERE owner_account_id = $1',
      [accountId],
    );
    expect(Number(before[0]!.n)).toBe(0);

    // No test dispatches anything: the running worker's periodic sweep hands
    // the behind-version account to the queue and the claimed job repairs it,
    // without a new user mutation.
    const worker = new Worker({
      db: getTestDb(),
      providers: ctx.providers,
      config,
      handlers: JOB_HANDLERS,
      log: () => undefined,
      heartbeatMs: 1_000,
      graphDispatchEveryMs: 0,
    });
    await worker.drain();

    const state = (await stateRow(accountId))!;
    expect(state.state).toBe('ready');
    expect(state.applied).toBe(await tasteRevision(accountId));

    // Converged: the owned root AND the previously omitted shared root both
    // project, the latter as private support of the account's own save row.
    const { rows: edges } = await db.query<{ item: string | null; save: string | null }>(
      `SELECT discovery_item_id AS item, saved_item_id AS save FROM personal_interest_edges WHERE owner_account_id = $1`,
      [accountId],
    );
    expect(edges).toHaveLength(2);
    expect(edges.filter((e) => e.item === owned)).toHaveLength(1);
    const sharedEdge = edges.find((e) => e.save !== null)!;
    const { rows: saveRows } = await db.query<{ id: string }>(
      'SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
      [accountId, shared],
    );
    expect(sharedEdge.save).toBe(saveRows[0]!.id);
    // The repairing pass stamped the current completeness marker.
    const { rows: version } = await db.query<{ support_version: number }>(
      'SELECT support_version FROM personal_graph_state WHERE owner_account_id = $1',
      [accountId],
    );
    expect(version[0]!.support_version).toBe(PROJECTION_SUPPORT_VERSION);

    // The catch-up is current-state repair, never invented event provenance:
    // the old intents stay done with zero attempts and no new events appear.
    const { rows: events } = await db.query<{ dispatch_state: string; attempts: number }>(
      'SELECT dispatch_state, attempts FROM graph_outbox WHERE owner_account_id = $1',
      [accountId],
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.dispatch_state === 'done' && e.attempts === 0)).toBe(true);

    // The catch-up run is labeled honestly, and one completed catch-up job
    // owns the repair; the next sweep has nothing left for the account.
    const { rows: runs } = await db.query<{ source: string }>(
      `SELECT budget->>'source' AS source FROM graph_runs WHERE owner_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [accountId],
    );
    expect(runs[0]!.source).toBe('support_version_catch_up');
    const { rows: jobs } = await db.query<{ state: string; payload: { catch_up?: string } }>(
      `SELECT state, payload FROM jobs WHERE owner_account_id = $1 AND type = 'project_interest_graph'`,
      [accountId],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe('complete');
    expect(jobs[0]!.payload.catch_up).toBe('support_version');
  });
});
