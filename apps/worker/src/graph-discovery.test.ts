import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeQloo } from '@culture-atlas/providers/testing';
import {
  JOB_HANDLERS,
  admitGraphCorpus,
  agentConnections,
  cancelJob,
  claimJobs,
  collections,
  discovery,
  dispatchGraphOutbox,
  enqueueJob,
  ensureGraphWorkBudget,
  getCorpusManifestFile,
  heartbeatJob,
  items,
  linkGraphReferenceIdentities,
  loadGraphWorkBudget,
  preferences,
  upsertGraphIdentity,
  type Db,
  type DomainConfig,
  type JobHandlerMap,
  type PoolDb,
} from '@culture-atlas/domain';
import {
  closeTestDb,
  createIsolatedDatabase,
  getTestDb,
  insertAccount,
  insertAgentConnection,
  testConfig,
  testContext,
} from '@culture-atlas/domain/testing';
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

async function stateRow(accountId: string, dbFor: PoolDb = db): Promise<StateRow | null> {
  const { rows } = await dbFor.query<StateRow>(
    `SELECT state, applied_taste_revision AS applied, target_taste_revision AS target
       FROM personal_graph_state WHERE owner_account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

/** A corpus identity with a linked cultural reference, and an account-owned item on it. */
async function savedCorpusItem(
  ctx: Awaited<ReturnType<typeof accountCtx>>,
  accountId: string,
  dbFor: PoolDb = db,
) {
  const name = `work-${randomUUID().slice(0, 6)}`;
  const reference = (
    await dbFor.query<{ id: string }>(
      `INSERT INTO cultural_references (canonical_name, canonical_key, type, external_ids, research_status)
       VALUES ($1, $2, 'style', '{}'::jsonb, 'complete') RETURNING id`,
      [name, `test:${randomUUID()}`],
    )
  ).rows[0]!.id;
  const node = await upsertGraphIdentity(dbFor, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: name,
    nodeKind: 'work',
    domain: 'art',
    senseKey: 'painting',
    culturalReferenceId: reference,
  });
  const itemId = (
    await dbFor.query<{ id: string }>(
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

async function jobsOf(accountId: string, type: string, dbFor: PoolDb = db): Promise<JobRow[]> {
  const { rows } = await dbFor.query<JobRow>(
    `SELECT id, state, result_type, result_id, dedupe_key, budget FROM jobs
      WHERE owner_account_id = $1 AND type = $2 ORDER BY created_at`,
    [accountId, type],
  );
  return rows;
}

async function refreshRow(
  accountId: string,
  dbFor: PoolDb = db,
): Promise<{ expansion_due_since: Date | null; last_expansion_at: Date | null }> {
  const { rows } = await dbFor.query<{ expansion_due_since: Date | null; last_expansion_at: Date | null }>(
    'SELECT expansion_due_since, last_expansion_at FROM graph_refresh_state WHERE owner_account_id = $1',
    [accountId],
  );
  return rows[0] ?? { expansion_due_since: null, last_expansion_at: null };
}

function makeWorker(ctx: Awaited<ReturnType<typeof accountCtx>>, dbFor: PoolDb = db): Worker {
  return new Worker({
    db: dbFor,
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
    const qloo = providers.qloo as FakeQloo;

    // This test's drain is deliberately UNSCOPED — it is the operator's whole
    // worker carrying the closed-app chain — so it runs against a provably
    // isolated queue: a fresh per-test database that holds only this test's
    // account, its intents and the jobs its own chain enqueues
    // (docs/ARCHITECTURE.md: scope drains by job id, or isolate the queue).
    // The shared per-run database instead holds queued work from other files,
    // which an unscoped drain would claim and spend this test's fake Qloo on.
    const created = await createIsolatedDatabase('scrdwclosed');
    const isoDb = created.db;
    try {
      const owner = await insertAccount(isoDb);
      const ctx = testContext(owner, { db: isoDb, providers, config });
      if (ctx.principal.kind !== 'account') throw new Error('test requires an account principal');
      const accountId = ctx.principal.accountId;
      const saved = await savedCorpusItem(ctx, accountId, isoDb);

      // The app is closed: no feed read, no discovery GET. The mutation is
      // committed and the operator's worker alone carries the chain.
      await makeWorker(ctx, isoDb).drain();

      // 1. The mutation was projected (state caught up, outbox satisfied).
      const state = await stateRow(accountId, isoDb);
      expect(state?.state).toBe('ready');
      expect(state?.applied).toBe(state?.target);
      expect((await jobsOf(accountId, 'project_interest_graph', isoDb)).every((j) => j.state === 'complete')).toBe(true);

      // 2. The committed projection's due work was handed to the queue by the
      //    worker's own expansion sweep, as exactly ONE bounded job.
      const expansions = await jobsOf(accountId, 'expand_interest_graph', isoDb);
      expect(expansions).toHaveLength(1);
      expect(expansions[0]!.state).toBe('complete');
      expect(expansions[0]!.result_type).toBe('graph_expansion');
      expect(expansions[0]!.budget.qloo_requests).toBe(4);
      expect(expansions[0]!.budget.deadline_ms).toBe(45_000);

      // 3. The completed run consumed the due marker it covered and closed the
      //    logical window's durable budget (never resettable by redelivery).
      const refresh = await refreshRow(accountId, isoDb);
      expect(refresh.expansion_due_since).toBeNull();
      expect(refresh.last_expansion_at).toBeInstanceOf(Date);
      const budget = (
        await isoDb.query<{ state: string; qloo_attempts_max: number; qloo_attempts_used: number; deadline_ms: number }>(
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
      //    real Qloo HTTP attempt. The drain is provably isolated to this
      //    test's chain, so this fake saw only this account's work; the lower
      //    bound stays the conservative check.
      expect(qloo.calls.length).toBeGreaterThanOrEqual(budget?.qloo_attempts_used ?? 0);
      expect(budget?.qloo_attempts_used).toBeLessThanOrEqual(4);

      // 5. The projected root the expansion walked is in the account's graph.
      const { rows: edges } = await isoDb.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM personal_interest_edges WHERE owner_account_id = $1',
        [accountId],
      );
      expect(Number(edges[0]!.n)).toBeGreaterThanOrEqual(1);
      expect(saved.nodeId).toBeDefined();
    } finally {
      await created.drop();
    }
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

    // Run the legacy job through the real worker, scoped to exactly this
    // test-created job id (docs/ARCHITECTURE.md: `new Worker({jobIds})`):
    // the shared per-run database holds queued work from other files, and an
    // unscoped drain would claim it and spend this test's fake Qloo on it.
    // The legacy handler still completes without any Qloo spend — the graph
    // account's refresh belongs to the graph sweep.
    await runJobs(ctx, [enqueued.job.id]);

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

describe('real-worker drains stay scoped to owned jobs in the shared queue', () => {
  /**
   * The serial gate's historical flake, made deterministic. The per-run test
   * database is shared by every file of the run, and this file's real-worker
   * drains used to be UNSCOPED: a queued job left behind by an earlier file
   * was claimable by a later file's drain, which then ran the FOREIGN work
   * through the current test's fake providers — observed once as five
   * unexpected FakeQloo calls inside 'the legacy expansion handler refuses
   * to spend for a graph-discovery account' (that one full serial gate exit
   * is preserved as history in library/graph.md). docs/ARCHITECTURE.md
   * mandates the discipline: when a test drives the queue, claim jobs by id
   * (`new Worker({jobIds})`), or provably isolate the queue.
   *
   * The fixture reproduces the pickup under full control, on a per-test
   * isolated database holding exactly one owned job and one FOREIGN queued
   * job that spends Qloo the moment any drain claims it.
   */
  it('only the owned job executes: a foreign queued job is never claimed and makes zero Qloo calls', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const qloo = providers.qloo as FakeQloo;
    const created = await createIsolatedDatabase('scrdwforeign');
    const isoDb = created.db;
    try {
      // The owned job: the exact legacy-refuses shape — a graph-discovery
      // account's legacy expansion job, which must complete without spend.
      const ownedOwner = await insertAccount(isoDb);
      const ownedCtx = testContext(ownedOwner, { db: isoDb, providers, config });
      if (ownedCtx.principal.kind !== 'account') throw new Error('test requires an account principal');
      const owned = await enqueueJob(isoDb, {
        type: 'interest_expand',
        owner: { kind: 'account', accountId: ownedCtx.principal.accountId },
        payload: { wave: 0, category: 'watch' },
        maxAttempts: 3,
      });

      // The foreign job: another account's queued related discovery — the
      // durable shape an earlier test file leaves behind — which spends Qloo
      // (origin resolution + per-category insights) the moment it is claimed.
      const foreignOwner = await insertAccount(isoDb);
      const foreignCtx = testContext(foreignOwner, { db: isoDb, providers, config });
      const foreignItem = (
        await isoDb.query<{ id: string }>(
          `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title,
                                        display_metadata, external_ids)
           VALUES ($1, 'film', 'watch', $2, $3, '{}'::jsonb, $4::jsonb) RETURNING id`,
          [foreignOwner.accountId, `test:${randomUUID()}`, 'Playtime', JSON.stringify({ qloo: randomUUID() })],
        )
      ).rows[0]!.id;
      const foreign = await items.startRelatedDiscovery(foreignCtx, { id: foreignItem, body: {} });

      const foreignJob = async () =>
        (
          await isoDb.query<{ state: string; attempt: number; lease_owner: string | null }>(
            'SELECT state, attempt, lease_owner FROM jobs WHERE id = $1',
            [foreign.job_id],
          )
        ).rows[0]!;

      // The corrected harness: a drain scoped to exactly the test-created
      // job id (docs/ARCHITECTURE.md: `new Worker({jobIds})`). jobIds also
      // turns the worker's own periodic sweeps off, so nothing beyond the
      // owned job is even enqueued, let alone claimable.
      const scoped = new Worker({
        db: isoDb,
        providers,
        config,
        handlers: JOB_HANDLERS,
        log: () => undefined,
        heartbeatMs: 1_000,
        jobIds: [owned.job.id],
      });
      await scoped.drain();

      // Only the owned job executed: it completed, the foreign job was never
      // claimed (still queued at its initial attempt with no lease owner),
      // and no unrelated paid/fake Qloo call occurred.
      const ownedState = (
        await isoDb.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [owned.job.id])
      ).rows[0]!.state;
      expect(ownedState).toBe('complete');
      expect(await foreignJob()).toMatchObject({ state: 'queued', attempt: 0, lease_owner: null });
      expect(qloo.calls).toHaveLength(0);

      // The reproduction, quarantined on this test's own isolated queue: the
      // SAME two jobs drained the OLD way (an unscoped worker, exactly this
      // file's historical makeWorker shape) — the unscoped drain DOES claim
      // the foreign job and spends through the current test's fake Qloo,
      // proving the fixture models the real pickup this file's drains are
      // now scoped against.
      const unscoped = new Worker({
        db: isoDb,
        providers,
        config,
        handlers: JOB_HANDLERS,
        log: () => undefined,
        heartbeatMs: 1_000,
        graphDispatchEveryMs: 0,
        graphExpansionEveryMs: 0,
      });
      await unscoped.drain();
      const claimed = await foreignJob();
      expect(claimed.attempt).toBeGreaterThan(0);
      expect(qloo.calls.length).toBeGreaterThan(0);
    } finally {
      await created.drop();
    }
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

  it('a redelivered scoped job whose anchored window already passed fails honestly: no re-anchored work, no provider fallback', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const qloo = providers.qloo as FakeQloo;
    const lib = await scopedLibrary(providers);
    const { jobId, discoveryJobId } = await enqueueScoped(lib);
    // The job sat in the queue across a worker restart while its immutable
    // anchored work window (migration 400) expired long ago: the redelivery
    // inherits the SAME durable row, never a fresh 45 seconds. The row is
    // re-anchored through its own allowed closed path (DELETE + fresh
    // INSERT, exactly the enqueue transaction's dedupe-race cleanup).
    await db.query(
      `WITH old AS (DELETE FROM discovery_grant_authorities WHERE discovery_job_id = $1 RETURNING *)
       INSERT INTO discovery_grant_authorities
         (owner_account_id, discovery_job_id, job_id, agent_connection_id, authorization_version,
          collection_granted_at, origin_collection_id, origin_item_id, origin_saved_item_id, work_deadline_at)
       SELECT owner_account_id, discovery_job_id, job_id, agent_connection_id, authorization_version,
              collection_granted_at, origin_collection_id, origin_item_id, origin_saved_item_id,
              now() - interval '1 minute'
         FROM old`,
      [discoveryJobId],
    );
    await runJobs(lib.ownerCtx, [jobId]);
    const outcome = await scopedOutcome(jobId);
    expect(outcome.state).toBe('failed');
    expect(outcome.error_code).toBe('service_unavailable');
    expect(outcome.error_retryable).toBe(false);
    const { rows: recs } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
      [discoveryJobId],
    );
    expect(Number(recs[0]!.n)).toBe(0);
    // The marker keeps the expired window on the typed graph outcome — never
    // a paid provider fallback and no partial scoped results.
    expect(qloo.calls).toHaveLength(0);
  });
});

// --- DISC-SCR-039: the queue attempt publication fence through the REAL worker --

describe('scoped Discover more queue attempt fencing through the real worker (DISC-SCR-039)', () => {
  /**
   * The real Worker's liveness callback (`stillOwnsJob` on the pool) is an
   * UNLOCKED read: the real queue writers (cancel, reclaim, heartbeat, reap)
   * are single-row jobs UPDATEs that can commit between that read and the
   * scoped pass's commit while a tail write waits. The pass therefore locks
   * its own queue attempt row in the publication transaction and revalidates
   * running state, ownership, the pinned attempt, cancellation and the live
   * lease through the commit. These cases drive the REAL Worker (real claim,
   * heartbeat timer, stage records, completion and cancelled-cleanup paths)
   * with its ctx.db parked at exactly one statement, so each ordering is
   * deterministic:
   *
   *  - cancellation / lease transfer committing between the liveness read
   *    and the guard rejects the pass (job cancelled / new attempt intact)
   *    with zero published rows and no provider call;
   *  - a writer arriving while the pass holds the row queues behind the
   *    publication and lands after the commit (publisher-first: no
   *    retroactive failure of a committed publication, and the bounded row
   *    lock is never a heartbeat deadlock);
   *  - the transferred attempt converges through another real worker.
   */

  /** Verified live Qloo entity ids (see the corpus manifest provenance). */
  const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
  const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';

  /** The pass's locked queue revalidation (DISC-SCR-039's guard). */
  const GUARD_PATTERN = /SELECT lease_expiry FROM jobs/;
  /** The pass's first tail write (where round 8's blocked tail motivated the fence). */
  const TAIL_DELETE_PATTERN = /DELETE FROM recommendations WHERE discovery_job_id/;

  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeAll(async () => {
    const created = await createIsolatedDatabase('scrdqw');
    isoDb = created.db;
    dropIso = created.drop;
    await admitGraphCorpus(isoDb, getCorpusManifestFile());
  });
  afterAll(async () => {
    await dropIso();
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * A Db view whose FIRST query matching `pattern` parks until `release()`.
   * The statement is intercepted before it reaches the server, so the row
   * stays unlocked and real queue writers can still commit while the pass
   * sits between its unlocked liveness read and the committing writes.
   */
  function parkedDb(base: Db, pattern: RegExp): { db: Db; arrived: Promise<void>; release: () => void } {
    let parked = false;
    let markArrived!: () => void;
    const arrived = new Promise<void>((resolve) => {
      markArrived = resolve;
    });
    let openGate!: () => void;
    const opened = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const wrap = (inner: Db): Db => {
      const self: Db = {
        inTransaction: inner.inTransaction,
        // The park is transparent: identical statements, one held back. The
        // generic query signature flows through the implementation cast.
        query: (async (text: string, params?: readonly unknown[]) => {
          if (!parked && pattern.test(text)) {
            parked = true;
            markArrived();
            await opened;
          }
          return inner.query(text, params);
        }) as Db['query'],
        transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
      };
      return self;
    };
    return { db: wrap(base), arrived, release: () => openGate() };
  }

  /** The real handler map with the pass's Db view parked at one statement. */
  function parkedHandlers(park: { db: Db }): JobHandlerMap {
    return {
      ...JOB_HANDLERS,
      discover_related: (ctx) => JOB_HANDLERS.discover_related({ ...ctx, db: park.db }),
    };
  }

  interface ScopedQueueLibrary {
    accountId: string;
    origin: string;
    collection: { id: string };
    agentCtx: Awaited<ReturnType<typeof accountCtx>>;
  }

  /** A fresh scoped library on the isolated corpus database: owner + granted agent + anchored origin. */
  async function scopedQueueLibrary(
    providers: Awaited<ReturnType<typeof world>>['providers'],
    libraryConfig: DomainConfig = config,
  ): Promise<ScopedQueueLibrary> {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, providers, config: libraryConfig });
    const ref = (canonicalKey: string, name: string, qlooId: string) =>
      isoDb
        .query<{ id: string }>(
          `INSERT INTO cultural_references (canonical_name, canonical_key, type, external_ids)
           VALUES ($1, $2, 'creator', $3::jsonb)
           ON CONFLICT (canonical_key) DO UPDATE
             SET external_ids = cultural_references.external_ids || EXCLUDED.external_ids, updated_at = now()
           RETURNING id`,
          [name, canonicalKey, JSON.stringify({ qloo: qlooId, qloo_types: ['urn:entity:person'] })],
        )
        .then((r) => r.rows[0]!.id);
    const rodinRef = await ref(`qloo:${RODIN_QLOO_ID}`, 'Auguste Rodin', RODIN_QLOO_ID);
    await ref(`qloo:${SEURAT_QLOO_ID}`, 'Georges Seurat', SEURAT_QLOO_ID);
    const origin = (
      await isoDb.query<{ id: string }>(
        `INSERT INTO discovery_items (owner_account_id, owner_session_id, is_sample, kind, category, canonical_key, title,
                                      display_metadata, external_ids, reference_id, resolved_anchor_ids)
         VALUES ($1, NULL, false, 'artist', 'play', $2, $3, '{}'::jsonb, $4::jsonb, $5, '{}'::uuid[]) RETURNING id`,
        [owner.accountId, `qloo:${RODIN_QLOO_ID}`, 'Auguste Rodin', JSON.stringify({ qloo: RODIN_QLOO_ID }), rodinRef],
      )
    ).rows[0]!.id;
    const collection = await collections.createCollection(ownerCtx, { name: `scoped-queue-${randomUUID().slice(0, 8)}` });
    await collections.addCollectionItem(ownerCtx, { id: collection.id, item_id: origin, body: {} });
    const agent = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [collection.id] },
      isoDb,
    );
    await linkGraphReferenceIdentities(isoDb);
    return {
      accountId: owner.accountId,
      origin,
      collection,
      agentCtx: testContext(agent.principal, { db: isoDb, providers, config: libraryConfig }),
    };
  }

  /** Enqueue the real agent-initiated scoped Discover more job. */
  async function enqueueScoped(lib: ScopedQueueLibrary): Promise<{ jobId: string; discoveryJobId: string }> {
    const started = await items.startRelatedDiscovery(lib.agentCtx, {
      id: lib.origin,
      body: { collection_id: lib.collection.id, category: 'play' },
    });
    return { jobId: started.job_id, discoveryJobId: started.discovery_job_id };
  }

  async function scopedRowsOf(discoveryJobId: string): Promise<{ recs: number; proofs: number }> {
    const { rows: recs } = await isoDb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
      [discoveryJobId],
    );
    const { rows: proofs } = await isoDb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
      [discoveryJobId],
    );
    return { recs: Number(recs[0]!.n), proofs: Number(proofs[0]!.n) };
  }

  async function jobRowOf(
    jobId: string,
  ): Promise<{ state: string; lease_owner: string | null; attempt: number; cancel_requested_at: Date | null }> {
    const { rows } = await isoDb.query<{
      state: string;
      lease_owner: string | null;
      attempt: number;
      cancel_requested_at: Date | null;
    }>('SELECT state, lease_owner, attempt, cancel_requested_at FROM jobs WHERE id = $1', [jobId]);
    return rows[0]!;
  }

  /** Fails honestly on timeout: the observed wait MUST be a real lock waiter. */
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
      await sleep(25);
    }
  }

  it('a cancellation committing between the worker liveness read and the tail rejects the real pass: cancelled, nothing published', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const qloo = providers.qloo as FakeQloo;
    const lib = await scopedQueueLibrary(providers);
    const { jobId, discoveryJobId } = await enqueueScoped(lib);

    const park = parkedDb(isoDb, GUARD_PATTERN);
    const worker = new Worker({
      db: isoDb,
      providers,
      config,
      handlers: parkedHandlers(park),
      jobIds: [jobId],
      log: () => undefined,
      workerId: 'w-real',
      heartbeatMs: 60_000,
      leaseMs: 30_000,
    });
    const drained = worker.drain();
    try {
      // The real pass sits inside its publication transaction between its
      // UNLOCKED liveness read (which already returned true) and the guard.
      await park.arrived;

      // The REAL cancellation writer commits in exactly that window.
      expect(await cancelJob(isoDb, jobId)).toBe('running');

      park.release();
      await drained;
    } finally {
      park.release();
      await worker.stop().catch(() => undefined);
      await drained.catch(() => undefined);
    }
    const job = await jobRowOf(jobId);
    expect(job.state).toBe('cancelled');
    expect(await scopedRowsOf(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });
    expect(qloo.calls).toHaveLength(0);
  }, 20_000);

  it('publisher-first: the real cancel and heartbeat queue on the held attempt row and land after the publication commits', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const lib = await scopedQueueLibrary(providers);
    const { jobId, discoveryJobId } = await enqueueScoped(lib);

    const park = parkedDb(isoDb, TAIL_DELETE_PATTERN);
    const worker = new Worker({
      db: isoDb,
      providers,
      config,
      handlers: parkedHandlers(park),
      jobIds: [jobId],
      log: () => undefined,
      workerId: 'w-real',
      heartbeatMs: 60_000,
      leaseMs: 30_000,
    });
    const drained = worker.drain();
    try {
      // The pass is parked AFTER its guard: the live attempt authority was
      // validated under the lock, and the row lock is held through the commit.
      await park.arrived;

      // The real queue writers arrive mid-tail: both must QUEUE on the held
      // row — the pass publishes under exactly the authority it validated.
      const cancelled = cancelJob(isoDb, jobId);
      void cancelled.catch(() => undefined);
      await waitForLockWaiters('%UPDATE jobs SET cancel_requested_at%', 1);
      // The current attempt's heartbeat (the worker claimed attempt 1).
      const heartbeat = heartbeatJob(isoDb, jobId, 'w-real', 1, 30_000);
      void heartbeat.catch(() => undefined);
      await waitForLockWaiters('%UPDATE jobs SET lease_expiry%', 1);

      park.release();
      await drained;

      // The publication committed; the queued writers land after it. The
      // later cancellation never retroactively fails the committed results,
      // and the heartbeat settles as soon as the row lock releases (the tail
      // is bounded by the work window — never a queue heartbeat deadlock).
      expect(await cancelled).toBe('running');
      await heartbeat;
    } finally {
      park.release();
      await worker.stop().catch(() => undefined);
      await drained.catch(() => undefined);
    }
    const job = await jobRowOf(jobId);
    expect(job.state).toBe('complete');
    expect(job.cancel_requested_at).not.toBeNull();
    expect(await scopedRowsOf(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
  }, 20_000);

  it('a real lease transfer supersedes the parked pass; the transferred attempt converges through another real worker', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const lib = await scopedQueueLibrary(providers);
    const { jobId, discoveryJobId } = await enqueueScoped(lib);

    const park = parkedDb(isoDb, GUARD_PATTERN);
    const worker = new Worker({
      db: isoDb,
      providers,
      config,
      handlers: parkedHandlers(park),
      jobIds: [jobId],
      log: () => undefined,
      workerId: 'w-real',
      heartbeatMs: 60_000,
      leaseMs: 30_000,
    });
    const drained = worker.drain();
    try {
      await park.arrived;

      // The lease lapses and the REAL reclaim writer transfers it: the
      // unlocked liveness read could not see this.
      await isoDb.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
      const [reclaimed] = await claimJobs(isoDb, { workerId: 'w2', limit: 1, leaseMs: 30_000, ids: [jobId] });
      expect(reclaimed?.attempt).toBe(2);

      park.release();
      await drained;
    } finally {
      park.release();
      await worker.stop().catch(() => undefined);
      await drained.catch(() => undefined);
    }
    // The superseded pass rejected and its cancelled-cleanup no-ops (the
    // row belongs to the new attempt now): zero published rows, the new
    // attempt's authority exactly as the real writer left it.
    const job = await jobRowOf(jobId);
    expect(job).toMatchObject({ state: 'running', lease_owner: 'w2', attempt: 2 });
    expect(await scopedRowsOf(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });

    // The transferred authority converges: the new attempt's lease lapses
    // and another REAL worker reclaims (attempt 3) and publishes through
    // the guard — with its production heartbeat cadence flowing.
    await isoDb.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const worker2 = new Worker({
      db: isoDb,
      providers,
      config,
      handlers: JOB_HANDLERS,
      jobIds: [jobId],
      log: () => undefined,
      workerId: 'w-real-2',
      heartbeatMs: 1_000,
      leaseMs: 30_000,
    });
    const drained2 = worker2.drain();
    try {
      await drained2;
    } finally {
      await worker2.stop().catch(() => undefined);
      await drained2.catch(() => undefined);
    }
    const jobAfter = await jobRowOf(jobId);
    expect(jobAfter).toMatchObject({ state: 'complete', lease_owner: null, attempt: 3 });
    expect(await scopedRowsOf(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
  }, 20_000);

  it('the control: the real worker publishes scoped results through the guarded tail with live heartbeats', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    const lib = await scopedQueueLibrary(providers);
    const { jobId, discoveryJobId } = await enqueueScoped(lib);

    const worker = new Worker({
      db: isoDb,
      providers,
      config,
      handlers: JOB_HANDLERS,
      jobIds: [jobId],
      log: () => undefined,
      workerId: 'w-real',
      heartbeatMs: 1_000,
      leaseMs: 30_000,
    });
    const drained = worker.drain();
    try {
      await drained;
    } finally {
      await worker.stop().catch(() => undefined);
      await drained.catch(() => undefined);
    }
    const job = await jobRowOf(jobId);
    expect(job).toMatchObject({ state: 'complete', lease_owner: null, attempt: 1 });
    expect(await scopedRowsOf(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
  }, 20_000);

  it('a SAME-worker reclaim supersedes the parked pass: its cancelled-cleanup cannot cancel the successor the same worker then converges', async () => {
    const { providers } = world({ qloo: {}, research: false, composer: false });
    // A real production knob (JOB_MAX_ATTEMPTS) widens the retry budget so
    // the same worker can reclaim twice: the manually transferred attempt 2
    // and the converging attempt 3.
    const fenceConfig = testConfig({
      INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
      INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
      JOB_MAX_ATTEMPTS: '5',
    });
    const lib = await scopedQueueLibrary(providers, fenceConfig);
    const { jobId, discoveryJobId } = await enqueueScoped(lib);

    const park = parkedDb(isoDb, GUARD_PATTERN);
    const worker = new Worker({
      db: isoDb,
      providers,
      config: fenceConfig,
      handlers: parkedHandlers(park),
      jobIds: [jobId],
      log: () => undefined,
      workerId: 'w-real',
      heartbeatMs: 60_000,
      leaseMs: 30_000,
      // The parked old execution occupies the worker's only slot, so the
      // reclaim below is the sole same-worker transfer of the lapsed lease.
      concurrency: 1,
    });
    const drained = worker.drain();
    try {
      await park.arrived;

      // The lease lapses and the SAME worker reclaims its own job at a
      // newer attempt while the old execution is still parked at its guard.
      await isoDb.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
      const [reclaimed] = await claimJobs(isoDb, { workerId: 'w-real', limit: 1, leaseMs: 30_000, ids: [jobId] });
      expect(reclaimed?.attempt).toBe(2);

      park.release();
      await drained;

      // The superseded pass rejected (its pinned attempt is gone); its
      // cancelled-cleanup must NOT have cancelled the successor attempt the
      // same worker now holds, and the old attempt published nothing.
      const superseded = await jobRowOf(jobId);
      expect(superseded).toMatchObject({ state: 'running', lease_owner: 'w-real', attempt: 2 });
      expect(await scopedRowsOf(discoveryJobId)).toEqual({ recs: 0, proofs: 0 });

      // Successor convergence through the SAME real worker: its own loop
      // reclaims the lapsed successor lease at attempt 3 and publishes.
      await isoDb.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
      const converged = worker.drain();
      await converged;
      const jobAfter = await jobRowOf(jobId);
      expect(jobAfter).toMatchObject({ state: 'complete', lease_owner: null, attempt: 3 });
      expect(await scopedRowsOf(discoveryJobId)).toEqual({ recs: 1, proofs: 1 });
      const { rows: discovery } = await isoDb.query<{ status: string }>(
        'SELECT status FROM discovery_jobs WHERE id = $1',
        [discoveryJobId],
      );
      expect(discovery[0]!.status).toBe('complete');
    } finally {
      park.release();
      await worker.stop().catch(() => undefined);
      await drained.catch(() => undefined);
    }
  }, 30_000);
});
