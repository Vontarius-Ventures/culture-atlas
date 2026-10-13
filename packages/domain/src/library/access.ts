import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { grantedCollectionFilter, requireCollectionGrant } from '../authz';
import { AppError } from '../errors';
import { ownerOf, ownerPredicate, type Owner, type Principal } from '../principal';

/**
 * Library access rules shared by collections, items, saved, plans and jobs.
 *
 * Everything is constrained by owner first. Agent connections limited to
 * selected collections are additionally limited to the CURRENT grant (never an
 * id obtained earlier):
 *  - items saved into a granted collection;
 *  - the compiled context of a capture in a granted collection (its analysis
 *    recommendations) and captures created by this connection;
 *  - related discoveries whose discovery job originated from a granted
 *    collection item that is still a member;
 *  - items of plans derived entirely from currently granted items;
 *  - public sample items.
 * Not-owned or not-granted records are 404, never 403.
 */

export interface CollectionRow {
  id: string;
  owner_account_id: string;
  name: string;
  description: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

/** Account that owns the library (anonymous sessions have no collections). */
export function accountIdOf(principal: Principal): string | null {
  return principal.kind === 'account' || principal.kind === 'agent' ? principal.accountId : null;
}

/** True when the principal is limited to selected collections (or no library at all). */
export function isGrantLimited(principal: Principal): boolean {
  return grantedCollectionFilter(principal) !== null;
}

/** Granted collection ids for a limited agent ([] when library_access is none). */
export function grantedIds(principal: Principal): string[] {
  return [...(grantedCollectionFilter(principal) ?? [])];
}

/**
 * Load a collection the principal may access (owner + current grant), or 404.
 * `lock` takes a row lock for mutations.
 */
export async function loadAccessibleCollection(
  ctx: ServiceContext,
  id: string,
  options: { db?: Queryable; lock?: boolean } = {},
): Promise<CollectionRow> {
  const accountId = accountIdOf(ctx.principal);
  if (!accountId) throw new AppError('not_found');
  requireCollectionGrant(ctx.principal, id);
  const db = options.db ?? ctx.db;
  const { rows } = await db.query<CollectionRow>(
    `SELECT id, owner_account_id, name, description, revision, created_at, updated_at
       FROM collections WHERE id = $1 AND owner_account_id = $2 ${options.lock ? 'FOR UPDATE' : ''}`,
    [id, accountId],
  );
  if (!rows[0]) throw new AppError('not_found');
  return rows[0];
}

const MEMBER_ITEMS = `SELECT si.discovery_item_id AS id
   FROM collection_items ci JOIN saved_items si ON si.id = ci.saved_item_id
  WHERE ci.owner_account_id = $1 AND ci.collection_id = ANY($2::uuid[])`;

/**
 * Discovery item ids (subset of `ids`) visible to the principal: owned or
 * sample for full-library principals; the grant rules above for limited agents.
 */
export async function visibleItemIds(ctx: ServiceContext, ids: readonly string[], db: Queryable = ctx.db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const p = ctx.principal;
  if (!isGrantLimited(p)) {
    const own = ownerPredicate(ownerOf(p), 'di', 2);
    const { rows } = await db.query<{ id: string }>(
      `SELECT di.id FROM discovery_items di WHERE di.id = ANY($1::uuid[]) AND (di.is_sample OR ${own.sql})`,
      [ids, ...own.params],
    );
    return new Set(rows.map((r) => r.id));
  }
  const agent = p.kind === 'agent' ? p : null;
  const { rows } = await db.query<{ id: string }>(
    `WITH member_items AS (${MEMBER_ITEMS})
     SELECT di.id FROM discovery_items di
      WHERE di.id = ANY($3::uuid[]) AND (
        di.is_sample
        OR (di.owner_account_id = $1 AND (
             di.id IN (SELECT id FROM member_items)
          OR (di.capture_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM captures c WHERE c.id = di.capture_id AND c.deleted_at IS NULL
                  AND c.created_by_agent_connection_id = $4))
          OR EXISTS (
               SELECT 1 FROM recommendations r
                 JOIN analyses a ON a.id = r.analysis_id
                 JOIN discovery_items cdi ON cdi.capture_id = a.capture_id AND cdi.owner_account_id = $1
                WHERE r.discovery_item_id = di.id AND cdi.id IN (SELECT id FROM member_items))
          OR EXISTS (
               SELECT 1 FROM recommendations r JOIN discovery_jobs dj ON dj.id = r.discovery_job_id
                WHERE r.discovery_item_id = di.id AND dj.owner_account_id = $1
                  AND dj.origin_collection_id = ANY($2::uuid[])
                  AND dj.origin_item_id IN (SELECT id FROM member_items))
          OR EXISTS (
               SELECT 1 FROM recommendations r JOIN plans pl ON pl.id = r.plan_id
                WHERE r.discovery_item_id = di.id AND pl.owner_account_id = $1
                  AND pl.selected_item_ids <@ ARRAY(SELECT id FROM member_items))
        )))`,
    [agent?.accountId ?? null, grantedIds(p), ids, agent?.connectionId ?? null],
  );
  return new Set(rows.map((r) => r.id));
}

/** Throw 404 unless the item is visible to the principal. */
export async function requireVisibleItem(ctx: ServiceContext, id: string, db: Queryable = ctx.db): Promise<void> {
  const visible = await visibleItemIds(ctx, [id], db);
  if (!visible.has(id)) throw new AppError('not_found');
}

/** Whether every selected item of a plan is currently in a granted collection. */
export async function planWithinGrant(ctx: ServiceContext, selectedItemIds: readonly string[], db: Queryable = ctx.db): Promise<boolean> {
  const p = ctx.principal;
  if (!isGrantLimited(p) || p.kind !== 'agent') return true;
  const { rows } = await db.query<{ ok: boolean }>(
    `WITH member_items AS (${MEMBER_ITEMS})
     SELECT $3::uuid[] <@ ARRAY(SELECT id FROM member_items) AS ok`,
    [p.accountId, grantedIds(p), selectedItemIds],
  );
  return rows[0]?.ok === true;
}

/** Collection ids (visible to the principal) containing each saved item. */
export async function membershipsFor(
  ctx: ServiceContext,
  savedItemIds: readonly string[],
  db: Queryable = ctx.db,
): Promise<Map<string, { membershipIds: string[]; collectionIds: string[] }>> {
  const out = new Map<string, { membershipIds: string[]; collectionIds: string[] }>();
  const accountId = accountIdOf(ctx.principal);
  if (!accountId || savedItemIds.length === 0) return out;
  const filter = grantedCollectionFilter(ctx.principal);
  const { rows } = await db.query<{ saved_item_id: string; id: string; collection_id: string }>(
    `SELECT ci.saved_item_id, ci.id, ci.collection_id FROM collection_items ci
      WHERE ci.owner_account_id = $1 AND ci.saved_item_id = ANY($2::uuid[])
        AND ($3::uuid[] IS NULL OR ci.collection_id = ANY($3::uuid[]))
      ORDER BY ci.added_at, ci.id`,
    [accountId, savedItemIds, filter ? [...filter] : null],
  );
  for (const r of rows) {
    const e = out.get(r.saved_item_id) ?? { membershipIds: [], collectionIds: [] };
    e.membershipIds.push(r.id);
    e.collectionIds.push(r.collection_id);
    out.set(r.saved_item_id, e);
  }
  return out;
}

/** Canonical keys hidden by an owner (item exclusions). */
export async function hiddenKeys(db: Queryable, owner: Owner): Promise<Set<string>> {
  const own = ownerPredicate(owner, '', 1);
  const { rows } = await db.query<{ canonical_key: string }>(`SELECT canonical_key FROM item_exclusions WHERE ${own.sql}`, own.params);
  return new Set(rows.map((r) => r.canonical_key));
}
