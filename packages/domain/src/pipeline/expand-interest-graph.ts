import { AppError } from '../errors';
import { JobCancelledError, type JobContext, type JobHandler } from '../jobs/handler';
import type { JobOutcome } from '../jobs/types';
import { stillOwnsJob } from '../jobs/queue';
import {
  ensureGraphWorkBudget,
  setGraphWorkBudgetState,
} from '../interest-graph/budgets';
import { consumeExpansionDue } from '../interest-graph/refresh';
import {
  GraphFenceError,
  expandAccountInterestGraph,
  type ExpansionRejectionReason,
} from '../interest-graph/expansion';

/**
 * Queue handler for `expand_interest_graph` (PR 8 discovery, VAL-DISC-003/006/007).
 *
 * The engine owns the walk, admission, frontier and publication; this handler
 * owns the queue contract around it:
 *
 *  - the DURABLE budget of the logical expansion (at most four Qloo HTTP
 *    attempts including retries, a 45-second deadline) anchors at the FIRST
 *    attempt of the job's dedupe key and is never reset by lease loss, worker
 *    restart or redelivery. An expired logical deadline stops bounded work
 *    honestly — no run, no publication, and never a fallback to the legacy
 *    paid expansion;
 *  - the publication transaction rechecks the handler's lease ownership
 *    through the engine's fence hook, so a lost or superseded lease cannot
 *    publish;
 *  - a successful run consumes the due marker it covered; fence rejections
 *    keep it (a fresh projection stamps a fresh marker), and paused or deleted
 *    accounts complete honestly without publishing anything.
 */
export const expandInterestGraph: JobHandler<'expand_interest_graph'> = async (ctx: JobContext<'expand_interest_graph'>): Promise<JobOutcome> => {
  const accountId = ctx.job.owner_account_id;
  if (!accountId || ctx.payload.account_id !== accountId) {
    throw new AppError('invalid_input', { message: 'Graph expansion requires its owning account.', retryable: false });
  }
  await ctx.ensureActive();

  // Deletion fence: jobs cascade with the account, but a claimed job can
  // still race deletion; the engine re-checks inside its transaction too.
  const { rows } = await ctx.db.query<{ id: string }>('SELECT id FROM accounts WHERE id = $1', [accountId]);
  if (rows.length === 0) return { state: 'complete', resultType: 'graph_expansion' };

  // The durable budget of the LOGICAL expansion: the job's dedupe key is its
  // identity, so the first attempt anchors the deadline and every redelivery
  // inherits the same row (attempts used, remaining allowance, deadline end).
  const workKey = ctx.job.dedupe_key ?? `expand:${ctx.job.id}`;
  const budget = await ensureGraphWorkBudget(ctx.db, {
    ownerAccountId: accountId,
    workKind: 'expansion',
    workKey,
  });
  if (budget.deadlineExpired) {
    // The logical deadline is gone: stop bounded work honestly. No run, no
    // publication, and never an uncontrolled paid fallback. The due marker
    // stays, so the next dispatch window retries from current authority.
    await setGraphWorkBudgetState(ctx.db, { ownerAccountId: accountId, workKey, state: 'stopped' });
    throw new AppError('service_unavailable', {
      message: 'This graph refresh window expired; a new one is on the way.',
      retryable: false,
      details: { rule: 'logical_deadline_expired' },
    });
  }

  const at = new Date();
  const result = await expandAccountInterestGraph(ctx.db, {
    accountId,
    config: ctx.config,
    jobId: ctx.job.id,
    at,
    // Publication-time lease recheck, inside the transaction: work published
    // after a lost or superseded lease cannot exist.
    fence: async (tx) => {
      if (!(await stillOwnsJob(tx, ctx.job.id, ctx.workerId))) throw new GraphFenceError('lease_lost');
    },
  });

  if (!result.expanded) {
    const reason = result.reason as ExpansionRejectionReason | undefined;
    switch (reason) {
      case 'paused':
      case 'account_missing':
        // Expected states, not errors: the account halted discovery refresh or
        // was deleted while this job was in flight. Complete honestly — the
        // run published nothing, and the account's own controls own what
        // happens next (resume re-reads current authority; deletion cascades).
        await ctx.trace({ kind: 'note', name: 'graph_expansion_skipped', data: { reason } });
        return { state: 'complete', resultType: 'graph_expansion' };
      case 'lease_lost':
        // The lease recheck rejected the publication; the worker must stop.
        throw new JobCancelledError('lease lost before publication');
      case 'disabled':
        // The flag (or a kill) halted publication. Nothing this job can do;
        // the due marker stays until the operator re-enables discovery.
        throw new AppError('service_unavailable', {
          message: 'Interest-graph discovery is disabled for this account.',
          retryable: false,
        });
      default:
        // stale_authority / exclusion_landed / source_invalidated /
        // support_withdrawn: the pass is stale against current authority and
        // rolled back. A retry rebuilds from current state.
        await ctx.trace({ kind: 'note', name: 'graph_expansion_fenced', data: { reason } });
        throw new AppError('service_unavailable', {
          message: 'This graph refresh landed behind a newer change; retrying from current state.',
          retryable: true,
          details: { rule: reason ?? 'fenced' },
        });
    }
  }

  // A completed expansion consumes the due markers its own read covered; a
  // projection that committed DURING the run stamped a newer marker (and
  // tripped the fence above), which stays due for the next window.
  await consumeExpansionDue(ctx.db, { accountId, dueUntil: at });
  // The logical window is finished: close its durable budget so a redelivery
  // can never reserve against a completed window.
  await setGraphWorkBudgetState(ctx.db, { ownerAccountId: accountId, workKey, state: 'complete' });
  return { state: 'complete', resultType: 'graph_expansion', resultId: result.runId ?? undefined };
};
