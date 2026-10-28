import { z } from 'zod';
import { grantedCollectionFilter, requireScopes, requireWholeLibrary } from '../authz';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import type { ItemKind, PreferenceAction } from '../enums';
import { AppError } from '../errors';
import { accountIdOf, isGrantLimited, membershipsFor, requireVisibleItem, visibleItemIds } from '../library/access';
import { ownerColumns, ownerOf, ownerPredicate, type Owner } from '../principal';
import type {
  PreferenceRequest,
  PreferenceResponse,
  SavedItemDto,
  SavedListResponse,
  SavedQuery,
} from '../schemas/preferences';
import { decodeCursor, encodeCursor } from '../util/cursor';
import { iso } from '../util/time';
import { tsKey } from '../library/sql';
import { noteExplicitIntent } from '../interest-graph/intent';
import { loadCards } from './cards';
import { bumpTasteRevision, getTasteRevision, rebuildTasteProfile } from './taste';

/**
 * Taste memory actions. Every effective action writes a PreferenceEvent and
 * bumps the taste revision in the same transaction, then rebuilds the derived
 * profile so Undo/unsave take effect immediately.
 *  save   -> upsert SavedItem (unique owner+item); a capture target endorses the
 *            capture inspiration + its current focus. Saving also lifts a hide.
 *            Anonymous visitors are asked to create an account (403
 *            account_required); the UI then sends the save as `pending_save`.
 *  remove -> "Unsave everywhere": delete SavedItem and all memberships
 *            (bump revisions of affected collections). Agents need whole-library.
 *  hide   -> item_exclusions row (this item only). Agents need whole-library.
 *  unhide -> remove exclusion. Agents need whole-library.
 * No-op actions (already saved, not hidden...) change nothing and offer no Undo.
 */

export interface TargetItem {
  id: string;
  canonical_key: string;
  kind: ItemKind;
  capture_id: string | null;
  is_sample: boolean;
}

/** The capture's own DiscoveryItem ("Save this inspiration"), created if the intake did not. */
export async function ensureCaptureItem(db: Queryable, owner: Owner, captureId: string): Promise<TargetItem> {
  const own = ownerPredicate(owner, 'c', 2);
  const cap = await db.query<{
    id: string;
    owner_account_id: string | null;
    owner_session_id: string | null;
    private_object_key: string | null;
    width: number | null;
    height: number | null;
    title: string | null;
  }>(
    `SELECT c.id, c.owner_account_id, c.owner_session_id, c.private_object_key, c.width, c.height, a.title
       FROM captures c LEFT JOIN analyses a ON a.id = c.active_analysis_id
      WHERE c.id = $1 AND c.deleted_at IS NULL AND ${own.sql}`,
    [captureId, ...own.params],
  );
  const c = cap.rows[0];
  if (!c) throw new AppError('not_found');
  const meta = c.private_object_key
    ? { image: { object_key: c.private_object_key, width: c.width, height: c.height, alt: c.title ?? 'Your photo' } }
    : {};
  await db.query(
    `INSERT INTO discovery_items (owner_account_id, owner_session_id, kind, canonical_key, capture_id, title, display_metadata)
     VALUES ($1, $2, 'capture', $3, $4, $5, $6::jsonb)
     ON CONFLICT DO NOTHING`,
    [c.owner_account_id, c.owner_session_id, `capture:${c.id}`, c.id, c.title ?? 'Your photo', JSON.stringify(meta)],
  );
  const { rows } = await db.query<TargetItem>(
    `SELECT id, canonical_key, kind, capture_id, is_sample FROM discovery_items
      WHERE capture_id = $1 AND kind = 'capture'
        AND owner_account_id IS NOT DISTINCT FROM $2 AND owner_session_id IS NOT DISTINCT FROM $3`,
    [c.id, c.owner_account_id, c.owner_session_id],
  );
  if (!rows[0]) throw new AppError('not_found');
  return rows[0];
}

async function loadTarget(ctx: ServiceContext, db: Queryable, body: PreferenceRequest): Promise<TargetItem> {
  const owner = ownerOf(ctx.principal);
  if (body.target_type === 'capture') {
    const item = await ensureCaptureItem(db, owner, body.target_id);
    if (isGrantLimited(ctx.principal)) await requireVisibleItem(ctx, item.id, db);
    return item;
  }
  await requireVisibleItem(ctx, body.target_id, db);
  const { rows } = await db.query<TargetItem>(
    'SELECT id, canonical_key, kind, capture_id, is_sample FROM discovery_items WHERE id = $1',
    [body.target_id],
  );
  if (!rows[0]) throw new AppError('not_found');
  return rows[0];
}

async function currentSaved(db: Queryable, owner: Owner, itemId: string): Promise<SavedItemDto | null> {
  const own = ownerPredicate(owner, '', 2);
  const { rows } = await db.query<{ id: string; discovery_item_id: string; saved_at: Date }>(
    `SELECT id, discovery_item_id, saved_at FROM saved_items WHERE discovery_item_id = $1 AND ${own.sql}`,
    [itemId, ...own.params],
  );
  const r = rows[0];
  return r ? { id: r.id, discovery_item_id: r.discovery_item_id, saved_at: iso(r.saved_at) } : null;
}

async function writeEvent(
  ctx: ServiceContext,
  db: Queryable,
  action: PreferenceAction,
  body: PreferenceRequest,
  payload: Record<string, unknown>,
): Promise<void> {
  const cols = ownerColumns(ownerOf(ctx.principal));
  await db.query(
    `INSERT INTO preference_events (owner_account_id, owner_session_id, action, target_type, target_id, payload, agent_connection_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      cols.owner_account_id,
      cols.owner_session_id,
      action,
      body.target_type,
      body.target_id,
      JSON.stringify(payload),
      ctx.principal.kind === 'agent' ? ctx.principal.connectionId : null,
    ],
  );
}

/**
 * Create the SavedItem for an accessible item if missing. Returns whether it
 * was created. Shared by POST /v1/preferences, collection adds and taste
 * onboarding picks (source `onboarding`, services/onboarding.ts).
 */
export async function saveItem(
  ctx: ServiceContext,
  db: Queryable,
  item: TargetItem,
  body: PreferenceRequest,
  options: { source?: 'onboarding' } = {},
): Promise<{ saved: SavedItemDto; created: boolean }> {
  const owner = ownerOf(ctx.principal);
  const cols = ownerColumns(owner);
  let focus: unknown = null;
  if (item.capture_id) {
    const f = await db.query<{ focus: unknown }>('SELECT focus FROM captures WHERE id = $1', [item.capture_id]);
    focus = f.rows[0]?.focus ?? null;
  }
  const ins = await db.query<{ id: string }>(
    `INSERT INTO saved_items (owner_account_id, owner_session_id, discovery_item_id, endorsed_focus)
     VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
    [cols.owner_account_id, cols.owner_session_id, item.id, focus === null ? null : JSON.stringify(focus)],
  );
  const created = ins.rowCount === 1;
  if (created) {
    // An explicit save lifts an earlier hide of the same item.
    const own = ownerPredicate(owner, '', 2);
    await db.query(`DELETE FROM item_exclusions WHERE canonical_key = $1 AND ${own.sql}`, [item.canonical_key, ...own.params]);
    await writeEvent(ctx, db, 'save', body, {
      canonical_key: item.canonical_key,
      kind: item.kind,
      endorsed_focus: focus,
      // Taste onboarding picks (amendment 2.2) are ordinary explicit saves, marked by source.
      ...(options.source ? { source: options.source } : {}),
    });
    const revision = await bumpTasteRevision(db, owner);
    await rebuildTasteProfile(db, owner);
    // PR 8: the effective save commits its graph projection intent in this
    // same transaction. Duplicate saves (created === false) add nothing.
    if (owner.kind === 'account') {
      await noteExplicitIntent(db, {
        ownerAccountId: owner.accountId,
        kind: 'taste',
        action: 'save',
        targetTasteRevision: revision,
        config: ctx.config,
        payload: {
          target_type: body.target_type,
          target_id: body.target_id,
          canonical_key: item.canonical_key,
          ...(options.source ? { source: options.source } : {}),
        },
      });
    }
  }
  const saved = await currentSaved(db, owner, item.id);
  if (!saved) throw new AppError('conflict', { retryable: true });
  return { saved, created };
}

/** POST /v1/preferences */
export async function recordPreference(ctx: ServiceContext, body: PreferenceRequest): Promise<PreferenceResponse> {
  requireScopes(ctx.principal, 'taste:write');
  const owner = ownerOf(ctx.principal);
  return ctx.db.transaction(async (db) => {
    let undo: PreferenceResponse['undo'] = null;
    const reverse = (action: PreferenceAction) => ({ action, target_type: body.target_type, target_id: body.target_id });

    if (body.action === 'save') {
      if (ctx.principal.kind === 'anonymous') {
        throw new AppError('account_required', { message: 'Create an account to save.' });
      }
      const item = await loadTarget(ctx, db, body);
      const { created } = await saveItem(ctx, db, item, body);
      if (created) undo = reverse('remove');
      return response(ctx, db, body, item.id, undo);
    }

    // remove / hide / unhide can affect contexts outside a selected-collection grant.
    requireWholeLibrary(ctx.principal);
    const item = await loadTarget(ctx, db, body);
    const own = ownerPredicate(owner, '', 2);

    if (body.action === 'remove') {
      const saved = await db.query<{ id: string }>(
        `SELECT id FROM saved_items WHERE discovery_item_id = $1 AND ${own.sql} FOR UPDATE`,
        [item.id, ...own.params],
      );
      const savedId = saved.rows[0]?.id;
      if (savedId) {
        const cols = await db.query<{ collection_id: string }>(
          'SELECT collection_id FROM collection_items WHERE saved_item_id = $1',
          [savedId],
        );
        const collectionIds = cols.rows.map((r) => r.collection_id);
        // Memberships cascade with the saved item (unsave everywhere).
        await db.query('DELETE FROM saved_items WHERE id = $1', [savedId]);
        if (collectionIds.length) {
          await db.query(
            'UPDATE collections SET revision = revision + 1, updated_at = now() WHERE id = ANY($1::uuid[])',
            [collectionIds],
          );
        }
        await writeEvent(ctx, db, 'remove', body, { canonical_key: item.canonical_key, collection_ids: collectionIds });
        const revision = await bumpTasteRevision(db, owner);
        await rebuildTasteProfile(db, owner);
        // PR 8: unsave reverses support intent; it is never a negative vote.
        if (owner.kind === 'account') {
          await noteExplicitIntent(db, {
            ownerAccountId: owner.accountId,
            kind: 'taste',
            action: 'remove',
            targetTasteRevision: revision,
            config: ctx.config,
            payload: { target_type: body.target_type, target_id: body.target_id, canonical_key: item.canonical_key },
          });
        }
        undo = reverse('save');
      }
    } else if (body.action === 'hide') {
      if (item.kind === 'capture') {
        throw new AppError('invalid_input', { message: 'Photos can be deleted, not hidden.' });
      }
      const cols = ownerColumns(owner);
      const ins = await db.query(
        `INSERT INTO item_exclusions (owner_account_id, owner_session_id, discovery_item_id, canonical_key)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [cols.owner_account_id, cols.owner_session_id, item.id, item.canonical_key],
      );
      if (ins.rowCount === 1) {
        await writeEvent(ctx, db, 'hide', body, { canonical_key: item.canonical_key });
        const revision = await bumpTasteRevision(db, owner);
        await rebuildTasteProfile(db, owner);
        // PR 8: a hide constrains; the projection intent it triggers never
        // endorses anything.
        if (owner.kind === 'account') {
          await noteExplicitIntent(db, {
            ownerAccountId: owner.accountId,
            kind: 'taste',
            action: 'hide',
            targetTasteRevision: revision,
            config: ctx.config,
            payload: { target_type: body.target_type, target_id: body.target_id, canonical_key: item.canonical_key },
          });
        }
        undo = reverse('unhide');
      }
    } else {
      const del = await db.query(`DELETE FROM item_exclusions WHERE canonical_key = $1 AND ${own.sql}`, [
        item.canonical_key,
        ...own.params,
      ]);
      if ((del.rowCount ?? 0) > 0) {
        await writeEvent(ctx, db, 'unhide', body, { canonical_key: item.canonical_key });
        const revision = await bumpTasteRevision(db, owner);
        await rebuildTasteProfile(db, owner);
        // PR 8: unhide restores visibility and adds no endorsement; the
        // intent just lets the projection drop the constraint.
        if (owner.kind === 'account') {
          await noteExplicitIntent(db, {
            ownerAccountId: owner.accountId,
            kind: 'taste',
            action: 'unhide',
            targetTasteRevision: revision,
            config: ctx.config,
            payload: { target_type: body.target_type, target_id: body.target_id, canonical_key: item.canonical_key },
          });
        }
        undo = reverse('hide');
      }
    }
    return response(ctx, db, body, item.id, undo);
  });
}

async function response(
  ctx: ServiceContext,
  db: Queryable,
  body: PreferenceRequest,
  itemId: string,
  undo: PreferenceResponse['undo'],
): Promise<PreferenceResponse> {
  const owner = ownerOf(ctx.principal);
  return {
    action: body.action,
    target_type: body.target_type,
    target_id: body.target_id,
    saved_item: await currentSaved(db, owner, itemId),
    taste_revision: await getTasteRevision(db, owner),
    undo,
  };
}

const SavedCursor = z.object({ t: z.string(), id: z.uuid() });

/**
 * GET /v1/saved — canonical saved items with membership ids. Selected-
 * collection agents only see items in granted collections (no unfiled).
 */
export async function listSaved(ctx: ServiceContext, query: SavedQuery): Promise<SavedListResponse> {
  requireScopes(ctx.principal, 'taste:read');
  const owner = ownerOf(ctx.principal);
  const filter = grantedCollectionFilter(ctx.principal);
  if (filter && query.filter === 'unfiled') {
    throw new AppError('scope_denied', { message: 'This connection cannot see unfiled saves.' });
  }
  const limit = query.limit ?? 24;
  const own = ownerPredicate(owner, 'si', 1);
  const params: unknown[] = [...own.params];
  const where: string[] = [own.sql];
  if (query.filter === 'unfiled') where.push('NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.saved_item_id = si.id)');
  if (filter) {
    params.push([...filter]);
    where.push(`EXISTS (SELECT 1 FROM collection_items ci WHERE ci.saved_item_id = si.id AND ci.collection_id = ANY($${params.length}::uuid[]))`);
  }
  if (query.kind) {
    params.push(query.kind);
    where.push(`di.kind = $${params.length}`);
  }
  if (query.cursor) {
    const c = decodeCursor(query.cursor, SavedCursor);
    params.push(c.t, c.id);
    where.push(`(si.saved_at, si.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const { rows } = await ctx.db.query<{ id: string; discovery_item_id: string; saved_at: Date; ts_key: string }>(
    `SELECT si.id, si.discovery_item_id, si.saved_at, ${tsKey('si.saved_at', 'ts_key')}
       FROM saved_items si JOIN discovery_items di ON di.id = si.discovery_item_id
      WHERE ${where.join(' AND ')}
      ORDER BY si.saved_at DESC, si.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const visible = filter ? await visibleItemIds(ctx, page.map((r) => r.discovery_item_id)) : null;
  const shown = visible ? page.filter((r) => visible.has(r.discovery_item_id)) : page;
  const cards = new Map((await loadCards(ctx, shown.map((r) => r.discovery_item_id))).map((c) => [c.id, c]));
  const memberships = await membershipsFor(ctx, shown.map((r) => r.id));
  const last = page[page.length - 1];
  return {
    items: shown.flatMap((r) => {
      const card = cards.get(r.discovery_item_id);
      if (!card) return [];
      const m = memberships.get(r.id);
      return [
        {
          saved_item_id: r.id,
          saved_at: iso(r.saved_at),
          item: card,
          membership_ids: m?.membershipIds ?? [],
          collection_ids: m?.collectionIds ?? [],
        },
      ];
    }),
    next_cursor: rows.length > limit && last ? encodeCursor({ t: last.ts_key, id: last.id }) : null,
  };
}

/** Accounts only own collections; used by callers that need to reject anonymous principals early. */
export function libraryAccountId(ctx: ServiceContext): string {
  const id = accountIdOf(ctx.principal);
  if (!id) throw new AppError('account_required');
  return id;
}
