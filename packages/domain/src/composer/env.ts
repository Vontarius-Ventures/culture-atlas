import { randomUUID } from 'node:crypto';
import type { JobContext } from '../jobs/handler';
import { hiddenKeys } from '../library/access';
import type { Owner } from '../principal';
import type { ComposeEnv } from './movie-night';
import { QlooSession } from './provider-calls';

/** Build the composer environment for a worker job (budgets, retries, cancellation, idempotent stages). */
export async function composeEnvFor(ctx: JobContext, owner: Owner): Promise<ComposeEnv> {
  return {
    qloo: new QlooSession(ctx.providers.qloo, {
      maxRequests: ctx.budget.qlooRequests,
      maxRetries: ctx.budget.providerRetries,
      signal: ctx.signal,
      newId: randomUUID,
    }),
    composer: ctx.providers.composer,
    hidden: await hiddenKeys(ctx.db, owner),
    maxRetries: ctx.budget.providerRetries,
    signal: ctx.signal,
    runStage: (name, fn) => ctx.runStage(name, fn),
  };
}
