import { composeEnvFor } from '../composer/env';
import { composeMovieNight, composeProse, inputContributions } from '../composer/movie-night';
import { persistPlanSections, planStateFrom } from '../composer/persist-plan';
import { PlanSnapshot, StoredFilm, StoredFood, StoredMusic, type ComposedPick, type StoredPick } from '../composer/plan-types';
import type { PlanSection, SectionStatus } from '../enums';
import { JobCancelledError, type JobHandler } from '../jobs/handler';

/**
 * Regenerates one section into the new version (created by the request with
 * the other sections copied), preserving the others. Earlier picks of that
 * section (in any version) are not proposed again. If nothing new can be
 * produced, the previous content is kept and the job ends 'partial'.
 */

function picksOf(section: PlanSection, value: unknown): StoredPick[] {
  if (!value) return [];
  if (section === 'film') {
    const f = StoredFilm.safeParse(value);
    return f.success ? [...(f.data.feature ? [f.data.feature] : []), ...f.data.alternates] : [];
  }
  if (section === 'music') {
    const m = StoredMusic.safeParse(value);
    return m.success ? [...m.data.before, ...m.data.after] : [];
  }
  const d = StoredFood.safeParse(value);
  return d.success ? d.data.dishes : [];
}

function asComposed(p: StoredPick, qlooId: string | null): ComposedPick {
  return {
    key: p.key,
    kind: p.kind,
    category: p.kind === 'film' ? 'watch' : p.kind === 'food' ? 'eat' : 'play',
    title: p.title,
    year: p.year,
    detail: p.detail,
    description: p.description,
    qloo_id: qlooId,
    existing_item_id: p.item_id,
    origin: 'vlm_creative',
    provider_query_ids: [],
    contributing_input_ids: p.contributing_input_ids,
    contributing_reference_ids: [],
    reason: p.reason,
    is_fixed: p.is_fixed,
  };
}

export const replacePlanSection: JobHandler<'replace_plan_section'> = async (ctx) => {
  const { plan_id, version, section, instruction } = ctx.payload;
  const plan = await ctx.db.query<{ owner_account_id: string }>('SELECT owner_account_id FROM plans WHERE id = $1', [plan_id]);
  const row = await ctx.db.query<{ input_snapshot: unknown; film: unknown; food: unknown; music: unknown; section_statuses: Record<string, SectionStatus> }>(
    'SELECT input_snapshot, film, food, music, section_statuses FROM plan_versions WHERE plan_id = $1 AND version = $2',
    [plan_id, version],
  );
  if (!plan.rows[0] || !row.rows[0]) throw new JobCancelledError('plan deleted');
  const owner = { kind: 'account' as const, accountId: plan.rows[0].owner_account_id };
  const snapshot = PlanSnapshot.parse(row.rows[0].input_snapshot);
  const current = row.rows[0];

  // Never re-propose anything this section has shown in any version.
  const history = await ctx.db.query<{ film: unknown; food: unknown; music: unknown }>(
    'SELECT film, food, music FROM plan_versions WHERE plan_id = $1',
    [plan_id],
  );
  const avoid = new Set(history.rows.flatMap((h) => picksOf(section, h[section]).map((p) => p.key)));

  const featureStored = StoredFilm.safeParse(current.film).success ? StoredFilm.parse(current.film).feature : null;
  let featureQloo: string | null = null;
  if (featureStored?.item_id) {
    const ext = await ctx.db.query<{ external_ids: Record<string, unknown> }>('SELECT external_ids FROM discovery_items WHERE id = $1', [
      featureStored.item_id,
    ]);
    const q = ext.rows[0]?.external_ids?.['qloo'];
    featureQloo = typeof q === 'string' ? q : null;
  }

  await ctx.db.query(`UPDATE plans SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued'`, [plan_id]);
  await ctx.setStage('composing');
  const env = await composeEnvFor(ctx, owner);
  const output = await composeMovieNight(env, snapshot, {
    sections: [section],
    avoidKeys: { [section]: avoid },
    extraInstruction: instruction ?? null,
    currentFilm: featureStored ? asComposed(featureStored, featureQloo) : null,
  });

  const produced =
    (section === 'film' && output.film && output.film.status !== 'unavailable') ||
    (section === 'music' && output.music && output.music.status !== 'unavailable') ||
    (section === 'food' && output.food && output.food.status !== 'unavailable');

  // Title, summary and rationale describe the WHOLE new version: replacing the
  // film must not leave a summary that still names the old one.
  let prose: Awaited<ReturnType<typeof composeProse>> | null = null;
  if (produced) {
    const kept = (s: 'film' | 'music' | 'food') => picksOf(s, current[s]).map((p) => asComposed(p, null));
    const film =
      section === 'film'
        ? (output.film?.value.feature ?? null)
        : featureStored
          ? asComposed(featureStored, featureQloo)
          : null;
    const artists = section === 'music' && output.music ? [...output.music.value.before, ...output.music.value.after] : kept('music');
    const dishes = section === 'food' && output.food ? output.food.value.dishes : kept('food');
    const fresh = [...(film ? [film] : []), ...(section === 'film' && output.film ? output.film.value.alternates : []), ...artists, ...dishes];
    prose = await composeProse(env, snapshot, { film, dishes, artists }, inputContributions(snapshot, fresh));
  }

  await ctx.ensureActive();
  const state = await ctx.db.transaction(async (tx) => {
    const exists = await tx.query('SELECT 1 FROM plans WHERE id = $1 FOR UPDATE', [plan_id]);
    if (!exists.rowCount) throw new JobCancelledError('plan deleted');
    if (!produced) {
      // Keep the previous content of the section; record what was attempted.
      const base = await tx.query<{ section_statuses: Record<string, SectionStatus> }>(
        'SELECT section_statuses FROM plan_versions WHERE plan_id = $1 AND version = $2',
        [plan_id, ctx.payload.base_version],
      );
      const previous = base.rows[0]?.section_statuses?.[section] ?? 'unavailable';
      await persistPlanSections(tx, { planId: plan_id, version, owner, output: { queries: output.queries }, traceId: ctx.job.trace_id });
      await tx.query(
        `UPDATE plan_versions SET section_statuses = section_statuses || jsonb_build_object($3::text, $4::text)
          WHERE plan_id = $1 AND version = $2`,
        [plan_id, version, section, previous],
      );
      const statuses = { ...current.section_statuses, [section]: previous };
      await tx.query('UPDATE plans SET status = $2, updated_at = now() WHERE id = $1', [plan_id, planStateFrom(statuses)]);
      return 'partial' as const;
    }
    // Contributions over the whole new version (other sections are unchanged).
    const others = (['film', 'music', 'food'] as const)
      .filter((s) => s !== section)
      .flatMap((s) => picksOf(s, current[s]).map((p) => asComposed(p, null)));
    const fresh = [
      ...(output.film ? [...(output.film.value.feature ? [output.film.value.feature] : []), ...output.film.value.alternates] : []),
      ...(output.music ? [...output.music.value.before, ...output.music.value.after] : []),
      ...(output.food?.value.dishes ?? []),
    ];
    const contributions = inputContributions(snapshot, [...others, ...fresh]);
    const statuses = await persistPlanSections(tx, {
      planId: plan_id,
      version,
      owner,
      output,
      traceId: ctx.job.trace_id,
      contributions,
    });
    if (prose) {
      await tx.query(
        'UPDATE plan_versions SET title = $3, summary = $4, rationale = $5 WHERE plan_id = $1 AND version = $2',
        [plan_id, version, prose.title, prose.summary, prose.rationale],
      );
    }
    const s = planStateFrom(statuses);
    await tx.query('UPDATE plans SET status = $2, updated_at = now() WHERE id = $1', [plan_id, s]);
    return s;
  });
  return { state, resultType: 'plan', resultId: plan_id };
};
