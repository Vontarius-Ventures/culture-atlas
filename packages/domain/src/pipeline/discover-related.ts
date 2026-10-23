import { randomUUID } from 'node:crypto';
import { isProviderError, isUsable, type QlooEntity, type QlooEntityType } from '@culture-atlas/providers';
import { suggestDishes } from '../composer/creative';
import { stripSafetyClaims, violatedExclusions } from '../composer/dietary';
import { foodExclusionsFor } from '../services/onboarding';
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
import { CATEGORIES, LIMITS, type Category, type ItemKind, type RecommendationOrigin, type SectionStatus } from '../enums';
import type { Queryable } from '../db/pool';
import { JobCancelledError, type JobHandler } from '../jobs/handler';
import { loadItemAnchors } from '../library/anchors';
import { hiddenKeys } from '../library/access';
import type { Owner } from '../principal';
import { destinationFromQlooProperties, imageFromQlooProperties, qlooImageIfRenderable, readDisplayMetadata, type DisplayImage } from '../services/display';
import { interleaveFeed, rebuildFeedSnapshots } from '../services/discovery';

/**
 * Explicit "Discover more" for one item: anchors = item's canonical entities
 * (its own provider id, its resolved references' ids, or a name resolved via
 * /search); bounded Qloo insights across supported categories; at most 6
 * cached results tied to discovery_jobs (parent of provider_queries and
 * recommendations). Eat has no Qloo dish catalog: dish ideas come from the
 * composer model as creative suggestions (origin 'vlm_creative') when Qloo
 * place search has nothing with a real picture. Unsupported or unavailable
 * categories are marked and the job ends 'partial'.
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

function textProp(properties: Record<string, unknown> | undefined, key: string): string | null {
  const v = properties?.[key];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 280) : null;
}

/** Interest-feed cards already sourced from Qloo for this owner — not a title search. */
async function seedRelatedPicks(
  db: Queryable,
  owner: Owner,
  category: Category,
  originKey: string,
  hidden: Set<string>,
  take: number,
): Promise<Pick[]> {
  if (owner.kind !== 'account' || take <= 0) return [];
  const { rows } = await db.query<{
    title: string;
    kind: ItemKind;
    canonical_key: string;
    external_ids: Record<string, unknown>;
    display_metadata: unknown;
    origin: RecommendationOrigin;
    provider_query_ids: string[];
  }>(
    `SELECT di.title, di.kind, di.canonical_key, di.external_ids, di.display_metadata,
            r.origin, r.provider_query_ids
       FROM recommendations r
       JOIN discovery_items di ON di.id = r.discovery_item_id
       JOIN taste_seed_runs ts ON ts.id = r.taste_seed_run_id
      WHERE ts.owner_account_id = $1
        AND ts.state IN ('complete', 'partial')
        AND r.category = $2
        AND di.canonical_key <> $3
      ORDER BY ts.updated_at DESC, r.rank
      LIMIT $4`,
    [owner.accountId, category, originKey, take * 6],
  );
  const out: Pick[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (hidden.has(row.canonical_key) || seen.has(row.canonical_key)) continue;
    if (row.origin === 'qloo' && row.provider_query_ids.length < 1) continue;
    if (row.origin !== 'qloo' && row.origin !== 'replay') continue;
    const meta = readDisplayMetadata(row.display_metadata);
    const qloo = typeof row.external_ids?.qloo === 'string' ? row.external_ids.qloo : null;
    seen.add(row.canonical_key);
    out.push({
      key: row.canonical_key,
      kind: row.kind,
      category,
      title: row.title,
      year: meta.year ?? null,
      qloo_id: qloo,
      description: meta.description ?? null,
      image: meta.image ?? null,
      destination_url: meta.destination_url ?? null,
      origin: row.origin === 'replay' ? 'replay' : 'qloo',
      provider_query_ids: row.provider_query_ids,
      reason: 'From your interests.',
    });
    if (out.length >= take) break;
  }
  return out;
}

/** "Mulatu's Bar" for Mulatu Astatke, or the origin itself in another script, is not a discovery. */
export function sameAsOrigin(candidate: string, origin: string): boolean {
  const a = normalizeLabel(candidate);
  const b = normalizeLabel(origin);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const first = b.split('-')[0] ?? '';
  return first.length >= 4 && a.split('-').some((w) => w.replace(/s$/, '') === first);
}

/** Qloo lists localized names (e.g. 細野晴臣 for Haruomi Hosono): the same person is not "related". */
function namesOrigin(entity: QlooEntity, origin: string): boolean {
  const alt = entity.properties?.['alternative_names'] ?? entity.properties?.['akas'];
  const names = Array.isArray(alt) ? alt : [];
  return names.some((n) => {
    const value = typeof n === 'string' ? n : n && typeof n === 'object' ? (n as { value?: unknown }).value : null;
    return typeof value === 'string' && normalizeLabel(value) !== '' && normalizeLabel(value) === normalizeLabel(origin);
  });
}

interface Pick {
  key: string;
  kind: ItemKind;
  category: Category;
  title: string;
  year: number | null;
  qloo_id: string | null;
  description: string | null;
  image: DisplayImage | null;
  destination_url: string | null;
  origin: 'qloo' | 'replay' | 'vlm_creative';
  provider_query_ids: string[];
  reason: string;
}

export const discoverRelated: JobHandler<'discover_related'> = async (ctx) => {
  const { discovery_job_id, origin_item_id } = ctx.payload;
  const dj = await ctx.db.query<{
    owner_account_id: string | null;
    owner_session_id: string | null;
    category: Category | null;
    source: 'item' | 'music_mode';
    source_label: string | null;
  }>(
    'SELECT owner_account_id, owner_session_id, category, source, source_label FROM discovery_jobs WHERE id = $1',
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
  // Music Mode: the reason names what the user heard; results join the feed.
  const fromMusic = job.source === 'music_mode';
  const connectedReason = fromMusic
    ? `Because you heard ${job.source_label ?? origin.title}.`
    : `Loved by fans of ${origin.title}.`;
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
    const out = await ctx.runStage(`insights:${category}`, async () => {
      const before = session.recorded.length;
      const map = QLOO_KIND[filterType]!;
      const toPicks = (entities: QlooEntity[], queryId: string, isReplay: boolean): Pick[] =>
        entities
          .filter((e) => !signals.ids.includes(e.entity_id) && !namesOrigin(e, origin.title))
          .map((e) => ({
            key: canonicalKeyFor({ kind: map.kind, title: e.name, qlooId: e.entity_id }),
            kind: map.kind,
            category,
            title: e.name,
            year: map.kind === 'film' ? yearOf(e) : null,
            qloo_id: e.entity_id,
            description: textProp(e.properties, 'short_description') ?? textProp(e.properties, 'description'),
            image: imageFromQlooProperties(e.properties, e.name),
            destination_url: destinationFromQlooProperties(e.properties),
            origin: isReplay ? ('replay' as const) : ('qloo' as const),
            provider_query_ids: [queryId],
            reason: connectedReason,
          }))
          .filter((p) => !hidden.has(p.key) && p.key !== origin.canonical_key && !sameAsOrigin(p.title, origin.title));

      if (session.insightsUsable() && signals.ids.length > 0) {
        try {
          const { response, queryId } = await session.insights(
            { filterType, signalEntities: signals.ids.slice(0, 10), explainability: true, take: 15 },
            { purpose: 'related_discovery', category },
          );
          const list: RankedList<Pick> = { id: queryId, items: toPicks(response.data.entities, queryId, response.is_replay) };
          const fused = reciprocalRankFusion([list]).slice(0, perCategory).map((f) => f.item);
          if (fused.length) {
            return { picks: fused, status: 'complete' as SectionStatus, queries: session.recorded.slice(before) };
          }
        } catch (err) {
          if (!(err instanceof BudgetExhaustedError) && !isProviderError(err)) throw err;
        }
      }
      // Insights often time out; fall back to this owner's Qloo interest cards, not a title search.
      const seeded = await seedRelatedPicks(ctx.db, owner, category, origin.canonical_key, hidden, perCategory);
      if (seeded.length) {
        return {
          picks: seeded,
          status: 'complete' as SectionStatus,
          queries: session.recorded.slice(before),
        };
      }
      return { picks: [] as Pick[], status: 'failed' as SectionStatus, queries: session.recorded.slice(before) };
    });
    queries.push(...out.queries);
    picks.push(...out.picks);
    statuses[category] = out.status;
  }

  // 3. Eat: real places with pictures from Qloo search; creative dishes only if search is empty.
  if (categories.includes('eat')) {
    const seededEat = await seedRelatedPicks(ctx.db, owner, 'eat', origin.canonical_key, hidden, perCategory);
    if (seededEat.length) {
      picks.push(...seededEat);
      statuses.eat = 'complete';
    } else if (
      (signals.ids.length > 0 && session.insightsUsable()) ||
      (origin.kind === 'food' && session.searchUsable())
    ) {
      const out = await ctx.runStage('eat:places', async () => {
        const before = session.recorded.length;
        try {
          // Taste-based: places Qloo connects to the origin's own entities. A
          // name search ("Babette's Feast" -> a venue called Babette's Feast)
          // is only right when the origin is itself a dish or a place.
          const tasteBased = signals.ids.length > 0 && session.insightsUsable();
          const { response, queryId } = tasteBased
            ? await (async () => {
                const r = await session.insights(
                  { filterType: 'urn:entity:place', signalEntities: signals.ids.slice(0, 10), explainability: true, take: 15 },
                  { purpose: 'related_discovery', category: 'eat' },
                );
                return { response: { data: r.response.data.entities, is_replay: r.response.is_replay }, queryId: r.queryId };
              })()
            : await session.search(origin.title, ['urn:entity:place'], {
                purpose: 'related_discovery',
                category: 'eat',
              });
          const map = QLOO_KIND['urn:entity:place']!;
          const candidates = await Promise.all(
            response.data
              .filter((e) => !signals.ids.includes(e.entity_id) && !(tasteBased && sameAsOrigin(e.name, origin.title)))
              .map(async (e): Promise<Pick | null> => {
                const image = await qlooImageIfRenderable(imageFromQlooProperties(e.properties, e.name));
                if (!image) return null;
                return {
                  key: canonicalKeyFor({ kind: map.kind, title: e.name, qlooId: e.entity_id }),
                  kind: map.kind,
                  category: 'eat' as const,
                  title: e.name,
                  year: null,
                  qloo_id: e.entity_id,
                  description: textProp(e.properties, 'short_description') ?? textProp(e.properties, 'description'),
                  image,
                  destination_url: destinationFromQlooProperties(e.properties),
                  origin: response.is_replay ? ('replay' as const) : ('qloo' as const),
                  provider_query_ids: [queryId],
                  reason: tasteBased ? connectedReason : `Shares a name with ${origin.title}.`,
                };
              }),
          );
          const items: Pick[] = candidates
            .filter((p): p is Pick => p !== null)
            .filter((p) => !hidden.has(p.key) && p.key !== origin.canonical_key)
            .slice(0, perCategory);
          return { picks: items, queries: session.recorded.slice(before), failed: false };
        } catch (err) {
          if (!(err instanceof BudgetExhaustedError) && !isProviderError(err)) throw err;
          return { picks: [] as Pick[], queries: session.recorded.slice(before), failed: true };
        }
      });
      queries.push(...out.queries);
      picks.push(...out.picks);
      if (out.picks.length) statuses.eat = 'complete';
      else if (out.failed) statuses.eat = 'failed';
    }
    const model = ctx.providers.composer;
    if (statuses.eat === 'complete') {
      // Real place pictures already filled this slot.
    } else if (!isUsable(model.capability()) || (anchors.length === 0 && origin.kind === 'capture')) {
      if (!statuses.eat) statuses.eat = 'unavailable';
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
                image: null,
                destination_url: null,
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
      // Amendment 2.2 (ONB-05): the account's food exclusions filter Eat ideas.
      // They stay server-side (never sent to the model as identity data).
      const foodExclusions = await foodExclusionsFor(ctx.db, owner);
      const fresh = out.picks.filter(
        (p) => !hidden.has(p.key) && !violatedExclusions({ title: p.title, description: p.description }, foodExclusions).length,
      );
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
        display_metadata: {
          subtitle: p.year ? String(p.year) : null,
          year: p.year,
          description: p.description,
          image: p.image,
          destination_url: p.destination_url,
          // Provider picks record whether they came from a replay; creative ideas leave it unchanged.
          ...(p.origin === 'vlm_creative' ? {} : { example: p.origin === 'replay' }),
        },
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
        destination_url: p.destination_url,
      });
    }
    await insertRecommendations(tx, parent, recs);
    await tx.query('UPDATE discovery_jobs SET status = $2 WHERE id = $1', [discovery_job_id, state]);
    // Music Mode suggestions float into the interest feed right away.
    if (fromMusic && owner.kind === 'account' && recs.length) await rebuildFeedSnapshots(tx, owner);
  });
  return { state, resultType: 'discovery_job', resultId: discovery_job_id };
};
