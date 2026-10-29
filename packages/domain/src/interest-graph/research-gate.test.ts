import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import {
  createProviderRegistry,
  ProviderError,
  type ModelProfile,
  type ProviderRegistry,
  type ResearchExtraction,
  type ResearchSourceDoc,
  type StructuredTransport,
} from '@culture-atlas/providers';
import type { Db, PoolDb, TransactionOptions } from '../db/pool';
import { accountCtx, runJob } from '../test-support/library';
import { closeTestDb, getTestDb, insertAccount, testConfig, testProviders } from '../testing';
import { upsertGraphIdentity } from './evidence';
import { pauseGraphDiscovery } from './refresh';
import {
  dispatchGraphResearch,
  researchDispatchGate,
  researchEnabledInConfig,
} from './research-gate';
import { RESEARCH_MAX_SOURCE_DOCUMENTS } from './research';
import { ensureGraphWorkBudget, loadGraphWorkBudget } from './budgets';

/**
 * VAL-DISC-005: paid relation research is DEFAULT-OFF and stays off until the
 * operator opt-in, no kill, no pause, an ACTUALLY QUALIFIED effective claims
 * adapter (a dispatching research_text runner, never a demo-observed role)
 * AND durable account/global spend limits all hold — and it never passively
 * confirms anything: proposals are unreviewed `proposed` assertions whose
 * evidence is machine-extraction, never confirmation of feed/photo/background
 * outputs. The handler re-checks the same gate at run time, so a gate that
 * closes between dispatch and run refuses without spending.
 *
 * The deterministic research adapters here are explicit registry overrides
 * (fault-test adapters, never live); the gate still requires the deployment's
 * genuinely qualified research_text role and durable ledger, which these
 * fixtures construct through the real gateway with a controlled transport.
 */

const db = getTestDb();
afterAll(closeTestDb);

const researchOn = testConfig({ INTEREST_GRAPH_RESEARCH_ENABLED: 'true' });
const researchOff = testConfig();
const researchKilled = testConfig({
  INTEREST_GRAPH_RESEARCH_ENABLED: 'true',
  FEATURE_KILL_SWITCHES: 'interest_graph_research_enabled',
});

// --- Fixture helpers -----------------------------------------------------------------

function sourceDoc(name: string, url: string): ResearchSourceDoc {
  return {
    url,
    title: `${name} — test source`,
    publisher: 'Wikipedia',
    retrieved_at: '2026-10-28T00:00:00.000Z',
    extract: `Test extract about ${name}.`,
  };
}

/** Claims for one extraction: one factual-cited, one interpretive, one uncited factual. */
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

/** A counting research fake: call counts prove paid calls happened or not. */
function countingResearch(
  sources: (name: string) => ResearchSourceDoc[],
  extract: (name: string, url: string) => ResearchExtraction,
) {
  const calls = { findSources: 0, extractClaims: 0 };
  const available = { status: 'available' as const, provider: 'fake' };
  const provider = {
    id: 'research:fake',
    capability: () => ({ sources: available, claims: available }),
    findSources: async (query: { name: string }) => {
      calls.findSources++;
      return sources(query.name);
    },
    extractClaims: async (input: { name: string; sources: ResearchSourceDoc[] }) => {
      calls.extractClaims++;
      return extract(input.name, input.sources[0]?.url ?? 'https://en.wikipedia.org/wiki/Test');
    },
  };
  return { provider: provider as unknown as ProviderRegistry['research'], calls };
}

function unqualifiedResearch(): ProviderRegistry['research'] {
  const unavailable = { status: 'unavailable' as const, provider: 'test' };
  return {
    id: 'research:test',
    capability: () => ({ sources: unavailable, claims: unavailable }),
    findSources: async () => [],
    extractClaims: async () => {
      throw new Error('unqualified');
    },
  } as unknown as ProviderRegistry['research'];
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
      db: getTestDb(),
      profiles: { research_text: qualifiedResearchTextProfile },
      qualification: () => 'qualified',
      // The deterministic research override serves the claims calls; the
      // gateway transport must never be reached in this suite.
      transport: neverTransport,
    },
  );
}

/** The durable-ledger registry without spend limits: the ledger must not exist. */
function registryWithoutLimits(research: ProviderRegistry['research']): ProviderRegistry {
  return createProviderRegistry(
    {
      STORAGE_DRIVER: 'memory',
      LLM_PROVIDER: 'concentrate',
      CONCENTRATE_API_KEY: 'test-concentrate-key',
      CONCENTRATE_REQUIRE_ZDR: 'true',
      CONCENTRATE_ALLOW_CONTENT_LOGGING: 'false',
    },
    { research },
    { db: getTestDb() },
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

async function jobsOfKind(
  accountId: string,
  type: string,
): Promise<{ id: string; state: string; dedupe_key: string | null }[]> {
  const { rows } = await db.query<{ id: string; state: string; dedupe_key: string | null }>(
    `SELECT id, state, dedupe_key FROM jobs WHERE owner_account_id = $1 AND type = $2 ORDER BY created_at`,
    [accountId, type],
  );
  return rows;
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
 * A Db view over the shared pool that rejects ONE statement of the storage
 * pass's open transaction: the fence's pause check dies with exactly
 * PostgreSQL's statement-timeout error shape (code 57014), while every
 * pool-level statement (claim, entry checks, completion) passes through.
 * The production handler and storage pass are untouched — this pins how a
 * deadline-SHAPED cancel that is not this window's expiry is classified.
 */
function cancelFencePauseCheckDb(cancel: Error & { code: string }): PoolDb {
  const wrap = (handle: Db): Db => {
    const self: Db = {
      inTransaction: handle.inTransaction,
      query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
        if (handle.inTransaction && text.includes('SELECT discovery_paused_at FROM graph_refresh_state')) {
          return Promise.reject(cancel);
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

// --- The gate matrix -----------------------------------------------------------------

describe('the paid research dispatch gate (VAL-DISC-005)', () => {
  it('stays off until the operator opts in, and never dispatches or spends while off', async () => {
    expect(researchEnabledInConfig(researchOff)).toBe(false);
    expect(researchEnabledInConfig(researchOn)).toBe(true);

    const accountId = (await insertAccount(db)).accountId;
    const { subjectNodeId, objectNodeId } = await nodePair();
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );

    // Default-off: no job, and no paid call of any kind.
    const refused = await dispatchGraphResearch(db, {
      accountId,
      config: researchOff,
      providers: registryWithDurableLedger(research.provider),
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
    });
    expect(refused).toEqual({ dispatched: false, reason: 'flag_off' });
    expect(research.calls.findSources).toBe(0);
    expect(research.calls.extractClaims).toBe(0);
    expect(await jobsOfKind(accountId, 'research_graph_relation')).toHaveLength(0);
  });

  it('an environment or database kill, or a discovery pause, refuses without consuming anything', async () => {
    const accountId = (await insertAccount(db)).accountId;
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const providers = registryWithDurableLedger(research.provider);

    const envKilled = await researchDispatchGate(db, { accountId, config: researchKilled, providers });
    expect(envKilled).toEqual({ allowed: false, reason: 'killed' });

    await db.query(
      `INSERT INTO feature_flag_kills (flag, account_id, reason, created_by)
       VALUES ('interest_graph_research_enabled', $1, 'test', 'test')`,
      [accountId],
    );
    const dbKilled = await researchDispatchGate(db, { accountId, config: researchOn, providers });
    expect(dbKilled).toEqual({ allowed: false, reason: 'killed' });
    await db.query(`UPDATE feature_flag_kills SET lifted_at = now() WHERE account_id = $1`, [accountId]);

    await pauseGraphDiscovery(db, accountId);
    const paused = await researchDispatchGate(db, { accountId, config: researchOn, providers });
    expect(paused).toEqual({ allowed: false, reason: 'paused' });

    // A refusal never dispatched or spent anything.
    expect(research.calls.findSources).toBe(0);
    expect(research.calls.extractClaims).toBe(0);
    expect(await jobsOfKind(accountId, 'research_graph_relation')).toHaveLength(0);
  });

  it('an unqualified research role refuses: no job, no paid call', async () => {
    const accountId = (await insertAccount(db)).accountId;
    const { subjectNodeId, objectNodeId } = await nodePair();
    const gate = await researchDispatchGate(db, {
      accountId,
      config: researchOn,
      providers: registryWithDurableLedger(unqualifiedResearch()),
    });
    expect(gate).toEqual({ allowed: false, reason: 'role_not_qualified' });
    const refused = await dispatchGraphResearch(db, {
      accountId,
      config: researchOn,
      providers: registryWithDurableLedger(unqualifiedResearch()),
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
    });
    expect(refused).toEqual({ dispatched: false, reason: 'role_not_qualified' });
    expect(await jobsOfKind(accountId, 'research_graph_relation')).toHaveLength(0);
  });

  it('no durable spend ledger refuses: default-off fail-closed without budgets', async () => {
    const accountId = (await insertAccount(db)).accountId;
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );

    // The plain test registry (Concentrate not configured) has no gateway.
    const noGateway = await researchDispatchGate(db, {
      accountId,
      config: researchOn,
      providers: testProviders({ research: research.provider }),
    });
    expect(noGateway).toEqual({ allowed: false, reason: 'limits_not_configured' });

    // A configured gateway WITHOUT spend limits has no ledger either.
    const noLedger = await researchDispatchGate(db, {
      accountId,
      config: researchOn,
      providers: registryWithoutLimits(research.provider),
    });
    expect(noLedger).toEqual({ allowed: false, reason: 'limits_not_configured' });

    expect(await jobsOfKind(accountId, 'research_graph_relation')).toHaveLength(0);
    expect(research.calls.extractClaims).toBe(0);
  });

  it('with the opt-in, a qualified role and durable limits, dispatch is bounded and coalesced', async () => {
    const accountId = (await insertAccount(db)).accountId;
    const { subjectNodeId, objectNodeId } = await nodePair();
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const providers = registryWithDurableLedger(research.provider);

    const gate = await researchDispatchGate(db, { accountId, config: researchOn, providers });
    expect(gate).toEqual({ allowed: true });

    const dispatched = await dispatchGraphResearch(db, {
      accountId,
      config: researchOn,
      providers,
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
      associationSubtype: 'studied_at',
    });
    expect(dispatched.dispatched).toBe(true);
    expect(dispatched.reused).toBe(false);

    // A repeated dispatch of the same pair coalesces into the same active job.
    const again = await dispatchGraphResearch(db, {
      accountId,
      config: researchOn,
      providers,
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
      associationSubtype: 'studied_at',
    });
    expect(again.dispatched).toBe(false);
    expect(again.reused).toBe(true);
    expect(again.jobId).toBe(dispatched.jobId);

    const jobs = await jobsOfKind(accountId, 'research_graph_relation');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe('queued');
    // Dispatch alone spent nothing: the research provider was never called.
    expect(research.calls.findSources).toBe(0);
    expect(research.calls.extractClaims).toBe(0);
  });
});

// --- The handler's run-time contract ---------------------------------------------------

describe('the relation-research handler (VAL-DISC-005)', () => {
  it('re-checks the gate at run time and refuses honestly before any paid call', async () => {
    const { principal } = await accountCtx({});
    const accountId = principal.accountId;
    const { subjectNodeId, objectNodeId } = await nodePair();
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const providers = registryWithDurableLedger(research.provider);

    // Dispatch while the gate is open...
    const dispatched = await dispatchGraphResearch(db, {
      accountId,
      config: researchOn,
      providers,
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
    });
    expect(dispatched.dispatched).toBe(true);

    // ...then the flag is off at run time (the durable shape of an operator
    // rollback). The job refuses non-retryably, before any paid call.
    await expect(runJob(dispatched.jobId!, { providers, config: researchOff })).rejects.toThrow(
      'Relation research is not available on this server.',
    );
    const { rows: failedJob } = await db.query<{ state: string; error_code: string; error_retryable: boolean }>(
      `SELECT state, error_code, error_retryable FROM jobs WHERE id = $1`,
      [dispatched.jobId!],
    );
    expect(failedJob[0]!.state).toBe('failed');
    expect(failedJob[0]!.error_code).toBe('service_unavailable');
    expect(failedJob[0]!.error_retryable).toBe(false);
    expect(research.calls.findSources).toBe(0);
    expect(research.calls.extractClaims).toBe(0);
    // No run, no proposals, no evidence: nothing was published.
    const { rows: runs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'research'`,
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(0);
  });

  it('a paused account completes honestly at run time without spending', async () => {
    const { principal } = await accountCtx({});
    const accountId = principal.accountId;
    const { subjectNodeId, objectNodeId } = await nodePair();
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const providers = registryWithDurableLedger(research.provider);

    const dispatched = await dispatchGraphResearch(db, {
      accountId,
      config: researchOn,
      providers,
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
    });
    await pauseGraphDiscovery(db, accountId);

    const outcome = await runJob(dispatched.jobId!, { providers, config: researchOn });
    expect(outcome.state).toBe('complete');
    expect(research.calls.findSources).toBe(0);
    expect(research.calls.extractClaims).toBe(0);
    const { rows: runs } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'research'`,
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(0);
  });

  it('publishes one UNREVIEWED proposed assertion from citing factual claims only — never passive confirmation', async () => {
    const { principal } = await accountCtx({});
    const accountId = principal.accountId;
    const { subjectNodeId, objectNodeId } = await nodePair();
    const wiki = `https://en.wikipedia.org/wiki/${encodeURIComponent('Test')}`;
    // THREE source documents offered: only the approved bound of two is kept.
    const research = countingResearch(
      (name) => [
        sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`),
        sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(`${name} (disambiguation)`)}`),
        sourceDoc(name, `https://example.com/not-approved/${encodeURIComponent(name)}`),
      ],
      extraction,
    );
    const providers = registryWithDurableLedger(research.provider);

    const dispatched = await dispatchGraphResearch(db, {
      accountId,
      config: researchOn,
      providers,
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
    });
    expect(dispatched.dispatched).toBe(true);

    const outcome = await runJob(dispatched.jobId!, { providers, config: researchOn });
    expect(outcome.state).toBe('complete');

    // The paid call happened exactly once, through the bounded sources.
    expect(research.calls.extractClaims).toBe(1);
    const { rows: sources } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_source_revisions WHERE source_family_key LIKE 'research:%'`,
    );
    expect(Number(sources[0]!.n)).toBeLessThanOrEqual(RESEARCH_MAX_SOURCE_DOCUMENTS);

    // The researched pair exists as ONE proposed assertion with machine-
    // extraction evidence; the interpretive and uncited claims grounded nothing.
    const { rows: assertions } = await db.query<{ id: string; status: string; revision: number }>(
      `SELECT id, status, revision FROM graph_assertions
        WHERE subject_node_id = $1 AND object_node_id = $2 AND predicate = 'CREATED_BY'`,
      [subjectNodeId, objectNodeId],
    );
    expect(assertions).toHaveLength(1);
    // No passive confirmation: the proposal is NOT validated, and its evidence
    // is unreviewed machine extraction. Validation is the separate review gate.
    expect(assertions[0]!.status).toBe('proposed');
    const { rows: evidence } = await db.query<{ evidence_kind: string; validation_version: string; reviewed_by: string | null }>(
      `SELECT e.evidence_kind, e.validation_version, e.reviewed_by
         FROM graph_assertion_support s JOIN graph_evidence e ON e.id = s.evidence_id
        WHERE s.assertion_id = $1`,
      [assertions[0]!.id],
    );
    expect(evidence.length).toBe(1);
    expect(evidence[0]!.evidence_kind).toBe('fact');
    expect(evidence[0]!.validation_version).toBe('research-text-1');
    expect(evidence[0]!.reviewed_by).toBeNull();
    expect(wiki).toContain('wikipedia.org');
  });

  it('records honest emptiness and proposes nothing without an approved source', async () => {
    const { principal } = await accountCtx({});
    const accountId = principal.accountId;
    const { subjectNodeId, objectNodeId } = await nodePair();
    // Only unapproved domains offered: research invents nothing.
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://example.com/not-approved/${encodeURIComponent(name)}`)],
      extraction,
    );
    const providers = registryWithDurableLedger(research.provider);

    const dispatched = await dispatchGraphResearch(db, {
      accountId,
      config: researchOn,
      providers,
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
    });
    const outcome = await runJob(dispatched.jobId!, { providers, config: researchOn });
    expect(outcome.state).toBe('complete');
    // No paid extraction without an approved source.
    expect(research.calls.extractClaims).toBe(0);
    const { rows: assertions } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_assertions WHERE subject_node_id = $1 AND object_node_id = $2`,
      [subjectNodeId, objectNodeId],
    );
    expect(Number(assertions[0]!.n)).toBe(0);
    const { rows: run } = await db.query<{ state: string }>(
      `SELECT state FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'research'`,
      [accountId],
    );
    expect(run[0]!.state).toBe('complete');
  });

  it('a research window makes no Qloo calls: its budget allowance is zero', async () => {
    const { principal } = await accountCtx({});
    const accountId = principal.accountId;
    const { subjectNodeId, objectNodeId } = await nodePair();
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const providers = registryWithDurableLedger(research.provider);

    const dispatched = await dispatchGraphResearch(db, {
      accountId,
      config: researchOn,
      providers,
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
    });
    await runJob(dispatched.jobId!, { providers, config: researchOn });

    const { rows: budgets } = await db.query<{ work_kind: string; qloo_attempts_max: number; state: string }>(
      `SELECT work_kind, qloo_attempts_max, state FROM graph_work_budgets WHERE owner_account_id = $1`,
      [accountId],
    );
    expect(budgets).toHaveLength(1);
    expect(budgets[0]!.work_kind).toBe('research');
    expect(budgets[0]!.qloo_attempts_max).toBe(0);
    expect(budgets[0]!.state).toBe('active');
  });
});

// --- The anchored logical deadline governs research work (VAL-DISC-006, DISC-SCR-006) ---

describe('the anchored logical deadline governs research work', () => {
  /** The dedupe key that carries the research item's logical identity. */
  async function researchWorkKey(jobId: string): Promise<string> {
    const { rows } = await db.query<{ dedupe_key: string }>('SELECT dedupe_key FROM jobs WHERE id = $1', [jobId]);
    if (!rows[0]?.dedupe_key) throw new Error('research job has no dedupe key');
    return rows[0].dedupe_key;
  }

  /** One dispatched, still-queued research job with one approved source. */
  async function dispatchedResearch(
    research: ProviderRegistry['research'],
  ): Promise<{ accountId: string; jobId: string; workKey: string; subjectNodeId: string; objectNodeId: string }> {
    const { principal } = await accountCtx({});
    const accountId = principal.accountId;
    const { subjectNodeId, objectNodeId } = await nodePair();
    const providers = registryWithDurableLedger(research);
    const dispatched = await dispatchGraphResearch(db, {
      accountId,
      config: researchOn,
      providers,
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
    });
    expect(dispatched.dispatched).toBe(true);
    return {
      accountId,
      jobId: dispatched.jobId!,
      workKey: await researchWorkKey(dispatched.jobId!),
      subjectNodeId,
      objectNodeId,
    };
  }

  /** Run states of the account's research runs (nothing published → empty). */
  async function researchRunStates(accountId: string): Promise<Record<string, number>> {
    const { rows } = await db.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 GROUP BY state`,
      [accountId],
    );
    return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
  }

  it('a delayed claim whose window already ended refuses before any provider call', async () => {
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const { accountId, jobId, workKey } = await dispatchedResearch(research.provider);
    const providers = registryWithDurableLedger(research.provider);

    // The window was anchored long ago (an earlier attempt of this logical
    // item) and has ended: a delayed first claim or redelivery inherits the
    // same row and must refuse honestly — never a fresh 45 seconds of work.
    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      at: new Date(Date.now() - 60_000),
    });

    await expect(runJob(jobId, { providers, config: researchOn })).rejects.toMatchObject({
      details: { rule: 'logical_deadline_expired' },
    });
    // No provider was called at all.
    expect(research.calls.findSources).toBe(0);
    expect(research.calls.extractClaims).toBe(0);
    // The window is durably stopped and nothing was published.
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
    expect(await researchRunStates(accountId)).toEqual({});
  });

  it('work delayed past its deadline cannot commit: the storage fence rejects after the paid call', async () => {
    // The paid extraction takes longer than the window has left, so the
    // storage fence is the last word: the call stays accounted, the proposals
    // publish nothing, and the window stops honestly.
    const calls = { findSources: 0, extractClaims: 0, urls: [] as string[] };
    const available = { status: 'available' as const, provider: 'fake' };
    const slowProvider = {
      id: 'research:fake',
      capability: () => ({ sources: available, claims: available }),
      findSources: async (query: { name: string }) => {
        calls.findSources++;
        const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(query.name)}`;
        calls.urls.push(url);
        return [sourceDoc(query.name, url)];
      },
      extractClaims: async (input: { name: string; sources: ResearchSourceDoc[] }) => {
        calls.extractClaims++;
        await new Promise((resolve) => setTimeout(resolve, 900));
        return extraction(input.name, input.sources[0]!.url);
      },
    } as unknown as ProviderRegistry['research'];
    const { accountId, jobId, workKey, subjectNodeId, objectNodeId } = await dispatchedResearch(slowProvider);
    const providers = registryWithDurableLedger(slowProvider);

    // A short remaining window (as a redelivery near the anchor's end holds):
    // the pass enters legally, the paid call happens, and the commit is fenced.
    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      deadlineMs: 400,
    });

    await expect(runJob(jobId, { providers, config: researchOn })).rejects.toMatchObject({
      details: { rule: 'logical_deadline_expired' },
    });
    // The paid call happened exactly once and stays accounted in provider_queries.
    expect(calls.extractClaims).toBe(1);
    const { rows: queries } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_queries WHERE owner_account_id = $1 AND provider = 'research' AND operation = 'extract_claims'`,
      [accountId],
    );
    expect(Number(queries[0]!.n)).toBe(1);
    // But nothing committed: no source revision for this job's URL, no
    // proposed assertion, no evidence — the storage transaction rolled back.
    const { rows: sources } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_source_revisions WHERE source_family_key = $1`,
      [`research:${calls.urls[0]}`],
    );
    expect(Number(sources[0]!.n)).toBe(0);
    const { rows: assertions } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_assertions WHERE subject_node_id = $1 AND object_node_id = $2`,
      [subjectNodeId, objectNodeId],
    );
    expect(Number(assertions[0]!.n)).toBe(0);
    // The run is an honest failure and the window is durably stopped.
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
  });

  it('the paid extraction cannot outlive its window: the deadline aborts the call and reports the typed outcome', async () => {
    // An extraction that would never finish on its own: only the deadline's
    // abort can end it. The pass entered legally, so the call is bound by the
    // remaining window, not by a fresh per-attempt allowance. The abort IS the
    // window expiring, so the outcome is the typed non-retryable
    // logical_deadline_expired result (DISC-SCR-026) — never a raw abort
    // error the production Worker would classify as provider_unavailable.
    const calls = { extractClaims: 0 };
    const available = { status: 'available' as const, provider: 'fake' };
    const hangingProvider = {
      id: 'research:fake',
      capability: () => ({ sources: available, claims: available }),
      findSources: async (query: { name: string }) => [
        sourceDoc(query.name, `https://en.wikipedia.org/wiki/${encodeURIComponent(query.name)}`),
      ],
      extractClaims: async (input: { name: string; sources: ResearchSourceDoc[] }, options?: { signal?: AbortSignal }) => {
        calls.extractClaims++;
        await new Promise<void>((resolve, reject) => {
          const fallback = setTimeout(resolve, 5_000); // honest RED without the fix: never hangs the suite
          options?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(fallback);
              reject(new Error('extraction aborted at the logical deadline'));
            },
            { once: true },
          );
        });
        return extraction(input.name, input.sources[0]!.url);
      },
    } as unknown as ProviderRegistry['research'];
    const { accountId, jobId, workKey } = await dispatchedResearch(hangingProvider);
    const providers = registryWithDurableLedger(hangingProvider);

    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      deadlineMs: 300,
    });

    // The typed window-expired outcome — never the raw abort error.
    await expect(runJob(jobId, { providers, config: researchOn })).rejects.toMatchObject({
      details: { rule: 'logical_deadline_expired' },
    });
    expect(calls.extractClaims).toBe(1);
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
    const { rows: failedJob } = await db.query<{ state: string; error_code: string; error_retryable: boolean }>(
      `SELECT state, error_code, error_retryable FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(failedJob[0]!.state).toBe('failed');
    expect(failedJob[0]!.error_code).toBe('service_unavailable');
    expect(failedJob[0]!.error_retryable).toBe(false);
  });

  it("a real adapter's window-expiry abort is the typed logical-deadline outcome, never a raw provider abort (DISC-SCR-026)", async () => {
    // The production Wikipedia adapter reports a caller-signal cancel as
    // ProviderError('research', 'aborted') (wikipedia.ts getJson; withRetries
    // throws the same shape before an attempt and during backoff). When the
    // cancel came from the EXPIRED DURABLE WINDOW — the combined deadline
    // signal aborted on its own while the worker's own grant is still live —
    // that abort IS the deadline firing and must surface as the typed
    // non-retryable logical_deadline_expired outcome. Rethrown unchanged, the
    // real Worker's classifier records provider_unavailable instead: the
    // exact near-expiry-redelivery misclassification round 4 found.
    const calls = { findSources: 0, extractClaims: 0 };
    const available = { status: 'available' as const, provider: 'fake' };
    const abortingProvider = {
      id: 'research:fake',
      capability: () => ({ sources: available, claims: available }),
      findSources: async (_query: { name: string }, options?: { signal?: AbortSignal }) => {
        calls.findSources++;
        await new Promise<void>((resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error('the window never aborted the lookup')), 5_000);
          if (!options?.signal) {
            clearTimeout(fallback);
            reject(new Error('findSources received no deadline signal'));
            return;
          }
          if (options.signal.aborted) {
            clearTimeout(fallback);
            resolve();
            return;
          }
          options.signal.addEventListener('abort', () => {
            clearTimeout(fallback);
            resolve();
          }, { once: true });
        });
        // The real adapter's exact production shape for this cancel.
        throw new ProviderError('research', 'aborted', 'aborted');
      },
      extractClaims: async () => {
        calls.extractClaims++;
        throw new Error('extraction must never run after the window aborted the lookup');
      },
    } as unknown as ProviderRegistry['research'];
    const { accountId, jobId, workKey, subjectNodeId, objectNodeId } = await dispatchedResearch(abortingProvider);
    const providers = registryWithDurableLedger(abortingProvider);

    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      deadlineMs: 300,
    });

    const err = await runJob(jobId, { providers, config: researchOn }).then(
      () => {
        throw new Error('the window-expired lookup must not complete');
      },
      (e: unknown) => e,
    );
    // The typed outcome — not the raw provider abort.
    expect(err).toMatchObject({ code: 'service_unavailable', details: { rule: 'logical_deadline_expired' } });
    expect((err as { name?: string }).name).not.toBe('ProviderError');
    expect(calls.findSources).toBe(1);
    expect(calls.extractClaims).toBe(0);
    // Honest terminal state: the run failed, the window durably stopped, no
    // lookup was recorded as completed, nothing published, and the job holds
    // the typed non-retryable failure.
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
    const { rows: lookups } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_queries WHERE owner_account_id = $1 AND operation = 'find_sources'`,
      [accountId],
    );
    expect(Number(lookups[0]!.n)).toBe(0);
    const { rows: assertions } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_assertions WHERE subject_node_id = $1 AND object_node_id = $2`,
      [subjectNodeId, objectNodeId],
    );
    expect(Number(assertions[0]!.n)).toBe(0);
    const { rows: failedJob } = await db.query<{ state: string; error_code: string; error_retryable: boolean }>(
      `SELECT state, error_code, error_retryable FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(failedJob[0]!.state).toBe('failed');
    expect(failedJob[0]!.error_code).toBe('service_unavailable');
    expect(failedJob[0]!.error_retryable).toBe(false);
  });

  it('a still-live provider failure keeps its own shape: the raw error is never relabeled deadline-expired (DISC-SCR-026)', async () => {
    // Truthful classification cuts both ways: only the window's OWN expiry is
    // the typed deadline outcome. A provider failing while the window is
    // still live — the combined deadline signal never fired — surfaces as its
    // raw provider error (the real Worker classifies that provider_unavailable),
    // and the window is neither consumed nor stopped.
    const calls = { findSources: 0 };
    const available = { status: 'available' as const, provider: 'fake' };
    const failingProvider = {
      id: 'research:fake',
      capability: () => ({ sources: available, claims: available }),
      findSources: async () => {
        calls.findSources++;
        throw new ProviderError('research', 'server', 'wikipedia search HTTP 503');
      },
      extractClaims: async () => {
        throw new Error('extraction must never run after the source failure');
      },
    } as unknown as ProviderRegistry['research'];
    const { accountId, jobId, workKey } = await dispatchedResearch(failingProvider);
    const providers = registryWithDurableLedger(failingProvider);

    // The handler anchors the default durable window: live throughout.
    await expect(runJob(jobId, { providers, config: researchOn })).rejects.toMatchObject({
      provider: 'research',
      kind: 'server',
    });
    expect(calls.findSources).toBe(1);
    // The window is untouched — still active — and the attempt failed
    // honestly, as the PROVIDER failure it is, not a deadline expiry.
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('active');
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
  });

  it('the deadline canceling the storage pass itself is the typed window-expired outcome, never a raw database error', async () => {
    // The storage pass's account-authority lock is contended by an open
    // holder transaction, so its very first fenced statement parks on the
    // row lock. The window's remaining time bounds that lock wait
    // (`SET LOCAL lock_timeout`), so PostgreSQL cancels the statement with
    // code 57014 AT the anchored deadline — BEFORE the fence's typed window
    // check can run. That cancel IS the deadline firing and must surface as
    // the truthful logical_deadline_expired terminal outcome (the run failed
    // honestly, the window durably stopped, the paid call stays accounted,
    // nothing published) — never as a raw SQL error.
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const { accountId, jobId, workKey, subjectNodeId, objectNodeId } = await dispatchedResearch(research.provider);
    const providers = registryWithDurableLedger(research.provider);

    // A window with room for the entry checks and the paid call, but not
    // for a lock wait that outlives it.
    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      deadlineMs: 1_500,
    });

    const holder = await db.pool.connect();
    let holderOpen = true;
    let run: Promise<{ state: string }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [accountId]);
      // The storage pass enters legally and parks at its fence on the
      // holder's row lock.
      run = runJob(jobId, { providers, config: researchOn });
      void run.catch(() => undefined);
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);
      // The window ends while the storage pass is parked: the bounded lock
      // wait cancels the statement at the anchor — never the holder's
      // release, which stays held until the rejection has landed.
      await expect(run).rejects.toMatchObject({ details: { rule: 'logical_deadline_expired' } });
      await holder.query('ROLLBACK');
      holderOpen = false;
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // The paid call happened exactly once and stays accounted in provider_queries.
    expect(research.calls.extractClaims).toBe(1);
    const { rows: queries } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_queries WHERE owner_account_id = $1 AND provider = 'research' AND operation = 'extract_claims'`,
      [accountId],
    );
    expect(Number(queries[0]!.n)).toBe(1);
    // Nothing committed: no proposal for the researched pair.
    const { rows: assertions } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_assertions WHERE subject_node_id = $1 AND object_node_id = $2`,
      [subjectNodeId, objectNodeId],
    );
    expect(Number(assertions[0]!.n)).toBe(0);
    // The run is an honest failure, the window durably stopped, the job
    // failed non-retryably: the terminal outcome is the typed one.
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
    const { rows: failedJob } = await db.query<{ state: string; error_code: string; error_retryable: boolean }>(
      `SELECT state, error_code, error_retryable FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(failedJob[0]!.state).toBe('failed');
    expect(failedJob[0]!.error_code).toBe('service_unavailable');
    expect(failedJob[0]!.error_retryable).toBe(false);
  });

  it("the storage fence's successive account-then-taste waits each honor the CURRENT remainder (DISC-SCR-025)", async () => {
    // The storage fence is ONE helper with SEVERAL independent lock waits:
    // the account publication-authority lock, then the taste/state authority
    // locks inside lockAccountAuthorityVersions. A bound computed once before
    // the fence is stale by the second wait — the first wait's consumed time
    // must not widen the second wait's allowance past the anchor. Two
    // connections hold the two waits: the account holder releases INSIDE the
    // window, the taste holder never releases. The pass must reject AT the
    // anchored deadline — never a full entry-bound later, never on the second
    // holder's release.
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const { accountId, jobId, workKey, subjectNodeId, objectNodeId } = await dispatchedResearch(research.provider);
    const providers = registryWithDurableLedger(research.provider);

    // Room for the entry checks, the paid call and the FIRST (short) wait —
    // but the second wait must be bounded by what is LEFT, not this entry
    // allowance.
    const anchored = await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      deadlineMs: 3_200,
    });
    const deadlineAt = anchored.deadlineAt;

    const accountHolder = await db.pool.connect();
    const tasteHolder = await db.pool.connect();
    let run: Promise<{ state: string }> | undefined;
    try {
      // Wait #2 first, on the ground: the holder's UNCOMMITTED taste row for
      // this fresh account is in place before the pass starts, so the fence's
      // materializing taste INSERT deterministically parks on it.
      await tasteHolder.query('BEGIN');
      await tasteHolder.query('INSERT INTO taste_profiles (owner_account_id, revision) VALUES ($1, 0)', [accountId]);

      // Wait #1: the storage fence parks on the held account-authority lock
      // (a short wait that fits the entry bound).
      await accountHolder.query('BEGIN');
      await accountHolder.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [accountId]);
      run = runJob(jobId, { providers, config: researchOn });
      void run.catch(() => undefined);
      await waitForLockWaiters('%accounts WHERE id = $1 FOR NO KEY UPDATE%', 1);
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      await accountHolder.query('COMMIT');

      // The pass proceeds past the short first wait and parks on the taste
      // holder's uncommitted row — a LATE wait, started well after the bound
      // was last computed at the storage pass's entry.
      await waitForLockWaiters('%INSERT INTO taste_profiles%', 1);

      // The rejection is the typed window-expired outcome and lands AT the
      // anchored deadline: the second wait was bounded by the CURRENT
      // remainder — never by the entry bound (a full window past it) and
      // never by the taste holder's release (which stays held).
      await expect(run).rejects.toMatchObject({ details: { rule: 'logical_deadline_expired' } });
      expect(Date.now() - deadlineAt.getTime()).toBeLessThanOrEqual(700);
    } finally {
      await accountHolder.query('ROLLBACK').catch(() => undefined);
      await tasteHolder.query('ROLLBACK').catch(() => undefined);
      accountHolder.release();
      tasteHolder.release();
    }

    // Nothing committed: no proposal for the researched pair and no source
    // revision for either document URL — the whole storage pass rolled back.
    const { rows: assertions } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_assertions WHERE subject_node_id = $1 AND object_node_id = $2`,
      [subjectNodeId, objectNodeId],
    );
    expect(Number(assertions[0]!.n)).toBe(0);
    const { rows: nodes } = await db.query<{ canonical_name: string }>(
      'SELECT canonical_name FROM graph_nodes WHERE id = ANY($1::uuid[])',
      [[subjectNodeId, objectNodeId]],
    );
    const familyKeys = nodes.map(
      (n) => `research:https://en.wikipedia.org/wiki/${encodeURIComponent(n.canonical_name)}`,
    );
    const { rows: sourceRows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_source_revisions WHERE source_family_key = ANY($1)`,
      [familyKeys],
    );
    expect(Number(sourceRows[0]!.n)).toBe(0);
    // The run is an honest failure, the window durably stopped, the job
    // failed non-retryably: the successive-wait overrun published nothing.
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
    const { rows: failedJob } = await db.query<{ state: string; error_code: string; error_retryable: boolean }>(
      `SELECT state, error_code, error_retryable FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(failedJob[0]!.state).toBe('failed');
    expect(failedJob[0]!.error_code).toBe('service_unavailable');
    expect(failedJob[0]!.error_retryable).toBe(false);
  });

  it('a statement-timeout cancel while the window is still live stays the raw database error', async () => {
    // Truthful classification cuts both ways: the deadline-bounded cancel is
    // the typed window-expired outcome only when the durable window really
    // ended. A deadline-SHAPED statement timeout hitting the storage pass
    // while the anchored window is still live keeps its raw error — the
    // window is never consumed or mislabeled by a cancel it did not cause.
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const { accountId, jobId, workKey, subjectNodeId, objectNodeId } = await dispatchedResearch(research.provider);
    const providers = registryWithDurableLedger(research.provider);
    // The default 45-second window, nowhere near its end.

    const cancel = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    await expect(
      runJob(jobId, { providers, config: researchOn, db: cancelFencePauseCheckDb(cancel) }),
    ).rejects.toMatchObject({ code: '57014', message: 'canceling statement due to statement timeout' });
    // The window is untouched — still active — the attempt failed honestly,
    // the paid call stays accounted, and nothing published.
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('active');
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
    expect(research.calls.extractClaims).toBe(1);
    const { rows: queries } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_queries WHERE owner_account_id = $1 AND provider = 'research' AND operation = 'extract_claims'`,
      [accountId],
    );
    expect(Number(queries[0]!.n)).toBe(1);
    const { rows: assertions } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_assertions WHERE subject_node_id = $1 AND object_node_id = $2`,
      [subjectNodeId, objectNodeId],
    );
    expect(Number(assertions[0]!.n)).toBe(0);
  });

  it('two individually short but cumulatively over-window storage waits cannot commit proposals', async () => {
    // DISC-SCR-018: a one-time entry bound is not an absolute deadline. Two
    // successive lock waits — the storage fence's account-authority lock,
    // then the second source revision's upsert — each fit the per-statement
    // bound the pass set at entry, while cumulatively running past the
    // anchored deadline. The later wait must honor the CURRENT remainder
    // (PostgreSQL cancels it AT the deadline, never a full entry-bound window
    // later), and the honest terminal outcome is the typed window-expired
    // result with nothing committed.
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const { accountId, jobId, workKey, subjectNodeId, objectNodeId } = await dispatchedResearch(research.provider);
    const providers = registryWithDurableLedger(research.provider);

    // The pass enters legally: the window has room for the entry checks, the
    // paid call and the FIRST (short) wait, but not for both waits.
    const anchored = await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      deadlineMs: 3_000,
    });
    const deadlineAt = anchored.deadlineAt;

    // The object document's URL — the SECOND source revision the storage
    // pass records, and the row the second holder pins.
    const { rows: objectRows } = await db.query<{ canonical_name: string }>(
      'SELECT canonical_name FROM graph_nodes WHERE id = $1',
      [objectNodeId],
    );
    const objectUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(objectRows[0]!.canonical_name)}`;
    const subjectUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(
      (await db.query<{ canonical_name: string }>('SELECT canonical_name FROM graph_nodes WHERE id = $1', [subjectNodeId]))
        .rows[0]!.canonical_name,
    )}`;

    const fenceHolder = await db.pool.connect();
    const sourceHolder = await db.pool.connect();
    let run: Promise<{ state: string }> | undefined;
    try {
      // Wait #2 first, on the ground: the holder's uncommitted row for the
      // object document's URL is in place before the pass starts, so the
      // second source revision's upsert deterministically parks on it.
      await sourceHolder.query('BEGIN');
      await sourceHolder.query(
        `INSERT INTO sources (url, title, publisher, retrieved_at, allowed_display_metadata)
         VALUES ($1, 'held', 'held', now(), '{}'::jsonb)`,
        [objectUrl],
      );

      // Wait #1: the storage fence parks on the held account-authority lock
      // (a short wait that fits the entry bound).
      await fenceHolder.query('BEGIN');
      await fenceHolder.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [accountId]);
      run = runJob(jobId, { providers, config: researchOn });
      void run.catch(() => undefined);
      await waitForLockWaiters('%FOR NO KEY UPDATE%', 1);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await fenceHolder.query('COMMIT');

      // The pass proceeds past the short first wait and parks on the
      // holder's row — a LATE wait, started well after the entry bound was
      // computed.
      await waitForLockWaiters('%INSERT INTO sources%', 1);

      // The rejection is the typed window-expired outcome, and it lands AT
      // the anchored deadline: the second wait was bounded by the CURRENT
      // remainder, never by the entry bound (which would cancel it a full
      // window later) nor by the holder's release (which stays held).
      await expect(run).rejects.toMatchObject({ details: { rule: 'logical_deadline_expired' } });
      expect(Date.now() - deadlineAt.getTime()).toBeLessThanOrEqual(700);
    } finally {
      await fenceHolder.query('ROLLBACK').catch(() => undefined);
      await sourceHolder.query('ROLLBACK').catch(() => undefined);
      fenceHolder.release();
      sourceHolder.release();
    }

    // Nothing committed: no proposal for the researched pair and no source
    // revision for either document URL — the whole storage pass rolled back.
    const { rows: assertions } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_assertions WHERE subject_node_id = $1 AND object_node_id = $2`,
      [subjectNodeId, objectNodeId],
    );
    expect(Number(assertions[0]!.n)).toBe(0);
    const { rows: sourceRows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_source_revisions WHERE source_family_key = ANY($1)`,
      [[`research:${subjectUrl}`, `research:${objectUrl}`]],
    );
    expect(Number(sourceRows[0]!.n)).toBe(0);
    // The run is an honest failure, the window durably stopped and the job
    // failed non-retryably: the successive-wait overrun published nothing.
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
    const { rows: failedJob } = await db.query<{ state: string; error_code: string; error_retryable: boolean }>(
      `SELECT state, error_code, error_retryable FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(failedJob[0]!.state).toBe('failed');
    expect(failedJob[0]!.error_code).toBe('service_unavailable');
    expect(failedJob[0]!.error_retryable).toBe(false);
  });

  it('a source lookup that outlived the window never starts the second lookup', async () => {
    // DISC-SCR-019: source discovery checks the window before EVERY provider
    // stage. A first search that ran past the anchored deadline cannot start
    // the object search: the budget stops honestly and the elapsed work
    // reports as the typed logical-deadline outcome.
    const calls = { findSources: 0 };
    const available = { status: 'available' as const, provider: 'fake' };
    const slowProvider = {
      id: 'research:fake',
      capability: () => ({ sources: available, claims: available }),
      findSources: async (query: { name: string }) => {
        calls.findSources++;
        const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(query.name)}`;
        if (calls.findSources === 1) await new Promise((resolve) => setTimeout(resolve, 700));
        return [sourceDoc(query.name, url)];
      },
      extractClaims: async (input: { name: string; sources: ResearchSourceDoc[] }) =>
        extraction(input.name, input.sources[0]!.url),
    } as unknown as ProviderRegistry['research'];
    const { accountId, jobId, workKey } = await dispatchedResearch(slowProvider);
    const providers = registryWithDurableLedger(slowProvider);

    // The pass enters legally; the subject search alone outlives the window.
    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      deadlineMs: 400,
    });

    await expect(runJob(jobId, { providers, config: researchOn })).rejects.toMatchObject({
      details: { rule: 'logical_deadline_expired' },
    });
    // Exactly ONE source lookup ran; the second never started after the
    // window ended.
    expect(calls.findSources).toBe(1);
    // The window is durably stopped and the run failed honestly.
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
  });

  it('the anchored combined signal aborts an in-flight source lookup at the window end', async () => {
    // DISC-SCR-019: the deadline signal must reach source discovery itself —
    // a hanging lookup is aborted at the original anchored deadline (never a
    // fresh per-attempt one), and it receives the remaining window as its
    // per-attempt timeout bound.
    const seen: { signal?: AbortSignal; timeoutMs?: number }[] = [];
    const available = { status: 'available' as const, provider: 'fake' };
    const hangingProvider = {
      id: 'research:fake',
      capability: () => ({ sources: available, claims: available }),
      findSources: async (query: { name: string }, options?: { signal?: AbortSignal; timeoutMs?: number }) => {
        seen.push({ signal: options?.signal, timeoutMs: options?.timeoutMs });
        await new Promise<void>((resolve, reject) => {
          const fallback = setTimeout(resolve, 1_500); // honest RED without the fix: never hangs the suite
          options?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(fallback);
              reject(new Error('findSources aborted at the logical deadline'));
            },
            { once: true },
          );
        });
        return [];
      },
      extractClaims: async () => extraction('unused', 'https://en.wikipedia.org/wiki/Test'),
    } as unknown as ProviderRegistry['research'];
    const { accountId, jobId, workKey } = await dispatchedResearch(hangingProvider);
    const providers = registryWithDurableLedger(hangingProvider);

    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      deadlineMs: 300,
    });

    // The abort IS the window expiring, so the outcome is the typed
    // logical-deadline result (DISC-SCR-026) — never the raw abort error the
    // production Worker would misclassify as provider_unavailable.
    await expect(runJob(jobId, { providers, config: researchOn })).rejects.toMatchObject({
      details: { rule: 'logical_deadline_expired' },
    });
    // The lookup received the anchored combined signal and the remaining
    // window as its per-attempt bound — the abort, not a fallback timer, is
    // what ended it.
    expect(seen.length).toBe(1);
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.signal!.aborted).toBe(true);
    expect(seen[0]!.timeoutMs).toBeGreaterThan(0);
    expect(seen[0]!.timeoutMs!).toBeLessThanOrEqual(300);
    // Honest terminal state: the run failed, the window durably stopped.
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
  });

  it('an empty source result cannot complete past its window: the elapsed work reports as the logical-deadline outcome', async () => {
    // DISC-SCR-019: the no-documents branch checked nothing. An empty result
    // that completed past the anchored deadline is NOT a completed lookup:
    // the window must be live at the empty-result completion, the elapsed
    // work reports as the typed logical-deadline outcome, the window stops
    // honestly, and nothing is recorded as a completed empty search.
    const available = { status: 'available' as const, provider: 'fake' };
    const seen = { lookups: 0 };
    const lateEmptyProvider = {
      id: 'research:fake',
      capability: () => ({ sources: available, claims: available }),
      findSources: async (query: { name: string }) => {
        // The subject lookup answers fast; the object lookup starts inside
        // the window but outlives it (a lookup that ignores the cooperative
        // signal still cannot complete as a fresh empty result).
        if (seen.lookups === 1) await new Promise((resolve) => setTimeout(resolve, 700));
        seen.lookups++;
        return [] as ResearchSourceDoc[];
      },
      extractClaims: async () => extraction('unused', 'https://en.wikipedia.org/wiki/Test'),
    } as unknown as ProviderRegistry['research'];
    const { accountId, jobId, workKey } = await dispatchedResearch(lateEmptyProvider);
    const providers = registryWithDurableLedger(lateEmptyProvider);

    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      deadlineMs: 400,
    });

    await expect(runJob(jobId, { providers, config: researchOn })).rejects.toMatchObject({
      details: { rule: 'logical_deadline_expired' },
    });
    expect(seen.lookups).toBe(2);
    // No completed-empty provider query was recorded past the window, the
    // run failed honestly, and the window durably stopped.
    const { rows: emptyQueries } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_queries WHERE owner_account_id = $1 AND operation = 'find_sources'`,
      [accountId],
    );
    expect(Number(emptyQueries[0]!.n)).toBe(0);
    expect(await researchRunStates(accountId)).toEqual({ failed: 1 });
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
  });
});
