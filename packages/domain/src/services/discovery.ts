import { z } from 'zod';
import { requireScopes, requireWholeLibrary } from '../authz';
import { reciprocalRankFusion, type RankedList } from '../composer/fusion';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { CATEGORIES, LIMITS, type Category, type ItemKind, type RecommendationOrigin } from '../enums';
import { AppError } from '../errors';
import { sampleItemIds } from '../feed/samples';
import { hiddenKeys } from '../library/access';
import { ownerColumns, ownerOf, ownerPredicate, type Owner } from '../principal';
import type { DiscoveriesQuery, DiscoveriesResponse } from '../schemas/discoveries';
import { decodeCursor, encodeCursor } from '../util/cursor';
import { addHours } from '../util/time';
import { loadCards, type CardRecommendationContext } from './cards';
import { enqueueInterestExpand } from './interest-expand';
import { excludedFoodItemIds, foodExclusionsFor, isOnboardingRequired } from './onboarding';
import { getTasteRevision } from './taste';

/**
 * Discovery Feed module. New users: reviewed sample items (is_example_feed).
 * Returning users: bounded pool of supported recommendations connected to
 * explicit saves. Interleave categories, dedupe canonical items, suppress
 * hidden items, avoid >2 consecutive cards of one category when alternatives
 * exist. Pages read a FeedSnapshot (cursor = snapshot id + taste revision +
 * position); fetching a page NEVER starts generation. Selected-collection
 * agents cannot read the global feed (403).
 */

/** Maximum candidates kept in one feed snapshot. */
export const FEED_POOL_MAX = 120;
/** Snapshots stay valid for stable pagination this long. */
export const FEED_SNAPSHOT_TTL_HOURS = 24;
/** Returning users with fewer connected results than this get reviewed samples after them. */
export const FEED_TOP_UP_MIN = 24;
/** Newest expand cards woven into the first page so they can float on-screen. */
export const FEED_RECENCY_STRIDE = 3;

export interface FeedCandidate {
  id: string;
  canonical_key: string;
  category: string | null;
  kind?: ItemKind;
}

const groupKey = (c: { category: string | null; kind?: string }) => c.category ?? `kind:${c.kind ?? 'other'}`;

/**
 * Pure ordering helper: dedupe by canonical key, drop excluded keys, then
 * interleave categories. Each round takes the best remaining item of every
 * category (rounds ordered by each category's best remaining priority), so
 * no category appears more than twice in a row while alternatives remain.
 * Items without a category (photos, references) form their own group.
 */
export function interleaveFeed<T extends { id: string; canonical_key: string; category: string | null }>(
  candidates: readonly T[],
  excludedKeys: ReadonlySet<string>,
): T[] {
  const seen = new Set<string>();
  const queues = new Map<string, { item: T; priority: number }[]>();
  candidates.forEach((c, priority) => {
    if (excludedKeys.has(c.canonical_key) || seen.has(c.canonical_key)) return;
    seen.add(c.canonical_key);
    const g = groupKey(c as { category: string | null; kind?: string });
    const q = queues.get(g) ?? [];
    q.push({ item: c, priority });
    queues.set(g, q);
  });
  const out: T[] = [];
  while (queues.size > 0) {
    const round = [...queues.entries()].sort((a, b) => a[1][0]!.priority - b[1][0]!.priority);
    for (const [g, q] of round) {
      out.push(q.shift()!.item);
      if (q.length === 0) queues.delete(g);
    }
  }
  return out;
}

/**
 * Weave newest recommendations into the front of an already-fused list:
 * two existing cards, then one recent, repeating. Expand waves append at
 * high rank and would otherwise sit past the first page the phone polls.
 */
export function weaveRecentIntoFront<T extends { id: string }>(
  fused: readonly T[],
  recentIds: readonly string[],
  stride = FEED_RECENCY_STRIDE,
): T[] {
  if (fused.length === 0 || recentIds.length === 0 || stride < 2) return [...fused];
  const byId = new Map(fused.map((item) => [item.id, item]));
  const recents: T[] = [];
  const seen = new Set<string>();
  for (const id of recentIds) {
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    recents.push(item);
    seen.add(id);
  }
  if (recents.length === 0) return [...fused];
  const rest = fused.filter((item) => !seen.has(item.id));
  const out: T[] = [];
  let r = 0;
  let s = 0;
  const olderPerRecent = stride - 1;
  while (s < rest.length || r < recents.length) {
    for (let i = 0; i < olderPerRecent && s < rest.length; i++) out.push(rest[s++]!);
    if (r < recents.length) out.push(recents[r++]!);
    else while (s < rest.length) out.push(rest[s++]!);
  }
  return out;
}

/** Longest run of one group (used by tests and invariants). */
export function longestCategoryRun(items: readonly { category: string | null; kind?: string }[]): number {
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const i of items) {
    const g = groupKey(i);
    run = g === prev ? run + 1 : 1;
    prev = g;
    best = Math.max(best, run);
  }
  return best;
}

interface PoolRow {
  item_id: string;
  canonical_key: string;
  category: Category | null;
  kind: ItemKind;
  list_id: string;
  rank: number;
  created_at: Date;
}

/**
 * Candidates connected to explicit saves: recommendations of (a) captures the
 * owner saved as inspirations or saved items from, and (b) for accounts, the
 * taste seed built from onboarding picks (amendment 2.2): per category, the
 * latest seed run that published that category. Related-discovery jobs stay
 * on the item-detail rail — title-search leftovers (Tesla from a film) must
 * not enter the home feed. Owner-scoped: another user's private captures
 * never enter a feed. Explicit saves (preference events) leave the feed;
 * Interests auto-file does not. Hidden items stay out.
 */
export async function buildSavedPool(db: Queryable, owner: Owner): Promise<FeedCandidate[]> {
  const own = (alias: string) => ownerPredicate(owner, alias, 1).sql;
  const params = ownerPredicate(owner, '', 1).params;
  // Taste seeds are account data; anonymous sessions never have one.
  const seedSql =
    owner.kind === 'account'
      ? `SELECT DISTINCT ON (tc.category) tc.run_id, tc.category
           FROM taste_seed_categories tc JOIN taste_seed_runs tr ON tr.id = tc.run_id
          WHERE tr.owner_account_id = $1 AND tc.state = 'ready'
          ORDER BY tc.category, tc.ready_at DESC, tr.created_at DESC`
      : `SELECT NULL::uuid AS run_id, NULL::text AS category WHERE false`;
  const { rows } = await db.query<PoolRow>(
    `WITH saved AS (SELECT si.discovery_item_id AS id FROM saved_items si WHERE ${own('si')}),
     ctx_analyses AS (
       SELECT c.active_analysis_id AS id FROM captures c
        WHERE ${own('c')} AND c.deleted_at IS NULL AND c.active_analysis_id IS NOT NULL
          AND (EXISTS (SELECT 1 FROM discovery_items cdi WHERE cdi.capture_id = c.id AND cdi.id IN (SELECT id FROM saved))
               OR EXISTS (SELECT 1 FROM recommendations r0 WHERE r0.analysis_id = c.active_analysis_id
                                                             AND r0.discovery_item_id IN (SELECT id FROM saved)))),
     ctx_seed AS (${seedSql})
     SELECT r.discovery_item_id AS item_id, di.canonical_key, di.category, di.kind,
            COALESCE(r.analysis_id, r.taste_seed_run_id)::text || ':' || COALESCE(r.category, '-') AS list_id, r.rank, r.created_at
       FROM recommendations r JOIN discovery_items di ON di.id = r.discovery_item_id
      WHERE (r.analysis_id IN (SELECT id FROM ctx_analyses)
             OR (r.taste_seed_run_id, r.category) IN (SELECT run_id, category FROM ctx_seed))
        AND (di.is_sample OR ${own('di')})
        -- Explicit saves leave the feed; Interests auto-file does not write those events.
        AND di.id NOT IN (
          SELECT si.discovery_item_id FROM saved_items si
           WHERE ${own('si')}
             AND EXISTS (
               SELECT 1 FROM preference_events pe
                WHERE pe.action = 'save' AND pe.target_type = 'discovery_item'
                  AND pe.target_id = si.discovery_item_id AND ${own('pe')}
             )
        )
      ORDER BY r.created_at DESC, r.rank
      LIMIT 600`,
    params,
  );
  const lists = new Map<string, PoolRow[]>();
  for (const r of rows) {
    const l = lists.get(r.list_id) ?? [];
    l.push(r);
    lists.set(r.list_id, l);
  }
  const ranked: RankedList<PoolRow & { key: string }>[] = [...lists.entries()].map(([id, items]) => ({
    id,
    items: [...items].sort((a, b) => a.rank - b.rank).map((i) => ({ ...i, key: i.canonical_key })),
  }));
  const fused = reciprocalRankFusion(ranked).map((f) => ({
    id: f.item.item_id,
    canonical_key: f.item.canonical_key,
    category: f.item.category,
    kind: f.item.kind,
  }));
  const recentIds = [...rows]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((r) => r.item_id);
  return weaveRecentIntoFront(fused, recentIds).slice(0, FEED_POOL_MAX);
}

async function savedItemIdSet(db: Queryable, owner: Owner): Promise<Set<string>> {
  const own = ownerPredicate(owner, '', 1);
  const { rows } = await db.query<{ discovery_item_id: string }>(`SELECT discovery_item_id FROM saved_items WHERE ${own.sql}`, own.params);
  return new Set(rows.map((r) => r.discovery_item_id));
}

async function hasSaves(db: Queryable, owner: Owner): Promise<boolean> {
  const own = ownerPredicate(owner, '', 1);
  const { rows } = await db.query(`SELECT 1 FROM saved_items WHERE ${own.sql} LIMIT 1`, own.params);
  return rows.length > 0;
}

interface SnapshotRow {
  id: string;
  taste_revision: number;
  category: Category | null;
  ordered_item_ids: string[];
  is_example_feed: boolean;
  available_categories: Category[];
  expires_at: Date;
}

const FeedCursor = z.object({ f: z.uuid(), r: z.number().int().nonnegative(), p: z.number().int().nonnegative() });

/** Sourced https or local sample path. Null/empty image is a cuisine tag, not a dish. */
async function picturedItemIds(db: Queryable, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM discovery_items
      WHERE id = ANY($1::uuid[])
        AND (
          COALESCE(display_metadata->'image'->>'url','') LIKE 'https://%'
          OR COALESCE(display_metadata->'image'->>'url','') LIKE '/%'
        )`,
    [ids],
  );
  return new Set(rows.map((r) => r.id));
}

/** Build and store a new snapshot from the EXISTING pool (no provider calls, no jobs). */
async function createSnapshot(ctx: { db: Queryable; now(): Date }, owner: Owner, revision: number, category: Category | null): Promise<SnapshotRow> {
  const hidden = await hiddenKeys(ctx.db, owner);
  let pool: FeedCandidate[] = (await hasSaves(ctx.db, owner)) ? await buildSavedPool(ctx.db, owner) : [];
  pool = pool.filter((c) => !hidden.has(c.canonical_key));
  // Amendment 2.2 (ONB-05): the account's food exclusions filter Eat suggestions.
  // Applied to the personal pool before the picture rule below, so an excluded
  // pictured venue cannot evict the owner's remaining (image-less) Eat cards.
  const exclusions = await foodExclusionsFor(ctx.db, owner);
  const dropExcluded = async (cards: FeedCandidate[]) => {
    if (!exclusions.length) return cards;
    const drop = await excludedFoodItemIds(ctx.db, cards.filter((p) => p.kind === 'food').map((p) => p.id), exclusions);
    return drop.size ? cards.filter((p) => !drop.has(p.id)) : cards;
  };
  pool = await dropExcluded(pool);
  // Cuisine tags have no pictures. When Qloo returned restaurant photos for
  // this owner, keep those and drop the owner's image-less Eat cards so the
  // grid is not a brown poster. Only the personal pool decides this, and it
  // happens before the top-up: reviewed samples' own pictures never evict a
  // real Qloo result, samples are never dropped, and the grid still tops up
  // to FEED_TOP_UP_MIN.
  const pictured = await picturedItemIds(ctx.db, pool.filter((p) => p.kind === 'food').map((p) => p.id));
  if (pictured.size > 0) {
    pool = pool.filter((p) => p.kind !== 'food' || pictured.has(p.id));
  }
  const isExample = pool.length === 0;
  if (isExample) pool = await sampleItemIds(ctx.db);
  else if (pool.length < FEED_TOP_UP_MIN) {
    // A returning user with only a few connected results still gets a full
    // grid: reviewed samples (labeled "Example result") fill in after them.
    const saved = await savedItemIdSet(ctx.db, owner);
    const inPool = new Set(pool.map((p) => p.canonical_key));
    const samples = (await sampleItemIds(ctx.db)).filter((s) => !inPool.has(s.canonical_key) && !hidden.has(s.canonical_key) && !saved.has(s.id));
    pool = [...pool, ...samples.slice(0, FEED_TOP_UP_MIN - pool.length)];
  }
  // Samples added by the top-up (or the example feed) obey the same exclusions.
  pool = await dropExcluded(pool);
  const available = CATEGORIES.filter((c) => pool.some((p) => p.category === c));
  const filtered = category ? pool.filter((p) => p.category === category) : pool;
  const ordered = interleaveFeed(filtered, hidden).map((c) => c.id);
  const cols = ownerColumns(owner);
  const { rows } = await ctx.db.query<SnapshotRow>(
    // created_at is the wall-clock insert time, not the transaction start, so a
    // rebuild that waited for a lock (taste seed publishing) still sorts after
    // the snapshot it supersedes.
    `INSERT INTO feed_snapshots (owner_account_id, owner_session_id, taste_revision, category, ordered_item_ids,
                                 is_example_feed, available_categories, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7::text[], $8, clock_timestamp())
     RETURNING id, taste_revision, category, ordered_item_ids, is_example_feed, available_categories, expires_at`,
    [cols.owner_account_id, cols.owner_session_id, revision, category, ordered, isExample, available, addHours(ctx.now(), FEED_SNAPSHOT_TTL_HOURS)],
  );
  return rows[0]!;
}

/**
 * Rebuild the owner's FeedSnapshot from the current pool after new
 * recommendations were published outside a page fetch (the taste seed job).
 * Builds the unfiltered snapshot plus a fresh one for every category filter
 * already viewed at this taste revision, so the next page fetch without a
 * cursor reads the new pool. Existing snapshots stay valid for open cursors.
 * Uses the usual feed rules (interleaving, dedupe, hidden suppression,
 * labeled examples topping up a short pool). No provider calls, no jobs.
 */
export async function rebuildFeedSnapshots(
  db: Queryable,
  owner: Owner,
  now: () => Date = () => new Date(),
): Promise<{ feedId: string; revision: number; isExampleFeed: boolean; availableCategories: Category[]; itemCount: number }> {
  const revision = await getTasteRevision(db, owner);
  const own = ownerPredicate(owner, '', 1);
  const { rows } = await db.query<{ category: Category }>(
    `SELECT DISTINCT category FROM feed_snapshots
      WHERE ${own.sql} AND taste_revision = $2 AND category IS NOT NULL AND expires_at > $3`,
    [...own.params, revision, now()],
  );
  const ctx = { db, now };
  const main = await createSnapshot(ctx, owner, revision, null);
  for (const r of rows) await createSnapshot(ctx, owner, revision, r.category);
  return {
    feedId: main.id,
    revision,
    isExampleFeed: main.is_example_feed,
    availableCategories: main.available_categories,
    itemCount: main.ordered_item_ids.length,
  };
}

async function findSnapshot(ctx: ServiceContext, owner: Owner, where: { id?: string; revision?: number; category?: Category | null }): Promise<SnapshotRow | null> {
  const own = ownerPredicate(owner, '', 1);
  const params: unknown[] = [...own.params, ctx.now()];
  const conds = [own.sql, `expires_at > $2`];
  if (where.id) {
    params.push(where.id);
    conds.push(`id = $${params.length}`);
  } else {
    params.push(where.revision, where.category ?? null);
    conds.push(`taste_revision = $${params.length - 1}`, `category IS NOT DISTINCT FROM $${params.length}::text`);
  }
  const { rows } = await ctx.db.query<SnapshotRow>(
    `SELECT id, taste_revision, category, ordered_item_ids, is_example_feed, available_categories, expires_at
       FROM feed_snapshots WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 1`,
    params,
  );
  return rows[0] ?? null;
}

/** Latest owner-context recommendation per item, for "Why this?" and example labeling. */
async function recommendationContexts(db: Queryable, owner: Owner, itemIds: string[]): Promise<Map<string, CardRecommendationContext>> {
  const out = new Map<string, CardRecommendationContext>();
  if (itemIds.length === 0) return out;
  const own = (alias: string) => ownerPredicate(owner, alias, 2).sql;
  const seedOwner = owner.kind === 'account' ? 'ts.owner_account_id = $2' : 'false';
  const { rows } = await db.query<{ item_id: string; id: string; origin: RecommendationOrigin; display_reason: string | null }>(
    `SELECT DISTINCT ON (r.discovery_item_id) r.discovery_item_id AS item_id, r.id, r.origin, r.display_reason
       FROM recommendations r
       LEFT JOIN analyses a ON a.id = r.analysis_id
       LEFT JOIN captures c ON c.id = a.capture_id
       LEFT JOIN discovery_jobs dj ON dj.id = r.discovery_job_id
       LEFT JOIN taste_seed_runs ts ON ts.id = r.taste_seed_run_id
      WHERE r.discovery_item_id = ANY($1::uuid[])
        AND ((c.id IS NOT NULL AND ${own('c')} AND c.deleted_at IS NULL) OR (dj.id IS NOT NULL AND ${own('dj')})
             OR (ts.id IS NOT NULL AND ${seedOwner}))
      ORDER BY r.discovery_item_id, r.created_at DESC`,
    [itemIds, ...ownerPredicate(owner, '', 2).params],
  );
  for (const r of rows) out.set(r.item_id, { id: r.id, origin: r.origin, display_reason: r.display_reason });
  return out;
}

/** GET /v1/discoveries */
export async function getDiscoveries(ctx: ServiceContext, query: DiscoveriesQuery): Promise<DiscoveriesResponse> {
  requireScopes(ctx.principal, 'taste:read');
  requireWholeLibrary(ctx.principal);
  const owner = ownerOf(ctx.principal);
  // ONB-01: the account's own clients (browser, enrolled phone) do not get the
  // personal feed while the account still owes the taste questionnaire; every
  // client sees the same typed error, so ignoring the client gate does not help.
  if ((ctx.principal.kind === 'account' || ctx.principal.kind === 'installation') && (await isOnboardingRequired(ctx, ctx.principal.accountId))) {
    throw new AppError('onboarding_required', { details: { next: '/welcome/taste' } });
  }
  const limit = query.limit ?? LIMITS.feedPageDefault;
  const category = query.category ?? null;

  let snapshot: SnapshotRow | null;
  let position = 0;
  if (query.cursor) {
    const c = decodeCursor(query.cursor, FeedCursor);
    snapshot = await findSnapshot(ctx, owner, { id: c.f });
    if (!snapshot || snapshot.taste_revision !== c.r) {
      throw new AppError('invalid_input', { message: 'This feed has expired. Refresh to see more.', details: { reason: 'feed_expired' } });
    }
    if ((snapshot.category ?? null) !== category) {
      throw new AppError('invalid_input', { message: 'The cursor belongs to a different filter.' });
    }
    position = c.p;
  } else {
    const revision = await getTasteRevision(ctx.db, owner);
    snapshot = query.refresh ? null : await findSnapshot(ctx, owner, { revision, category });
    snapshot ??= await createSnapshot(ctx, owner, revision, category);
    // Living engine: any first-page read (poll or pull) may start the next
    // 15-minute wave. Dedupe occupies the wave, so 8s polls reuse it. The GET
    // itself never calls Qloo.
    if (owner.kind === 'account') {
      await enqueueInterestExpand(ctx.db, {
        accountId: owner.accountId,
        now: ctx.now(),
        traceId: ctx.traceId,
        config: ctx.config,
      });
    }
  }

  // Hide takes effect immediately, even inside an existing snapshot.
  const hidden = await hiddenKeys(ctx.db, owner);
  const ids = snapshot.ordered_item_ids;
  const pageIds: string[] = [];
  let next = position;
  while (next < ids.length && pageIds.length < limit) {
    const chunk = ids.slice(next, next + limit * 2);
    const keys = await ctx.db.query<{ id: string; canonical_key: string }>(
      'SELECT id, canonical_key FROM discovery_items WHERE id = ANY($1::uuid[])',
      [chunk],
    );
    const keyOf = new Map(keys.rows.map((r) => [r.id, r.canonical_key]));
    for (const id of chunk) {
      next++;
      const key = keyOf.get(id);
      if (key && !hidden.has(key)) pageIds.push(id);
      if (pageIds.length >= limit) break;
    }
  }
  const recs = snapshot.is_example_feed ? new Map() : await recommendationContexts(ctx.db, owner, pageIds);
  const items = await loadCards(ctx, pageIds, { recommendations: recs });
  return {
    items,
    next_cursor: next < ids.length ? encodeCursor({ f: snapshot.id, r: snapshot.taste_revision, p: next }) : null,
    feed_id: snapshot.id,
    feed_revision: snapshot.taste_revision,
    is_example_feed: snapshot.is_example_feed,
    available_categories: snapshot.available_categories,
  };
}
