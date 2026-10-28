import { AppError } from '../errors';
import type { JobContext } from '../jobs/handler';
import type { JobOutcome } from '../jobs/types';
import { projectAccountInterestGraph } from '../interest-graph/projector';

/**
 * Queue handler for `project_interest_graph` (PR 8 package B). The projector
 * itself is pure domain logic on private state: no providers, no model calls,
 * no live recommendations. The job exists so the existing queue infrastructure
 * (leases, heartbeats, retries) drives projection with the same guarantees as
 * every other worker job.
 *
 * Completion is honest: the job completes only when the account's committed
 * outbox tail is clean. A tail that keeps growing under continuous mutation
 * re-queues with retry; a terminally failed job never blocks a later
 * dispatch, whose fresh dedupe key re-arms the account (at-least-once).
 */
export async function projectInterestGraph(ctx: JobContext<'project_interest_graph'>): Promise<JobOutcome> {
  const accountId = ctx.job.owner_account_id;
  if (!accountId || ctx.payload.account_id !== accountId) {
    // Nothing is ever pretended: a projection without its owning account does nothing.
    throw new AppError('invalid_input', { message: 'Graph projection requires its owning account.', retryable: false });
  }
  await ctx.ensureActive();

  // Deletion fence: jobs cascade with the account, but a claimed job can
  // still race deletion; the projector would fail on the missing state row.
  const { rows } = await ctx.db.query<{ id: string }>('SELECT id FROM accounts WHERE id = $1', [accountId]);
  if (rows.length === 0) return { state: 'complete' };

  const result = await projectAccountInterestGraph(ctx.db, {
    accountId,
    config: ctx.config,
    source: 'mutation_intent',
    jobId: ctx.job.id ?? undefined,
  });

  if (result.projected === false && result.reason === 'disabled') {
    // The flag (or a kill) halted publication. Nothing this job can do; the
    // intents stay pending until the operator re-enables projection.
    throw new AppError('service_unavailable', {
      message: 'Interest-graph projection is disabled for this account.',
      retryable: false,
    });
  }
  if (!result.tailClean) {
    // Committed work advanced, but newer intents keep arriving; retry.
    throw new AppError('service_unavailable', {
      message: 'Interest-graph projection converged partially; newer intents are pending.',
      retryable: true,
    });
  }
  return { state: 'complete', resultType: 'graph_projection', resultId: result.graphRunId ?? undefined };
}
