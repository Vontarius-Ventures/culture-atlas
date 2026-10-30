import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  JOB_HANDLERS,
  dispatchGraphResearch,
  ensureGraphWorkBudget,
  loadGraphWorkBudget,
  upsertGraphIdentity,
} from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAccount, testConfig } from '@culture-atlas/domain/testing';
import {
  createProviderRegistry,
  ProviderError,
  type ModelProfile,
  type ProviderRegistry,
  type ResearchSourceDoc,
  type StructuredTransport,
} from '@culture-atlas/providers';
import { Worker } from './worker';

/**
 * DISC-SCR-026 / VAL-DISC-006: the REAL Worker's error classification for
 * relation research when the durable logical window expires mid-flight.
 *
 * The research handler aborts its in-flight provider calls at the anchored
 * deadline through the combined window signal; a real adapter surfaces that
 * cancel as ProviderError('research', 'aborted'). This suite runs the REAL
 * Worker.execute path (claim, per-attempt timer, heartbeat, toFailure) over
 * the REAL research handler with a deterministic registry — never a live or
 * paid call — and pins the production classifications:
 *
 *  - a window-expiry abort is recorded as the typed NON-RETRYABLE
 *    service_unavailable/logical_deadline_expired outcome (never
 *    provider_unavailable, which is where the raw abort landed before the
 *    repair);
 *  - a genuine worker cancellation (cancel_requested_at while the window is
 *    still live) keeps its own classification: the job is cancelled, the
 *    window is not consumed;
 *  - a still-live provider failure keeps its own classification:
 *    provider_unavailable, retryable, window not consumed.
 */

const db = getTestDb();
afterAll(closeTestDb);

const researchOn = testConfig({ INTEREST_GRAPH_RESEARCH_ENABLED: 'true' });

// --- Fixture: the qualified, durable-ledger registry (deterministic, never live) ------

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

async function dispatchedResearchJob(research: ProviderRegistry['research']) {
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
  const { rows } = await db.query<{ id: string; dedupe_key: string }>('SELECT id, dedupe_key FROM jobs WHERE id = $1', [
    dispatched.jobId!,
  ]);
  return { accountId, jobId: rows[0]!.id, workKey: rows[0]!.dedupe_key, providers };
}

async function jobRow(jobId: string): Promise<{
  state: string;
  error_code: string | null;
  error_message: string | null;
  error_retryable: boolean | null;
}> {
  const { rows } = await db.query<{
    state: string;
    error_code: string | null;
    error_message: string | null;
    error_retryable: boolean | null;
  }>('SELECT state, error_code, error_message, error_retryable FROM jobs WHERE id = $1', [jobId]);
  return rows[0]!;
}

async function runState(accountId: string): Promise<string | null> {
  const { rows } = await db.query<{ state: string }>(
    `SELECT state FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'research'`,
    [accountId],
  );
  return rows[0]?.state ?? null;
}

/** A hanging source lookup that reports the REAL adapter's abort shape when the window signal fires. */
function windowAbortingResearch(): { provider: ProviderRegistry['research']; started: Promise<void> } {
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  const available = { status: 'available' as const, provider: 'fake' };
  const provider = {
    id: 'research:fake',
    capability: () => ({ sources: available, claims: available }),
    findSources: async (_query: { name: string }, options?: { signal?: AbortSignal }) => {
      release();
      await new Promise<void>((resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error('the window never aborted the lookup')), 10_000);
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
        options.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(fallback);
            resolve();
          },
          { once: true },
        );
      });
      // The production Wikipedia adapter's exact shape for a caller-signal
      // cancel (packages/providers/src/research/wikipedia.ts getJson).
      throw new ProviderError('research', 'aborted', 'aborted');
    },
    extractClaims: async () => {
      throw new Error('extraction must never run after the window aborted the lookup');
    },
  };
  return { provider: provider as unknown as ProviderRegistry['research'], started };
}

/** An immediately failing source lookup: a still-live window's provider failure. */
function failingResearch(): ProviderRegistry['research'] {
  const available = { status: 'available' as const, provider: 'fake' };
  return {
    id: 'research:fake',
    capability: () => ({ sources: available, claims: available }),
    findSources: async () => {
      throw new ProviderError('research', 'server', 'wikipedia search HTTP 503');
    },
    extractClaims: async () => {
      throw new Error('extraction must never run after the source failure');
    },
  } as unknown as ProviderRegistry['research'];
}

describe('the real Worker classifies research deadline expiry, cancellation and provider failure (DISC-SCR-026)', () => {
  it('a window-expiry provider abort records the typed non-retryable logical-deadline outcome, never provider_unavailable', async () => {
    // A near-expiry redelivery shape: the durable window is almost over when
    // the worker claims the job, so the per-attempt timer (60s) is still
    // live while the anchored deadline aborts the in-flight lookup. The raw
    // ProviderError('research', 'aborted') must be classified as the typed
    // outcome at the real Worker boundary: failed, non-retryable,
    // service_unavailable with the window-expired message.
    const fake = windowAbortingResearch();
    const { accountId, jobId, workKey, providers } = await dispatchedResearchJob(fake.provider);

    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'research',
      workKey,
      qlooAttemptsMax: 0,
      deadlineMs: 600,
    });

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

    const job = await jobRow(jobId);
    expect(job.state).toBe('failed');
    expect(job.error_code).toBe('service_unavailable');
    expect(job.error_retryable).toBe(false);
    expect(job.error_message).toBe('This graph work window expired; a new one is on the way.');
    // The window durably stopped and the run is an honest failure; the
    // aborted lookup was never recorded as a completed find_sources.
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
    expect(await runState(accountId)).toBe('failed');
    const { rows: lookups } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_queries WHERE owner_account_id = $1 AND operation = 'find_sources'`,
      [accountId],
    );
    expect(Number(lookups[0]!.n)).toBe(0);
  });

  it('a genuine worker cancellation keeps its own classification: cancelled, window not consumed', async () => {
    // The same hanging lookup, but the worker's OWN grant dies mid-call
    // (cancel_requested_at while the window is still live): the combined
    // signal aborts because of the worker, not the deadline. The raw abort
    // keeps the worker's cancellation classification — the job is cancelled,
    // never relabeled as the window expiring, and the live window stays
    // unconsumed for the next attempt.
    const fake = windowAbortingResearch();
    const { accountId, jobId, workKey, providers } = await dispatchedResearchJob(fake.provider);

    const worker = new Worker({
      db,
      providers,
      config: researchOn,
      handlers: JOB_HANDLERS,
      jobIds: [jobId],
      log: () => undefined,
      heartbeatMs: 150,
    });
    const drained = worker.drain();
    void drained.catch(() => undefined);
    // The lookup is hanging on the combined signal: request the worker's own
    // stop now, while the durable window is still live.
    await fake.started;
    await db.query('UPDATE jobs SET cancel_requested_at = now() WHERE id = $1', [jobId]);
    await drained;

    const job = await jobRow(jobId);
    expect(job.state).toBe('cancelled');
    expect(job.error_code).toBeNull();
    // The window was NOT consumed: this was the worker's stop, not the
    // deadline. The run is honest failed lineage.
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('active');
    expect(await runState(accountId)).toBe('failed');
  });

  it('a still-live provider failure keeps its own classification: provider_unavailable, retryable', async () => {
    // Truthful classification cuts both ways: a provider failing while the
    // window is still live surfaces as provider_unavailable — re-queued with
    // backoff, never relabeled deadline-expired, and the live window stays
    // unconsumed.
    const { accountId, jobId, workKey, providers } = await dispatchedResearchJob(failingResearch());

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

    const job = await jobRow(jobId);
    expect(job.state).toBe('queued');
    expect(job.error_code).toBe('provider_unavailable');
    expect(job.error_retryable).toBe(true);
    expect(job.error_message).toBe('Part of this is taking longer than usual. Try again in a little while.');
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('active');
    expect(await runState(accountId)).toBe('failed');
  });
});

describe('a successful research pass closes its durable work-budget window', () => {
  it('the honest empty-sources completion leaves no active window behind (ops metric hygiene)', async () => {
    // A completed logical item must close its budget window exactly like the
    // expansion pass does; before the repair the window stayed 'active'
    // forever after a successful run, inflating GraphBudgetWindowsStuck.
    // Deterministic registry, never a live or paid call.
    const available = { status: 'available' as const, provider: 'fake' };
    const emptySources = {
      id: 'research:fake',
      capability: () => ({ sources: available, claims: available }),
      findSources: async () => [] as ResearchSourceDoc[],
      extractClaims: async () => {
        throw new Error('extraction must never run when no approved source was found');
      },
    } as unknown as ProviderRegistry['research'];
    const { accountId, jobId, workKey, providers } = await dispatchedResearchJob(emptySources);

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

    const job = await jobRow(jobId);
    expect(job.state).toBe('complete');
    expect(await runState(accountId)).toBe('complete');
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('complete');
  });
});
