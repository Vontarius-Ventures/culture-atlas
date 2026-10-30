import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolDb } from '../db/pool';
import { activeKills, evaluateFeatureFlags, type FeatureFlagInputs } from './feature-flags';
import { liftFeatureKill, setFeatureKill } from './feature-flags';
import { discoveryEnabledForAccount } from '../interest-graph/expansion';
import { noteExplicitIntent, projectionEnabledForAccount } from '../interest-graph/intent';
import { feedGraphReadGate } from '../interest-graph/feed-reads';
import { researchDispatchGate } from '../interest-graph/research-gate';
import { dispatchGraphExpansion } from '../interest-graph/sweeper';
import { createIsolatedDatabase, insertAccount, testConfig } from '../testing';

/**
 * VAL-OPS-001 flag parity: the four PR 8 graph flags must agree across the
 * SHARED client-facing evaluation (evaluateFeatureFlags, the surface behind
 * GET /v2/capabilities) and the SERVER policies that actually enforce them
 * (the projection intent gate, the discovery read/dispatch/expansion gate and
 * the research dispatch gate), for every operator opt-in combination and
 * every kill shape (environment kill list, global database kill, account
 * database kill, another account's kill).
 *
 * Behavioral corollaries pinned here: projection alone never switches live
 * graph reads or buys research, and the optional framework shadow alone
 * changes nothing at all — no intents, no dispatch, no reads.
 */

let isoDb: PoolDb;
let dropIso: () => Promise<void>;

beforeAll(async () => {
  const created = await createIsolatedDatabase('flagparity');
  isoDb = created.db;
  dropIso = created.drop;
});
afterAll(async () => {
  await dropIso();
});

const on = (value: string | undefined) => value === 'true' || value === '1';

/** Minimal inputs: the graph flags' gates read only `killed` and the opt-ins. */
function flagInputs(
  over: { killed: ReadonlySet<string>; interestGraph: FeatureFlagInputs['optIn']['interestGraph'] },
): FeatureFlagInputs {
  return {
    killed: over.killed,
    mediaCreationEnabled: true,
    cameraVideoEnabled: true,
    videoDecoderQualified: true,
    glasses: {
      buildSupported: false,
      channelEligible: false,
      rolloutEligible: false,
      deviceCompatible: false,
      permissionGranted: false,
      locallyReady: false,
    },
    remote: { armedLocally: false, sameAccount: false, freshDeviceState: false },
    audio: { qualifiedAudio: false, microphonePermission: false, sourceSelected: false },
    analysis: {
      keyConfigured: false,
      profileQualified: false,
      qualityQualified: false,
      privacyVerified: false,
      budgetAvailable: false,
      providerReady: false,
      enrichReady: false,
      verifyReady: false,
    },
    agentApiConfigured: false,
    sharingConfigured: false,
    onboarding: { requiredConfigured: true, seedConfigured: true, whileWeLookConfigured: true },
    optIn: {
      automaticAnalysis: false,
      nativeVideoModelInput: false,
      agentRemoteCapture: false,
      analysisVerifier: false,
      interestGraph: over.interestGraph,
    },
  };
}

/** A research providers stub whose gate decision reflects ONLY the flag half. */
function qualifiedResearchProviders() {
  return {
    research: { capability: () => ({ claims: { status: 'available' as const, provider: 'stub' } }) },
    researchClaimsPath: { primaryRunner: true, demo: false, legs: [], explicitOverride: true },
    modelGateway: { ledger: { store: { durable: true }, limits: { totalMicros: 100_000_000 } } },
  };
}

interface Combo {
  name: string;
  env: Record<string, string>;
}

const OPT_IN_COMBOS: Combo[] = [
  { name: 'all off (defaults)', env: {} },
  { name: 'projection only', env: { INTEREST_GRAPH_PROJECTION_ENABLED: 'true' } },
  { name: 'projection + discovery', env: { INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' } },
  { name: 'research only', env: { INTEREST_GRAPH_RESEARCH_ENABLED: 'true' } },
  { name: 'shadow only', env: { INTEREST_GRAPH_FRAMEWORK_SHADOW_ENABLED: 'true' } },
  {
    name: 'all four',
    env: {
      INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
      INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
      INTEREST_GRAPH_RESEARCH_ENABLED: 'true',
      INTEREST_GRAPH_FRAMEWORK_SHADOW_ENABLED: 'true',
    },
  },
];

const KILL_SCENARIOS: Array<{
  name: string;
  envKill?: string;
  dbKill?: { flag: string; accountId: string | null };
}> = [
  { name: 'no kill' },
  { name: 'env kills all four flags', envKill: 'interest_graph_projection_enabled,interest_graph_discovery_enabled,interest_graph_research_enabled,interest_graph_framework_shadow_enabled' },
  { name: 'global db kill of discovery', dbKill: { flag: 'interest_graph_discovery_enabled', accountId: null } },
  { name: 'account db kill of discovery', dbKill: { flag: 'interest_graph_discovery_enabled', accountId: 'own' } },
];

describe('graph flag parity across the shared evaluation and server policies (VAL-OPS-001)', () => {
  it('every opt-in/kill combination evaluates identically on both surfaces', async () => {
    const own = await insertAccount(isoDb);
    const other = await insertAccount(isoDb);
    const accountId = own.accountId;

    for (const combo of OPT_IN_COMBOS) {
      for (const scenario of KILL_SCENARIOS) {
        const env = {
          ...combo.env,
          ...(scenario.envKill ? { FEATURE_KILL_SWITCHES: scenario.envKill } : {}),
        };
        const config = testConfig(env);
        // Insert + later lift the scenario's database kill.
        const killAccountId =
          scenario.dbKill && scenario.dbKill.accountId === 'own' ? accountId : scenario.dbKill?.accountId ?? null;
        if (scenario.dbKill) {
          await setFeatureKill(isoDb, {
            flag: scenario.dbKill.flag,
            accountId: killAccountId,
            reason: 'parity matrix',
            actor: 'operator',
          });
        }
        try {
          const killed = await activeKills(isoDb, accountId, config);
          const shared = evaluateFeatureFlags(
            flagInputs({
              killed,
              interestGraph: {
                projection: on(config.INTEREST_GRAPH_PROJECTION_ENABLED),
                discovery: on(config.INTEREST_GRAPH_DISCOVERY_ENABLED),
                research: on(config.INTEREST_GRAPH_RESEARCH_ENABLED),
                frameworkShadow: on(config.INTEREST_GRAPH_FRAMEWORK_SHADOW_ENABLED),
              },
            }),
          ).flags;

          const server = {
            projection: await projectionEnabledForAccount(isoDb, { accountId, config }),
            discovery: await discoveryEnabledForAccount(isoDb, { accountId, config }),
            research:
              (await researchDispatchGate(isoDb, {
                accountId,
                config,
                providers: qualifiedResearchProviders() as never,
              })).allowed,
            shadow: on(config.INTEREST_GRAPH_FRAMEWORK_SHADOW_ENABLED) && !killed.has('interest_graph_framework_shadow_enabled'),
          };

          const label = `${combo.name} / ${scenario.name}`;
          expect(shared.interest_graph_projection_enabled, label).toBe(server.projection);
          expect(shared.interest_graph_discovery_enabled, label).toBe(server.discovery);
          expect(shared.interest_graph_research_enabled, label).toBe(server.research);
          expect(shared.interest_graph_framework_shadow_enabled, label).toBe(server.shadow);
        } finally {
          if (scenario.dbKill) {
            await liftFeatureKill(isoDb, { flag: scenario.dbKill.flag, accountId: killAccountId });
          }
        }
      }
    }

    // An OTHER account's kill never affects this account's evaluation.
    await setFeatureKill(isoDb, {
      flag: 'interest_graph_discovery_enabled',
      accountId: other.accountId,
      reason: 'parity matrix',
      actor: 'operator',
    });
    const config = testConfig({
      INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
      INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
    });
    const killed = await activeKills(isoDb, accountId, config);
    const shared = evaluateFeatureFlags(
      flagInputs({
        killed,
        interestGraph: { projection: true, discovery: true, research: false, frameworkShadow: false },
      }),
    ).flags;
    expect(shared.interest_graph_discovery_enabled).toBe(true);
    expect(await discoveryEnabledForAccount(isoDb, { accountId, config })).toBe(true);
  });

  it('projection alone never switches live graph reads or buys research', async () => {
    const { accountId } = await insertAccount(isoDb);
    const projectionOnly = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

    // The projection opt-in queues intents (that is its only effect)...
    const noted = await noteExplicitIntent(isoDb, {
      ownerAccountId: accountId,
      kind: 'taste',
      action: 'save',
      targetTasteRevision: 1,
      config: projectionOnly,
    });
    expect(noted).toBe(true);
    const { rows: pending } = await isoDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_outbox WHERE owner_account_id = $1 AND dispatch_state = 'pending'`,
      [accountId],
    );
    expect(Number(pending[0]!.n)).toBe(1);

    // ...but the live read gate stays off: no graph cards can serve.
    expect((await feedGraphReadGate(isoDb, { accountId, config: projectionOnly })).enabled).toBe(false);
    // No expansion is dispatched, and no research is bought.
    expect((await dispatchGraphExpansion(isoDb, { config: projectionOnly, ownerAccountId: accountId })).accounts).toEqual([]);
    const researchGate = await researchDispatchGate(isoDb, {
      accountId,
      config: projectionOnly,
      providers: qualifiedResearchProviders() as never,
    });
    expect(researchGate).toEqual({ allowed: false, reason: 'flag_off' });
    const { rows: jobs } = await isoDb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM jobs WHERE owner_account_id = $1',
      [accountId],
    );
    expect(Number(jobs[0]!.n)).toBe(0);
  });

  it('the framework shadow alone changes nothing: no intents, no reads, no dispatch', async () => {
    const { accountId } = await insertAccount(isoDb);
    const shadowOnly = testConfig({ INTEREST_GRAPH_FRAMEWORK_SHADOW_ENABLED: 'true' });

    const noted = await noteExplicitIntent(isoDb, {
      ownerAccountId: accountId,
      kind: 'taste',
      action: 'save',
      targetTasteRevision: 1,
      config: shadowOnly,
    });
    expect(noted).toBe(false);
    const { rows: pending } = await isoDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graph_outbox WHERE owner_account_id = $1`,
      [accountId],
    );
    expect(Number(pending[0]!.n)).toBe(0);
    expect((await feedGraphReadGate(isoDb, { accountId, config: shadowOnly })).enabled).toBe(false);
    expect((await dispatchGraphExpansion(isoDb, { config: shadowOnly, ownerAccountId: accountId })).accounts).toEqual([]);
    const researchGate = await researchDispatchGate(isoDb, {
      accountId,
      config: shadowOnly,
      providers: qualifiedResearchProviders() as never,
    });
    expect(researchGate).toEqual({ allowed: false, reason: 'flag_off' });
  });
});
