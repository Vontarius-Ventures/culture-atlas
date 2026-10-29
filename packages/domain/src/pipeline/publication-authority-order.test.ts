import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  createProviderRegistry,
  ProviderError,
  type ModelProfile,
  type ProviderRegistry,
  type ResearchExtraction,
  type ResearchSourceDoc,
  type StructuredTransport,
} from '@culture-atlas/providers';
import type { DomainConfig } from '../config';
import type { Db, PoolDb, TransactionOptions } from '../db/pool';
import type { JobType } from '../enums';
import type { JobContext } from '../jobs/handler';
import { claimJobs, enqueueJob, getJobById } from '../jobs/queue';
import { runStageOnce } from '../jobs/stages';
import { JOB_HANDLERS } from '../pipeline';
import { runJob } from '../test-support/library';
import { closeTestDb, getTestDb, insertAccount, testConfig } from '../testing';
import { GRAPH_EXPANSION_DEADLINE_MS } from '../interest-graph/budgets';
import { upsertGraphIdentity } from '../interest-graph/evidence';
import { projectAccountInterestGraph } from '../interest-graph/projector';
import { graphDiscoveryPausedAt, pauseGraphDiscovery, resumeGraphDiscovery } from '../interest-graph/refresh';
import { dispatchGraphResearch } from '../interest-graph/research-gate';
import { bumpTasteRevision } from '../services/taste';

/**
 * Ordered authority publication (DISC-SCR-007/008/011, VAL-DISC-007).
 *
 * Publication is ordered against pause and current account authority through
 * ONE consistent per-account lock, taken by pause/resume and by BOTH
 * publishers (the expansion publication fence and relation research's storage
 * fence) and held through the publishing transaction's commit:
 *
 *  - a pause that commits while a publisher is parked at its fence WINS: the
 *    fence reads it under the lock and the whole publication rolls back;
 *  - a publisher that holds the fence lock commits first: a contending pause
 *    cannot slip between the checks and the commit, and lands AFTER the
 *    publication. The publisher-wins fixtures PROVE that ownership: the
 *    publisher is stalled INSIDE its publication transaction — past its
 *    pause check, at its lease recheck — with the ordering lock really held,
 *    and the pause's own lock wait against that held row is the proof. No
 *    tuple-lock waiter queue is consulted: PostgreSQL's per-tuple lock grant
 *    after a release is a wakeup race, not a FIFO queue, so a fixture that
 *    releases a shared holder and assumes the first-arriving waiter wins can
 *    honestly see the PAUSE win under load (the premise this suite used to
 *    rely on failed 2 of 3 baseline runs at load ~5);
 *  - the lease recheck still gates publication through the new lock, the
 *    rejections roll everything back, and an independent account keeps
 *    publishing (the lock is per-account and never blocks projection,
 *    support removal or cleanup, which are foreign-key key-share workloads).
 *
 * Relation research additionally captures its ORIGINAL input
 * taste/projection/deletion-generation versions at run start, persists them on
 * the run and compares CURRENT versions transactionally before any write —
 * across the held paid extraction AND across redelivery replays of a stored
 * extraction, not just at callback entry (DISC-SCR-011).
 */

const db: PoolDb = getTestDb();
afterAll(closeTestDb);

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });
const projectionOnly = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });
const researchOn = testConfig({ INTEREST_GRAPH_RESEARCH_ENABLED: 'true' });

// --- Shared helpers -----------------------------------------------------------------

/** One queued expansion job for a fresh account (dedupe-keyed logical identity). */
async function queuedExpansion(): Promise<{ accountId: string; jobId: string }> {
  const { accountId } = await insertAccount(db);
  const { job } = await enqueueJob(db, {
    type: 'expand_interest_graph',
    owner: { kind: 'account', accountId },
    payload: { account_id: accountId },
    dedupeKey: `graph_expansion:window:${randomUUID()}`,
    maxAttempts: 3,
    budget: { qloo_requests: 4, deadline_ms: GRAPH_EXPANSION_DEADLINE_MS },
    resultType: 'graph_expansion',
  });
  return { accountId, jobId: job.id };
}

/**
 * Resolves once at least `atLeast` backends are observed WAITING on a lock
 * whose in-flight query matches `pattern` — the park itself is never assumed.
 * Fails honestly on timeout, so a barrier test cannot pass by racing past it.
 */
async function waitForLockWaiters(pattern: string, atLeast: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.query<{ n: number }>(
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
 * transaction instead of issuing its own BEGIN/COMMIT: the real pause runs its
 * exact production statements while the test holds the commit barrier on that
 * connection.
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

/**
 * A Db view over the shared pool that stalls ONE statement of a publisher's
 * OPEN transaction: the lease recheck (`stillOwnsJob`) executed INSIDE the
 * publication transaction — the expansion pass's fence hook or research's
 * storage-pass fence hook, both of which run AFTER the account-authority
 * lock was really taken — is held unsent on a client-side gate, while every
 * pool-level statement (claim, entry checks, completion) passes through.
 * The production handlers and engines are untouched.
 *
 * This is what makes the publisher-wins ordering PROVABLE without any
 * tuple-lock waiter-queue assumption (PostgreSQL's per-tuple lock grant after
 * a release is a wakeup race, not a FIFO queue): the publisher is parked
 * mid-publication while it demonstrably OWNS the ordering lock, so a pause
 * launched then contends against a HELD lock — its real lock wait is the
 * proof of ownership — and can only land after the publisher's commit.
 */
function stalledFenceLeaseDb(gate: Promise<void>, onParked?: () => void): PoolDb {
  const wrap = (handle: Db): Db => {
    const self: Db = {
      inTransaction: handle.inTransaction,
      query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
        if (handle.inTransaction && text.includes('FROM jobs WHERE id = $1 AND lease_owner = $2')) {
          onParked?.();
          return gate.then(() => handle.query<R>(text, params));
        }
        return handle.query<R>(text, params);
      },
      transaction<T>(fn: (tx: Db) => Promise<T>, options?: TransactionOptions): Promise<T> {
        return handle.transaction<T>((tx) => fn(wrap(tx)), options);
      },
    };
    return self;
  };
  const view = wrap(db);
  return Object.assign(view, { pool: db.pool }) as unknown as PoolDb;
}

/** Resolves when `awaitable` does, or fails honestly after `timeoutMs`. */
async function withDeadline(awaitable: Promise<void>, what: string, timeoutMs = 5_000): Promise<void> {
  let timeout!: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${what} within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([awaitable, guard]);
  } finally {
    clearTimeout(timeout);
  }
}

async function expansionRunCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function recommendationCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM recommendations WHERE owner_account_id = $1 AND graph_run_id IS NOT NULL`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function jobRow(jobId: string): Promise<{ state: string; error_code: string | null }> {
  const job = await getJobById(db, jobId);
  return { state: job!.state, error_code: job!.error_code ?? null };
}

/** The account's CURRENT authority versions, read directly (the handler's own capture mirrors this). */
async function authorityVersions(accountId: string): Promise<{ tasteRevision: number; projectionRevision: number; generation: number }> {
  const taste = await db.query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [accountId]);
  const state = await db.query<{ projection_revision: number; deletion_generation: number }>(
    'SELECT projection_revision, deletion_generation FROM personal_graph_state WHERE owner_account_id = $1',
    [accountId],
  );
  return {
    tasteRevision: taste.rows[0]?.revision ?? 0,
    projectionRevision: state.rows[0]?.projection_revision ?? 0,
    generation: state.rows[0]?.deletion_generation ?? 0,
  };
}

/** An effective taste change (a save/remove commits and bumps the revision). */
async function bumpTaste(accountId: string): Promise<void> {
  const { rows } = await db.query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [accountId]);
  if (rows[0]) {
    await db.query('UPDATE taste_profiles SET revision = revision + 1 WHERE owner_account_id = $1', [accountId]);
  } else {
    await db.query('INSERT INTO taste_profiles (owner_account_id, revision) VALUES ($1, 1)', [accountId]);
  }
}

// --- Research fixtures -----------------------------------------------------------------

function sourceDoc(name: string, url: string): ResearchSourceDoc {
  return {
    url,
    title: `${name} — test source`,
    publisher: 'Wikipedia',
    retrieved_at: '2026-10-28T00:00:00.000Z',
    extract: `Test extract about ${name}.`,
  };
}

function extraction(subjectName: string, url: string): ResearchExtraction {
  return {
    overview: `${subjectName} is a test reference.`,
    sections: [{ heading: 'Context', body: `${subjectName} is documented.`, claim_indexes: [1] }],
    claims: [
      { text: `${subjectName} is a test reference.`, claim_type: 'factual', source_urls: [url] },
      { text: `${subjectName} feels influential.`, claim_type: 'interpretive', source_urls: [url] },
      { text: `${subjectName} was founded in 1901.`, claim_type: 'factual', source_urls: [] },
    ],
  };
}

/** A research fake whose paid extraction can be HELD (for mid-call authority races). */
function heldResearch(over: { hold?: boolean } = {}) {
  const calls = { findSources: 0, extractClaims: 0 };
  let releaseHold!: () => void;
  const hold = over.hold
    ? new Promise<void>((resolve) => {
        releaseHold = resolve;
      })
    : Promise.resolve();
  let startedExtraction!: () => void;
  const started = new Promise<void>((resolve) => {
    startedExtraction = resolve;
  });
  const available = { status: 'available' as const, provider: 'fake' };
  const provider = {
    id: 'research:fake',
    capability: () => ({ sources: available, claims: available }),
    findSources: async (query: { name: string }) => {
      calls.findSources++;
      return [sourceDoc(query.name, `https://en.wikipedia.org/wiki/${encodeURIComponent(query.name)}`)];
    },
    extractClaims: async (input: { name: string; sources: ResearchSourceDoc[] }) => {
      calls.extractClaims++;
      startedExtraction();
      await hold;
      return extraction(input.name, input.sources[0]?.url ?? 'https://en.wikipedia.org/wiki/Test');
    },
  };
  return {
    provider: provider as unknown as ProviderRegistry['research'],
    calls,
    started,
    release: () => {
      if (over.hold) releaseHold();
    },
  };
}

/** A research_text profile the gateway accepts (synthetic: never a production route). */
const qualifiedResearchTextProfile: ModelProfile = {
  gateway: 'concentrate',
  role: 'research_text',
  version: 'test-v1',
  model: 'fixture/model-1',
  provider: 'fixture',
  allowedFallbackProviders: [],
  maxOutputTokens: 4000,
  maxInputTokens: 100_000,
  maxInputBytes: 100_000,
  image: { maxBytes: 0, maxPixels: 0, maxCount: 0, maxDimension: 0 },
  timeoutMs: 5_000,
  structuredOutput: true,
  requireZdr: true,
  providerZdrEligible: true,
  contentLoggingEnabled: false,
  privacyVerifiedAt: '2026-10-15T00:00:00Z',
  promptVersion: 'research-p1',
  schemaVersion: 'reference_notes',
  catalogSnapshotAt: '2026-10-15T00:00:00Z',
  qualificationArtifactId: 'synthetic-offline-only',
  pricingSnapshotVersion: 'test-price1',
  reservationMicros: 100,
};

/** The gateway's controlled transport: reaching it in this suite would be a bug. */
const neverTransport: StructuredTransport = async () => {
  throw new ProviderError('model-gateway', 'unavailable', 'the deterministic research override must serve this call');
};

/** The full production-shaped registry: Concentrate gateway with a DURABLE spend ledger. */
function registryWithDurableLedger(research: ProviderRegistry['research']): ProviderRegistry {
  return createProviderRegistry(
    {
      STORAGE_DRIVER: 'memory',
      LLM_PROVIDER: 'concentrate',
      CONCENTRATE_API_KEY: 'test-concentrate-key',
      CONCENTRATE_REQUIRE_ZDR: 'true',
      CONCENTRATE_ALLOW_CONTENT_LOGGING: 'false',
      MODEL_DAILY_SPEND_LIMIT_USD: '10',
      MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD: '2',
      MODEL_MAX_UNKNOWN_SPEND_USD: '0.01',
    },
    { research },
    {
      db,
      profiles: { research_text: qualifiedResearchTextProfile },
      qualification: () => 'qualified',
      transport: neverTransport,
    },
  );
}

async function nodePair(): Promise<{ subjectNodeId: string; objectNodeId: string }> {
  const suffix = randomUUID().slice(0, 6);
  const subject = await upsertGraphIdentity(db, {
    canonicalKey: `atlas:work-${suffix}`,
    canonicalName: `Test Work ${suffix}`,
    nodeKind: 'work',
    domain: 'art',
    senseKey: 'painting',
  });
  const object = await upsertGraphIdentity(db, {
    canonicalKey: `atlas:creator-${suffix}`,
    canonicalName: `Test Creator ${suffix}`,
    nodeKind: 'creator',
    domain: 'art',
    senseKey: 'painter',
  });
  return { subjectNodeId: subject.id, objectNodeId: object.id };
}

async function researchFixture(over: { hold?: boolean } = {}) {
  const { accountId } = await insertAccount(db);
  const { subjectNodeId, objectNodeId } = await nodePair();
  const research = heldResearch(over);
  const providers = registryWithDurableLedger(research.provider);
  return { accountId, subjectNodeId, objectNodeId, providers, research };
}

async function dispatchResearch(input: {
  accountId: string;
  subjectNodeId: string;
  objectNodeId: string;
  providers: ProviderRegistry;
}): Promise<string> {
  const dispatched = await dispatchGraphResearch(db, {
    accountId: input.accountId,
    config: researchOn,
    providers: input.providers,
    subjectNodeId: input.subjectNodeId,
    objectNodeId: input.objectNodeId,
    predicate: 'CREATED_BY',
  });
  if (!dispatched.jobId) throw new Error('research did not dispatch');
  return dispatched.jobId;
}

async function proposedAssertionCount(subjectNodeId: string, objectNodeId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM graph_assertions
      WHERE subject_node_id = $1 AND object_node_id = $2 AND predicate = 'CREATED_BY' AND status = 'proposed'`,
    [subjectNodeId, objectNodeId],
  );
  return Number(rows[0]!.n);
}

async function researchRunRows(
  accountId: string,
): Promise<Array<{ state: string; input_taste_revision: number | null; input_projection_revision: number | null; input_generation: number | null }>> {
  const { rows } = await db.query<{
    state: string;
    input_taste_revision: number | null;
    input_projection_revision: number | null;
    input_generation: number | null;
  }>(
    `SELECT state, input_taste_revision, input_projection_revision, input_generation
       FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'research' ORDER BY created_at`,
    [accountId],
  );
  return rows;
}

async function extractQueryCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM provider_queries
      WHERE owner_account_id = $1 AND provider = 'research' AND operation = 'extract_claims'`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

// --- The consistent account lock orders pause against both publishers -----------------

describe('ordered authority publication: pause vs the expansion publisher', () => {
  it('a pause committed while the expansion pass is parked at its fence wins: the whole pass rolls back', async () => {
    const { accountId, jobId } = await queuedExpansion();
    const holder = await db.pool.connect();
    let holderOpen = true;
    let run: Promise<{ state: string }> | undefined;
    try {
      await holder.query('BEGIN');
      // The REAL pause, held uncommitted inside the caller's open transaction:
      // it takes the same per-account authority lock the publisher's fence
      // takes, writes the refresh row, and holds both through the barrier.
      const paused = await pauseGraphDiscovery(openTransactionDb(holder), accountId);
      expect(paused.paused).toBe(true);
      // Uncommitted: the publisher's READ COMMITTED checks must not see it.
      expect(await graphDiscoveryPausedAt(db, accountId)).toBeNull();

      run = runJob(jobId, { config: graphOn });
      void run.catch(() => undefined);
      // The pass walks (its foreign-key key-share inserts never conflict with
      // the held lock) and parks AT ITS FENCE, contending on the same lock.
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);

      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // The pause committed first: the fence reads it under the lock and
    // rejects, the transaction rolls back, and the handler completes honestly.
    const outcome = await run!;
    expect(outcome.state).toBe('complete');
    expect(await graphDiscoveryPausedAt(db, accountId)).toBeInstanceOf(Date);
    expect(await expansionRunCount(accountId)).toBe(0);
    expect(await recommendationCount(accountId)).toBe(0);
  });

  it('an expansion pass holding its fence lock commits first: a contending pause cannot slip in and lands after publication', async () => {
    const { accountId, jobId } = await queuedExpansion();

    // Two contending connections: the publisher and the pause. The publisher
    // is stalled INSIDE its publication transaction — past its pause check,
    // at its lease recheck — with the account-authority lock REALLY taken.
    // No holder releases a shared row and no waiter-queue order is assumed.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked!: () => void;
    const parkedAtLeaseRecheck = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const stalled = stalledFenceLeaseDb(gate, parked);
    let run: Promise<{ state: string }> | undefined;
    let pause: Promise<{ paused: boolean }> | undefined;
    try {
      run = runJob(jobId, { config: graphOn, db: stalled });
      void run.catch(() => undefined);
      await withDeadline(parkedAtLeaseRecheck, 'the expansion pass never reached its fence lease recheck');
      // The pass holds the ordering lock now. A pause arriving between its
      // pause check and its commit must queue for the publication commit.
      pause = pauseGraphDiscovery(db, accountId);
      void pause.catch(() => undefined);
      // The pause's real wait on the account-authority row is the PROOF the
      // publisher owns the lock — it is the only backend that can hold it.
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);
      // And while the publisher holds the ordering, the pause cannot commit.
      expect(await graphDiscoveryPausedAt(db, accountId)).toBeNull();

      release();
    } finally {
      release();
    }

    // The publisher wins the ordering: its publication commits first...
    const outcome = await run!;
    expect(outcome.state).toBe('complete');
    expect(await expansionRunCount(accountId)).toBe(1);
    // ...and only then does the pause land (decided by the held lock, never
    // by a wakeup race between released waiters).
    const paused = await pause!;
    expect(paused.paused).toBe(true);
    expect(await graphDiscoveryPausedAt(db, accountId)).toBeInstanceOf(Date);
  });

  it('the lease recheck still gates publication through the new lock: a lost lease cancels with zero publication', async () => {
    const { accountId, jobId } = await queuedExpansion();
    const holder = await db.pool.connect();
    let holderOpen = true;
    let run: Promise<{ state: string }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [accountId]);

      run = runJob(jobId, { config: graphOn });
      void run.catch(() => undefined);
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);

      // The lease is lost while the pass is parked at its fence.
      await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);

      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // The lease recheck rejected the publication through the new lock: the
    // pass rolled back and the job stopped without publishing.
    const outcome = await run!;
    expect(outcome.state).toBe('cancelled');
    expect((await jobRow(jobId)).state).toBe('cancelled');
    expect(await expansionRunCount(accountId)).toBe(0);
    expect(await recommendationCount(accountId)).toBe(0);
  });

  it('independent accounts keep progressing while one expansion is parked at its fence', async () => {
    const a = await queuedExpansion();
    const b = await queuedExpansion();
    const holder = await db.pool.connect();
    let holderOpen = true;
    let runA: Promise<{ state: string }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [a.accountId]);

      runA = runJob(a.jobId, { config: graphOn });
      void runA.catch(() => undefined);
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);

      // Account B publishes, pauses and resumes freely: the ordering lock is
      // per-account and never blocks another account's work.
      const outcomeB = await runJob(b.jobId, { config: graphOn });
      expect(outcomeB.state).toBe('complete');
      expect(await expansionRunCount(b.accountId)).toBe(1);
      await pauseGraphDiscovery(db, b.accountId);
      expect(await graphDiscoveryPausedAt(db, b.accountId)).toBeInstanceOf(Date);
      await resumeGraphDiscovery(db, b.accountId);
      expect(await graphDiscoveryPausedAt(db, b.accountId)).toBeNull();

      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    const outcomeA = await runA!;
    expect(outcomeA.state).toBe('complete');
    expect(await expansionRunCount(a.accountId)).toBe(1);
  });
});

describe('ordered authority publication: pause vs the research publisher', () => {
  it('a pause committed while research is parked at its storage fence wins: the paid call stays accounted, nothing publishes', async () => {
    const fixture = await researchFixture();
    const jobId = await dispatchResearch(fixture);

    const holder = await db.pool.connect();
    let holderOpen = true;
    let run: Promise<{ state: string }> | undefined;
    try {
      await holder.query('BEGIN');
      const paused = await pauseGraphDiscovery(openTransactionDb(holder), fixture.accountId);
      expect(paused.paused).toBe(true);
      expect(await graphDiscoveryPausedAt(db, fixture.accountId)).toBeNull();

      run = runJob(jobId, { providers: fixture.providers, config: researchOn });
      void run.catch(() => undefined);
      // The handler's entry gate sees no committed pause; the storage fence is
      // where the contention is decided.
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);

      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    await expect(run!).rejects.toThrow('Discovery is paused; research cannot publish.');
    expect((await jobRow(jobId)).state).toBe('failed');
    // The paid call happened once and stays accounted; nothing published.
    expect(fixture.research.calls.extractClaims).toBe(1);
    expect(await extractQueryCount(fixture.accountId)).toBe(1);
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(0);
    expect((await researchRunRows(fixture.accountId)).map((r) => r.state)).toEqual(['failed']);
  });

  it('research holding its fence lock commits first: a contending pause lands after the proposals', async () => {
    const fixture = await researchFixture();
    const jobId = await dispatchResearch(fixture);

    // Two contending connections: the publisher and the pause. The storage
    // pass is stalled INSIDE its publication transaction — past its pause
    // check, at its lease recheck — with the account-authority lock REALLY
    // taken. No holder releases a shared row and no waiter-queue order is
    // assumed.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked!: () => void;
    const parkedAtLeaseRecheck = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const stalled = stalledFenceLeaseDb(gate, parked);
    let run: Promise<{ state: string }> | undefined;
    let pause: Promise<{ paused: boolean }> | undefined;
    try {
      run = runJob(jobId, { providers: fixture.providers, config: researchOn, db: stalled });
      void run.catch(() => undefined);
      await withDeadline(parkedAtLeaseRecheck, 'the research storage pass never reached its fence lease recheck');
      // The storage pass holds the ordering lock now, PAST its pause check:
      // a pause arriving here must queue for the publication commit.
      pause = pauseGraphDiscovery(db, fixture.accountId);
      void pause.catch(() => undefined);
      // The pause's real wait on the account-authority row is the PROOF the
      // publisher owns the lock — it is the only backend that can hold it.
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);
      // And while the publisher holds the ordering, the pause cannot commit.
      expect(await graphDiscoveryPausedAt(db, fixture.accountId)).toBeNull();

      release();
    } finally {
      release();
    }

    // The publisher wins the ordering: proposals commit first, then the pause.
    const outcome = await run!;
    expect(outcome.state).toBe('complete');
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(1);
    const paused = await pause!;
    expect(paused.paused).toBe(true);
    expect(await graphDiscoveryPausedAt(db, fixture.accountId)).toBeInstanceOf(Date);
  });

  it('the lease recheck still gates research publication through the new lock: a lost lease cancels, spend stays accounted', async () => {
    const fixture = await researchFixture();
    const jobId = await dispatchResearch(fixture);

    const holder = await db.pool.connect();
    let holderOpen = true;
    let run: Promise<{ state: string }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [fixture.accountId]);

      run = runJob(jobId, { providers: fixture.providers, config: researchOn });
      void run.catch(() => undefined);
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);

      await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);

      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    const outcome = await run!;
    expect(outcome.state).toBe('cancelled');
    expect((await jobRow(jobId)).state).toBe('cancelled');
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(0);
    expect(await extractQueryCount(fixture.accountId)).toBe(1);
  });

  it('independent accounts keep progressing while one research job is parked at its fence', async () => {
    const a = await researchFixture();
    const b = await researchFixture();
    const jobIdA = await dispatchResearch(a);
    const jobIdB = await dispatchResearch(b);

    const holder = await db.pool.connect();
    let holderOpen = true;
    let runA: Promise<{ state: string }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [a.accountId]);

      runA = runJob(jobIdA, { providers: a.providers, config: researchOn });
      void runA.catch(() => undefined);
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);

      const outcomeB = await runJob(jobIdB, { providers: b.providers, config: researchOn });
      expect(outcomeB.state).toBe('complete');
      expect(await proposedAssertionCount(b.subjectNodeId, b.objectNodeId)).toBe(1);

      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    const outcomeA = await runA!;
    expect(outcomeA.state).toBe('complete');
    expect(await proposedAssertionCount(a.subjectNodeId, a.objectNodeId)).toBe(1);
  });
});

// --- DISC-SCR-011: research authority versions across extraction and replay -------------

describe('relation research publishes only under its original input authority', () => {
  it('a held extraction followed by a taste change cannot publish: the paid call stays accounted', async () => {
    const fixture = await researchFixture({ hold: true });
    const jobId = await dispatchResearch(fixture);
    const before = await authorityVersions(fixture.accountId);

    const run = runJob(jobId, { providers: fixture.providers, config: researchOn });
    void run.catch(() => undefined);
    // The paid extraction is in flight (the input versions are captured).
    await fixture.research.started;
    // An explicit save/remove commits while the call is held.
    await bumpTaste(fixture.accountId);
    fixture.research.release();

    await expect(run).rejects.toMatchObject({ details: { rule: 'stale_authority' } });
    expect((await jobRow(jobId)).state).toBe('failed');
    expect(fixture.research.calls.extractClaims).toBe(1);
    expect(await extractQueryCount(fixture.accountId)).toBe(1);
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(0);
    // The run persists the ORIGINAL (pre-change) input versions it captured.
    const runs = await researchRunRows(fixture.accountId);
    expect(runs.map((r) => r.state)).toEqual(['failed']);
    expect(runs[0]!.input_taste_revision).toBe(before.tasteRevision);
  });

  it('a held extraction followed by a projection or deletion-generation advance cannot publish', async () => {
    // Projection: the real projector pass for the account commits mid-call.
    const projectionCase = await researchFixture({ hold: true });
    const projectionJob = await dispatchResearch(projectionCase);
    let run = runJob(projectionJob, { providers: projectionCase.providers, config: researchOn });
    void run.catch(() => undefined);
    await projectionCase.research.started;
    await projectAccountInterestGraph(db, {
      accountId: projectionCase.accountId,
      config: projectionOnly,
      source: 'mutation_intent',
    });
    projectionCase.research.release();
    await expect(run).rejects.toMatchObject({ details: { rule: 'stale_authority' } });
    expect(await proposedAssertionCount(projectionCase.subjectNodeId, projectionCase.objectNodeId)).toBe(0);

    // Deletion generation: an advanced generation (the deletion fence's
    // version) commits mid-call. The account is projected first so the state
    // row exists for the generation to advance on.
    const deletionCase = await researchFixture({ hold: true });
    await projectAccountInterestGraph(db, {
      accountId: deletionCase.accountId,
      config: projectionOnly,
      source: 'mutation_intent',
    });
    const deletionJob = await dispatchResearch(deletionCase);
    run = runJob(deletionJob, { providers: deletionCase.providers, config: researchOn });
    void run.catch(() => undefined);
    await deletionCase.research.started;
    await db.query(
      `UPDATE personal_graph_state SET deletion_generation = deletion_generation + 1 WHERE owner_account_id = $1`,
      [deletionCase.accountId],
    );
    deletionCase.research.release();
    await expect(run).rejects.toMatchObject({ details: { rule: 'stale_authority' } });
    expect(await proposedAssertionCount(deletionCase.subjectNodeId, deletionCase.objectNodeId)).toBe(0);
  });

  it('unchanged original authority publishes: the run records the captured input versions', async () => {
    const fixture = await researchFixture({ hold: true });
    const jobId = await dispatchResearch(fixture);
    const before = await authorityVersions(fixture.accountId);

    const run = runJob(jobId, { providers: fixture.providers, config: researchOn });
    void run.catch(() => undefined);
    await fixture.research.started;
    // No authority change during the held call.
    fixture.research.release();

    const outcome = await run;
    expect(outcome.state).toBe('complete');
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(1);
    const runs = await researchRunRows(fixture.accountId);
    expect(runs.map((r) => r.state)).toEqual(['complete']);
    expect(runs[0]!.input_taste_revision).toBe(before.tasteRevision);
    expect(runs[0]!.input_projection_revision).toBe(before.projectionRevision);
    expect(runs[0]!.input_generation).toBe(before.generation);
  });

  /**
   * Runs the handler like apps/worker, but the "worker" dies right after the
   * paid extraction completes: no completion, no failure bookkeeping — the job
   * stays 'running' with its lease while the durable stage output and the run
   * row (with its captured input versions) persist.
   */
  async function runJobCrashingAfterExtraction(jobId: string, providers: ProviderRegistry, config: DomainConfig): Promise<void> {
    const workerId = `crash-${randomUUID()}`;
    const [job] = await claimJobs(db, { workerId, limit: 1, leaseMs: 60_000, ids: [jobId] });
    if (!job) throw new Error('research job not claimable');
    const controller = new AbortController();
    let ensureCalls = 0;
    const ctx: JobContext = {
      job,
      payload: job.payload,
      attempt: job.attempt,
      workerId,
      db,
      providers,
      config,
      signal: controller.signal,
      budget: { qlooRequests: 0, researchRefs: 0, providerRetries: 0, deadlineMs: 60_000 },
      setStage: async () => undefined,
      runStage: (stage, fn) => runStageOnce(db, { jobId: job.id, stage, attempt: job.attempt }, fn),
      ensureActive: async () => {
        ensureCalls++;
        // The handler's second ensureActive runs after the extraction stage:
        // the worker dies here, mid-flight, with no job bookkeeping.
        if (ensureCalls === 2) throw new Error('simulated worker crash after extraction');
      },
      trace: async () => undefined,
      log: () => undefined,
    };
    const handler = JOB_HANDLERS[job.type as JobType] as (c: JobContext) => Promise<unknown>;
    try {
      await handler(ctx);
      throw new Error('the crash injection never fired');
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'simulated worker crash after extraction') throw err;
    }
  }

  it('a replayed extraction keeps its ORIGINAL input versions: a redelivery after an authority change cannot publish', async () => {
    const fixture = await researchFixture();
    const jobId = await dispatchResearch(fixture);
    const before = await authorityVersions(fixture.accountId);

    // Attempt 1 runs the paid extraction, then the worker dies.
    await runJobCrashingAfterExtraction(jobId, fixture.providers, researchOn);
    expect(fixture.research.calls.extractClaims).toBe(1);
    // While the job sat dead, the account's authority moved.
    await bumpTaste(fixture.accountId);

    // The redelivery claims the expired lease and replays the stored
    // extraction; it must still compare against the ORIGINAL versions.
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
    await expect(runJob(jobId, { providers: fixture.providers, config: researchOn })).rejects.toMatchObject({
      details: { rule: 'stale_authority' },
    });

    // The replay reused the paid extraction (no re-buy) and the ORIGINAL
    // input versions — not fresh ones read at callback entry.
    expect(fixture.research.calls.extractClaims).toBe(1);
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(0);
    // One run row per job (job_id is unique): the redelivered attempt reused
    // it, and the row still carries the ORIGINAL pre-change input versions.
    const runs = await researchRunRows(fixture.accountId);
    expect(runs.map((r) => r.state)).toEqual(['failed']);
    expect(runs[0]!.input_taste_revision).toBe(before.tasteRevision);
  });

  it('a replayed extraction with unchanged original authority publishes without re-buying the paid call', async () => {
    const fixture = await researchFixture();
    const jobId = await dispatchResearch(fixture);
    const before = await authorityVersions(fixture.accountId);

    await runJobCrashingAfterExtraction(jobId, fixture.providers, researchOn);
    expect(fixture.research.calls.extractClaims).toBe(1);
    // No authority change while the job sat dead.
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const outcome = await runJob(jobId, { providers: fixture.providers, config: researchOn });
    expect(outcome.state).toBe('complete');

    // The stored extraction was reused (one paid call total), and the
    // redelivered attempt published under the same ORIGINAL versions.
    expect(fixture.research.calls.extractClaims).toBe(1);
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(1);
    // One run row per job, reused by the redelivered attempt: it completed
    // while still carrying the ORIGINAL input versions.
    const runs = await researchRunRows(fixture.accountId);
    expect(runs.map((r) => r.state)).toEqual(['complete']);
    expect(runs[0]!.input_taste_revision).toBe(before.tasteRevision);
  });
});

// --- DISC-SCR-021: the version comparison is ordered with its actual writers ------

describe('research authority versions are ordered with their actual writers through the storage commit (DISC-SCR-021)', () => {
  /**
   * Parks the research storage pass INSIDE its publication transaction, past
   * its original-version comparison, at its lease recheck — the exact drift
   * window scrutiny flagged: a writer arriving here has already passed the
   * old unlocked comparison, and pre-repair it could commit before the
   * storage commit, leaving stale extraction proposals published.
   */
  async function parkedResearchJob(
    fixture: { providers: ProviderRegistry },
    jobId: string,
  ): Promise<{ run: Promise<{ state: string }>; release: () => void }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked!: () => void;
    const parkedAtLeaseRecheck = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const stalled = stalledFenceLeaseDb(gate, parked);
    const run = runJob(jobId, { providers: fixture.providers, config: researchOn, db: stalled });
    void run.catch(() => undefined);
    await withDeadline(parkedAtLeaseRecheck, 'the research storage pass never reached its fence lease recheck');
    return { run, release };
  }

  /** Whether the account's projection state row / taste profile row exist yet. */
  async function authorityRowPresence(accountId: string): Promise<{ state: boolean; taste: boolean }> {
    const state = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM personal_graph_state WHERE owner_account_id = $1',
      [accountId],
    );
    const taste = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM taste_profiles WHERE owner_account_id = $1',
      [accountId],
    );
    return { state: Number(state.rows[0]!.n) > 0, taste: Number(taste.rows[0]!.n) > 0 };
  }

  it('a save arriving after the comparison cannot overtake it: the publication commits first, the save lands after', async () => {
    const fixture = await researchFixture();
    const jobId = await dispatchResearch(fixture);
    const before = await authorityVersions(fixture.accountId);

    const { run, release } = await parkedResearchJob(fixture, jobId);
    // The ordinary taste writer — the bump every save/remove/hide performs —
    // arrives in the drift window, AFTER the comparison already ran. It must
    // queue for the storage commit instead of committing first.
    const bump = bumpTasteRevision(db, { kind: 'account', accountId: fixture.accountId });
    void bump.catch(() => undefined);
    try {
      await waitForLockWaiters('%ON CONFLICT (owner_account_id) DO UPDATE%', 1);
      // PROOF of held authority: while the storage pass is parked past its
      // comparison, the save has NOT committed — the committed revision is
      // still the original one, whether or not the row existed before.
      expect((await authorityVersions(fixture.accountId)).tasteRevision).toBe(before.tasteRevision);
    } finally {
      release();
    }
    // The publication committed under the ORIGINAL versions it compared...
    const outcome = await run;
    expect(outcome.state).toBe('complete');
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(1);
    const runs = await researchRunRows(fixture.accountId);
    expect(runs.map((r) => r.state)).toEqual(['complete']);
    expect(runs[0]!.input_taste_revision).toBe(before.tasteRevision);
    // ...and only then did the save land.
    expect(await bump).toBe(before.tasteRevision + 1);
    expect((await authorityVersions(fixture.accountId)).tasteRevision).toBe(before.tasteRevision + 1);
    // The save stayed a pure authority bump: no projection run appeared.
    const { rows: projectionRuns } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'projection'`,
      [fixture.accountId],
    );
    expect(Number(projectionRuns[0]!.n)).toBe(0);
  });

  it('a projection pass arriving after the comparison cannot overtake it: publication first, projection after', async () => {
    const fixture = await researchFixture();
    // The account is projected BEFORE research dispatch, so the state row
    // exists and the comparison's projection half is a real locked read.
    const first = await projectAccountInterestGraph(db, {
      accountId: fixture.accountId,
      config: projectionOnly,
      source: 'mutation_intent',
    });
    expect(first.projected).toBe(true);
    const jobId = await dispatchResearch(fixture);
    const before = await authorityVersions(fixture.accountId);
    expect(before.projectionRevision).toBe(1);

    const { run, release } = await parkedResearchJob(fixture, jobId);
    // The REAL projector pass arrives in the drift window, after the
    // comparison: it must queue for the storage commit. Its pass takes the
    // per-account publication-authority lock first — the same accounts row
    // the parked publication holds — so that real lock wait is the park.
    const projection = projectAccountInterestGraph(db, {
      accountId: fixture.accountId,
      config: projectionOnly,
      source: 'mutation_intent',
    });
    void projection.catch(() => undefined);
    try {
      await waitForLockWaiters('%accounts WHERE id = $1 FOR NO KEY UPDATE%', 1);
      // PROOF of held authority: the newer projection has not committed while
      // the publication is parked.
      expect((await authorityVersions(fixture.accountId)).projectionRevision).toBe(before.projectionRevision);
    } finally {
      release();
    }
    // The publication committed under the ORIGINAL projection version...
    const outcome = await run;
    expect(outcome.state).toBe('complete');
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(1);
    const runs = await researchRunRows(fixture.accountId);
    expect(runs[0]!.input_projection_revision).toBe(before.projectionRevision);
    // ...and only then did the projection land.
    const second = await projection;
    expect(second.projected).toBe(true);
    expect(second.projectionRevision).toBe(before.projectionRevision + 1);
    expect((await authorityVersions(fixture.accountId)).projectionRevision).toBe(before.projectionRevision + 1);
  });

  it('a save holding the taste authority blocks the comparison; on its commit, research rejects stale proposals while the paid extraction stays accounted', async () => {
    const fixture = await researchFixture();
    const jobId = await dispatchResearch(fixture);
    const before = await authorityVersions(fixture.accountId);

    // The REAL taste writer runs inside the holder's open transaction: the
    // revision bump is uncommitted while research's storage fence reads the
    // current versions.
    const holder = await db.pool.connect();
    let holderOpen = true;
    let run: Promise<{ state: string }> | undefined;
    try {
      await holder.query('BEGIN');
      const bumped = await bumpTasteRevision(openTransactionDb(holder), { kind: 'account', accountId: fixture.accountId });
      expect(bumped).toBe(before.tasteRevision + 1);

      run = runJob(jobId, { providers: fixture.providers, config: researchOn });
      void run.catch(() => undefined);
      // Writer-first: the fence's guarded version read queues behind the
      // writer's authority row.
      await waitForLockWaiters('%taste_profiles%', 1);
      // The paid call already happened and is durably accounted while the
      // fence waits for the authority row.
      expect(fixture.research.calls.extractClaims).toBe(1);
      expect(await extractQueryCount(fixture.accountId)).toBe(1);
      // Committed taste authority is still the ORIGINAL one.
      expect((await authorityVersions(fixture.accountId)).tasteRevision).toBe(before.tasteRevision);

      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // The writer's newer authority is what the comparison now sees, so the
    // stale proposals are rejected; the spend stays accounted.
    await expect(run!).rejects.toMatchObject({ details: { rule: 'stale_authority' } });
    expect((await jobRow(jobId)).state).toBe('failed');
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(0);
    expect(await extractQueryCount(fixture.accountId)).toBe(1);
    const runs = await researchRunRows(fixture.accountId);
    expect(runs.map((r) => r.state)).toEqual(['failed']);
    expect(runs[0]!.input_taste_revision).toBe(before.tasteRevision);
  });

  it('a projector pass holding the projection authority blocks the comparison; on its commit, research rejects stale proposals', async () => {
    const fixture = await researchFixture();
    const first = await projectAccountInterestGraph(db, {
      accountId: fixture.accountId,
      config: projectionOnly,
      source: 'mutation_intent',
    });
    expect(first.projected).toBe(true);
    const jobId = await dispatchResearch(fixture);
    const before = await authorityVersions(fixture.accountId);
    expect(before.projectionRevision).toBe(1);

    // The REAL projector pass for a SECOND projection runs inside the
    // holder's open transaction: it holds the state row lock with its
    // revision bump uncommitted while research's storage fence reads.
    const holder = await db.pool.connect();
    let holderOpen = true;
    let run: Promise<{ state: string }> | undefined;
    try {
      await holder.query('BEGIN');
      const second = await projectAccountInterestGraph(openTransactionDb(holder), {
        accountId: fixture.accountId,
        config: projectionOnly,
        source: 'mutation_intent',
      });
      expect(second.projected).toBe(true);
      expect(second.projectionRevision).toBe(before.projectionRevision + 1);

      run = runJob(jobId, { providers: fixture.providers, config: researchOn });
      void run.catch(() => undefined);
      // Writer-first: the storage fence's FIRST ordered statement — the
      // per-account publication-authority lock — queues behind the writer's
      // held account row, so the fence cannot even reach its comparison
      // until the projector commits.
      await waitForLockWaiters('%accounts WHERE id = $1 FOR NO KEY UPDATE%', 1);
      expect(fixture.research.calls.extractClaims).toBe(1);
      expect(await extractQueryCount(fixture.accountId)).toBe(1);
      // Committed projection authority is still the ORIGINAL one.
      expect((await authorityVersions(fixture.accountId)).projectionRevision).toBe(before.projectionRevision);

      await holder.query('COMMIT');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    await expect(run!).rejects.toMatchObject({ details: { rule: 'stale_authority' } });
    expect((await jobRow(jobId)).state).toBe('failed');
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(0);
    expect(await extractQueryCount(fixture.accountId)).toBe(1);
    const runs = await researchRunRows(fixture.accountId);
    expect(runs[0]!.input_projection_revision).toBe(before.projectionRevision);
  });

  it('absent authority rows are guarded too: the FIRST save and the FIRST projection both queue behind a parked publication', async () => {
    const fixture = await researchFixture();
    const jobId = await dispatchResearch(fixture);
    const before = await authorityVersions(fixture.accountId);
    // The account has neither an authority row yet: no taste profile, no
    // projection state. Without the absent-row guard, both first-ever
    // writers would commit between the comparison and the storage commit —
    // an unlocked read of a missing row holds nothing.
    expect(await authorityRowPresence(fixture.accountId)).toEqual({ state: false, taste: false });
    expect(before.tasteRevision).toBe(0);
    expect(before.projectionRevision).toBe(0);

    const { run, release } = await parkedResearchJob(fixture, jobId);
    const bump = bumpTasteRevision(db, { kind: 'account', accountId: fixture.accountId });
    void bump.catch(() => undefined);
    const projection = projectAccountInterestGraph(db, {
      accountId: fixture.accountId,
      config: projectionOnly,
      source: 'mutation_intent',
    });
    void projection.catch(() => undefined);
    try {
      // Both first-ever writers queue behind the publication: the first save
      // on the guarded taste row, the first projection on the account-row
      // publication lock its pass takes first.
      await waitForLockWaiters('%ON CONFLICT (owner_account_id) DO UPDATE%', 1);
      await waitForLockWaiters('%accounts WHERE id = $1 FOR NO KEY UPDATE%', 1);
      expect((await authorityVersions(fixture.accountId)).tasteRevision).toBe(0);
      expect((await authorityVersions(fixture.accountId)).projectionRevision).toBe(0);
    } finally {
      release();
    }
    // The publication committed under the ORIGINAL (absent-row) versions...
    const outcome = await run;
    expect(outcome.state).toBe('complete');
    expect(await proposedAssertionCount(fixture.subjectNodeId, fixture.objectNodeId)).toBe(1);
    const runs = await researchRunRows(fixture.accountId);
    expect(runs[0]!.input_taste_revision).toBe(0);
    expect(runs[0]!.input_projection_revision).toBe(0);
    expect(runs[0]!.input_generation).toBe(0);
    // ...and only then did both first-ever writers land.
    expect(await bump).toBe(1);
    const projected = await projection;
    expect(projected.projected).toBe(true);
    expect(projected.projectionRevision).toBe(1);
  });

  it('an independent account keeps saving and projecting while one research publication is parked past its comparison', async () => {
    const a = await researchFixture();
    const b = await researchFixture();
    const jobIdA = await dispatchResearch(a);
    const { run, release } = await parkedResearchJob(a, jobIdA);
    const beforeB = await authorityVersions(b.accountId);
    try {
      // Account B's own writers never touch account A's guarded rows: both
      // complete while A's publication is still parked.
      expect(await bumpTasteRevision(db, { kind: 'account', accountId: b.accountId })).toBe(beforeB.tasteRevision + 1);
      const projected = await projectAccountInterestGraph(db, {
        accountId: b.accountId,
        config: projectionOnly,
        source: 'mutation_intent',
      });
      expect(projected.projected).toBe(true);
    } finally {
      release();
    }
    const outcome = await run;
    expect(outcome.state).toBe('complete');
    expect(await proposedAssertionCount(a.subjectNodeId, a.objectNodeId)).toBe(1);
  });
});
