import { AppError } from '../errors';
import { JobCancelledError, type JobContext, type JobHandler } from '../jobs/handler';
import type { JobOutcome } from '../jobs/types';
import { stillOwnsJob } from '../jobs/queue';
import {
  ensureGraphWorkBudget,
  graphWorkDeadlineSignal,
  graphWorkWindowEnded,
  setGraphWorkBudgetState,
} from '../interest-graph/budgets';
import { consumeExpansionDue } from '../interest-graph/refresh';
import {
  GraphFenceError,
  expandAccountInterestGraph,
  type ExpansionRejectionReason,
} from '../interest-graph/expansion';
import { graphRunForJob } from '../interest-graph/store';
import type { GraphRunRow } from '../interest-graph/schema';

/**
 * Queue handler for `expand_interest_graph` (PR 8 discovery, VAL-DISC-003/006/007).
 *
 * The engine owns the walk, admission, frontier and publication; this handler
 * owns the queue contract around it:
 *
 *  - the DURABLE budget of the logical expansion (at most four Qloo HTTP
 *    attempts including retries, a 45-second deadline) anchors at the FIRST
 *    attempt of the job's dedupe key and is never reset by lease loss, worker
 *    restart or redelivery. The anchored deadline governs the WHOLE pass, not
 *    just handler entry: the engine's stage checks, SQL/lock waits and the
 *    publication fence all stop at the remaining window, so a delayed first
 *    attempt or a redelivery can neither spend, reserve nor commit after the
 *    original deadline — and an expired window stops bounded work honestly
 *    with no run, no publication, and never a fallback to the legacy paid
 *    expansion;
 *  - the publication transaction rechecks the handler's lease ownership
 *    through the engine's fence hook, so a lost or superseded lease cannot
 *    publish;
 *  - a successful run consumes the due marker it covered; fence rejections
 *    keep it (a fresh projection stamps a fresh marker), and paused or deleted
 *    accounts complete honestly without publishing anything;
 *  - a redelivery of a pass whose COMMIT survived but whose bookkeeping did
 *    not reuses the committed run: `graph_runs.job_id` is UNIQUE, so the run
 *    row IS the attempt's outcome, and re-walking could neither insert a
 *    second run nor republish honestly.
 */

/**
 * The committed pass's due-marker coverage bound: the attempt-start clock the
 * pass recorded on its run (`budget.due_until` — the same `at` a live attempt
 * would have consumed). Markers stamped after that instant were never covered
 * by the pass and stay due. A run from before the bound was recorded falls
 * back to its own `started_at` (the pass's earliest in-transaction clock —
 * still before the publication fence, so nothing mid-pass is consumed).
 */
function committedRunCoverageBound(run: GraphRunRow): Date {
  const budget = run.budget as { due_until?: unknown } | null | undefined;
  if (budget && typeof budget.due_until === 'string') {
    const parsed = new Date(budget.due_until);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return run.started_at ?? run.created_at;
}

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

  // At-least-once redelivery of a COMMITTED pass (DISC-SCR-012's crash
  // boundary): the pass is one transaction and `graph_runs.job_id` is UNIQUE,
  // so a run row for this job can only be the complete, published outcome of
  // an earlier attempt whose worker died between the pass's commit and this
  // bookkeeping (due consumption, budget close, job completion). Re-running
  // the pass would die on the unique key forever — or, without it, republish
  // a second set of cards — so the redelivery REUSES the committed run
  // instead: no re-walk, no republish, no re-anchored spend.
  const priorRun = await graphRunForJob(ctx.db, { ownerAccountId: accountId, jobId: ctx.job.id });
  if (priorRun && priorRun.state === 'complete' && priorRun.published) {
    await consumeExpansionDue(ctx.db, { accountId, dueUntil: committedRunCoverageBound(priorRun) });
    await setGraphWorkBudgetState(ctx.db, { ownerAccountId: accountId, workKey, state: 'complete' });
    await ctx.trace({ kind: 'note', name: 'graph_expansion_redelivery_reused', data: { runId: priorRun.id } });
    return { state: 'complete', resultType: 'graph_expansion', resultId: priorRun.id };
  }

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
  // The remaining logical window governs the WHOLE pass (VAL-DISC-006), not
  // just this entry: the engine bounds stage execution and SQL/lock waits by
  // it, and the signal aborts cooperative work the moment the window ends or
  // the worker's own grant dies — whichever comes first. The anchor itself is
  // the durable row above and is never reset.
  const window = graphWorkDeadlineSignal(budget.deadlineAt, ctx.signal);
  let result;
  try {
    result = await expandAccountInterestGraph(ctx.db, {
      accountId,
      config: ctx.config,
      jobId: ctx.job.id,
      at,
      deadline: { at: budget.deadlineAt, signal: window.signal },
      // Publication-time rechecks, INSIDE the transaction: work published
      // after a lost/superseded lease or after its logical window ended
      // cannot exist.
      fence: async (tx) => {
        if (!(await stillOwnsJob(tx, ctx.job.id, ctx.workerId))) throw new GraphFenceError('lease_lost');
        // The durable deadline, re-read with the transaction's own clock: a
        // delayed SQL/lock wait cannot commit past the original anchor.
        if (await graphWorkWindowEnded(tx, { ownerAccountId: accountId, workKey })) {
          throw new GraphFenceError('deadline_expired');
        }
      },
    });
  } finally {
    window.dispose();
  }

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
      case 'deadline_expired': {
        // The pass stopped at its logical window. Re-read the DURABLE row to
        // report the honest terminal outcome: an expired window is stopped for
        // good (never re-anchored, never retried into a fresh 45 seconds);
        // a still-live window means the worker's own signal ended the pass
        // (lease loss/cancellation), and the worker owns that outcome — the
        // window is not consumed and the due marker stays.
        const live = await ensureGraphWorkBudget(ctx.db, { ownerAccountId: accountId, workKind: 'expansion', workKey });
        if (live.deadlineExpired) {
          await setGraphWorkBudgetState(ctx.db, { ownerAccountId: accountId, workKey, state: 'stopped' });
          await ctx.trace({ kind: 'note', name: 'graph_expansion_window_expired', data: { reason } });
          throw new AppError('service_unavailable', {
            message: 'This graph refresh window expired; a new one is on the way.',
            retryable: false,
            details: { rule: 'logical_deadline_expired' },
          });
        }
        throw new JobCancelledError('worker stopped the pass before publication');
      }
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

  // The pass is COMMITTED and the worker's own bookkeeping follows: due-marker
  // consumption, the budget close and the job completion. Telemetry marks the
  // boundary — a worker that dies between the publication commit and this
  // bookkeeping leaves exactly the state the redelivery path below reuses.
  await ctx.trace({ kind: 'note', name: 'graph_expansion_published', data: { runId: result.runId } });

  // A completed expansion consumes the due markers its own read covered; a
  // projection that committed DURING the run stamped a newer marker (and
  // tripped the fence above), which stays due for the next window.
  await consumeExpansionDue(ctx.db, { accountId, dueUntil: at });
  // The logical window is finished: close its durable budget so a redelivery
  // can never reserve against a completed window.
  await setGraphWorkBudgetState(ctx.db, { ownerAccountId: accountId, workKey, state: 'complete' });
  return { state: 'complete', resultType: 'graph_expansion', resultId: result.runId ?? undefined };
};
