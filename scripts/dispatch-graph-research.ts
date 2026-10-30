/**
 * Gated live relation-research dispatch (PR 8 discovery runbook tooling).
 *
 * Hands ONE bounded relation-research pair to the shared job queue through
 * the real dispatch gate (packages/domain/src/interest-graph/research-gate.ts)
 * and the real provider registry — the same gate and adapters the worker
 * re-check at run time. It makes NO paid call itself: the paid research claims
 * extraction happens when a worker (started with INTEREST_GRAPH_RESEARCH_ENABLED
 * and a qualified, reservation-bound research_text role) claims the
 * `research_graph_relation` job. Every paid leg reserves and settles through
 * the durable model-gateway ledger, so the configured MODEL_* spend limits
 * bound the run; a closed gate refuses honestly and spends nothing.
 *
 * Usage:
 *   DATABASE_URL=... INTEREST_GRAPH_RESEARCH_ENABLED=true \
 *   CONCENTRATE_PROFILE_FILE=... CONCENTRATE_QUALIFICATION_DIR=... \
 *   MODEL_DAILY_SPEND_LIMIT_USD=... MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD=... \
 *   MODEL_MAX_UNKNOWN_SPEND_USD=... MODEL_TOTAL_SPEND_LIMIT_USD=... \
 *   pnpm exec tsx scripts/dispatch-graph-research.ts \
 *     --account <uuid> --subject-node <uuid> --object-node <uuid> \
 *     --predicate DOCUMENTED_ASSOCIATION --subtype work_on_display_at
 *
 * Output is the gate/dispatch result plus the job id (or the refusal reason);
 * watch the job in the jobs table while the worker processes it.
 */
import path from 'node:path';
import { loadRootEnv } from '../packages/domain/src/config';
import { createDb } from '../packages/domain/src/db/pool';
import { dispatchGraphResearch } from '../packages/domain/src/interest-graph/research-gate';
import type { GraphPredicate } from '../packages/domain/src/interest-graph/schema';
import { configureProviderRuntime, getProviders } from '../packages/providers/src/registry';

loadRootEnv(path.resolve(import.meta.dirname, '..'));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = process.env.DATABASE_URL;
const account = arg('account');
const subjectNode = arg('subject-node');
const objectNode = arg('object-node');
const predicate = arg('predicate') as GraphPredicate | undefined;
if (!url || !account || !subjectNode || !objectNode || !predicate) {
  console.error('--account, --subject-node, --object-node and --predicate are required.');
  process.exit(2);
}

const db = createDb(url, 1);
// The durable spend ledger this dispatch gate reads (the worker re-checks the
// same gate with its own registry before any paid call).
configureProviderRuntime({ gateway: { db: () => db } });
const providers = getProviders();

const result = await dispatchGraphResearch(db, {
  accountId: account,
  config: {
    INTEREST_GRAPH_RESEARCH_ENABLED: process.env.INTEREST_GRAPH_RESEARCH_ENABLED,
    FEATURE_KILL_SWITCHES: process.env.FEATURE_KILL_SWITCHES,
  },
  providers,
  subjectNodeId: subjectNode,
  objectNodeId: objectNode,
  predicate,
  associationSubtype: arg('subtype') ?? null,
});

if (!result.dispatched) {
  console.log(`[dispatch-graph-research] REFUSED: ${result.reason}`);
} else {
  console.log(
    `[dispatch-graph-research] dispatched job=${result.jobId}${result.reused ? ' (reused an active job)' : ''}`,
  );
}
await db.end().catch(() => undefined);
process.exit(result.dispatched ? 0 : 3);
