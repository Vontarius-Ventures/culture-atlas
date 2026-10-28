import type { CapabilityEntry } from '@culture-atlas/providers';
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
 *  - a COMPATIBLE QUALIFIED role serves relation research: the research
 *    claims capability must be available (through the real provider stack the
 *    gateway only hands research a dispatching runner when its model role is
 *    qualified, and the capability observes that state);
 *  - durable account/global daily spend limits are configured: the model
 *    gateway's spend ledger must exist with a durable store. The ledger is
 *    what every paid call reserves against; without it there is no bound.
 *
 * Deterministic adapters (test fakes) can satisfy the capability shape, but
 * the ledger requirement keeps a non-gateway deployment fail-closed: no
 * durable limits, no paid research. The handler re-checks the same gate
 * before its paid call, so a gate that closes between dispatch and run
 * refuses honestly without spending.
 */

/** Config subset the gate reads; DomainConfig satisfies it structurally. */
export interface ResearchGateConfig {
  INTEREST_GRAPH_RESEARCH_ENABLED?: string;
  FEATURE_KILL_SWITCHES?: string;
}

/** The provider surface the gate reads; ProviderRegistry satisfies it structurally. */
export interface ResearchGateProviders {
  research: { capability(): { claims: CapabilityEntry } };
  modelGateway?: { ledger?: { store: { durable: boolean } } };
}

export type ResearchDispatchRejection =
  | 'flag_off'
  | 'killed'
  | 'paused'
  | 'role_not_qualified'
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
  if (claims.status !== 'available') return { allowed: false, reason: 'role_not_qualified' };
  const ledger = input.providers.modelGateway?.ledger;
  if (!ledger || !ledger.store.durable) return { allowed: false, reason: 'limits_not_configured' };
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
