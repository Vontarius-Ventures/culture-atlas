import type { CapabilityEntry, ResearchClaimsPath } from '@culture-atlas/providers';
import type { Queryable } from '../db/pool';
import { activeKills } from '../flags/feature-flags';
import { enqueueJob } from '../jobs/queue';
import { graphResearchDedupeKey } from '../jobs/dedupe';
import type { GraphPredicate } from './schema';
import { graphDiscoveryPausedAt } from './refresh';

/**
 * The paid relation-research dispatch gate (VAL-DISC-005). Paid research is
 * default-off and stays off until ALL of the following hold:
 *
 *  - the operator opted the server in (INTEREST_GRAPH_RESEARCH_ENABLED) and
 *    the flag is not killed globally or for the account;
 *  - the account has not paused discovery (pause stops research dispatch and
 *    publication, never projection or cleanup);
 *  - the EFFECTIVE claims adapter is ACTUALLY QUALIFIED and fully
 *    RESERVATION-BOUND (DISC-SCR-010): the registry declares the claims chain
 *    (researchClaimsPath), the gateway hands its primary leg a dispatching
 *    runner (only a role with a passing qualification artifact gets one), and
 *    the role is NOT demo-dispatched — an OBSERVED capability of a
 *    CONCENTRATE_DEMO_ALLOW_ROLES role is not independent qualification;
 *  - EVERY paid leg of that chain (primary AND fallback) reserves and settles
 *    through the gateway's durable account/global ledger: a chain that
 *    contains MODEL_FALLBACK=elorian could route a primary timeout or invalid
 *    response to a paid call outside the ledger, so research fails closed
 *    rather than escaping its budget. Explicit deterministic test adapters
 *    (constructor overrides the registry cannot analyze) may serve fault
 *    tests, but the deployment invariants — a genuinely qualified non-demo
 *    research_text role and durable limits — still bind them;
 *  - durable account/global daily spend limits AND the all-time total
 *    ceiling are configured: the model gateway's spend ledger must exist with
 *    a durable store and a totalMicros bound. The ledger is what every paid
 *    call reserves against; daily limits alone reopen on every restart and
 *    midnight rollover, so without the total there is no bound on cumulative
 *    spend at all.
 *
 * The handler re-checks the same gate before its paid call, so a gate that
 * closes between dispatch and run refuses honestly without spending.
 */

/** Config subset the gate reads; DomainConfig satisfies it structurally. */
export interface ResearchGateConfig {
  INTEREST_GRAPH_RESEARCH_ENABLED?: string;
  FEATURE_KILL_SWITCHES?: string;
}

/** The provider surface the gate reads; ProviderRegistry satisfies it structurally. */
export interface ResearchGateProviders {
  research: { capability(): { claims: CapabilityEntry } };
  /** The registry-declared effective claims chain paid research binds to (DISC-SCR-010). */
  researchClaimsPath: ResearchClaimsPath;
  /**
   * The gateway's durable spend ledger. `limits` is the ledger's configured
   * SpendLimits: paid admission requires the ALL-TIME total ceiling too, not
   * just daily bounds (VAL-OPS-002).
   */
  modelGateway?: {
    ledger?: {
      store: { durable: boolean };
      limits: { totalMicros?: number };
    };
  };
}

export type ResearchDispatchRejection =
  | 'flag_off'
  | 'killed'
  | 'paused'
  | 'role_not_qualified'
  | 'fallback_unreserved'
  | 'limits_not_configured';

const optedIn = (value: string | undefined) => value === 'true' || value === '1';
const csvList = (value: string | undefined) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);

/** The server-wide research gate from config alone: opt-in AND not env-killed. */
export function researchEnabledInConfig(config: ResearchGateConfig): boolean {
  return researchConfigOptIn(config) && !researchConfigKilled(config);
}

/** The operator opt-in alone (no kill state). */
function researchConfigOptIn(config: ResearchGateConfig): boolean {
  return optedIn(config.INTEREST_GRAPH_RESEARCH_ENABLED);
}

/** The environment kill list alone. */
function researchConfigKilled(config: ResearchGateConfig): boolean {
  return csvList(config.FEATURE_KILL_SWITCHES).includes('interest_graph_research_enabled');
}

export type ResearchDispatchGate = { allowed: true } | { allowed: false; reason: ResearchDispatchRejection };

/** The full dispatch gate for one account. */
export async function researchDispatchGate(
  db: Queryable,
  input: { accountId: string; config: ResearchGateConfig; providers: ResearchGateProviders },
): Promise<ResearchDispatchGate> {
  if (!researchConfigOptIn(input.config)) return { allowed: false, reason: 'flag_off' };
  if (researchConfigKilled(input.config)) return { allowed: false, reason: 'killed' };
  const killed = await activeKills(db, input.accountId, input.config);
  if (killed.has('interest_graph_research_enabled')) return { allowed: false, reason: 'killed' };
  if ((await graphDiscoveryPausedAt(db, input.accountId)) != null) return { allowed: false, reason: 'paused' };
  const claims = input.providers.research.capability().claims;
  if (claims.status === 'unavailable') return { allowed: false, reason: 'role_not_qualified' };
  const ledger = input.providers.modelGateway?.ledger;
  // Durable budgets enforce the TOTAL (VAL-OPS-002): the durable ledger must
  // exist AND be configured with the all-time cumulative ceiling. Daily
  // limits alone reopen on every restart and every midnight rollover, so a
  // ledger without a total ceiling is not a bound on paid admission at all.
  if (!ledger || !ledger.store.durable || !ledger.limits.totalMicros)
    return { allowed: false, reason: 'limits_not_configured' };
  // DISC-SCR-010: bind paid research to the declared effective claims path.
  // The registry must describe the chain it constructed; an undeclared path is
  // unverifiable and fails closed.
  const path = input.providers.researchClaimsPath;
  if (!path) return { allowed: false, reason: 'fallback_unreserved' };
  // Only a dispatching runner reserves and settles every paid primary attempt,
  // and only a genuinely qualified role gets one. A demo-dispatched role has a
  // runner too, but its OBSERVED capability is not independent qualification.
  if (!path.primaryRunner) return { allowed: false, reason: 'role_not_qualified' };
  if (path.demo) return { allowed: false, reason: 'role_not_qualified' };
  // Every registry-constructed paid leg — primary AND fallback — must be
  // reservation-bound. The operator-chosen Elorian fallback (MODEL_FALLBACK)
  // spends outside the durable ledger, so a chain that could ever fall through
  // to it refuses: potentially unreserved fallback fails closed. Explicit
  // deterministic overrides replace the chain and carry no analyzable legs;
  // the qualified-role and durable-ledger invariants above still bind them.
  if (!path.explicitOverride && !path.legs.every((leg) => leg.reservationBound))
    return { allowed: false, reason: 'fallback_unreserved' };
  return { allowed: true };
}

export interface DispatchGraphResearchInput {
  accountId: string;
  config: ResearchGateConfig;
  providers: ResearchGateProviders;
  subjectNodeId: string;
  objectNodeId: string;
  predicate: GraphPredicate;
  associationSubtype?: string | null;
  traceId?: string;
}

export interface DispatchGraphResearchResult {
  dispatched: boolean;
  /** Present when the gate refused the dispatch. */
  reason?: ResearchDispatchRejection;
  jobId?: string;
  /** True when an existing active job already covered this pair. */
  reused?: boolean;
}

/**
 * Hands one bounded relation-research pair to the queue — the only enqueue
 * path for paid research, and it is gated end to end. The job's dedupe key
 * covers the (account, subject, object, predicate, subtype) pair, so repeated
 * dispatches coalesce into one active job; a completed job keeps its key, so a
 * pair is researched once rather than re-bought.
 */
export async function dispatchGraphResearch(
  db: Queryable,
  input: DispatchGraphResearchInput,
): Promise<DispatchGraphResearchResult> {
  const gate = await researchDispatchGate(db, {
    accountId: input.accountId,
    config: input.config,
    providers: input.providers,
  });
  if (!gate.allowed) return { dispatched: false, reason: gate.reason };
  const { job, reused } = await enqueueJob(db, {
    type: 'research_graph_relation',
    owner: { kind: 'account', accountId: input.accountId },
    payload: {
      account_id: input.accountId,
      subject_node_id: input.subjectNodeId,
      object_node_id: input.objectNodeId,
      predicate: input.predicate,
      ...(input.associationSubtype ? { association_subtype: input.associationSubtype } : {}),
    },
    dedupeKey: graphResearchDedupeKey({
      accountId: input.accountId,
      subjectNodeId: input.subjectNodeId,
      objectNodeId: input.objectNodeId,
      predicate: input.predicate,
      associationSubtype: input.associationSubtype ?? null,
    }),
    maxAttempts: 3,
    resultType: 'graph_research',
    traceId: input.traceId,
  });
  return { dispatched: !reused, jobId: job.id, reused };
}
