import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createProviderRegistry, type ProviderRegistry, type ResearchExtraction, type ResearchSourceDoc } from '@culture-atlas/providers';
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

/**
 * VAL-DISC-005: paid relation research is DEFAULT-OFF and stays off until the
 * operator opt-in, no kill, no pause, a qualified research role AND durable
 * account/global spend limits all hold — and it never passively confirms
 * anything: proposals are unreviewed `proposed` assertions whose evidence is
 * machine-extraction, never confirmation of feed/photo/background outputs.
 * The handler re-checks the same gate at run time, so a gate that closes
 * between dispatch and run refuses without spending.
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
    { db: getTestDb() },
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
