import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createProviderRegistry,
  ProviderError,
  type ModelProfile,
  type ProviderRegistry,
  type ResearchExtraction,
  type ResearchSourceDoc,
  type StructuredTransport,
} from '@culture-atlas/providers';
import type { JobType } from '../enums';
import { type JobContext } from '../jobs/handler';
import { claimJobs, getJobById } from '../jobs/queue';
import { runStageOnce } from '../jobs/stages';
import { accountCtx, runJob } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { upsertGraphIdentity } from '../interest-graph/evidence';
import { ensureGraphWorkBudget, loadGraphWorkBudget } from '../interest-graph/budgets';
import { dispatchGraphResearch } from '../interest-graph/research-gate';
import type { GraphRunRow } from '../interest-graph/schema';
import { JOB_HANDLERS } from './index';

/**
 * At-least-once redelivery of a COMMITTED relation-research pass (the crash
 * boundary the expansion handler already owns, VAL-DISC-005/006).
 *
 * The research pass's publication — the proposed assertions, or the honest
 * empty-sources lookup — commits together with the run's 'complete' state,
 * and the budget close and the job completion after it are bookkeeping. A
 * worker that dies between that commit and the queue acknowledgment leaves
 * the job 'running' with a lease and a COMMITTED complete run.
 *
 * The handler must REUSE that committed run on the redelivery instead of
 * re-running the pass: the complete budget is not an active window (its
 * durable ended-check reports the window over), so a re-run would reopen the
 * committed run, re-invoke providers, record duplicate provider queries and
 * fail at the storage fence — and past the 45-second anchor the entry check
 * would overwrite the complete window as 'stopped' and falsely fail the
 * finished job. Reuse means: no re-open, no re-anchored spend, no provider
 * call, no republish — and the original run id is the job's result.
 *
 * Precommit failures and expired never-published work keep failing honestly:
 * a run that never committed (state 'failed') and a window that expired
 * without any run are NOT committed passes and must never be reused.
 *
 * Every provider here is a deterministic registry override over the durable
 * test ledger — never a live or paid call.
 */

const db = getTestDb();
afterAll(closeTestDb);

const researchOn = testConfig({ INTEREST_GRAPH_RESEARCH_ENABLED: 'true' });

// --- Fixture: the qualified, durable-ledger registry (deterministic, never live) ------

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

/** A research fake whose paid extraction fails while the window is still live. */
function extractionFailingResearch(sources: (name: string) => ResearchSourceDoc[]) {
  const calls = { findSources: 0, extractClaims: 0 };
  const available = { status: 'available' as const, provider: 'fake' };
  const provider = {
    id: 'research:fake',
    capability: () => ({ sources: available, claims: available }),
    findSources: async (query: { name: string }) => {
      calls.findSources++;
      return sources(query.name);
    },
    extractClaims: async () => {
      calls.extractClaims++;
      throw new ProviderError('research', 'server', 'wikipedia extract HTTP 503');
    },
  };
  return { provider: provider as unknown as ProviderRegistry['research'], calls };
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
      MODEL_TOTAL_SPEND_LIMIT_USD: '100',
    },
    { research },
    {
      db: getTestDb(),
      profiles: { research_text: qualifiedResearchTextProfile },
      qualification: () => 'qualified',
      transport: neverTransport,
    },
  );
}

// --- Fixture: one dispatched research job ------------------------------------------------

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

async function dispatchResearch(
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
  const job = await getJobById(db, dispatched.jobId!);
  if (!job?.dedupe_key) throw new Error('research job has no dedupe key');
  return { accountId, jobId: dispatched.jobId!, workKey: job.dedupe_key, subjectNodeId, objectNodeId };
}

// --- Durable-state readers ----------------------------------------------------------------

async function researchRunRow(accountId: string): Promise<GraphRunRow | null> {
  const { rows } = await db.query<GraphRunRow>(
    `SELECT id, owner_account_id, job_id, run_kind, input_taste_revision, input_projection_revision,
            input_generation, policy_version, budget, state, published, started_at, finished_at,
            created_at, updated_at
       FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'research'`,
    [accountId],
  );
  return rows[0] ?? null;
}

async function researchRunCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'research'`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function providerQueryCount(accountId: string, operation: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM provider_queries WHERE owner_account_id = $1 AND provider = 'research' AND operation = $2`,
    [accountId, operation],
  );
  return Number(rows[0]!.n);
}

/** The committed proposal shape: exactly one proposed assertion with one machine-extraction evidence row. */
async function committedProposalShape(accountId: string, subjectNodeId: string, objectNodeId: string): Promise<void> {
  const { rows: assertions } = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM graph_assertions WHERE subject_node_id = $1 AND object_node_id = $2 AND predicate = 'CREATED_BY'`,
    [subjectNodeId, objectNodeId],
  );
  expect(assertions).toHaveLength(1);
  expect(assertions[0]!.status).toBe('proposed');
  const { rows: evidence } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM graph_assertion_support s JOIN graph_evidence e ON e.id = s.evidence_id
      WHERE s.assertion_id = $1 AND e.validation_method = 'machine_extraction'`,
    [assertions[0]!.id],
  );
  expect(Number(evidence[0]!.n)).toBe(1);
}

// --- The crash seam ---------------------------------------------------------------------------

/**
 * Claim `jobId` at its next real attempt and run its REAL handler to
 * completion — then die like a worker that crashed BETWEEN the handler's
 * return and the queue acknowledgment: NO terminal queue write. Every durable
 * write the pass made (the proposals — or the honest empty-sources lookup —
 * the run's 'complete' state, the closed window, the stage and provider-query
 * records) stands, and the claimed row keeps its 'running' state and the
 * claim's lease. A handler error keeps its own shape and propagates the same
 * way: its durable failure bookkeeping stands with no terminal write either.
 */
async function runCrashingBeforeAcknowledgment(jobId: string, providers: ProviderRegistry): Promise<void> {
  const workerId = `crash-${randomUUID()}`;
  const [job] = await claimJobs(db, { workerId, limit: 1, leaseMs: 60_000, ids: [jobId] });
  if (!job) throw new Error('research job not claimable');
  const controller = new AbortController();
  const ctx: JobContext = {
    job,
    payload: job.payload,
    attempt: job.attempt,
    workerId,
    db,
    providers,
    config: researchOn,
    signal: controller.signal,
    budget: {
      qlooRequests: job.budget.qloo_requests ?? 4,
      researchRefs: 0,
      providerRetries: 0,
      deadlineMs: 60_000,
    },
    setStage: async () => undefined,
    runStage: (stage, fn) => runStageOnce(db, { jobId: job.id, stage, attempt: job.attempt }, fn),
    ensureActive: async () => undefined,
    trace: async () => undefined,
    log: () => undefined,
  };
  const handler = JOB_HANDLERS[job.type as JobType] as (c: JobContext) => Promise<unknown>;
  // The process dies here: the handler's committed outcome is never
  // acknowledged to the queue.
  await handler(ctx);
}

// --- The committed pass's redelivery ------------------------------------------------------

describe('at-least-once redelivery of a committed research pass', () => {
  it('a redelivery inside the original window reuses the committed run instead of reopening it', async () => {
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const { accountId, jobId, workKey, subjectNodeId, objectNodeId } = await dispatchResearch(research.provider);
    const providers = registryWithDurableLedger(research.provider);

    // Attempt 1: the pass commits (proposals, run 'complete', window closed),
    // then the worker dies before the queue acknowledgment.
    await runCrashingBeforeAcknowledgment(jobId, providers);

    const committed = await researchRunRow(accountId);
    expect(committed?.state).toBe('complete');
    const runId = committed!.id;
    const budgetBefore = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budgetBefore?.state).toBe('complete');
    expect((await getJobById(db, jobId))?.state).toBe('running');
    // The pass spent exactly its bounded work: two source lookups, one paid
    // extraction, one proposed assertion with one evidence row.
    expect(research.calls.findSources).toBe(2);
    expect(research.calls.extractClaims).toBe(1);
    expect(await providerQueryCount(accountId, 'extract_claims')).toBe(1);
    await committedProposalShape(accountId, subjectNodeId, objectNodeId);

    // At-least-once delivery: the lease lapses and the queue reclaims the
    // job — still inside the original 45-second window.
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const traces: string[] = [];
    const redelivered = await runJob(jobId, { providers, config: researchOn, onTrace: (e) => traces.push(e.name) });

    // The redelivery completes the job by REUSING the committed run.
    expect(redelivered.state).toBe('complete');
    const done = await getJobById(db, jobId);
    expect(done?.state).toBe('complete');
    expect(done?.result_id).toBe(runId);
    expect(done?.result_type).toBe('graph_research');
    expect(traces).toContain('graph_research_redelivery_reused');

    // No reopen, no re-fail, no second run row: the committed run row is
    // byte-identical (the reuse never touches it).
    expect(await researchRunCount(accountId)).toBe(1);
    const after = await researchRunRow(accountId);
    expect(after?.id).toBe(runId);
    expect(after?.state).toBe('complete');
    expect(after?.updated_at.getTime()).toBe(committed!.updated_at.getTime());
    expect(after?.finished_at?.getTime()).toBe(committed!.finished_at?.getTime());

    // Zero new provider work: no source lookups, no extraction, no duplicate
    // provider-query records, nothing republished.
    expect(research.calls.findSources).toBe(2);
    expect(research.calls.extractClaims).toBe(1);
    expect(await providerQueryCount(accountId, 'extract_claims')).toBe(1);
    await committedProposalShape(accountId, subjectNodeId, objectNodeId);

    // The complete window is unchanged: same anchor, same length, complete.
    const budgetAfter = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budgetAfter?.state).toBe('complete');
    expect(budgetAfter?.deadline_started_at.getTime()).toBe(budgetBefore!.deadline_started_at.getTime());
    expect(budgetAfter?.deadline_ms).toBe(budgetBefore!.deadline_ms);
  });

  it('a redelivery after the original window still completes with the original run id and never expires the window', async () => {
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const { accountId, jobId, workKey } = await dispatchResearch(research.provider);
    const providers = registryWithDurableLedger(research.provider);

    await runCrashingBeforeAcknowledgment(jobId, providers);
    const runId = (await researchRunRow(accountId))!.id;

    // The reclaim happens after the original 45-second window ended (a
    // delayed redelivery): the durable shape of the anchor having passed
    // while the committed job sat unacknowledged.
    await db.query(
      `UPDATE graph_work_budgets SET deadline_started_at = now() - interval '60 seconds'
        WHERE owner_account_id = $1 AND work_key = $2`,
      [accountId, workKey],
    );
    const expiredAnchor = (await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey }))!;
    expect(expiredAnchor.state).toBe('complete');
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);

    const redelivered = await runJob(jobId, { providers, config: researchOn });
    expect(redelivered.state).toBe('complete');

    // Correct completed terminal status with the ORIGINAL run id.
    const done = await getJobById(db, jobId);
    expect(done?.state).toBe('complete');
    expect(done?.result_id).toBe(runId);
    expect((await researchRunRow(accountId))?.state).toBe('complete');

    // The window stays the honest complete row: never overwritten 'stopped',
    // never re-anchored, and the redelivery invoked no provider.
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('complete');
    expect(budget?.deadline_started_at.getTime()).toBe(expiredAnchor.deadline_started_at.getTime());
    expect(budget?.deadline_ms).toBe(45_000);
    expect(research.calls.findSources).toBe(2);
    expect(research.calls.extractClaims).toBe(1);
    expect(await providerQueryCount(accountId, 'extract_claims')).toBe(1);
  });

  it('a completed empty-sources run is preserved: the redelivery reuses it without re-searching', async () => {
    const research = countingResearch(() => [], extraction);
    const { accountId, jobId, workKey } = await dispatchResearch(research.provider);
    const providers = registryWithDurableLedger(research.provider);

    await runCrashingBeforeAcknowledgment(jobId, providers);

    const committed = await researchRunRow(accountId);
    expect(committed?.state).toBe('complete');
    expect((await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey }))?.state).toBe('complete');
    expect(research.calls.findSources).toBe(2);
    expect(research.calls.extractClaims).toBe(0);
    // The honest empty lookup is recorded exactly once.
    expect(await providerQueryCount(accountId, 'find_sources')).toBe(1);

    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const traces: string[] = [];
    const redelivered = await runJob(jobId, { providers, config: researchOn, onTrace: (e) => traces.push(e.name) });

    expect(redelivered.state).toBe('complete');
    const done = await getJobById(db, jobId);
    expect(done?.state).toBe('complete');
    expect(done?.result_id).toBe(committed!.id);
    expect(traces).toContain('graph_research_redelivery_reused');

    // No re-search: the provider was not invoked again, the completed run row
    // was never reopened (byte-identical) and the empty lookup was not
    // recorded twice.
    expect(research.calls.findSources).toBe(2);
    expect(research.calls.extractClaims).toBe(0);
    expect(await providerQueryCount(accountId, 'find_sources')).toBe(1);
    const after = await researchRunRow(accountId);
    expect(after?.state).toBe('complete');
    expect(after?.updated_at.getTime()).toBe(committed!.updated_at.getTime());
    expect(after?.finished_at?.getTime()).toBe(committed!.finished_at?.getTime());
    expect((await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey }))?.state).toBe('complete');
  });
});

// --- Honest failures keep failing -----------------------------------------------------------

describe('uncommitted work is never reused', () => {
  it('an expired window whose work never published still fails honestly: no run exists to reuse', async () => {
    const research = countingResearch(
      (name) => [sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`)],
      extraction,
    );
    const { accountId, jobId, workKey } = await dispatchResearch(research.provider);
    const providers = registryWithDurableLedger(research.provider);

    // The logical item's window anchored long ago and has ended: a delayed
    // claim or redelivery inherits the same row — and with no committed run
    // there is nothing to reuse, so it must refuse honestly.
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
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
    expect(await researchRunCount(accountId)).toBe(0);
    expect(research.calls.findSources).toBe(0);
    expect(research.calls.extractClaims).toBe(0);
    const done = await getJobById(db, jobId);
    expect(done?.state).toBe('failed');
  });

  it('a precommit failure keeps failing honestly: a failed run is re-attempted, never reused', async () => {
    const research = extractionFailingResearch((name) => [
      sourceDoc(name, `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}`),
    ]);
    const { accountId, jobId } = await dispatchResearch(research.provider);
    const providers = registryWithDurableLedger(research.provider);

    // Attempt 1: the sources resolve but the paid extraction fails while the
    // window is live. The handler marks the run 'failed' durably, then the
    // worker dies before the queue's terminal write.
    await expect(runCrashingBeforeAcknowledgment(jobId, providers)).rejects.toThrow('wikipedia extract HTTP 503');
    const failedRun = await researchRunRow(accountId);
    expect(failedRun?.state).toBe('failed');
    expect(research.calls.findSources).toBe(2);
    expect(research.calls.extractClaims).toBe(1);

    // The lease lapses; the redelivery re-runs the work honestly — a FAILED
    // run is not a committed pass and must never be reused.
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const traces: string[] = [];
    await expect(
      runJob(jobId, { providers, config: researchOn, onTrace: (e) => traces.push(e.name) }),
    ).rejects.toThrow('wikipedia extract HTTP 503');
    expect(research.calls.findSources).toBe(4);
    expect(research.calls.extractClaims).toBe(2);
    expect(traces).not.toContain('graph_research_redelivery_reused');
    const after = await researchRunRow(accountId);
    expect(after?.id).toBe(failedRun!.id);
    expect(after?.state).toBe('failed');
    expect((await getJobById(db, jobId))?.state).toBe('failed');
  });
});
