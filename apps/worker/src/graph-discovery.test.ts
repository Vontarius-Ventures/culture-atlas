import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { FakeQloo } from '@culture-atlas/providers/testing';
import {
  JOB_HANDLERS,
  agentConnections,
  collections,
  discovery,
  dispatchGraphOutbox,
  enqueueJob,
  ensureGraphWorkBudget,
  items,
  loadGraphWorkBudget,
  preferences,
  upsertGraphIdentity,
} from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAgentConnection, testConfig, testContext } from '@culture-atlas/domain/testing';
import { accountCtx, runJobs, world } from './test-world';
import { Worker } from './worker';

/**
 * VAL-DISC-003 real-stack evidence: the closed-app discovery chain and the
 * feed-read handoff.
 *
 *  - Closed app: a mutation commits; the running worker projects it; the
 *    committed projection stamps fresh support DUE; the worker's own
 *    expansion sweep hands that due work to the queue as ONE bounded
 *    `expand_interest_graph` job; the handler runs it and closes its durable
 *    budget. No feed read anywhere in the chain.
 *  - Feed read: the read only ENQUEUES deduplicated due work — never inline
 *    provider spend, and never the legacy paid expansion for a graph account
 *    (mutual exclusion; the legacy handler refuses the same way, so a job that
 *    slipped in before the flag flipped cannot spend either).
 */

const db = getTestDb();
afterAll(closeTestDb);

const config = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});

interface StateRow {
  state: string;
  applied: number;
  target: number;
}

async function stateRow(accountId: string): Promise<StateRow | null> {
  const { rows } = await db.query<StateRow>(
    `SELECT state, applied_taste_revision AS applied, target_taste_revision AS target
       FROM personal_graph_state WHERE owner_account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

/** A corpus identity with a linked cultural reference, and an account-owned item on it. */
async function savedCorpusItem(ctx: Awaited<ReturnType<typeof accountCtx>>, accountId: string) {
  const name = `work-${randomUUID().slice(0, 6)}`;
  const reference = (
    await db.query<{ id: string }>(
      `INSERT INTO cultural_references (canonical_name, canonical_key, type, external_ids, research_status)
       VALUES ($1, $2, 'style', '{}'::jsonb, 'complete') RETURNING id`,
      [name, `test:${randomUUID()}`],
    )
  ).rows[0]!.id;
  const node = await upsertGraphIdentity(db, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: name,
    nodeKind: 'work',
    domain: 'art',
    senseKey: 'painting',
    culturalReferenceId: reference,
  });
  const itemId = (
    await db.query<{ id: string }>(
      `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title, reference_id)
       VALUES ($1, 'film', 'watch', $2, $3, $4) RETURNING id`,
      [accountId, `test:${randomUUID()}`, name, reference],
    )
  ).rows[0]!.id;
  await preferences.recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemId });
  return { itemId, nodeId: node.id, referenceId: reference };
}

interface JobRow {
  id: string;
  state: string;
  result_type: string | null;
  result_id: string | null;
  dedupe_key: string | null;
  budget: { qloo_requests?: number; deadline_ms?: number };
}

async function jobsOf(accountId: string, type: string): Promise<JobRow[]> {
  const { rows } = await db.query<JobRow>(
    `SELECT id, state, result_type, result_id, dedupe_key, budget FROM jobs
      WHERE owner_account_id = $1 AND type = $2 ORDER BY created_at`,
    [accountId, type],
  );
  return rows;
}

async function refreshRow(accountId: string): Promise<{ expansion_due_since: Date | null; last_expansion_at: Date | null }> {
  const { rows } = await db.query<{ expansion_due_since: Date | null; last_expansion_at: Date | null }>(
    'SELECT expansion_due_since, last_expansion_at FROM graph_refresh_state WHERE owner_account_id = $1',
    [accountId],
  );
  return rows[0] ?? { expansion_due_since: null, last_expansion_at: null };
}

function makeWorker(ctx: Awaited<ReturnType<typeof accountCtx>>): Worker {
  return new Worker({
    db: getTestDb(),
    providers: ctx.providers,
    config,
    handlers: JOB_HANDLERS,
    log: () => undefined,
    heartbeatMs: 1_000,
    graphDispatchEveryMs: 0,
    graphExpansionEveryMs: 0,
  });
}

describe('graph discovery through the real worker', () => {
  it('a mutation becomes due work and one bounded expansion with the app closed and no feed read', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const ctx = await accountCtx(providers, config);
    if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ctx.principal.accountId;
    const saved = await savedCorpusItem(ctx, accountId);
    const qloo = providers.qloo as FakeQloo;

    // The app is closed: no feed read, no discovery GET. The mutation is
    // committed and the operator's worker alone carries the chain.
    await makeWorker(ctx).drain();

    // 1. The mutation was projected (state caught up, outbox satisfied).
    const state = await stateRow(accountId);
    expect(state?.state).toBe('ready');
    expect(state?.applied).toBe(state?.target);
    expect((await jobsOf(accountId, 'project_interest_graph')).every((j) => j.state === 'complete')).toBe(true);

    // 2. The committed projection's due work was handed to the queue by the
    //    worker's own expansion sweep, as exactly ONE bounded job.
    const expansions = await jobsOf(accountId, 'expand_interest_graph');
    expect(expansions).toHaveLength(1);
    expect(expansions[0]!.state).toBe('complete');
    expect(expansions[0]!.result_type).toBe('graph_expansion');
    expect(expansions[0]!.budget.qloo_requests).toBe(4);
    expect(expansions[0]!.budget.deadline_ms).toBe(45_000);

    // 3. The completed run consumed the due marker it covered and closed the
    //    logical window's durable budget (never resettable by redelivery).
    const refresh = await refreshRow(accountId);
    expect(refresh.expansion_due_since).toBeNull();
    expect(refresh.last_expansion_at).toBeInstanceOf(Date);
    const budget = (
      await db.query<{ state: string; qloo_attempts_max: number; qloo_attempts_used: number; deadline_ms: number }>(
        `SELECT state, qloo_attempts_max, qloo_attempts_used, deadline_ms FROM graph_work_budgets
          WHERE owner_account_id = $1 AND work_key = $2`,
        [accountId, expansions[0]!.dedupe_key],
      )
    ).rows[0];
    expect(budget?.state).toBe('complete');
    expect(budget?.qloo_attempts_max).toBe(4);
    expect(budget?.qloo_attempts_used).toBeLessThanOrEqual(4);
    expect(budget?.deadline_ms).toBe(45_000);

    // 4. Honest spend accounting: every reserved attempt of this window was a
    //    real Qloo HTTP attempt (the shared test database may hold other
    //    files' queued work this worker also drained, hence the lower bound).
    expect(qloo.calls.length).toBeGreaterThanOrEqual(budget?.qloo_attempts_used ?? 0);
    expect(budget?.qloo_attempts_used).toBeLessThanOrEqual(4);

    // 5. The projected root the expansion walked is in the account's graph.
    const { rows: edges } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM personal_interest_edges WHERE owner_account_id = $1',
      [accountId],
    );
    expect(Number(edges[0]!.n)).toBeGreaterThanOrEqual(1);
    expect(saved.nodeId).toBeDefined();
  });

  it('a feed read only enqueues deduplicated due work; it never spends inline', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const ctx = await accountCtx(providers, config);
    if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ctx.principal.accountId;
    const qloo = providers.qloo as FakeQloo;
    await savedCorpusItem(ctx, accountId);

    // Project the committed mutation first (as the operator's worker would),
    // without dispatching or running any expansion yet.
    const projected = await dispatchGraphOutbox(db, { config, ownerAccountId: accountId });
    expect(projected.accounts).toHaveLength(1);
    await runJobs(ctx, projected.accounts.map((a) => a.jobId));
    expect((await refreshRow(accountId)).expansion_due_since).toBeInstanceOf(Date);

    // A first-page feed read: it hands the DUE work to the queue and spends
    // nothing inline — the fixture Qloo saw zero HTTP calls.
    const callsBefore = qloo.calls.length;
    await discovery.getDiscoveries(ctx, { limit: 6, refresh: false });
    expect(qloo.calls).toHaveLength(callsBefore);

    // Exactly ONE bounded expansion job was enqueued by the read (the same
    // deduplicated due work the closed-app sweeper would hand over), still
    // queued: nothing about a read runs or consumes the work.
    const expansions = await jobsOf(accountId, 'expand_interest_graph');
    expect(expansions).toHaveLength(1);
    expect(expansions[0]!.state).toBe('queued');
    expect(expansions[0]!.budget.qloo_requests).toBe(4);
    expect(expansions[0]!.budget.deadline_ms).toBe(45_000);
    // And the read never enqueued the legacy paid expansion for a graph
    // account (VAL-DISC-003 mutual exclusion: the graph sweep owns refresh).
    expect(await jobsOf(accountId, 'interest_expand')).toHaveLength(0);
    // The due marker is still due: dispatch alone consumed nothing.
    expect((await refreshRow(accountId)).expansion_due_since).toBeInstanceOf(Date);
  });

  it('the legacy expansion handler refuses to spend for a graph-discovery account', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const ctx = await accountCtx(providers, config);
    if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ctx.principal.accountId;
    const qloo = providers.qloo as FakeQloo;

    // A legacy expansion job that slipped in before the flag flipped (the
    // durable shape a redelivered queue or an operator replay holds).
    const enqueued = await enqueueJob(db, {
      type: 'interest_expand',
      owner: { kind: 'account', accountId },
      payload: { wave: 0, category: 'watch' },
      maxAttempts: 3,
    });

    // Run the legacy job through the real worker: it completes without any
    // Qloo spend — the graph account's refresh belongs to the graph sweep.
    await makeWorker(ctx).drain();

    const legacy = await jobsOf(accountId, 'interest_expand');
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.state).toBe('complete');
    expect(legacy[0]!.id).toBe(enqueued.job.id);
    // No legacy spend: the fixture Qloo saw zero HTTP calls from the job.
    expect(qloo.calls).toHaveLength(0);
    // And no graph expansion ran either: the legacy no-op dispatched nothing.
    expect(await jobsOf(accountId, 'expand_interest_graph')).toHaveLength(0);
  });

  it('with discovery off, the legacy wave still enqueues from a feed read', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    // taste_seed_enabled must be on and a completed seed must exist for the
    // legacy wave to be allowed at all.
    const offConfig = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', TASTE_SEED_ENABLED: 'true' });
    const ctx = await accountCtx(providers, offConfig);
    if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ctx.principal.accountId;
    await db.query(
      `INSERT INTO taste_seed_runs (owner_account_id, taste_revision, state)
       VALUES ($1, 0, 'complete')`,
      [accountId],
    );

    await discovery.getDiscoveries(ctx, { limit: 6, refresh: false });
    const legacy = await jobsOf(accountId, 'interest_expand');
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.state).toBe('queued');
    // The graph pipeline never dispatched anything: discovery is off.
    expect(await jobsOf(accountId, 'expand_interest_graph')).toHaveLength(0);
  });

  it('a redelivered window whose logical deadline already passed fails honestly: no re-anchored work', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const ctx = await accountCtx(providers, config);
    if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ctx.principal.accountId;
    const qloo = providers.qloo as FakeQloo;

    // A dispatch window's job sat in the queue across a worker restart while
    // its logical budget was anchored and expired long ago (VAL-DISC-006): the
    // redelivery inherits the same durable row, never a fresh 45 seconds.
    const { job } = await enqueueJob(db, {
      type: 'expand_interest_graph',
      owner: { kind: 'account', accountId },
      payload: { account_id: accountId },
      dedupeKey: `graph_expansion:delayed:${randomUUID()}`,
      maxAttempts: 3,
      budget: { qloo_requests: 4, deadline_ms: 45_000 },
      resultType: 'graph_expansion',
    });
    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'expansion',
      workKey: job.dedupe_key!,
      at: new Date(Date.now() - 60_000),
    });

    // The real worker claims exactly this delayed job (no sweeps, no other work).
    const worker = new Worker({
      db: getTestDb(),
      providers: ctx.providers,
      config,
      handlers: JOB_HANDLERS,
      log: () => undefined,
      heartbeatMs: 1_000,
      jobIds: [job.id],
    });
    await worker.drain();

    // Honest terminal outcome: failed non-retryably, window stopped, nothing
    // published, nothing reserved, nothing spent.
    const expansions = await jobsOf(accountId, 'expand_interest_graph');
    expect(expansions).toHaveLength(1);
    expect(expansions[0]!.state).toBe('failed');
    const { rows: failed } = await db.query<{ error_code: string; error_retryable: boolean }>(
      'SELECT error_code, error_retryable FROM jobs WHERE id = $1',
      [job.id],
    );
    expect(failed[0]!.error_code).toBe('service_unavailable');
    expect(failed[0]!.error_retryable).toBe(false);
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey: job.dedupe_key! });
    expect(budget?.state).toBe('stopped');
    expect(budget?.qloo_attempts_used).toBe(0);
    const { rows: runs } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1',
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(0);
    expect(qloo.calls).toHaveLength(0);
  });
});

describe('scoped Discover more grant fencing through the real worker (VAL-DISC-007)', () => {
  interface ScopedLibrary {
    ownerCtx: Awaited<ReturnType<typeof accountCtx>>;
    accountId: string;
    origin: string;
    collection: { id: string };
    agentCtx: Awaited<ReturnType<typeof accountCtx>>;
    connectionId: string;
  }

  /** A fresh scoped library on the shared test database: owner, granted agent, anchored origin. */
  async function scopedLibrary(providers: Awaited<ReturnType<typeof world>>['providers']): Promise<ScopedLibrary> {
    const ownerCtx = await accountCtx(providers, config);
    if (ownerCtx.principal.kind !== 'account') throw new Error('test requires an account principal');
    const accountId = ownerCtx.principal.accountId;
    const name = `scoped-${randomUUID().slice(0, 8)}`;
    const referenceId = (
      await db.query<{ id: string }>(
        `INSERT INTO cultural_references (canonical_name, canonical_key, type, external_ids, research_status)
         VALUES ($1, $2, 'style', '{}'::jsonb, 'complete') RETURNING id`,
        [name, `test:${randomUUID()}`],
      )
    ).rows[0]!.id;
    const origin = (
      await db.query<{ id: string }>(
        `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title, reference_id)
         VALUES ($1, 'artist', 'play', $2, $3, $4) RETURNING id`,
        [accountId, `test:${randomUUID()}`, name, referenceId],
      )
    ).rows[0]!.id;
    const collection = await collections.createCollection(ownerCtx, { name });
    await collections.addCollectionItem(ownerCtx, { id: collection.id, item_id: origin, body: {} });
    const agent = await insertAgentConnection(ownerCtx.principal, {
      scopes: ['collections:read'],
      libraryAccess: 'selected_collections',
      collectionIds: [collection.id],
    });
    return {
      ownerCtx,
      accountId,
      origin,
      collection,
      agentCtx: testContext(agent.principal, { db: getTestDb(), providers, config }),
      connectionId: agent.principal.connectionId,
    };
  }

  /** Enqueue the real agent-initiated scoped Discover more job. */
  async function enqueueScoped(lib: ScopedLibrary): Promise<{ jobId: string; discoveryJobId: string }> {
    const started = await items.startRelatedDiscovery(lib.agentCtx, {
      id: lib.origin,
      body: { collection_id: lib.collection.id, category: 'play' },
    });
    return { jobId: started.job_id, discoveryJobId: started.discovery_job_id };
  }

  async function scopedOutcome(jobId: string): Promise<{ state: string; error_code: string | null; error_retryable: boolean | null }> {
    const { rows } = await db.query<{ state: string; error_code: string | null; error_retryable: boolean | null }>(
      'SELECT state, error_code, error_retryable FROM jobs WHERE id = $1',
      [jobId],
    );
    return rows[0]!;
  }

  it('a revoked connection fails the delayed scoped job closed: token_revoked, non-retryable, nothing published', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const qloo = providers.qloo as FakeQloo;
    const lib = await scopedLibrary(providers);
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    // The owner revokes before the worker ever claims the redelivered job.
    await agentConnections.revokeAgentConnection(lib.ownerCtx, { id: lib.connectionId });
    await runJobs(lib.ownerCtx, [jobId]);
    const outcome = await scopedOutcome(jobId);
    expect(outcome.state).toBe('failed');
    expect(outcome.error_code).toBe('token_revoked');
    expect(outcome.error_retryable).toBe(false);
    const { rows: recs } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
      [discoveryJobId],
    );
    expect(Number(recs[0]!.n)).toBe(0);
    // The fence rejects before any provider call.
    expect(qloo.calls).toHaveLength(0);
  });

  it('a removed origin membership fails the delayed scoped job closed: not_found, non-retryable', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const qloo = providers.qloo as FakeQloo;
    const lib = await scopedLibrary(providers);
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    await collections.removeCollectionItem(lib.ownerCtx, { id: lib.collection.id, item_id: lib.origin });
    await runJobs(lib.ownerCtx, [jobId]);
    const outcome = await scopedOutcome(jobId);
    expect(outcome.state).toBe('failed');
    expect(outcome.error_code).toBe('not_found');
    expect(outcome.error_retryable).toBe(false);
    const { rows: recs } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
      [discoveryJobId],
    );
    expect(Number(recs[0]!.n)).toBe(0);
    expect(qloo.calls).toHaveLength(0);
  });
});
