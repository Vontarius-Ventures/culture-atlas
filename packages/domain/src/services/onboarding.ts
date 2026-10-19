import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { hasScope, requireAccountOwner, requireScopes, requireWholeLibrary } from '../authz';
import { violatedExclusions } from '../composer/dietary';
import { upsertDiscoveryItem } from '../composer/store';
import type { ServiceContext } from '../context';
import type { Db, Queryable } from '../db/pool';
import { type Category, type ItemKind } from '../enums';
import { AppError } from '../errors';
import { serviceFeatureState } from '../flags/feature-flags';
import { accountIdOf } from '../library/access';
import {
  entityTypeInfo,
  findCatalogItem,
  getOnboardingCatalogFile,
  itemForRef,
  primaryEntityType,
  SEARCH_TYPES,
} from '../onboarding/catalog';
import type { Owner } from '../principal';
import {
  FOOD_EXCLUSION_SUGGESTIONS,
  FoodExclusions,
  ONBOARDING_MAX_PICKS,
  ONBOARDING_MIN_PICKS,
  OnboardingImage,
  type CompleteOnboardingResponse,
  type CreatePickRequest,
  type CreatePickResponse,
  type DeletePickResponse,
  type ExclusionsResponse,
  type OnboardingCatalogEntry,
  type OnboardingCatalogResponse,
  type OnboardingPick,
  type OnboardingSearchQuery,
  type OnboardingSearchResponse,
  type OnboardingState,
  type OnboardingStateResponse,
  type PutExclusionsRequest,
  type QlooRef,
  type TastePicksResponse,
  type TasteSeedStatus,
} from '../schemas/onboarding';
import { currentUsage, secondsUntilUtcMidnight, tryConsume, utcDay } from '../quotas';
import { iso } from '../util/time';
import { recordPreference, saveItem, type TargetItem } from './preferences';
import { getTasteRevision } from './taste';
import { enqueueTasteSeed, getTasteSeedStatus } from './taste-seed';

/**
 * Taste onboarding (spec amendment 2.2): the sign-up questionnaire (screen 14),
 * its seed status (screen 15) and Settings -> Taste (screen 18).
 *
 * - Every pick is an explicit save of a real Qloo tag or entity, created via
 *   preferences.saveItem with source `onboarding`, so it shows in Saved for
 *   later, can be unsaved, and joins taste like any save. An image standing
 *   for several tags is ONE pick (one onboarding_picks row, several saves).
 * - Catalog picks come from fixtures/onboarding/catalog.json (real ids,
 *   retrieval dates); search picks only accept a server-signed `result_id`,
 *   so a client can never save an id Qloo did not return. Replayed (example)
 *   search data is never offered as a pick.
 * - A pick counts while at least one of its saves still exists.
 * - Food exclusions are preferences (`food.exclusions`), never taste and never
 *   picks; they are not sent to providers as identity data.
 * - `required` is true for a new account (and once, at sign-in, for an
 *   existing account with fewer than 3 explicit saves) until completion, and
 *   only while the onboarding_required flag is on.
 */

const SEARCH_TOKEN_TTL_SECONDS = 30 * 60;
const SEARCH_TIMEOUT_MS = 4000;
const SEARCH_MAX_CONCURRENT = 3;
/** Searches waiting for a slot, process-wide; beyond this a search reports `unavailable` at once. */
const SEARCH_MAX_WAITING = 12;
/** Searches one account may have in flight or waiting (the pickers debounce and cancel older ones). */
const SEARCH_MAX_PER_ACCOUNT = 2;

type Tx = Db;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface StateRow {
  required: boolean;
  origin: 'sign_up' | 'sign_in' | 'settings';
  started_at: Date | null;
  completed_at: Date | null;
  catalog_version: string | null;
  trigger_checked_at: Date | null;
}

async function loadStateRow(db: Queryable, accountId: string): Promise<StateRow | null> {
  const { rows } = await db.query<StateRow>(
    `SELECT required, origin, started_at, completed_at, catalog_version, trigger_checked_at
       FROM onboarding_states WHERE account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

async function lockAccount(db: Queryable, accountId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`onboarding:${accountId}`]);
}

/** Whether the questionnaire blocks the personal feed right now (flag on). */
export async function onboardingFlagOn(ctx: { db: Queryable; config: ServiceContext['config'] }, accountId: string): Promise<boolean> {
  return (await serviceFeatureState(ctx.db, { accountId, env: ctx.config }, 'onboarding_required')).enabled;
}

/** Ensures a state row exists (Settings -> Taste use creates one that is never required). */
async function ensureStateRow(db: Queryable, accountId: string, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO onboarding_states (account_id, required, origin, started_at, created_at, updated_at)
     VALUES ($1, false, 'settings', $2, $2, $2) ON CONFLICT (account_id) DO NOTHING`,
    [accountId, now],
  );
}

/** Counted picks: picks with at least one save still present. */
async function countActivePicks(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM onboarding_picks p
      WHERE p.account_id = $1
        AND EXISTS (SELECT 1 FROM onboarding_pick_items pi
                      JOIN saved_items si ON si.discovery_item_id = pi.discovery_item_id AND si.owner_account_id = p.account_id
                     WHERE pi.pick_id = p.id)`,
    [accountId],
  );
  return Number(rows[0]?.n ?? 0);
}

function stateDto(row: StateRow | null, picksCount: number, flagOn: boolean): OnboardingState {
  return {
    required: Boolean(flagOn && row?.required && !row.completed_at),
    picks_count: picksCount,
    min_picks: ONBOARDING_MIN_PICKS,
    started_at: row?.started_at ? iso(row.started_at) : null,
    completed_at: row?.completed_at ? iso(row.completed_at) : null,
    catalog_version: row?.catalog_version ?? null,
  };
}

async function currentState(ctx: Pick<ServiceContext, 'db' | 'config'>, db: Queryable, accountId: string): Promise<OnboardingState> {
  const row = await loadStateRow(db, accountId);
  const count = await countActivePicks(db, accountId);
  return stateDto(row, count, await onboardingFlagOn({ db, config: ctx.config }, accountId));
}

/** True while this account must finish the questionnaire before its personal feed. */
export async function isOnboardingRequired(ctx: Pick<ServiceContext, 'db' | 'config'>, accountId: string): Promise<boolean> {
  const row = await loadStateRow(ctx.db, accountId);
  if (!row?.required || row.completed_at) return false;
  return onboardingFlagOn(ctx, accountId);
}

/**
 * New account (sign-up, web or native): the questionnaire is required while
 * the flag is on. A save the visitor was making when asked to create the
 * account is preserved and counts as one pick (source `pending_save`).
 * Runs inside the account-creation transaction.
 */
export async function initForNewAccount(
  ctx: ServiceContext,
  tx: Tx,
  accountId: string,
  pending: { discovery_item_id: string } | null,
): Promise<boolean> {
  const now = ctx.now();
  const required = await onboardingFlagOn({ db: tx, config: ctx.config }, accountId);
  await tx.query(
    `INSERT INTO onboarding_states (account_id, required, origin, trigger_checked_at, created_at, updated_at)
     VALUES ($1, $2, 'sign_up', $3, $3, $3)
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId, required, now],
  );
  if (pending) await recordPendingSavePick(tx, accountId, pending.discovery_item_id, now);
  return required;
}

async function recordPendingSavePick(tx: Tx, accountId: string, itemId: string, now: Date): Promise<void> {
  const { rows } = await tx.query<{ title: string; category: Category | null; kind: ItemKind; display_metadata: Record<string, unknown> }>(
    'SELECT title, category, kind, display_metadata FROM discovery_items WHERE id = $1 AND (owner_account_id = $2 OR is_sample)',
    [itemId, accountId],
  );
  const item = rows[0];
  if (!item) return;
  const image = pendingImage(item.display_metadata);
  const pick = await tx.query<{ id: string }>(
    `INSERT INTO onboarding_picks (account_id, source, choice_key, label, category, item_kind, image, created_at)
     VALUES ($1, 'pending_save', $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (account_id, choice_key) DO NOTHING RETURNING id`,
    [accountId, `item:${itemId}`, item.title.slice(0, 200) || 'Your save', item.category, item.kind, image ? JSON.stringify(image) : null, now],
  );
  if (!pick.rows[0]) return;
  await tx.query(
    `INSERT INTO onboarding_pick_items (pick_id, account_id, discovery_item_id, position, created_save) VALUES ($1, $2, $3, 0, true)`,
    [pick.rows[0].id, accountId, itemId],
  );
  await tx.query('UPDATE onboarding_states SET started_at = COALESCE(started_at, $2), updated_at = $2 WHERE account_id = $1', [accountId, now]);
}

/** Only public licensed images travel with a pick (never a private photo object key). */
function pendingImage(meta: Record<string, unknown>): z.infer<typeof OnboardingImage> | null {
  const img = meta?.image as Record<string, unknown> | undefined;
  if (!img || typeof img.url !== 'string' || !img.url.startsWith('/')) return null;
  const parsed = OnboardingImage.safeParse({
    url: img.url,
    width: img.width,
    height: img.height,
    alt: typeof img.alt === 'string' && img.alt ? img.alt : 'Saved item',
    license: typeof img.license === 'string' ? img.license : undefined,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Existing account at sign-in: evaluated ONCE per account (flag on). Fewer
 * than 3 explicit saves -> the questionnaire is required until completed;
 * otherwise it never appears. Runs inside the sign-in transaction.
 */
export async function evaluateSignInTrigger(ctx: ServiceContext, tx: Tx, accountId: string): Promise<boolean> {
  const now = ctx.now();
  if (!(await onboardingFlagOn({ db: tx, config: ctx.config }, accountId))) {
    return false;
  }
  await lockAccount(tx, accountId);
  const row = await loadStateRow(tx, accountId);
  if (row?.trigger_checked_at) return Boolean(row.required && !row.completed_at);
  const { rows } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM saved_items WHERE owner_account_id = $1', [accountId]);
  const required = Number(rows[0]?.n ?? 0) < ONBOARDING_MIN_PICKS && !row?.completed_at;
  await tx.query(
    `INSERT INTO onboarding_states (account_id, required, origin, trigger_checked_at, created_at, updated_at)
     VALUES ($1, $2, 'sign_in', $3, $3, $3)
     ON CONFLICT (account_id) DO UPDATE
       SET required = EXCLUDED.required AND onboarding_states.completed_at IS NULL,
           trigger_checked_at = EXCLUDED.trigger_checked_at, updated_at = EXCLUDED.updated_at`,
    [accountId, required, now],
  );
  return required;
}

// ---------------------------------------------------------------------------
// Picks
// ---------------------------------------------------------------------------

interface PickRow {
  id: string;
  source: OnboardingPick['source'];
  catalog_item_id: string | null;
  label: string;
  category: Category | null;
  item_kind: ItemKind;
  image: unknown;
  created_at: Date;
  discovery_item_ids: string[];
  saved_item_ids: (string | null)[];
}

async function loadPicks(db: Queryable, accountId: string, pickId?: string): Promise<OnboardingPick[]> {
  const params: unknown[] = [accountId];
  let filter = '';
  if (pickId) {
    params.push(pickId);
    filter = 'AND p.id = $2';
  }
  const { rows } = await db.query<PickRow>(
    `SELECT p.id, p.source, p.catalog_item_id, p.label, p.category, p.item_kind, p.image, p.created_at,
            array_agg(pi.discovery_item_id ORDER BY pi.position) AS discovery_item_ids,
            array_agg(si.id ORDER BY pi.position) AS saved_item_ids
       FROM onboarding_picks p
       JOIN onboarding_pick_items pi ON pi.pick_id = p.id
       LEFT JOIN saved_items si ON si.discovery_item_id = pi.discovery_item_id AND si.owner_account_id = p.account_id
      WHERE p.account_id = $1 ${filter}
      GROUP BY p.id
      ORDER BY p.created_at, p.id`,
    params,
  );
  return rows.flatMap((r) => {
    const saved = r.saved_item_ids.filter((x): x is string => Boolean(x));
    if (!saved.length) return []; // every save of this pick was removed elsewhere
    const image = OnboardingImage.safeParse(r.image);
    return [
      {
        id: r.id,
        source: r.source,
        catalog_item_id: r.catalog_item_id,
        label: r.label,
        category: r.category,
        item_kind: r.item_kind,
        saved_item_ids: saved,
        discovery_item_ids: r.discovery_item_ids,
        image: image.success ? image.data : null,
        created_at: iso(r.created_at),
      },
    ];
  });
}

/** Search result token: binds the Qloo id, name and type to this account for a short time. */
const SearchToken = z.object({
  a: z.uuid(),
  i: z.string().min(1).max(200),
  n: z.string().min(1).max(120),
  t: z.string().regex(/^urn:[a-z0-9:_-]+$/i).max(120),
  x: z.number().int(),
});

function sign(secret: string, body: string): string {
  return createHmac('sha256', `onboarding-search:${secret}`).update(body).digest('base64url');
}

export function signSearchResult(secret: string, input: { accountId: string; ref: QlooRef; now: Date }): string {
  const body = Buffer.from(
    JSON.stringify({ a: input.accountId, i: input.ref.id, n: input.ref.name, t: input.ref.subtype, x: Math.floor(input.now.getTime() / 1000) + SEARCH_TOKEN_TTL_SECONDS }),
  ).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

function verifySearchResult(secret: string, token: string, accountId: string, now: Date): QlooRef {
  const expired = () => new AppError('invalid_input', { message: 'This search result has expired. Search again.' });
  const [body, mac] = token.split('.');
  if (!body || !mac) throw expired();
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw expired();
  let payload: z.infer<typeof SearchToken>;
  try {
    payload = SearchToken.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch {
    throw expired();
  }
  if (payload.a !== accountId || payload.x * 1000 < now.getTime()) throw expired();
  return { type: 'entity', id: payload.i, name: payload.n, subtype: payload.t };
}

interface Choice {
  source: 'catalog' | 'search';
  choiceKey: string;
  catalogItemId: string | null;
  label: string;
  category: Category | null;
  refs: QlooRef[];
  image: z.infer<typeof OnboardingImage> | null;
}

function resolveChoice(ctx: ServiceContext, accountId: string, req: CreatePickRequest): Choice {
  if (req.source === 'catalog') {
    const item = findCatalogItem(req.catalog_item_id);
    if (!item) throw new AppError('not_found', { message: 'That choice is no longer available.' });
    return {
      source: 'catalog',
      choiceKey: `catalog:${item.id}`,
      catalogItemId: item.id,
      label: item.label,
      category: item.category,
      refs: item.qloo,
      image: item.image ?? null,
    };
  }
  const ref = verifySearchResult(ctx.config.SESSION_SECRET, req.result_id, accountId, ctx.now());
  const info = ref.subtype ? entityTypeInfo(ref.subtype) : null;
  return {
    source: 'search',
    choiceKey: `qloo:${ref.id}`,
    catalogItemId: null,
    label: ref.name,
    category: info?.category ?? null,
    refs: [ref],
    image: null,
  };
}

async function existingPickId(db: Queryable, accountId: string, choiceKey: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM onboarding_picks WHERE account_id = $1 AND choice_key = $2', [accountId, choiceKey]);
  return rows[0]?.id ?? null;
}

/** POST /v1/onboarding/picks and POST /v1/taste/picks. Idempotent per choice. */
export async function createPick(ctx: ServiceContext, req: CreatePickRequest): Promise<CreatePickResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const accountId = owner.accountId;
  const choice = resolveChoice(ctx, accountId, req);
  const result = await ctx.db.transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const now = ctx.now();
    const prior = await existingPickId(tx, accountId, choice.choiceKey);
    if (prior) {
      const [active] = await loadPicks(tx, accountId, prior);
      if (active) return { pick: active, already: true };
      // Every save of the earlier pick was removed elsewhere: pick it afresh.
      await tx.query('DELETE FROM onboarding_picks WHERE id = $1', [prior]);
    }
    if ((await countActivePicks(tx, accountId)) >= ONBOARDING_MAX_PICKS) {
      throw new AppError('conflict', { message: `You can keep up to ${ONBOARDING_MAX_PICKS} picks. Remove one to add another.` });
    }
    const pctx: ServiceContext = { ...ctx, db: tx };
    const ownerRef: Owner = { kind: 'account', accountId };
    const saved: { itemId: string; created: boolean; kind: ItemKind }[] = [];
    for (const ref of choice.refs) {
      const spec = itemForRef(ref, choice.category);
      const itemId = await upsertDiscoveryItem(tx, ownerRef, {
        kind: spec.kind,
        category: spec.category,
        canonical_key: spec.canonical_key,
        title: spec.title,
        display_metadata: { subtitle: spec.subtitle },
        external_ids: spec.external_ids,
      });
      const { rows } = await tx.query<TargetItem>(
        'SELECT id, canonical_key, kind, capture_id, is_sample FROM discovery_items WHERE id = $1',
        [itemId],
      );
      const target = rows[0]!;
      const { created } = await saveItem(
        pctx,
        tx,
        target,
        { action: 'save', target_type: 'discovery_item', target_id: itemId },
        { source: 'onboarding' },
      );
      saved.push({ itemId, created, kind: target.kind });
    }
    const pick = await tx.query<{ id: string }>(
      `INSERT INTO onboarding_picks (account_id, source, choice_key, catalog_item_id, label, category, item_kind, image, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING id`,
      [accountId, choice.source, choice.choiceKey, choice.catalogItemId, choice.label, choice.category, saved[0]!.kind,
        choice.image ? JSON.stringify(choice.image) : null, now],
    );
    const pickId = pick.rows[0]!.id;
    for (const [position, s] of saved.entries()) {
      await tx.query(
        `INSERT INTO onboarding_pick_items (pick_id, account_id, discovery_item_id, position, created_save)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [pickId, accountId, s.itemId, position, s.created],
      );
    }
    await ensureStateRow(tx, accountId, now);
    await tx.query('UPDATE onboarding_states SET started_at = COALESCE(started_at, $2), updated_at = $2 WHERE account_id = $1', [accountId, now]);
    const [created] = await loadPicks(tx, accountId, pickId);
    return { pick: created!, already: false };
  });
  if (!result.already) await reseedAfterTasteChange(ctx, accountId);
  return {
    pick: result.pick,
    already_picked: result.already,
    state: await currentState(ctx, ctx.db, accountId),
    taste_revision: await getTasteRevision(ctx.db, { kind: 'account', accountId }),
  };
}

/**
 * DELETE /v1/onboarding/picks/{id} and /v1/taste/picks/{id}: unsaves the
 * saves this pick created (not ones the account already had, and not items
 * another current pick still stands for). Allowed below the minimum.
 */
export async function deletePick(ctx: ServiceContext, pickId: string): Promise<DeletePickResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const accountId = owner.accountId;
  await ctx.db.transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const { rows } = await tx.query<{ discovery_item_id: string; created_save: boolean }>(
      `SELECT pi.discovery_item_id, pi.created_save FROM onboarding_picks p
         JOIN onboarding_pick_items pi ON pi.pick_id = p.id
        WHERE p.id = $1 AND p.account_id = $2`,
      [pickId, accountId],
    );
    if (!rows.length) throw new AppError('not_found');
    const pctx: ServiceContext = { ...ctx, db: tx };
    for (const r of rows) {
      if (!r.created_save) continue;
      // Another current pick stands for the same item (an image and a chip
      // can share a Qloo tag): it inherits ownership of the save, so removing
      // that pick later unsaves the item instead of leaving it behind.
      const heir = await tx.query<{ pick_id: string }>(
        `SELECT pi.pick_id FROM onboarding_pick_items pi JOIN onboarding_picks p ON p.id = pi.pick_id
          WHERE pi.account_id = $1 AND pi.discovery_item_id = $2 AND pi.pick_id <> $3
          ORDER BY p.created_at, p.id LIMIT 1`,
        [accountId, r.discovery_item_id, pickId],
      );
      if (heir.rows[0]) {
        await tx.query(
          'UPDATE onboarding_pick_items SET created_save = true WHERE pick_id = $1 AND discovery_item_id = $2',
          [heir.rows[0].pick_id, r.discovery_item_id],
        );
        continue;
      }
      await recordPreference(pctx, { action: 'remove', target_type: 'discovery_item', target_id: r.discovery_item_id });
    }
    await tx.query('DELETE FROM onboarding_picks WHERE id = $1 AND account_id = $2', [pickId, accountId]);
  });
  await reseedAfterTasteChange(ctx, accountId);
  return {
    removed_pick_id: pickId,
    state: await currentState(ctx, ctx.db, accountId),
    taste_revision: await getTasteRevision(ctx.db, { kind: 'account', accountId }),
  };
}

// ---------------------------------------------------------------------------
// Catalog and search
// ---------------------------------------------------------------------------

/** GET /v1/onboarding/catalog (consumer projection: no Qloo ids). */
export async function getCatalog(ctx: ServiceContext): Promise<OnboardingCatalogResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const file = getOnboardingCatalogFile();
  await ctx.db.query(
    'UPDATE onboarding_states SET catalog_version = $2, updated_at = $3 WHERE account_id = $1 AND catalog_version IS DISTINCT FROM $2',
    [owner.accountId, file.catalog_version, ctx.now()],
  );
  const picks = await loadPicks(ctx.db, owner.accountId);
  const byCatalog = new Map(picks.filter((p) => p.catalog_item_id).map((p) => [p.catalog_item_id!, p.id]));
  const entry = (i: (typeof file.items)[number]): OnboardingCatalogEntry => ({
    id: i.id,
    kind: i.kind,
    category: i.category,
    label: i.label,
    image: i.image ?? null,
    picked: byCatalog.has(i.id),
    pick_id: byCatalog.get(i.id) ?? null,
  });
  const chips = (c: Category) => file.items.filter((i) => i.kind === 'chip' && i.category === c).map(entry);
  return {
    catalog_version: file.catalog_version,
    images: file.items.filter((i) => i.kind === 'image').map(entry),
    chips: { wear: chips('wear'), play: chips('play'), watch: chips('watch'), eat: chips('eat') },
    exclusion_suggestions: [...FOOD_EXCLUSION_SUGGESTIONS],
    min_picks: ONBOARDING_MIN_PICKS,
  };
}

let searchesInFlight = 0;
const searchWaiters: (() => void)[] = [];
const searchesByAccount = new Map<string, number>();

/** Thrown when the bounded search queue is full; reported as `unavailable`, never queued without bound. */
class SearchQueueFull extends Error {}

/**
 * Process-wide cap on concurrent onboarding searches (the hackathon key
 * throttles bursts), with a bounded wait queue and at most
 * SEARCH_MAX_PER_ACCOUNT searches per account in flight or waiting, so one
 * account cannot fill the queue for everyone.
 */
async function withSearchSlot<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const mine = searchesByAccount.get(accountId) ?? 0;
  if (mine >= SEARCH_MAX_PER_ACCOUNT) throw new SearchQueueFull();
  if (searchesInFlight >= SEARCH_MAX_CONCURRENT && searchWaiters.length >= SEARCH_MAX_WAITING) throw new SearchQueueFull();
  searchesByAccount.set(accountId, mine + 1);
  try {
    while (searchesInFlight >= SEARCH_MAX_CONCURRENT) await new Promise<void>((r) => searchWaiters.push(r));
    searchesInFlight++;
    try {
      return await fn();
    } finally {
      searchesInFlight--;
      searchWaiters.shift()?.();
    }
  } finally {
    const left = (searchesByAccount.get(accountId) ?? 1) - 1;
    if (left > 0) searchesByAccount.set(accountId, left);
    else searchesByAccount.delete(accountId);
  }
}

/**
 * One unit of the account's daily onboarding-search quota on the shared Qloo
 * key (ACCOUNT_DAILY_ONBOARDING_SEARCHES). Throws 429 quota_exceeded, which
 * the pickers show as "Search is taking a break".
 */
async function consumeSearchQuota(ctx: ServiceContext, accountId: string): Promise<void> {
  const used = await tryConsume(ctx.db, {
    bucket: `account:${accountId}`,
    metric: 'onboarding_searches',
    day: utcDay(ctx.now()),
    limit: ctx.config.ACCOUNT_DAILY_ONBOARDING_SEARCHES,
  });
  if (used === null) {
    throw new AppError('quota_exceeded', {
      message: 'Search is taking a break for today. Pick from the ideas above.',
      retryAfter: secondsUntilUtcMidnight(ctx.now()),
    });
  }
}

/**
 * GET /v1/onboarding/search: live Qloo entity search, name and type only.
 * Qloo down, throttled or only replay data available -> status 'unavailable'
 * ("Search is taking a break. Pick from the ideas above."); never fabricated.
 */
export async function search(ctx: ServiceContext, query: OnboardingSearchQuery): Promise<OnboardingSearchResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const types = SEARCH_TYPES[query.category ?? 'all'];
  await consumeSearchQuota(ctx, owner.accountId);
  let entities;
  try {
    const res = await withSearchSlot(owner.accountId, () =>
      ctx.providers.qloo.searchEntities(
        { query: query.q, types: types as never, take: 10 },
        { timeoutMs: SEARCH_TIMEOUT_MS, maxRetries: 0 },
      ),
    );
    if (res.is_replay) return { status: 'unavailable', results: [] };
    entities = res.data;
  } catch {
    return { status: 'unavailable', results: [] };
  }
  const { rows: active } = await ctx.db.query<{ choice_key: string; id: string }>(
    `SELECT p.choice_key, p.id FROM onboarding_picks p
      WHERE p.account_id = $1 AND p.source = 'search'
        AND EXISTS (SELECT 1 FROM onboarding_pick_items pi
                      JOIN saved_items si ON si.discovery_item_id = pi.discovery_item_id AND si.owner_account_id = p.account_id
                     WHERE pi.pick_id = p.id)`,
    [owner.accountId],
  );
  const activeKeys = new Map(active.map((r) => [r.choice_key, r.id]));
  const seen = new Set<string>();
  const results: OnboardingSearchResponse['results'] = [];
  for (const e of entities) {
    const type = primaryEntityType(e.types, e.subtype);
    if (!type || seen.has(e.entity_id) || !e.name?.trim()) continue;
    const info = entityTypeInfo(type)!;
    if (query.category && info.category !== query.category && !types.includes(type)) continue;
    seen.add(e.entity_id);
    const ref: QlooRef = { type: 'entity', id: e.entity_id.slice(0, 200), name: e.name.trim().slice(0, 120), subtype: type };
    results.push({
      result_id: signSearchResult(ctx.config.SESSION_SECRET, { accountId: owner.accountId, ref, now: ctx.now() }),
      name: ref.name,
      type_label: info.label,
      category: info.category,
      picked: activeKeys.has(`qloo:${ref.id}`),
      pick_id: activeKeys.get(`qloo:${ref.id}`) ?? null,
    });
    if (results.length >= 10) break;
  }
  return { status: 'ok', results };
}

// ---------------------------------------------------------------------------
// Exclusions (preferences, not taste)
// ---------------------------------------------------------------------------

/** The account's food exclusions (`preferences.food.exclusions`), [] when unset or malformed. */
export async function loadFoodExclusions(db: Queryable, accountId: string): Promise<string[]> {
  const { rows } = await db.query<{ exclusions: unknown }>(
    `SELECT preferences -> 'food' -> 'exclusions' AS exclusions FROM accounts WHERE id = $1`,
    [accountId],
  );
  const parsed = FoodExclusions.safeParse(rows[0]?.exclusions ?? []);
  return parsed.success ? parsed.data : [];
}

/** Exclusions for an owner (anonymous sessions have none). */
export async function foodExclusionsFor(db: Queryable, owner: Owner): Promise<string[]> {
  return owner.kind === 'account' ? loadFoodExclusions(db, owner.accountId) : [];
}

export function normalizeExclusions(list: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const v = raw.trim().replace(/\s+/g, ' ');
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return FoodExclusions.parse(out);
}

/**
 * Eat filtering (ONB-05): ids of food candidates whose title, cuisine or
 * description mention an excluded ingredient (composer/dietary.ts rules).
 */
export async function excludedFoodItemIds(db: Queryable, ids: readonly string[], exclusions: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length || !exclusions.length) return out;
  const { rows } = await db.query<{ id: string; title: string; display_metadata: Record<string, unknown> }>(
    `SELECT id, title, display_metadata FROM discovery_items WHERE id = ANY($1::uuid[]) AND kind = 'food'`,
    [[...ids]],
  );
  for (const r of rows) {
    const m = r.display_metadata ?? {};
    const text = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : null);
    const dish = { title: r.title, description: text('description'), cuisine: [text('subtitle'), text('detail')].filter(Boolean).join(' ') };
    if (violatedExclusions(dish, exclusions).length) out.add(r.id);
  }
  return out;
}

/** PUT /v1/onboarding/exclusions: replaces `food.exclusions` (an ordinary preference). */
export async function putExclusions(ctx: ServiceContext, body: PutExclusionsRequest): Promise<ExclusionsResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const exclusions = normalizeExclusions(body.food_exclusions);
  await ctx.db.query(
    `UPDATE accounts
        SET preferences = jsonb_set(preferences, '{food}',
              (CASE WHEN jsonb_typeof(preferences -> 'food') = 'object' THEN preferences -> 'food' ELSE '{}'::jsonb END)
              || jsonb_build_object('exclusions', $2::jsonb)),
            preferences_version = preferences_version + 1, updated_at = $3
      WHERE id = $1`,
    [owner.accountId, JSON.stringify(exclusions), ctx.now()],
  );
  // Cached feed snapshots were filtered with the old list; the next read rebuilds from the existing pool.
  await ctx.db.query('DELETE FROM feed_snapshots WHERE owner_account_id = $1', [owner.accountId]);
  return { food_exclusions: await loadFoodExclusions(ctx.db, owner.accountId) };
}

// ---------------------------------------------------------------------------
// Completion and seed status
// ---------------------------------------------------------------------------

/**
 * GET /v1/onboarding/seed. The seed job's own status (services/taste-seed.ts):
 * per-category progress from taste_seed_runs / taste_seed_categories, the
 * job row for queued, running and retrying.
 */
export async function getSeedStatus(ctx: ServiceContext): Promise<TasteSeedStatus> {
  const owner = requireAccountOwner(ctx.principal);
  return seedStatusFor(ctx.db, owner.accountId, ctx.now());
}

export function seedStatusFor(db: Queryable, accountId: string, now?: Date): Promise<TasteSeedStatus> {
  return getTasteSeedStatus(db, accountId, now);
}

/**
 * POST /v1/onboarding/complete: at least 3 counted picks, else 409. Marks
 * onboarding complete and queues one taste_seed job (deduped per taste
 * revision) when taste_seed_enabled is on. Idempotent.
 */
export async function complete(ctx: ServiceContext): Promise<CompleteOnboardingResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const accountId = owner.accountId;
  await ctx.db.transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const count = await countActivePicks(tx, accountId);
    if (count < ONBOARDING_MIN_PICKS) {
      throw new AppError('conflict', {
        message: 'Pick at least 3 so your feed starts with you.',
        details: { picks_count: count, min_picks: ONBOARDING_MIN_PICKS },
      });
    }
    const now = ctx.now();
    await ensureStateRow(tx, accountId, now);
    await tx.query(
      `UPDATE onboarding_states SET required = false, completed_at = COALESCE(completed_at, $2),
              catalog_version = COALESCE(catalog_version, $3), updated_at = $2
        WHERE account_id = $1`,
      [accountId, now, getOnboardingCatalogFile().catalog_version],
    );
    await queueTasteSeed({ ...ctx, db: tx }, accountId);
  });
  return { state: await currentState(ctx, ctx.db, accountId), seed: await seedStatusFor(ctx.db, accountId, ctx.now()) };
}

async function queueTasteSeed(ctx: ServiceContext, accountId: string, availableAt?: Date): Promise<boolean> {
  // When taste_seed_enabled is off nothing is queued: the feed keeps its labeled examples.
  const owner: Owner = { kind: 'account', accountId };
  const row = await loadStateRow(ctx.db, accountId);
  const out = await enqueueTasteSeed(ctx.db, {
    accountId,
    tasteRevision: await getTasteRevision(ctx.db, owner),
    catalogVersion: row?.catalog_version ?? null,
    config: ctx.config,
    traceId: ctx.traceId,
    now: ctx.now(),
    availableAt,
  });
  if (out.enqueued) {
    // Counted so Settings -> Taste reseeds stay within the account's daily cap
    // (completion is always queued; it counts toward the same day).
    await tryConsume(ctx.db, {
      bucket: `account:${accountId}`,
      metric: 'taste_seeds',
      day: utcDay(ctx.now()),
      limit: 2_000_000_000,
    });
  }
  return out.enqueued;
}

/** Minimum spacing between Settings -> Taste reseeds of one account. */
export const TASTE_RESEED_MIN_INTERVAL_MS = 2 * 60_000;

/**
 * Settings -> Taste: once onboarding is complete, a pick added or removed
 * queues a fresh seed for the new taste revision, so the personal feed follows
 * the picks. Bounded on the shared Qloo key:
 * - a seed that is still queued (not yet started) already reads the current
 *   saves when it runs, so no second one is queued behind it;
 * - a new seed starts no sooner than TASTE_RESEED_MIN_INTERVAL_MS after the
 *   account's previous one was queued (it waits, absorbing further edits);
 * - at most ACCOUNT_DAILY_TASTE_SEEDS seeds per account per day; past that the
 *   picks still change taste and the feed, only no new Qloo seed runs today.
 */
async function reseedAfterTasteChange(ctx: ServiceContext, accountId: string): Promise<void> {
  const row = await loadStateRow(ctx.db, accountId);
  if (!row?.completed_at) return; // during onboarding the seed starts at completion
  const queued = await ctx.db.query(
    `SELECT 1 FROM jobs WHERE owner_account_id = $1 AND type = 'taste_seed' AND state = 'queued' AND attempt = 0 LIMIT 1`,
    [accountId],
  );
  if (queued.rowCount) return;
  const now = ctx.now();
  if ((await currentUsage(ctx.db, `account:${accountId}`, 'taste_seeds', utcDay(now))) >= ctx.config.ACCOUNT_DAILY_TASTE_SEEDS) return;
  const { rows } = await ctx.db.query<{ created_at: Date }>(
    'SELECT created_at FROM taste_seed_runs WHERE owner_account_id = $1 ORDER BY created_at DESC LIMIT 1',
    [accountId],
  );
  const last = rows[0]?.created_at;
  const earliest = last ? new Date(last.getTime() + TASTE_RESEED_MIN_INTERVAL_MS) : null;
  await queueTasteSeed(ctx, accountId, earliest && earliest > now ? earliest : undefined);
}

/** GET /v1/onboarding/state */
export async function getState(ctx: ServiceContext): Promise<OnboardingStateResponse> {
  const owner = requireAccountOwner(ctx.principal);
  return {
    state: await currentState(ctx, ctx.db, owner.accountId),
    picks: await loadPicks(ctx.db, owner.accountId),
    food_exclusions: await loadFoodExclusions(ctx.db, owner.accountId),
    seed: await seedStatusFor(ctx.db, owner.accountId, ctx.now()),
  };
}

// ---------------------------------------------------------------------------
// Settings -> Taste
// ---------------------------------------------------------------------------

/**
 * GET /v1/taste/picks. Picks are taste: `taste:read`, and agents need
 * whole-library access (picks are not collection members). Exclusions are
 * preferences: included only with `preferences:read`, else null.
 */
export async function listTastePicks(ctx: ServiceContext): Promise<TastePicksResponse> {
  requireScopes(ctx.principal, 'taste:read');
  requireWholeLibrary(ctx.principal);
  const accountId = accountIdOf(ctx.principal);
  if (!accountId) throw new AppError('account_required');
  const picks = await loadPicks(ctx.db, accountId);
  const group = (c: Category | null) => picks.filter((p) => p.category === c);
  return {
    picks: { wear: group('wear'), play: group('play'), watch: group('watch'), eat: group('eat'), other: group(null) },
    picks_count: picks.length,
    food_exclusions: hasScope(ctx.principal, 'preferences:read') ? await loadFoodExclusions(ctx.db, accountId) : null,
  };
}

