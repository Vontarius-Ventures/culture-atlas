import { randomUUID } from 'node:crypto';
import { isProviderError } from '@culture-atlas/providers';
import { BudgetExhaustedError, QlooSession } from '../composer/provider-calls';
import { insertProviderQueries, insertRecommendations, upsertDiscoveryItem, type RecommendationInsert } from '../composer/store';
import { AppError } from '../errors';
import { requireServiceFeature } from '../flags/feature-flags';
import { JobCancelledError, type JobHandler } from '../jobs/handler';
import { hiddenKeys } from '../library/access';
import type { Owner } from '../principal';
import { discoveryEnabledForAccount } from '../interest-graph/expansion';
import { rebuildFeedSnapshots } from '../services/discovery';
import { INTEREST_EXPAND_MAX_QLOO_REQUESTS } from '../services/interest-expand';
import { readFoodExclusions, TASTE_SEED_INLINE_RETRIES } from '../services/taste-seed';
import {
  fetchCategory,
  isFoodSignal,
  loadSeedSignals,
  type SeedSignal,
  type SeedSignals,
} from './taste-seed';

/**
 * Interest expand: one more Qloo pass from cards already in the owner's
 * pool, appended to the latest taste seed. Never deletes existing cards.
 * Never fabricates — empty Qloo is a complete no-op.
 */

export const EXPAND_SIGNAL_TAKE = 6;
/** Shift a full window each category cycle so later waves don't re-ask the same six signals. */
export const EXPAND_SIGNAL_STRIDE = 6;

/** 1-based Qloo insights page once the current slice of the pool is already saved. */
export function expandInsightsPage(existingCount: number, take = 25): number {
  if (existingCount < 0) return 1;
  return Math.floor(existingCount / take) + 1;
}

/** Eat search needs cuisine tags. Place-only windows would just re-find the same restaurants. */
export function withEatCuisineSignals(taken: SeedSignals, seed: SeedSignals, maxTags = 3): SeedSignals {
  if (taken.tags.length > 0) return taken;
  const foodTags = seed.tags.filter((t) => t.food).slice(0, maxTags);
  if (foodTags.length === 0) return taken;
  return { tags: foodTags, entities: taken.entities };
}

export function pickExpandSignals(pool: readonly SeedSignal[], wave: number): SeedSignals {
  if (pool.length === 0) return { tags: [], entities: [] };
  const pass = Math.floor(wave / 4);
  const offset = (pass * EXPAND_SIGNAL_STRIDE) % pool.length;
  const taken: SeedSignal[] = [];
  for (let i = 0; i < Math.min(EXPAND_SIGNAL_TAKE, pool.length); i++) {
    taken.push(pool[(offset + i) % pool.length]!);
  }
  const out: SeedSignals = { tags: [], entities: [] };
  for (const s of taken) {
    (s.id.startsWith('urn:tag:') ? out.tags : out.entities).push(s);
  }
  return out;
}

export const interestExpand: JobHandler<'interest_expand'> = async (ctx) => {
  const accountId = ctx.job.owner_account_id;
  if (!accountId) throw new AppError('invalid_input', { message: 'Expanding a feed needs an account.', retryable: false });
  await requireServiceFeature({ db: ctx.db, config: ctx.config }, accountId, 'taste_seed_enabled');
  // Graph/legacy mutual exclusion (VAL-DISC-003): an account with graph
  // discovery enabled never runs the legacy PAID expansion — its refresh is
  // the graph sweep's job, so this wave completes without spending. A job
  // enqueued before the flag flipped cannot spend either.
  if (await discoveryEnabledForAccount(ctx.db, { accountId, config: ctx.config })) {
    ctx.log('skipping legacy expand: graph discovery is enabled for this account', { accountId });
    return { state: 'complete', resultType: 'interest_expand' as const };
  }
  const owner: Owner = { kind: 'account', accountId };
  const category = ctx.payload.category;
  const wave = ctx.payload.wave;
  const result = { resultType: 'interest_expand' as const };

  const run = await ctx.db.query<{ id: string }>(
    `SELECT id FROM taste_seed_runs
      WHERE owner_account_id = $1 AND state IN ('complete', 'partial')
      ORDER BY updated_at DESC LIMIT 1`,
    [accountId],
  );
  const runId = run.rows[0]?.id;
  if (!runId) return { state: 'complete', ...result };

  await ctx.setStage('reading_interests');
  const signals = await loadExpandSignals(ctx.db, accountId, runId, category, wave);
  if (signals.tags.length + signals.entities.length === 0) return { state: 'complete', ...result };

  const session = new QlooSession(ctx.providers.qloo, {
    maxRequests: Math.min(ctx.budget.qlooRequests, INTEREST_EXPAND_MAX_QLOO_REQUESTS),
    maxRetries: Math.min(ctx.budget.providerRetries, TASTE_SEED_INLINE_RETRIES),
    signal: ctx.signal,
    newId: randomUUID,
    clientMaxRetries: 0,
  });
  if (!session.insightsUsable() && category !== 'eat') {
    throw new AppError('provider_unavailable', {
      message: 'Part of this is taking longer than usual. Try again in a little while.',
      retryable: true,
    });
  }

  const [hidden, existing, prefs, inCategory] = await Promise.all([
    hiddenKeys(ctx.db, owner),
    ctx.db.query<{ canonical_key: string }>(
      `SELECT di.canonical_key
         FROM recommendations r JOIN discovery_items di ON di.id = r.discovery_item_id
        WHERE r.taste_seed_run_id = $1`,
      [runId],
    ),
    ctx.db.query<{ preferences: unknown }>('SELECT preferences FROM accounts WHERE id = $1', [accountId]),
    ctx.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM recommendations WHERE taste_seed_run_id = $1 AND category = $2`,
      [runId, category],
    ),
  ]);
  const excludedKeys = new Set([...hidden, ...existing.rows.map((r) => r.canonical_key)]);
  const foodExclusions = readFoodExclusions(prefs.rows[0]?.preferences);

  await ctx.setStage(`expanding:${category}`);
  const deeperPage = Math.max(2, expandInsightsPage(inCategory.rows[0]?.n ?? 0));
  const fetchPage = (page: number) =>
    fetchCategory(session, category, { signals, excludedKeys, foodExclusions, take: 25, page });
  let out;
  try {
    out = await ctx.runStage(`category:${category}`, () => fetchPage(1));
    if (out.cards.length === 0 && category !== 'eat') {
      try {
        out = await ctx.runStage(`category:${category}:page`, () => fetchPage(deeperPage));
      } catch (pageErr) {
        if (!isProviderError(pageErr) || pageErr.retryable) throw pageErr;
      }
    }
  } catch (err) {
    const failed = session.recorded.filter((q) => q.status === 'error');
    if (failed.length && !ctx.signal.aborted) {
      await insertProviderQueries(ctx.db, { kind: 'taste_seed', runId }, failed, ctx.job.trace_id);
    }
    if (err instanceof BudgetExhaustedError || (isProviderError(err) && err.retryable)) throw err;
    if (isProviderError(err)) {
      throw new AppError('provider_unavailable', {
        message: 'Part of this is taking longer than usual. Try again in a little while.',
        retryable: err.retryable,
      });
    }
    throw err;
  }

  await ctx.ensureActive();
  if (out.cards.length === 0) return { state: 'complete', ...result };

  await ctx.db.transaction(async (tx) => {
    const still = await tx.query('SELECT id FROM taste_seed_runs WHERE id = $1 FOR UPDATE', [runId]);
    if (!still.rowCount) throw new JobCancelledError('account deleted');
    const parent = { kind: 'taste_seed' as const, runId };
    await insertProviderQueries(tx, parent, out.queries, ctx.job.trace_id);
    const maxRank = await tx.query<{ n: number }>(
      `SELECT COALESCE(MAX(rank), 0) AS n FROM recommendations WHERE taste_seed_run_id = $1 AND category = $2`,
      [runId, category],
    );
    let rank = maxRank.rows[0]?.n ?? 0;
    const recs: RecommendationInsert[] = [];
    for (const c of out.cards) {
      const itemId = await upsertDiscoveryItem(tx, owner, {
        kind: c.kind,
        category: c.category,
        canonical_key: c.key,
        title: c.title,
        display_metadata: {
          subtitle: c.subtitle,
          year: c.year,
          destination_url: c.destination_url,
          example: c.origin === 'replay',
        },
        external_ids: { qloo: c.qloo_id },
      });
      rank += 1;
      recs.push({
        discovery_item_id: itemId,
        category: c.category,
        rank,
        title: c.title,
        external_ids: { qloo: c.qloo_id },
        display_reason: c.reason,
        origin: c.origin,
        provider_query_ids: [c.provider_query_id],
        destination_url: c.destination_url,
      });
    }
    await insertRecommendations(tx, parent, recs);
    await tx.query(
      `UPDATE taste_seed_categories
          SET card_count = card_count + $3, state = 'ready', ready_at = COALESCE(ready_at, now()), updated_at = now()
        WHERE run_id = $1 AND category = $2`,
      [runId, category, recs.length],
    );
    await rebuildFeedSnapshots(tx, owner);
  });

  return { state: 'complete', ...result, resultId: runId };
};

async function loadExpandSignals(
  db: Parameters<typeof loadSeedSignals>[0],
  accountId: string,
  runId: string,
  category: string,
  wave: number,
): Promise<SeedSignals> {
  const { rows } = await db.query<{ title: string; kind: string | null; category: string | null; qloo_id: string }>(
    `SELECT di.title, di.kind, di.category,
            CASE WHEN jsonb_typeof(di.external_ids->'qloo') = 'string' THEN di.external_ids->>'qloo'
                 ELSE di.external_ids->>'qloo_tag' END AS qloo_id
       FROM recommendations r JOIN discovery_items di ON di.id = r.discovery_item_id
      WHERE r.taste_seed_run_id = $1 AND r.category = $2
        AND (jsonb_typeof(di.external_ids->'qloo') = 'string' OR jsonb_typeof(di.external_ids->'qloo_tag') = 'string')
      ORDER BY r.rank DESC, r.created_at DESC`,
    [runId, category],
  );
  const fromPool: SeedSignal[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const id = r.qloo_id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Feed cards, not picks: reasons say "Related to X in your feed", and they
    // steer only their own category.
    fromPool.push({
      id,
      name: r.title,
      food: isFoodSignal({ id, kind: r.kind, category: r.category }),
      pickLabel: null,
      pickCategory: (r.category as SeedSignal['pickCategory']) ?? null,
    });
  }
  const fallback = await loadSeedSignals(db, accountId);
  const pool = fromPool.length ? fromPool : [...fallback.tags, ...fallback.entities];
  const taken = pickExpandSignals(pool, wave);
  return category === 'eat' ? withEatCuisineSignals(taken, fallback) : taken;
}
