import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createProviderRegistry,
  ModelSpendLedger,
  PostgresSpendStore,
  ProviderError,
  type GatewayResponse,
  type ModelIdentity,
  type ModelProfile,
  type ProviderRegistry,
  type ResearchSourceDoc,
  type StructuredTransport,
} from '@culture-atlas/providers';
import { runJob } from '../test-support/library';
import { closeTestDb, getTestDb, insertAccount, testConfig } from '../testing';
import { graphResearchDedupeKey } from '../jobs/dedupe';
import { enqueueJob } from '../jobs/queue';
import { upsertGraphIdentity } from './evidence';
import { dispatchGraphResearch, researchDispatchGate } from './research-gate';

/**
 * DISC-SCR-010 (VAL-DISC-005/006): optional paid graph research is bound to an
 * ACTUALLY QUALIFIED effective adapter whose every primary/fallback paid call
 * is account/global reservation-bound.
 *
 * The dispatch gate may not be satisfied by generic research availability plus
 * the mere presence of a gateway ledger:
 *  - an OBSERVED capability of a demo-allowed (CONCENTRATE_DEMO_ALLOW_ROLES)
 *    role is not independent role qualification;
 *  - MODEL_FALLBACK=elorian wraps the registry's research claims chain in an
 *    Elorian leg whose paid calls escape the Concentrate durable ledger.
 *
 * These tests run through the REAL registry (no research/text overrides), a
 * controlled transport (never a live provider) and the durable Postgres spend
 * store of the isolated test database: zero real spend, exact accounting. The
 * unrelated legacy model fallback (capture analysis, composer, legacy claim
 * extraction) keeps its behavior and is asserted to remain in place.
 */

const db = getTestDb();

/** Every account this file created: afterAll settles only these attempts. */
const createdAccounts: string[] = [];

/**
 * Settle this file's own ledger attempts and lift the global pause. Unsettled
 * `unknown` attempts count against the shared per-run ledger's unknown-spend
 * cap, so leaving them behind would corrupt later suites' budget decisions
 * (the same discipline model-gateway/postgres.test.ts follows). NEVER touches
 * other files' accounts or rows.
 */
afterAll(async () => {
  const store = new PostgresSpendStore(db);
  const ledger = new ModelSpendLedger(store, {
    dailyMicros: 1_000_000_000,
    accountDailyMicros: 1_000_000_000,
    maxUnknownMicros: 1_000_000_000,
    accountDailyAnalyses: 1_000,
  });
  for (const attempt of (await store.read()).attempts.filter((a) =>
    createdAccounts.includes(a.identity.accountId),
  )) {
    if (attempt.state === 'reserved') await ledger.finish(attempt.id, 'test-cleanup');
    if (attempt.state !== 'settled') await ledger.reconcile(attempt.id, 0);
  }
  await ledger.resume();
  await closeTestDb();
});

const researchOn = testConfig({ INTEREST_GRAPH_RESEARCH_ENABLED: 'true' });

/** A research_text profile the gateway accepts (synthetic: never a production route). */
const researchProfile: ModelProfile = {
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

/** A raw extraction payload matching the reference_notes schema exactly. */
const rawExtractionBody = (name: string, url: string) => ({
  overview_claim_indexes: [0],
  sections: [{ heading: 'Context', claim_indexes: [0] }],
  claims: [
    { text: `${name} is a documented reference.`, claim_type: 'factual', source_urls: [url] },
    { text: `${name} feels influential.`, claim_type: 'interpretive', source_urls: [url] },
  ],
});

const gatewayResponse = (body: unknown): GatewayResponse => ({
  id: 'resp_fixture',
  requestId: 'req_fixture',
  model: researchProfile.model,
  actualProvider: null,
  text: JSON.stringify(body),
  outcome: 'complete',
  usage: { inputTokens: 120, outputTokens: 40 },
});

function sourceDoc(name: string, url: string): ResearchSourceDoc {
  return {
    url,
    title: `${name} — test source`,
    publisher: 'Wikipedia',
    retrieved_at: '2026-10-28T00:00:00.000Z',
    extract: `Test extract about ${name}.`,
  };
}

/** Wraps a transport with a call counter: proves exactly which paid calls happened. */
function countingTransport(transport: StructuredTransport) {
  const mock = vi.fn(transport);
  return { transport: mock as unknown as StructuredTransport, mock };
}

/** The REAL registry (no research/text overrides) over the durable test ledger. */
function realRegistry(input: {
  env?: Record<string, string | undefined>;
  transport: StructuredTransport;
  /** Defaults to a genuinely qualified research_text role. */
  qualification?: () => 'qualified' | 'catalog-compatible' | 'configured';
  limits?: { daily: string; account: string; unknown: string; total?: string };
}): ProviderRegistry {
  return createProviderRegistry(
    {
      STORAGE_DRIVER: 'memory',
      LLM_PROVIDER: 'concentrate',
      CONCENTRATE_API_KEY: 'test-concentrate-key',
      CONCENTRATE_REQUIRE_ZDR: 'true',
      CONCENTRATE_ALLOW_CONTENT_LOGGING: 'false',
      MODEL_DAILY_SPEND_LIMIT_USD: input.limits?.daily ?? '10',
      MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD: input.limits?.account ?? '2',
      MODEL_MAX_UNKNOWN_SPEND_USD: input.limits?.unknown ?? '0.01',
      MODEL_TOTAL_SPEND_LIMIT_USD: input.limits?.total ?? '100',
      ...input.env,
    },
    {},
    {
      db: getTestDb(),
      profiles: { research_text: researchProfile },
      qualification: input.qualification ?? (() => 'qualified'),
      transport: input.transport,
    },
  );
}

/** A registry whose research was replaced by an explicit deterministic adapter. */
function overrideRegistry(input: {
  transport: StructuredTransport;
  research: ProviderRegistry['research'];
  qualification?: () => 'qualified' | 'catalog-compatible' | 'configured';
}): ProviderRegistry {
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
    { research: input.research },
    {
      db: getTestDb(),
      profiles: { research_text: researchProfile },
      qualification: input.qualification ?? (() => 'qualified'),
      transport: input.transport,
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

/** A verified server-owned identity bound to a real isolated account. */
async function identity(prefix: string): Promise<ModelIdentity> {
  const { accountId } = await insertAccount(db);
  createdAccounts.push(accountId);
  return { accountId, jobId: `research-${prefix}-${randomUUID()}`, attemptKey: `${prefix}:extract:0` };
}

/** Clears a leftover global spend pause so the shared per-run ledger starts clean. */
async function clearSpendPause(reg: ProviderRegistry): Promise<void> {
  await reg.modelGateway?.ledger?.resume();
}

interface AttemptRow {
  role: string;
  account_id: string;
  requested_model: string;
  reserved_micros: string;
  state: string;
  outcome: string;
}

async function attemptsOf(accountId: string): Promise<AttemptRow[]> {
  const { rows } = await db.query<AttemptRow>(
    `SELECT role, account_id, requested_model, reserved_micros::text, state, outcome
       FROM inference_attempts WHERE account_id = $1 ORDER BY started_at, id`,
    [accountId],
  );
  return rows;
}

async function jobsOfKind(accountId: string): Promise<{ id: string; state: string }[]> {
  const { rows } = await db.query<{ id: string; state: string }>(
    `SELECT id, state FROM jobs WHERE owner_account_id = $1 AND type = 'research_graph_relation'`,
    [accountId],
  );
  return rows;
}

const successTransport: StructuredTransport = async () =>
  gatewayResponse(rawExtractionBody('Test Work', 'https://en.wikipedia.org/wiki/Test'));

// --- The registry declares the effective claims chain ---------------------------------

describe('the effective research claims path (DISC-SCR-010)', () => {
  it('declares a qualified gateway primary leg with no unreserved fallback leg', () => {
    const reg = realRegistry({ transport: successTransport });
    expect(reg.researchClaimsPath).toEqual({
      primaryRunner: true,
      demo: false,
      explicitOverride: false,
      legs: [{ provider: 'text:concentrate:fixture/model-1', reservationBound: true }],
    });
  });

  it('declares the unreserved Elorian leg when MODEL_FALLBACK=elorian, and keeps the legacy fallback for other consumers', () => {
    const reg = realRegistry({
      env: { MODEL_FALLBACK: 'elorian', ELORIAN_API_KEY: 'synthetic-elorian-key' },
      transport: successTransport,
    });
    expect(reg.researchClaimsPath).toEqual({
      primaryRunner: true,
      demo: false,
      explicitOverride: false,
      legs: [
        { provider: 'text:concentrate:fixture/model-1', reservationBound: true },
        { provider: 'text:elorian:elorian-1-agent', reservationBound: false },
      ],
    });
    // Unrelated legacy consumers keep their operator-chosen fallback (DISC-SCR-010 preserves it).
    expect(reg.text.id).toContain('fallback:');
    expect(reg.vlm.id).toContain('fallback:');
  });

  it('declares a demo role and marks explicit overrides honestly', () => {
    const demo = realRegistry({
      env: { CONCENTRATE_DEMO_ALLOW_ROLES: 'research_text', NODE_ENV: 'test' },
      transport: successTransport,
      qualification: () => 'catalog-compatible',
    });
    expect(demo.researchClaimsPath.demo).toBe(true);
    expect(demo.researchClaimsPath.primaryRunner).toBe(true);

    const overridden = overrideRegistry({
      transport: successTransport,
      research: {
        id: 'research:fake',
        capability: () => ({
          sources: { status: 'available', provider: 'fake' },
          claims: { status: 'available', provider: 'fake' },
        }),
        findSources: async () => [],
        extractClaims: async () => ({ overview: '', sections: [], claims: [] }),
      } as unknown as ProviderRegistry['research'],
    });
    expect(overridden.researchClaimsPath.explicitOverride).toBe(true);
    expect(overridden.researchClaimsPath.legs).toEqual([]);
  });

  it('without a qualified gateway role there is no reservation-bound primary leg', () => {
    const reg = realRegistry({ transport: successTransport, qualification: () => 'catalog-compatible' });
    expect(reg.researchClaimsPath.primaryRunner).toBe(false);
    expect(reg.researchClaimsPath.legs[0]!.reservationBound).toBe(false);
  });
});

// --- The gate binds paid research to that path ----------------------------------------

describe('the research gate refuses unqualified or unbound paths with zero paid calls', () => {
  it('refuses a demo-observed role even after an observed available capability: no dispatch, no paid call', async () => {
    const counted = countingTransport(async () => gatewayResponse({ ok: true }));
    const reg = realRegistry({
      env: { CONCENTRATE_DEMO_ALLOW_ROLES: 'research_text', NODE_ENV: 'test' },
      transport: counted.transport,
      qualification: () => 'catalog-compatible',
    });
    await clearSpendPause(reg);

    // Observe the demo role once through the real registry text model: the
    // OBSERVED capability becomes 'available' — the old gate's only signal.
    const probe = await reg.text.generateStructured(
      { system: 's', prompt: 'p', schema: z.object({ ok: z.boolean() }), schemaName: 'probe' },
      { modelIdentity: await identity('demo-probe') },
    );
    expect(probe.data.ok).toBe(true);
    expect(reg.research.capability().claims.status).toBe('available');

    // The gate refuses anyway: demo observation is not role qualification.
    const { accountId } = await insertAccount(db);
    const gate = await researchDispatchGate(db, { accountId, config: researchOn, providers: reg });
    expect(gate).toEqual({ allowed: false, reason: 'role_not_qualified' });

    const { subjectNodeId, objectNodeId } = await nodePair();
    const refused = await dispatchGraphResearch(db, {
      accountId,
      config: researchOn,
      providers: reg,
      subjectNodeId,
      objectNodeId,
      predicate: 'CREATED_BY',
    });
    expect(refused).toEqual({ dispatched: false, reason: 'role_not_qualified' });
    expect(await jobsOfKind(accountId)).toHaveLength(0);
    // Zero paid research calls: the only transport call is the probe above.
    expect(counted.mock).toHaveBeenCalledTimes(1);
  });

  it('refuses the real MODEL_FALLBACK=elorian registry path: zero paid calls, zero proposals', async () => {
    // A canary on global fetch: the unreserved Elorian leg reaches the network
    // through plain fetch, so any call of that leg — even one — is observed.
    const fetchCalls = vi.fn();
    vi.stubGlobal('fetch', fetchCalls);
    try {
      const counted = countingTransport(successTransport);
      const withFallback = realRegistry({
        env: { MODEL_FALLBACK: 'elorian', ELORIAN_API_KEY: 'synthetic-elorian-key' },
        transport: counted.transport,
      });

      const { accountId } = await insertAccount(db);
      const gate = await researchDispatchGate(db, { accountId, config: researchOn, providers: withFallback });
      expect(gate).toEqual({ allowed: false, reason: 'fallback_unreserved' });

      const { subjectNodeId, objectNodeId } = await nodePair();
      const refused = await dispatchGraphResearch(db, {
        accountId,
        config: researchOn,
        providers: withFallback,
        subjectNodeId,
        objectNodeId,
        predicate: 'CREATED_BY',
      });
      expect(refused).toEqual({ dispatched: false, reason: 'fallback_unreserved' });
      expect(await jobsOfKind(accountId)).toHaveLength(0);
      // Neither the reservation-bound primary nor the unreserved Elorian leg ran.
      expect(counted.mock).toHaveBeenCalledTimes(0);
      expect(fetchCalls).toHaveBeenCalledTimes(0);
    } finally {
      vi.unstubAllGlobals();
    }

    // Control: the SAME deployment without the fallback leg dispatches.
    const clean = realRegistry({ transport: successTransport });
    const controlAccount = (await insertAccount(db)).accountId;
    const { subjectNodeId: subject, objectNodeId: object } = await nodePair();
    const control = await dispatchGraphResearch(db, {
      accountId: controlAccount,
      config: researchOn,
      providers: clean,
      subjectNodeId: subject,
      objectNodeId: object,
      predicate: 'CREATED_BY',
    });
    expect(control.dispatched).toBe(true);
  });

  it('an explicit deterministic override still requires the deployment qualified role and durable ledger', async () => {
    const available = { status: 'available' as const, provider: 'fake' };
    const fake = {
      id: 'research:fake',
      capability: () => ({ sources: available, claims: available }),
      findSources: async () => [] as ResearchSourceDoc[],
      extractClaims: async () => ({ overview: '', sections: [], claims: [] }),
    } as unknown as ProviderRegistry['research'];
    const neverCalled: StructuredTransport = async () => {
      throw new ProviderError('model-gateway', 'unavailable', 'must not be called');
    };

    // Override + qualified role + durable ledger: the deterministic fault path may dispatch.
    const allowed = await researchDispatchGate(db, {
      accountId: (await insertAccount(db)).accountId,
      config: researchOn,
      providers: overrideRegistry({ transport: neverCalled, research: fake }),
    });
    expect(allowed).toEqual({ allowed: true });

    // The same override without a qualified research_text role: fail closed.
    const refused = await researchDispatchGate(db, {
      accountId: (await insertAccount(db)).accountId,
      config: researchOn,
      providers: overrideRegistry({
        transport: neverCalled,
        research: fake,
        qualification: () => 'catalog-compatible',
      }),
    });
    expect(refused).toEqual({ allowed: false, reason: 'role_not_qualified' });
  });

  it('a stale queued job re-checks at run time: the unreserved fallback refuses before any call', async () => {
    const fetchCalls = vi.fn();
    vi.stubGlobal('fetch', fetchCalls);
    try {
      const counted = countingTransport(successTransport);
      const withFallback = realRegistry({
        env: { MODEL_FALLBACK: 'elorian', ELORIAN_API_KEY: 'synthetic-elorian-key' },
        transport: counted.transport,
      });
      const { accountId } = await insertAccount(db);
      const { subjectNodeId, objectNodeId } = await nodePair();
      const dedupeKey = graphResearchDedupeKey({
        accountId,
        subjectNodeId,
        objectNodeId,
        predicate: 'CREATED_BY',
        associationSubtype: null,
      });

      // A job enqueued before the operator enabled the fallback (or a stale
      // redelivery): the run-time gate, not just dispatch, must fail closed.
      const { job } = await enqueueJob(db, {
        type: 'research_graph_relation',
        owner: { kind: 'account', accountId },
        payload: {
          account_id: accountId,
          subject_node_id: subjectNodeId,
          object_node_id: objectNodeId,
          predicate: 'CREATED_BY',
        },
        dedupeKey,
        maxAttempts: 3,
        resultType: 'graph_research',
      });

      await expect(runJob(job.id, { providers: withFallback, config: researchOn })).rejects.toMatchObject({
        details: { rule: 'fallback_unreserved' },
      });
      const { rows } = await db.query<{ state: string; error_code: string; error_retryable: boolean }>(
        `SELECT state, error_code, error_retryable FROM jobs WHERE id = $1`,
        [job.id],
      );
      expect(rows[0]).toMatchObject({ state: 'failed', error_code: 'service_unavailable', error_retryable: false });

      // Zero paid calls of either leg — including the unreserved Elorian leg —
      // and nothing published.
      expect(counted.mock).toHaveBeenCalledTimes(0);
      expect(fetchCalls).toHaveBeenCalledTimes(0);
      const { rows: runs } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'research'`,
        [accountId],
      );
      expect(Number(runs[0]!.n)).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// --- The qualified primary path charges durable limits ---------------------------------

describe('the qualified primary path charges the durable account/global limits (VAL-DISC-005/006)', () => {
  it('a successful extraction reserves and settles exactly one durable ledger attempt', async () => {
    const counted = countingTransport(successTransport);
    const reg = realRegistry({ transport: counted.transport });
    await clearSpendPause(reg);
    const who = await identity('charge');
    const url = 'https://en.wikipedia.org/wiki/Test';

    const extraction = await reg.research.extractClaims(
      { name: 'Test Work', type: 'work', sources: [sourceDoc('Test Work', url)], maxClaims: 8 },
      { modelIdentity: who },
    );

    expect(extraction.claims).toHaveLength(2);
    expect(counted.mock).toHaveBeenCalledTimes(1);
    expect(reg.modelGateway?.ledger?.store.durable).toBe(true);

    const attempts = await attemptsOf(who.accountId);
    expect(attempts).toEqual([
      {
        role: 'research_text',
        account_id: who.accountId,
        requested_model: researchProfile.model,
        reserved_micros: '100',
        state: 'unknown',
        outcome: 'complete',
      },
    ]);
  });

  it.each([
    [
      'timeout',
      (async () => {
        throw new ProviderError('model-gateway', 'timeout', 'fixture timeout');
      }) as StructuredTransport,
      'timeout',
    ],
    [
      'invalid output',
      (async () => gatewayResponse({ overview_claim_indexes: 'not-an-array' })) as StructuredTransport,
      'invalid_response',
    ],
  ])('%s: honest failure, durably accounted, no unreserved escape', async (_name, transport, outcome) => {
    const counted = countingTransport(transport);
    const reg = realRegistry({ transport: counted.transport });
    await clearSpendPause(reg);
    const who = await identity(outcome);

    await expect(
      reg.research.extractClaims(
        {
          name: 'Test Work',
          type: 'work',
          sources: [sourceDoc('Test Work', 'https://en.wikipedia.org/wiki/Test')],
          maxClaims: 8,
        },
        { modelIdentity: who },
      ),
    ).rejects.toMatchObject({ kind: outcome });

    // One bounded paid attempt, accounted in the durable ledger; no fallback leg exists.
    expect(counted.mock).toHaveBeenCalledTimes(1);
    const attempts = await attemptsOf(who.accountId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe(outcome);
    expect(attempts[0]!.state).toBe('unknown');
    expect(attempts[0]!.reserved_micros).toBe('100');
  });

  it('cancellation: the aborted outcome is durably accounted and never escapes to a fallback', async () => {
    const counted = countingTransport(
      (async (_request, { signal }) =>
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new ProviderError('model-gateway', 'timeout', 'fixture hung')),
            5_000,
          );
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new ProviderError('model-gateway', 'aborted', 'cancelled'));
            },
            { once: true },
          );
        })) as StructuredTransport,
    );
    const reg = realRegistry({ transport: counted.transport });
    await clearSpendPause(reg);
    const who = await identity('cancelled');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(
      reg.research.extractClaims(
        {
          name: 'Test Work',
          type: 'work',
          sources: [sourceDoc('Test Work', 'https://en.wikipedia.org/wiki/Test')],
          maxClaims: 8,
        },
        { modelIdentity: who, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ kind: 'aborted' });

    expect(counted.mock).toHaveBeenCalledTimes(1);
    const attempts = await attemptsOf(who.accountId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'aborted', state: 'unknown' });
  });

  it('payment rejection (402): the credits pause is durable and the next call refuses before the transport', async () => {
    const paymentRejected = countingTransport(
      (async () => {
        throw new ProviderError('model-gateway', 'budget_exhausted', 'credits exhausted', { status: 402 });
      }) as StructuredTransport,
    );
    const reg = realRegistry({ transport: paymentRejected.transport });
    await clearSpendPause(reg);
    const who = await identity('credits');
    const call = (attemptKey: string) =>
      reg.research.extractClaims(
        {
          name: 'Test Work',
          type: 'work',
          sources: [sourceDoc('Test Work', 'https://en.wikipedia.org/wiki/Test')],
          maxClaims: 8,
        },
        { modelIdentity: { ...who, attemptKey } },
      );

    await expect(call('credits:0')).rejects.toMatchObject({ kind: 'budget_exhausted' });

    const attempts = await attemptsOf(who.accountId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'budget_exhausted', state: 'unknown' });
    const { rows: control } = await db.query<{ pause: unknown }>(
      `SELECT pause FROM model_gateway_control WHERE id = 1`,
    );
    expect((control[0]!.pause as { reason: string }).reason).toBe('credits');

    // The durable pause refuses the next attempt BEFORE any paid call.
    const paidBefore = paymentRejected.mock.mock.calls.length;
    await expect(call('credits:1')).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(paymentRejected.mock.mock.calls.length).toBe(paidBefore);
    expect(await attemptsOf(who.accountId)).toHaveLength(1);

    // Test hygiene: lift the global credits pause for the shared per-run ledger.
    await reg.modelGateway?.ledger?.resume();
  });

  it('budget rejection: the durable limits refuse before the transport with zero paid calls', async () => {
    const counted = countingTransport(successTransport);
    const reg = realRegistry({
      transport: counted.transport,
      // The daily global limit (50 micros) is below one reservation (100 micros).
      limits: { daily: '0.00005', account: '0.0001', unknown: '0.001' },
    });
    await clearSpendPause(reg);
    const who = await identity('limits');

    await expect(
      reg.research.extractClaims(
        {
          name: 'Test Work',
          type: 'work',
          sources: [sourceDoc('Test Work', 'https://en.wikipedia.org/wiki/Test')],
          maxClaims: 8,
        },
        { modelIdentity: who },
      ),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });

    // The reservation was refused: no paid call, no attempt row.
    expect(counted.mock).toHaveBeenCalledTimes(0);
    expect(await attemptsOf(who.accountId)).toHaveLength(0);
  });
});
