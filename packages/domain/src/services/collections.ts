import { z } from 'zod';
import {
  grantedCollectionFilter,
  requireAccount,
  requireCanCreateCollection,
  requireScopes,
  requireWholeLibrary,
} from '../authz';
import { agentActivity } from '../authz/agent-authorization';
import type { ServiceContext } from '../context';
import type { Db, Queryable } from '../db/pool';
import { COLLECTION_FILTER_KINDS, COLLECTION_FILTERS, type CollectionFilter, type ItemKind } from '../enums';
import { AppError } from '../errors';
import { assertAgentCannotExposeMedia } from '../sharing/agent-guard';
import { loadAccessibleCollection, requireVisibleItem, type CollectionRow } from '../library/access';
import type { Image } from '../schemas/common';
import type {
  AddCollectionItemRequest,
  AddCollectionItemResponse,
  CollectionDetailResponse,
  CollectionQuery,
  CollectionSummary,
  CollectionsListResponse,
  CreateCollectionRequest,
  RemoveCollectionItemResponse,
  ReorderCollectionRequest,
  ReorderCollectionResponse,
  UpdateCollectionRequest,
} from '../schemas/collections';
import { decodeCursor, encodeCursor } from '../util/cursor';
import { iso } from '../util/time';
import { loadCards } from './cards';
import { saveItem, type TargetItem } from './preferences';

/**
 * Collections module. Private by default; account-only. Every successful
 * mutation increments collections.revision; expected_revision mismatches
 * return 409 revision_conflict. Agents: list/read limited to granted
 * collections (grantedCollectionFilter); create requires collections:write +
 * whole-library; adding an UNSAVED item additionally requires taste:write.
 *
 * Membership semantics (spec "Collections and saving"): an item may belong to
 * many collections; removing a membership keeps the saved item and its other
 * memberships; "unsave everywhere" is POST /v1/preferences remove; deleting a
 * collection leaves items without remaining memberships as unfiled saves and
 * keeps existing plans (their source_collection_id is detached, the input
 * snapshot is retained).
 */

const COVER_MAX = 4;

function accountId(ctx: ServiceContext): string {
  return requireAccount(ctx.principal).accountId;
}

/** Cover mosaics: first images by position for each collection. */
async function covers(ctx: ServiceContext, db: Db, collectionIds: string[]): Promise<Map<string, { count: number; cover: Image[] }>> {
  const out = new Map<string, { count: number; cover: Image[] }>();
  for (const id of collectionIds) out.set(id, { count: 0, cover: [] });
  if (collectionIds.length === 0) return out;
  const counts = await db.query<{ collection_id: string; n: number }>(
    'SELECT collection_id, count(*)::int AS n FROM collection_items WHERE collection_id = ANY($1::uuid[]) GROUP BY collection_id',
    [collectionIds],
  );
  for (const r of counts.rows) out.get(r.collection_id)!.count = r.n;
  const heads = await db.query<{ collection_id: string; item_id: string }>(
    `SELECT collection_id, item_id FROM (
       SELECT ci.collection_id, si.discovery_item_id AS item_id,
              row_number() OVER (PARTITION BY ci.collection_id ORDER BY ci.position, ci.added_at, ci.id) AS rn
         FROM collection_items ci JOIN saved_items si ON si.id = ci.saved_item_id
        WHERE ci.collection_id = ANY($1::uuid[])) x
      WHERE rn <= 12 ORDER BY collection_id, rn`,
    [collectionIds],
  );
  const cards = new Map((await loadCards({ ...ctx, db }, [...new Set(heads.rows.map((r) => r.item_id))])).map((c) => [c.id, c]));
  for (const r of heads.rows) {
    const entry = out.get(r.collection_id)!;
    const image = cards.get(r.item_id)?.image;
    if (image && entry.cover.length < COVER_MAX) entry.cover.push(image);
  }
  return out;
}

async function summaries(ctx: ServiceContext, db: Db, rows: CollectionRow[]): Promise<CollectionSummary[]> {
  const meta = await covers(ctx, db, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    item_count: meta.get(r.id)?.count ?? 0,
    cover: meta.get(r.id)?.cover ?? [],
    revision: r.revision,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }));
}

const COLLECTION_COLUMNS = 'id, owner_account_id, name, description, revision, created_at, updated_at';

function revisionConflict(current: number): AppError {
  return new AppError('revision_conflict', { details: { current_revision: current } });
}

/** GET /v1/collections */
export async function listCollections(ctx: ServiceContext): Promise<CollectionsListResponse> {
  requireScopes(ctx.principal, 'collections:read');
  const owner = accountId(ctx);
  const filter = grantedCollectionFilter(ctx.principal);
  const { rows } = await ctx.db.query<CollectionRow>(
    `SELECT ${COLLECTION_COLUMNS} FROM collections
      WHERE owner_account_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      ORDER BY updated_at DESC, id`,
    [owner, filter ? [...filter] : null],
  );
  const collections = await summaries(ctx, ctx.db, rows);
  let unfiled: CollectionsListResponse['unfiled'] = null;
  if (!filter) {
    const u = await ctx.db.query<{ discovery_item_id: string }>(
      `SELECT si.discovery_item_id FROM saved_items si
        WHERE si.owner_account_id = $1
          AND NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.saved_item_id = si.id)
        ORDER BY si.saved_at DESC, si.id`,
      [owner],
    );
    const cards = await loadCards(ctx, u.rows.slice(0, 12).map((r) => r.discovery_item_id));
    unfiled = {
      item_count: u.rows.length,
      cover: cards.flatMap((c) => (c.image ? [c.image] : [])).slice(0, COVER_MAX),
    };
  }
  return { collections, unfiled };
}

/** POST /v1/collections (201) */
export async function createCollection(ctx: ServiceContext, body: CreateCollectionRequest): Promise<CollectionSummary> {
  requireCanCreateCollection(ctx.principal);
  const { rows } = await ctx.db.query<CollectionRow>(
    `INSERT INTO collections (owner_account_id, name, description) VALUES ($1, $2, $3) RETURNING ${COLLECTION_COLUMNS}`,
    [accountId(ctx), body.name, body.description ?? null],
  );
  return (await summaries(ctx, ctx.db, rows))[0]!;
}

const MemberCursor = z.object({ p: z.number().int(), a: z.string(), id: z.uuid() });

function filtersFor(kinds: Set<ItemKind>): CollectionFilter[] {
  return COLLECTION_FILTERS.filter((f) => COLLECTION_FILTER_KINDS[f].some((k) => kinds.has(k)));
}

/** GET /v1/collections/{id} */
export async function getCollection(
  ctx: ServiceContext,
  input: { id: string; query: CollectionQuery },
): Promise<CollectionDetailResponse> {
  requireScopes(ctx.principal, 'collections:read');
  const col = await loadAccessibleCollection(ctx, input.id);
  // Owner-visible agent activity ("Viewed Quiet weekends"); a no-op for people.
  if (!input.query.cursor) await agentActivity(ctx, 'collection.read', col.id);
  const limit = input.query.limit ?? 24;
  const params: unknown[] = [col.id];
  const where = ['ci.collection_id = $1'];
  if (input.query.filter) {
    params.push(COLLECTION_FILTER_KINDS[input.query.filter]);
    where.push(`di.kind = ANY($${params.length}::text[])`);
  }
  if (input.query.cursor) {
    const c = decodeCursor(input.query.cursor, MemberCursor);
    params.push(c.p, c.a, c.id);
    const n = params.length;
    where.push(`(ci.position, ci.added_at, ci.id) > ($${n - 2}::int, $${n - 1}::timestamptz, $${n}::uuid)`);
  }
  params.push(limit + 1);
  const { rows } = await ctx.db.query<{
    id: string;
    saved_item_id: string;
    position: number;
    added_at: Date;
    added_key: string;
    item_id: string;
  }>(
    `SELECT ci.id, ci.saved_item_id, ci.position, ci.added_at,
            to_char(ci.added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS added_key,
            si.discovery_item_id AS item_id
       FROM collection_items ci
       JOIN saved_items si ON si.id = ci.saved_item_id
       JOIN discovery_items di ON di.id = si.discovery_item_id
      WHERE ${where.join(' AND ')}
      ORDER BY ci.position, ci.added_at, ci.id
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const cards = new Map((await loadCards(ctx, page.map((r) => r.item_id))).map((c) => [c.id, c]));
  const kinds = await ctx.db.query<{ kind: ItemKind }>(
    `SELECT DISTINCT di.kind FROM collection_items ci
       JOIN saved_items si ON si.id = ci.saved_item_id JOIN discovery_items di ON di.id = si.discovery_item_id
      WHERE ci.collection_id = $1`,
    [col.id],
  );
  const last = page[page.length - 1];
  return {
    collection: (await summaries(ctx, ctx.db, [col]))[0]!,
    items: page.flatMap((r) => {
      const card = cards.get(r.item_id);
      return card
        ? [{ membership_id: r.id, saved_item_id: r.saved_item_id, position: r.position, added_at: iso(r.added_at), item: card }]
        : [];
    }),
    next_cursor: rows.length > limit && last ? encodeCursor({ p: last.position, a: last.added_key, id: last.id }) : null,
    available_filters: filtersFor(new Set(kinds.rows.map((r) => r.kind))),
  };
}

/** PATCH /v1/collections/{id} */
export async function updateCollection(
  ctx: ServiceContext,
  input: { id: string; body: UpdateCollectionRequest },
): Promise<CollectionSummary> {
  requireScopes(ctx.principal, 'collections:write');
  return ctx.db.transaction(async (db) => {
    const col = await loadAccessibleCollection(ctx, input.id, { db, lock: true });
    if (col.revision !== input.body.expected_revision) throw revisionConflict(col.revision);
    const { rows } = await db.query<CollectionRow>(
      `UPDATE collections
          SET name = COALESCE($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              revision = revision + 1, updated_at = now()
        WHERE id = $1 RETURNING ${COLLECTION_COLUMNS}`,
      [
        col.id,
        input.body.name ?? null,
        input.body.description !== undefined,
        input.body.description === undefined ? null : input.body.description || null,
      ],
    );
    return (await summaries(ctx, db, rows))[0]!;
  });
}

/**
 * DELETE /v1/collections/{id} — removes collection + memberships; saved items
 * with no remaining memberships become unfiled; plans keep their snapshot and
 * get source_collection_id = NULL (FK ON DELETE SET NULL). Agent grants on it
 * cascade. Agents need whole-library access (deleting affects unfiled saves).
 */
export async function deleteCollection(ctx: ServiceContext, input: { id: string }): Promise<void> {
  requireScopes(ctx.principal, 'collections:write');
  requireWholeLibrary(ctx.principal);
  await ctx.db.transaction(async (db) => {
    const col = await loadAccessibleCollection(ctx, input.id, { db, lock: true });
    await db.query('DELETE FROM collections WHERE id = $1', [col.id]);
  });
}

async function resolveAddTarget(ctx: ServiceContext, db: Queryable, owner: string, itemId: string): Promise<TargetItem> {
  // Accept a DiscoveryItem id (spec) or, for convenience, one of the owner's SavedItem ids.
  const viaSaved = await db.query<{ discovery_item_id: string }>(
    'SELECT discovery_item_id FROM saved_items WHERE id = $1 AND owner_account_id = $2',
    [itemId, owner],
  );
  const id = viaSaved.rows[0]?.discovery_item_id ?? itemId;
  await requireVisibleItem(ctx, id, db);
  const { rows } = await db.query<TargetItem>(
    'SELECT id, canonical_key, kind, capture_id, is_sample FROM discovery_items WHERE id = $1',
    [id],
  );
  if (!rows[0]) throw new AppError('not_found');
  return rows[0];
}

/**
 * PUT /v1/collections/{id}/items/{item_id} — item_id is a DiscoveryItem id.
 * Saves the accessible item if needed and adds membership idempotently.
 */
export async function addCollectionItem(
  ctx: ServiceContext,
  input: { id: string; item_id: string; body: AddCollectionItemRequest },
): Promise<AddCollectionItemResponse> {
  requireScopes(ctx.principal, 'collections:write');
  const owner = accountId(ctx);
  return ctx.db.transaction(async (db) => {
    const col = await loadAccessibleCollection(ctx, input.id, { db, lock: true });
    if (input.body.expected_revision !== undefined && input.body.expected_revision !== col.revision) {
      throw revisionConflict(col.revision);
    }
    const item = await resolveAddTarget(ctx, db, owner, input.item_id);
    // A capture item carries its photo or video into a share that includes media.
    if (item.capture_id) await assertAgentCannotExposeMedia(db, ctx.principal, owner, col.id, ctx.now());
    const existing = await db.query<{ id: string }>(
      'SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
      [owner, item.id],
    );
    let savedItemId = existing.rows[0]?.id;
    let saved = false;
    if (!savedItemId) {
      // Adding an unsaved item is also a save (an explicit endorsement).
      requireScopes(ctx.principal, 'taste:write');
      const r = await saveItem(ctx, db, item, { action: 'save', target_type: 'discovery_item', target_id: item.id });
      savedItemId = r.saved.id;
      saved = r.created;
    }
    const ins = await db.query<{ id: string }>(
      `INSERT INTO collection_items (collection_id, saved_item_id, owner_account_id, position)
       VALUES ($1, $2, $3, COALESCE((SELECT max(position) + 1 FROM collection_items WHERE collection_id = $1), 0))
       ON CONFLICT (collection_id, saved_item_id) DO NOTHING RETURNING id`,
      [col.id, savedItemId, owner],
    );
    let revision = col.revision;
    let membershipId = ins.rows[0]?.id;
    if (membershipId) {
      const r = await db.query<{ revision: number }>(
        'UPDATE collections SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision',
        [col.id],
      );
      revision = r.rows[0]!.revision;
    } else {
      const m = await db.query<{ id: string }>(
        'SELECT id FROM collection_items WHERE collection_id = $1 AND saved_item_id = $2',
        [col.id, savedItemId],
      );
      membershipId = m.rows[0]!.id;
    }
    return {
      collection_id: col.id,
      membership_id: membershipId,
      saved_item_id: savedItemId,
      collection_revision: revision,
      created: Boolean(ins.rows[0]),
      saved,
    };
  });
}

/**
 * DELETE /v1/collections/{id}/items/{item_id} — this membership only. The
 * saved item, its endorsement and its other memberships remain. item_id is the
 * DiscoveryItem id (a SavedItem or membership id is also accepted).
 */
export async function removeCollectionItem(
  ctx: ServiceContext,
  input: { id: string; item_id: string },
): Promise<RemoveCollectionItemResponse> {
  requireScopes(ctx.principal, 'collections:write');
  return ctx.db.transaction(async (db) => {
    const col = await loadAccessibleCollection(ctx, input.id, { db, lock: true });
    const del = await db.query(
      `DELETE FROM collection_items ci USING saved_items si
        WHERE ci.collection_id = $1 AND si.id = ci.saved_item_id
          AND (si.discovery_item_id = $2 OR si.id = $2 OR ci.id = $2)`,
      [col.id, input.item_id],
    );
    let revision = col.revision;
    if ((del.rowCount ?? 0) > 0) {
      const r = await db.query<{ revision: number }>(
        'UPDATE collections SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision',
        [col.id],
      );
      revision = r.rows[0]!.revision;
    }
    return { collection_id: col.id, collection_revision: revision, removed: (del.rowCount ?? 0) > 0 };
  });
}

/** Pure check: `proposed` lists exactly the current memberships, each once. */
export function validateReorder(current: readonly string[], proposed: readonly string[]): { ok: true } | { ok: false; reason: string } {
  const seen = new Set<string>();
  for (const id of proposed) {
    if (seen.has(id)) return { ok: false, reason: 'duplicate' };
    seen.add(id);
  }
  if (proposed.length !== current.length) return { ok: false, reason: proposed.length < current.length ? 'missing' : 'unknown' };
  const cur = new Set(current);
  for (const id of proposed) if (!cur.has(id)) return { ok: false, reason: 'unknown' };
  return { ok: true };
}

/** PUT /v1/collections/{id}/order — exactly the current members once each. */
export async function reorderCollection(
  ctx: ServiceContext,
  input: { id: string; body: ReorderCollectionRequest },
): Promise<ReorderCollectionResponse> {
  requireScopes(ctx.principal, 'collections:write');
  return ctx.db.transaction(async (db) => {
    const col = await loadAccessibleCollection(ctx, input.id, { db, lock: true });
    if (col.revision !== input.body.expected_revision) throw revisionConflict(col.revision);
    const { rows } = await db.query<{ id: string }>('SELECT id FROM collection_items WHERE collection_id = $1', [col.id]);
    const check = validateReorder(rows.map((r) => r.id), input.body.membership_ids);
    if (!check.ok) {
      throw new AppError('invalid_input', {
        message: 'List every item in this collection exactly once.',
        details: { reason: check.reason },
      });
    }
    await db.query(
      `UPDATE collection_items ci SET position = o.ord - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ord)
        WHERE ci.id = o.id AND ci.collection_id = $1`,
      [col.id, input.body.membership_ids],
    );
    const r = await db.query<{ revision: number }>(
      'UPDATE collections SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision',
      [col.id],
    );
    return { collection_id: col.id, collection_revision: r.rows[0]!.revision };
  });
}

export const INTERESTS_BOARD_NAME = 'Interests';

/**
 * File Qloo (or other non-sample) discovery items onto the owner's Interests
 * board. Does not bump taste revision — this is filing recommendations, not a
 * new endorsement that would re-run taste_seed.
 */
export async function fillInterestsBoard(
  db: Queryable,
  accountId: string,
  itemIds: readonly string[],
): Promise<string | null> {
  const unique = [...new Set(itemIds)].filter(Boolean);
  if (unique.length === 0) return null;
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM collections WHERE owner_account_id = $1 AND name = $2 ORDER BY created_at LIMIT 1`,
    [accountId, INTERESTS_BOARD_NAME],
  );
  let collectionId = existing.rows[0]?.id;
  if (!collectionId) {
    const created = await db.query<{ id: string }>(
      `INSERT INTO collections (owner_account_id, name, description) VALUES ($1, $2, $3) RETURNING id`,
      [accountId, INTERESTS_BOARD_NAME, 'Built from your picks. Add more from Feed.'],
    );
    collectionId = created.rows[0]!.id;
  }
  for (const itemId of unique) {
    const owned = await db.query<{ id: string; is_sample: boolean }>(
      `SELECT id, is_sample FROM discovery_items WHERE id = $1 AND owner_account_id = $2`,
      [itemId, accountId],
    );
    const row = owned.rows[0];
    if (!row || row.is_sample) continue;
    const saved = await db.query<{ id: string }>(
      `INSERT INTO saved_items (owner_account_id, discovery_item_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id`,
      [accountId, itemId],
    );
    let savedId = saved.rows[0]?.id;
    if (!savedId) {
      const got = await db.query<{ id: string }>(
        `SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2`,
        [accountId, itemId],
      );
      savedId = got.rows[0]?.id;
    }
    if (!savedId) continue;
    await db.query(
      `INSERT INTO collection_items (collection_id, saved_item_id, owner_account_id, position)
       VALUES ($1, $2, $3, COALESCE((SELECT max(position) + 1 FROM collection_items WHERE collection_id = $1), 0))
       ON CONFLICT (collection_id, saved_item_id) DO NOTHING`,
      [collectionId, savedId, accountId],
    );
  }
  await db.query(`UPDATE collections SET updated_at = now() WHERE id = $1`, [collectionId]);
  return collectionId;
}
