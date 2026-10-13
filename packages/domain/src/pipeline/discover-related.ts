import { randomUUID } from 'node:crypto';
import { isProviderError, isUsable, type QlooEntityType } from '@culture-atlas/providers';
import { suggestDishes } from '../composer/creative';
import { stripSafetyClaims } from '../composer/dietary';
import { reciprocalRankFusion, type RankedList } from '../composer/fusion';
import type { PlanSnapshot } from '../composer/plan-types';
import { BudgetExhaustedError, QlooSession, withProviderRetries } from '../composer/provider-calls';
import {
  canonicalKeyFor,
  insertProviderQueries,
  insertRecommendations,
  normalizeLabel,
  QLOO_KIND,
  upsertDiscoveryItem,
  yearOf,
  type RecommendationInsert,
} from '../composer/store';
import { CATEGORIES, LIMITS, type Category, type ItemKind, type SectionStatus } from '../enums';
import { JobCancelledError, type JobHandler } from '../jobs/handler';
import { loadItemAnchors } from '../library/anchors';
import { hiddenKeys } from '../library/access';
import type { Owner } from '../principal';
import { readDisplayMetadata } from '../services/display';
import { interleaveFeed } from '../services/discovery';

/**
 * Explicit "Discover more" for one item: anchors = item's canonical entities
 * (its own provider id, its resolved references' ids, or a name resolved via
 * /search); bounded Qloo insights across supported categories; at most 6
 * cached results tied to discovery_jobs (parent of provider_queries and
 * recommendations). Eat has no Qloo dish catalog: dish ideas come from the
 * composer model as creative suggestions (origin 'vlm_creative'). Unsupported
 * or unavailable categories are marked and the job ends 'partial'.
 */

const CATEGORY_FILTER: Partial<Record<Category, QlooEntityType>> = {
  watch: 'urn:entity:movie',
  play: 'urn:entity:artist',
  wear: 'urn:entity:brand',
};

const SEARCH_TYPES: Partial<Record<ItemKind, QlooEntityType>> = {
  film: 'urn:entity:movie',
  artist: 'urn:entity:artist',
  brand: 'urn:entity:brand',
};

interface Pick {
  key: string;
  kind: ItemKind;
  category: Category;
  title: string;
  year: number | null;
  qloo_id: string | null;
  description: string | null;
  origin: 'qloo' | 'replay' | 'vlm_creative';
  provider_query_ids: string[];
  reason: string;
}

export const discoverRelated: JobHandler<'discover_related'> = async (ctx) => {
  const { discovery_job_id, origin_item_id } = ctx.payload;
  const dj = await ctx.db.query<{ owner_account_id: string | null; owner_session_id: string | null; category: Category | null }>(
    'SELECT owner_account_id, owner_session_id, category FROM discovery_jobs WHERE id = $1',
    [discovery_job_id],
  );
  const item = await ctx.db.query<{
    id: string;
    kind: ItemKind;
    category: Category | null;
    title: string;
    canonical_key: string;
    external_ids: Record<string, unknown>;
    display_metadata: unknown;
  }>('SELECT id, kind, category, title, canonical_key, external_ids, display_metadata FROM discovery_items WHERE id = $1', [origin_item_id]);
  const job = dj.rows[0];
  const origin = item.rows[0];
  if (!job || !origin) throw new JobCancelledError('origin deleted');
  const owner: Owner = job.owner_account_id
    ? { kind: 'account', accountId: job.owner_account_id }
    : { kind: 'session', sessionId: job.owner_session_id! };
  await ctx.db.query(`UPDATE discovery_jobs SET status = 'running' WHERE id = $1`, [discovery_job_id]);

  const anchors = (await loadItemAnchors(ctx.db, [origin.id])).get(origin.id) ?? [];
  const hidden = await hiddenKeys(ctx.db, owner);
  const session = new QlooSession(ctx.providers.qloo, {
    maxRequests: ctx.budget.qlooRequests,
    maxRetries: ctx.budget.providerRetries,
    signal: ctx.signal,
    newId: randomUUID,
  });
  const categories = (ctx.payload.category ? [ctx.payload.category] : [...CATEGORIES]) as Category[];
  const perCategory = ctx.payload.category ? LIMITS.relatedCachedMax : 2;
  const statuses: Record<string, SectionStatus> = {};

  // 1. Signals: real provider ids only.
  await ctx.setStage('resolving');
  const signals = await ctx.runStage('resolve', async () => {
    const before = session.recorded.length;
    const ids = new Set<string>();
    const own = origin.external_ids?.['qloo'];
    if (typeof own === 'string') ids.add(own);
    for (const a of anchors) if (typeof a.external_ids['qloo'] === 'string') ids.add(a.external_ids['qloo'] as string);
    if (ids.size === 0 && session.searchUsable()) {
      const names = origin.kind === 'capture' ? anchors.slice(0, 2).map((a) => a.name) : [origin.title];
      for (const name of names) {
        try {
          const types = origin.kind === 'capture' ? undefined : SEARCH_TYPES[origin.kind];
          const { response } = await session.search(name, types ? [types] : undefined, { purpose: 'resolve_origin' });
          const hit = response.data.find((e) => normalizeLabel(e.name) === normalizeLabel(name));
          if (hit) ids.add(hit.entity_id);
        } catch (err) {
          if (!(err instanceof BudgetExhaustedError) && !isProviderError(err)) throw err;
        }
      }
    }
    return { ids: [...ids], queries: session.recorded.slice(before) };
  });
  const queries = [...signals.queries];

  // 2. Qloo categories.
  await ctx.setStage('recommending');
  const picks: Pick[] = [];
  for (const category of categories) {
    const filterType = CATEGORY_FILTER[category];
    if (!filterType) continue;
    if (!session.insightsUsable() || signals.ids.length === 0) {
      statuses[category] = 'unavailable';
      continue;
    }
    const out = await ctx.runStage(`insights:${category}`, async () => {
      const before = session.recorded.length;
      try {
        const { response, queryId } = await session.insights(
          { filterType, signalEntities: signals.ids.slice(0, 10), explainability: true, take: 15 },
          { purpose: 'related_discovery', category },
        );
        const map = QLOO_KIND[filterType]!;
        const list: RankedList<Pick> = {
          id: queryId,
          items: response.data.entities
            .filter((e) => !signals.ids.includes(e.entity_id))
            .map((e) => ({
              key: canonicalKeyFor({ kind: map.kind, title: e.name, qlooId: e.entity_id }),
              kind: map.kind,
              category,
              title: e.name,
              year: map.kind === 'film' ? yearOf(e) : null,
              qloo_id: e.entity_id,
              description: null,
              origin: response.is_replay ? ('replay' as const) : ('qloo' as const),
              provider_query_ids: [queryId],
              reason: `Connected to ${origin.title}.`,
            }))
            .filter((p) => !hidden.has(p.key) && p.key !== origin.canonical_key),
        };
        const fused = reciprocalRankFusion([list]).slice(0, perCategory).map((f) => f.item);
        return { picks: fused, status: (fused.length ? 'complete' : 'partial') as SectionStatus, queries: session.recorded.slice(before) };
      } catch (err) {
        if (!(err instanceof BudgetExhaustedError) && !isProviderError(err)) throw err;
        return { picks: [] as Pick[], status: 'failed' as SectionStatus, queries: session.recorded.slice(before) };
      }
    });
    queries.push(...out.queries);
    picks.push(...out.picks);
    statuses[category] = out.status;
  }

  // 3. Eat: creative dish ideas tied to the item's supported references.
  if (categories.includes('eat')) {
    const model = ctx.providers.composer;
    if (!isUsable(model.capability()) || (anchors.length === 0 && origin.kind === 'capture')) {
      statuses.eat = 'unavailable';
    } else {
      const meta = readDisplayMetadata(origin.display_metadata);
      const out = await ctx.runStage('eat', async () => {
        const snapshot: PlanSnapshot = {
          template: 'movie_night',
          collection: null,
          items: [
            {
              item_id: origin.id,
              saved_item_id: null,
              kind: origin.kind,
              category: origin.category,
              title: origin.title,
              canonical_key: origin.canonical_key,
              external_ids: {},
              subtitle: meta.subtitle ?? null,
              year: meta.year ?? null,
              detail: meta.detail ?? null,
              anchors: anchors.map((a) => ({ ...a })),
              capture: null,
            },
          ],
          constraints: { dietary_exclusions: [], instruction: null },
          exploration: 'balanced',
          fixed_film_item_id: null,
        };
        try {
          const r = await withProviderRetries(
            () =>
              suggestDishes(model, snapshot, {
                count: perCategory,
                cuisineHints: [],
                selectedDishes: [],
                avoidTitles: [],
                film: null,
                signal: ctx.signal,
              }),
            { maxRetries: ctx.budget.providerRetries },
          );
          const refs = anchors.map((a) => a.reference_id);
          return {
            picks: r.data.dishes.slice(0, perCategory).map(
              (d): Pick => ({
                key: canonicalKeyFor({ kind: 'food', title: d.title, referenceIds: refs }),
                kind: 'food',
                category: 'eat',
                title: d.title,
                year: null,
                qloo_id: null,
                description: stripSafetyClaims(d.description) || null,
                origin: 'vlm_creative',
                provider_query_ids: [],
                reason: stripSafetyClaims(d.reason) || `A creative idea inspired by ${origin.title}.`,
              }),
            ),
            failed: false,
          };
        } catch (err) {
          if (!isProviderError(err)) throw err;
          return { picks: [] as Pick[], failed: true };
        }
      });
      const fresh = out.picks.filter((p) => !hidden.has(p.key));
      picks.push(...fresh);
      statuses.eat = out.failed ? 'failed' : fresh.length ? 'complete' : 'partial';
    }
  }

  // 4. Publish (deletion while running prevents publication).
  await ctx.ensureActive();
  const anchorIds = anchors.map((a) => a.reference_id);
  const unique = interleaveFeed(
    picks.map((p) => ({ ...p, id: p.key, canonical_key: p.key })),
    hidden,
  ).slice(0, LIMITS.relatedCachedMax);
  const anyResult = unique.length > 0;
  const allComplete = Object.values(statuses).every((s) => s === 'complete');
  const state: 'complete' | 'partial' = anyResult && allComplete ? 'complete' : 'partial';
  await ctx.db.transaction(async (tx) => {
    const stillThere = await tx.query('SELECT 1 FROM discovery_jobs WHERE id = $1 FOR UPDATE', [discovery_job_id]);
    if (!stillThere.rowCount) throw new JobCancelledError('origin deleted');
    const parent = { kind: 'discovery_job' as const, discoveryJobId: discovery_job_id };
    await insertProviderQueries(tx, parent, queries, ctx.job.trace_id);
    await tx.query('DELETE FROM recommendations WHERE discovery_job_id = $1', [discovery_job_id]);
    const recs: RecommendationInsert[] = [];
    for (const [i, p] of unique.entries()) {
      const id = await upsertDiscoveryItem(tx, owner, {
        kind: p.kind,
        category: p.category,
        canonical_key: p.key,
        title: p.title,
        display_metadata: { subtitle: p.year ? String(p.year) : null, year: p.year, description: p.description },
        external_ids: p.qloo_id ? { qloo: p.qloo_id } : {},
        resolved_anchor_ids: p.origin === 'vlm_creative' ? anchorIds : [],
      });
      recs.push({
        discovery_item_id: id,
        category: p.category,
        rank: i + 1,
        title: p.title,
        external_ids: p.qloo_id ? { qloo: p.qloo_id } : {},
        display_reason: p.reason,
        origin: p.origin,
        provider_query_ids: p.provider_query_ids,
        contributing_reference_ids: anchorIds,
      });
    }
    await insertRecommendations(tx, parent, recs);
    await tx.query('UPDATE discovery_jobs SET status = $2 WHERE id = $1', [discovery_job_id, state]);
  });
  return { state, resultType: 'discovery_job', resultId: discovery_job_id };
};
