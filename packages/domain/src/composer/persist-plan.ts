import type { Queryable } from '../db/pool';
import type { PlanSection, SectionStatus } from '../enums';
import type { Owner } from '../principal';
import type { ComposeOutput, Prose } from './movie-night';
import type { ComposedPick, InputContribution, StoredPick } from './plan-types';
import { insertProviderQueries, insertRecommendations, upsertDiscoveryItem, type RecommendationInsert } from './store';

/**
 * Publish composed sections into one plan version: provider_queries (parent =
 * plan), stable DiscoveryItems for every pick, recommendations per section
 * (replacing earlier rows of the same version+section, so a retried attempt is
 * idempotent) and the stored section JSON.
 */

const REC_SECTIONS: Record<PlanSection, string[]> = {
  film: ['film', 'alternate_film'],
  food: ['food'],
  music: ['music_before', 'music_after'],
};

async function itemIdFor(db: Queryable, owner: Owner, pick: ComposedPick): Promise<string> {
  if (pick.existing_item_id) return pick.existing_item_id;
  return upsertDiscoveryItem(db, owner, {
    kind: pick.kind,
    category: pick.category,
    canonical_key: pick.key,
    title: pick.title,
    display_metadata: {
      subtitle: pick.kind === 'film' ? (pick.year ? String(pick.year) : null) : pick.detail,
      year: pick.year,
      description: pick.description,
      detail: pick.detail,
    },
    external_ids: pick.qloo_id ? { qloo: pick.qloo_id } : {},
    resolved_anchor_ids: pick.contributing_reference_ids,
  });
}

function stored(pick: ComposedPick, itemId: string): StoredPick {
  return {
    item_id: itemId,
    kind: pick.kind,
    title: pick.title,
    year: pick.year,
    detail: pick.detail,
    description: pick.description,
    reason: pick.reason,
    is_fixed: pick.is_fixed,
    key: pick.key,
    contributing_input_ids: pick.contributing_input_ids,
  };
}

function rec(pick: ComposedPick, itemId: string, section: string, rank: number): RecommendationInsert {
  return {
    discovery_item_id: itemId,
    category: pick.category,
    section,
    rank,
    title: pick.title,
    external_ids: pick.qloo_id ? { qloo: pick.qloo_id } : {},
    display_reason: pick.reason,
    origin: pick.origin,
    provider_query_ids: pick.provider_query_ids,
    contributing_reference_ids: pick.contributing_reference_ids,
  };
}

export interface PersistInput {
  planId: string;
  version: number;
  owner: Owner;
  output: ComposeOutput;
  traceId: string | null;
  contributions?: InputContribution[];
  prose?: Prose;
}

export async function persistPlanSections(db: Queryable, input: PersistInput): Promise<Record<string, SectionStatus>> {
  const { planId, version, owner, output } = input;
  const parent = { kind: 'plan' as const, planId, version };
  await db.query(`DELETE FROM provider_queries WHERE plan_id = $1 AND plan_version = $2 AND id = ANY($3::uuid[])`, [
    planId,
    version,
    output.queries.map((q) => q.id),
  ]);
  await insertProviderQueries(db, parent, output.queries, input.traceId);

  const sets: string[] = [];
  const params: unknown[] = [planId, version];
  const statuses: Record<string, SectionStatus> = {};
  const recs: RecommendationInsert[] = [];
  const replaced: string[] = [];

  if (output.film) {
    const { feature, alternates } = output.film.value;
    const featureId = feature ? await itemIdFor(db, owner, feature) : null;
    const alt: StoredPick[] = [];
    if (feature && featureId) recs.push(rec(feature, featureId, 'film', 1));
    for (const [i, a] of alternates.entries()) {
      const id = await itemIdFor(db, owner, a);
      alt.push(stored(a, id));
      recs.push(rec(a, id, 'alternate_film', i + 1));
    }
    params.push(JSON.stringify({ feature: feature && featureId ? stored(feature, featureId) : null, alternates: alt }));
    sets.push(`film = $${params.length}::jsonb`);
    statuses.film = output.film.status;
    replaced.push(...REC_SECTIONS.film);
  }
  if (output.music) {
    const pack = async (picks: ComposedPick[], section: string) => {
      const out: StoredPick[] = [];
      for (const [i, m] of picks.entries()) {
        const id = await itemIdFor(db, owner, m);
        out.push(stored(m, id));
        recs.push(rec(m, id, section, i + 1));
      }
      return out;
    };
    const before = await pack(output.music.value.before, 'music_before');
    const after = await pack(output.music.value.after, 'music_after');
    params.push(JSON.stringify({ before, after }));
    sets.push(`music = $${params.length}::jsonb`);
    statuses.music = output.music.status;
    replaced.push(...REC_SECTIONS.music);
  }
  if (output.food) {
    const dishes: StoredPick[] = [];
    for (const [i, d] of output.food.value.dishes.entries()) {
      const id = await itemIdFor(db, owner, d);
      dishes.push(stored(d, id));
      recs.push(rec(d, id, 'food', i + 1));
    }
    params.push(JSON.stringify({ dishes }));
    sets.push(`food = $${params.length}::jsonb`);
    statuses.food = output.food.status;
    replaced.push(...REC_SECTIONS.food);
  }

  await db.query('DELETE FROM recommendations WHERE plan_id = $1 AND plan_version = $2 AND section = ANY($3::text[])', [
    planId,
    version,
    replaced,
  ]);
  await insertRecommendations(db, parent, recs);

  params.push(JSON.stringify(statuses));
  sets.push(`section_statuses = section_statuses || $${params.length}::jsonb`);
  if (input.contributions) {
    params.push(JSON.stringify(input.contributions));
    sets.push(`input_contributions = $${params.length}::jsonb`);
  }
  if (input.prose) {
    params.push(input.prose.title, input.prose.summary, input.prose.rationale);
    sets.push(`title = $${params.length - 2}`, `summary = $${params.length - 1}`, `rationale = $${params.length}`);
  }
  sets.push(
    `recommendation_ids = ARRAY(SELECT id FROM recommendations WHERE plan_id = $1 AND plan_version = $2 ORDER BY section, rank)`,
  );
  const { rows } = await db.query<{ section_statuses: Record<string, SectionStatus> }>(
    `UPDATE plan_versions SET ${sets.join(', ')} WHERE plan_id = $1 AND version = $2 RETURNING section_statuses`,
    params,
  );
  return rows[0]?.section_statuses ?? statuses;
}

/** complete when every section is complete; partial otherwise (useful output may still exist). */
export function planStateFrom(statuses: Record<string, SectionStatus>): 'complete' | 'partial' {
  const values = ['film', 'food', 'music'].map((s) => statuses[s] ?? 'pending');
  return values.every((v) => v === 'complete') ? 'complete' : 'partial';
}
