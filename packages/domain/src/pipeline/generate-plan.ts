import { composeEnvFor } from '../composer/env';
import { composeMovieNight, composeProse, inputContributions } from '../composer/movie-night';
import { persistPlanSections, planStateFrom } from '../composer/persist-plan';
import { PlanSnapshot } from '../composer/plan-types';
import { JobCancelledError, type JobHandler } from '../jobs/handler';

/**
 * Movie night: one film + two alternates, up to three dishes, music before/
 * after (artist mix acceptable; verified tracks only via a catalog adapter).
 * Uses the plan_versions.input_snapshot only (never live collection state).
 * Enforces fixed film and dietary exclusions; discloses weak inputs in the
 * rationale; combinations of influences are described as creative choices.
 * Qloo where available; creative composer suggestions are flagged
 * 'vlm_creative'; sections with neither are 'unavailable' (plan 'partial').
 */
export const generatePlan: JobHandler<'generate_plan'> = async (ctx) => {
  const { plan_id, version } = ctx.payload;
  const plan = await ctx.db.query<{ owner_account_id: string }>('SELECT owner_account_id FROM plans WHERE id = $1', [plan_id]);
  const v = await ctx.db.query<{ input_snapshot: unknown }>(
    'SELECT input_snapshot FROM plan_versions WHERE plan_id = $1 AND version = $2',
    [plan_id, version],
  );
  if (!plan.rows[0] || !v.rows[0]) throw new JobCancelledError('plan deleted');
  const owner = { kind: 'account' as const, accountId: plan.rows[0].owner_account_id };
  const snapshot = PlanSnapshot.parse(v.rows[0].input_snapshot);

  await ctx.db.query(`UPDATE plans SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued'`, [plan_id]);
  await ctx.setStage('composing');
  const env = await composeEnvFor(ctx, owner);
  const output = await composeMovieNight(env, snapshot, { sections: ['film', 'music', 'food'] });
  const film = output.film?.value.feature ?? null;
  const picks = [
    ...(film ? [film] : []),
    ...(output.film?.value.alternates ?? []),
    ...(output.music ? [...output.music.value.before, ...output.music.value.after] : []),
    ...(output.food?.value.dishes ?? []),
  ];
  const contributions = inputContributions(snapshot, picks);
  await ctx.setStage('writing');
  const prose = await composeProse(
    env,
    snapshot,
    {
      film,
      dishes: output.food?.value.dishes ?? [],
      artists: output.music ? [...output.music.value.before, ...output.music.value.after] : [],
    },
    contributions,
  );

  // Deletion or cancellation while composing must prevent publication.
  await ctx.ensureActive();
  const state = await ctx.db.transaction(async (tx) => {
    const exists = await tx.query('SELECT 1 FROM plans WHERE id = $1 FOR UPDATE', [plan_id]);
    if (!exists.rowCount) throw new JobCancelledError('plan deleted');
    const statuses = await persistPlanSections(tx, {
      planId: plan_id,
      version,
      owner,
      output,
      traceId: ctx.job.trace_id,
      contributions,
      prose,
    });
    const s = planStateFrom(statuses);
    await tx.query('UPDATE plans SET status = $2, updated_at = now() WHERE id = $1', [plan_id, s]);
    return s;
  });
  await ctx.trace({
    kind: 'stage',
    name: 'plan_composed',
    traceId: ctx.job.trace_id,
    ownerAccountId: owner.accountId,
    data: {
      plan_id,
      version,
      qloo_requests: env.qloo.requestsUsed,
      sections: {
        film: output.film?.status ?? null,
        music: output.music?.status ?? null,
        food: output.food?.status ?? null,
      },
    },
  });
  return { state, resultType: 'plan', resultId: plan_id };
};
