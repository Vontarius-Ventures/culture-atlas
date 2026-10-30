import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  JOB_HANDLERS,
  claimJobs,
  dispatchGraphResearch,
  getJobById,
  loadGraphWorkBudget,
  runStageOnce,
  upsertGraphIdentity,
  type JobContext,
  type JobType,
} from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAccount, testConfig } from '@culture-atlas/domain/testing';
import {
  createProviderRegistry,
  ProviderError,
  type ModelProfile,
  type ProviderRegistry,
  type ResearchExtraction,
  type ResearchSourceDoc,
  type StructuredTransport,
} from '@culture-atlas/providers';
import { Worker } from './worker';

/**
 * The real-Worker half of the committed research pass's crash recovery
 * (VAL-DISC-005/006): the worker dies after the pass's run/proposals/budget
 * commit but before the queue acknowledgment, the lease lapses, and the REAL
 * Worker reclaims the job past its original 45-second window. The reclaim must
 * end in the correct completed terminal status — the ORIGINAL run id as the
 * job's result — with the complete window untouched (never overwritten
 * 'stopped', never re-anchored) and zero new provider work.
 *
 * The deterministic research adapter here is an explicit registry override
 * over the durable test ledger: never a live or paid call.
 */

const db = getTestDb();
afterAll(closeTestDb);

const researchOn = testConfig({ INTEREST_GRAPH_RESEARCH_ENABLED: 'true' });

// --- Fixture: the qualified, durable-ledger registry (deterministic, never live) ------

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

function sourceDoc(name: string, url: string): ResearchSourceDoc {
  return {
    url,
    title: `${name} — test source`,
    publisher: 'Wikipedia',
    retrieved_at: '2026-10-28T00:00:00.000Z',
    extract: `Test extract about ${name}.`,
  };
}

/** One factual-cited claim: the extraction a committed proposal shape needs. */
function extraction(subjectName: string, url: string): ResearchExtraction {
  return {
    overview: `${subjectName} is a test reference.`,
    sections: [{ heading: 'Context', body: `${subjectName} is documented.`, claim_indexes: [0] }],
    claims: [{ text: `${subjectName} is a test reference.`, claim_type: 'factual', source_urls: [url] }],
  };
}

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

// --- Fixture: one dispatched research job with a counting provider ---------------------

interface CountingResearch {
  provider: ProviderRegistry['research'];
  calls: { findSources: number; extractClaims: number };
}

function countingResearch(): CountingResearch {
  const calls = { findSources: 0, extractClaims: 0 };
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
      return extraction(input.name, input.sources[0]!.url);
    },
  };
  return { provider: provider as unknown as ProviderRegistry['research'], calls };
}

async function dispatchedResearchJob(research: ProviderRegistry['research']): Promise<{
  accountId: string;
  jobId: string;
  workKey: string;
  providers: ProviderRegistry;
}> {
  const accountId = (await insertAccount(db)).accountId;
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
  const providers = registryWithDurableLedger(research);
  const dispatched = await dispatchGraphResearch(db, {
    accountId,
    config: researchOn,
    providers,
    subjectNodeId: subject.id,
    objectNodeId: object.id,
    predicate: 'CREATED_BY',
  });
  expect(dispatched.dispatched).toBe(true);
  const job = await getJobById(db, dispatched.jobId!);
  if (!job?.dedupe_key) throw new Error('research job has no dedupe key');
  return { accountId, jobId: dispatched.jobId!, workKey: job.dedupe_key, providers };
}

// --- The crash seam ------------------------------------------------------------------------

/**
 * Claim `jobId` at its next real attempt and run its REAL handler to
 * completion — then die like a worker that crashed BETWEEN the handler's
 * return and the queue acknowledgment: NO terminal queue write. Every
 * durable write the pass made (the proposals, the run's 'complete' state,
 * the closed window, the stage and provider-query records) stands, and the
 * claimed row keeps its 'running' state and the claim's lease.
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

// --- The real Worker reclaims the crashed job ----------------------------------------------

describe('the real Worker completes a redelivered committed research pass past its window', () => {
  it('a lease-lapse reclaim after the original window ends in the correct completed status with the original run id', async () => {
    const research = countingResearch();
    const { accountId, jobId, workKey, providers } = await dispatchedResearchJob(research.provider);

    // Attempt 1: the pass commits (proposals, run 'complete', window closed),
    // then the worker dies before the queue acknowledgment.
    await runCrashingBeforeAcknowledgment(jobId, providers);

    const { rows: runs } = await db.query<{ id: string; state: string }>(
      `SELECT id, state FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'research'`,
      [accountId],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe('complete');
    const runId = runs[0]!.id;
    expect(research.calls.findSources).toBe(2);
    expect(research.calls.extractClaims).toBe(1);

    // The reclaim arrives after the original 45-second window ended.
    await db.query(
      `UPDATE graph_work_budgets SET deadline_started_at = now() - interval '60 seconds'
        WHERE owner_account_id = $1 AND work_key = $2`,
      [accountId, workKey],
    );
    const expiredAnchor = (await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey }))!;
    expect(expiredAnchor.state).toBe('complete');

    // The lease lapses; the REAL Worker reclaims and executes the redelivery
    // through the production claim → execute → completeJob path.
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const worker = new Worker({
      db,
      providers,
      config: researchOn,
      handlers: JOB_HANDLERS,
      jobIds: [jobId],
      log: () => undefined,
      heartbeatMs: 500,
    });
    await worker.drain();

    const job = await getJobById(db, jobId);
    expect(job?.state).toBe('complete');
    expect(job?.result_type).toBe('graph_research');
    expect(job?.result_id).toBe(runId);

    // The committed run was reused: still the single complete run row, and
    // the redelivered attempt invoked no provider again.
    const { rows: after } = await db.query<{ id: string; state: string }>(
      `SELECT id, state FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'research'`,
      [accountId],
    );
    expect(after).toEqual([{ id: runId, state: 'complete' }]);
    expect(research.calls.findSources).toBe(2);
    expect(research.calls.extractClaims).toBe(1);
    const { rows: queries } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_queries WHERE owner_account_id = $1 AND provider = 'research' AND operation = 'extract_claims'`,
      [accountId],
    );
    expect(Number(queries[0]!.n)).toBe(1);

    // The complete window is unchanged: complete, never overwritten
    // 'stopped', never re-anchored.
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('complete');
    expect(budget?.deadline_started_at.getTime()).toBe(expiredAnchor.deadline_started_at.getTime());
    expect(budget?.deadline_ms).toBe(45_000);
  });
});
