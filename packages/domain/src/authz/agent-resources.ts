import { requireAccount, requireCollectionGrant } from './index';
import { authorizeAgent } from './agent-authorization';
import type { ServiceContext } from '../context';
import type { Scope } from '../enums';
import { AppError } from '../errors';
import type { Principal } from '../principal';

/** SQL aliases are fixed by callers, never sourced from a request. */
export function mediaGrantPredicate(principal: Principal, firstParam: number, alias = 'm') {
  if (principal.kind !== 'agent' || principal.libraryAccess === 'all') return { sql: 'TRUE', params: [] };
  if (principal.libraryAccess === 'none') return { sql: 'FALSE', params: [] };
  return {
    sql: `(EXISTS(SELECT 1 FROM collection_media_items cm
      WHERE cm.account_id=${alias}.account_id AND cm.asset_id=${alias}.id AND cm.collection_id=ANY($${firstParam}::uuid[]))
      OR EXISTS(SELECT 1 FROM collection_items ci JOIN saved_items si ON si.id=ci.saved_item_id
        JOIN discovery_items di ON di.id=si.discovery_item_id JOIN captures c ON c.id=di.capture_id
        WHERE ci.owner_account_id=${alias}.account_id AND c.media_asset_id=${alias}.id
          AND ci.collection_id=ANY($${firstParam}::uuid[])))`,
    params: [principal.allowedCollectionIds],
  };
}

export async function authorizeMedia(ctx: ServiceContext, scope: Scope, assetId: string) {
  ctx = await authorizeAgent(ctx, scope);
  const account = requireAccount(ctx.principal);
  const predicate = mediaGrantPredicate(ctx.principal, 3);
  const { rows } = await ctx.db.query(
    `SELECT m.* FROM media_assets m WHERE m.id=$1 AND m.account_id=$2 AND m.deleted_at IS NULL AND m.hidden_at IS NULL AND ${predicate.sql}`,
    [assetId, account.accountId, ...predicate.params],
  );
  if (!rows[0]) throw new AppError('not_found');
  return { ctx, media: rows[0] };
}

export async function authorizeUploadDestination(ctx: ServiceContext, collectionId?: string) {
  ctx = await authorizeAgent(ctx, 'media:write');
  const account = requireAccount(ctx.principal);
  if (ctx.principal.kind === 'agent' && ctx.principal.libraryAccess !== 'all' && !collectionId) {
    throw new AppError('invalid_input', { message: 'A granted destination collection is required.' });
  }
  if (collectionId) {
    requireCollectionGrant(ctx.principal, collectionId);
    const owned = await ctx.db.query('SELECT id FROM collections WHERE id=$1 AND owner_account_id=$2', [collectionId, account.accountId]);
    if (!owned.rowCount) throw new AppError('not_found');
  }
  return ctx;
}
