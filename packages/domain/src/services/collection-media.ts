import { requireAccount, requireCollectionGrant, requireScopes } from '../authz';
import { authorizeAgent } from '../authz/agent-authorization';
import { authorizeMedia } from '../authz/agent-resources';
import type { ServiceContext } from '../context';
import { AppError } from '../errors';

/** Central membership service for first-party, agent and shared projections. */
async function collection(ctx: ServiceContext, id: string, write = false) {
  const account = requireAccount(ctx.principal);
  if (ctx.principal.kind === 'agent') ctx = await authorizeAgent(ctx, write ? 'collections:write' : 'collections:read');
  requireScopes(ctx.principal, write ? 'collections:write' : 'collections:read');
  requireCollectionGrant(ctx.principal, id);
  const found = await ctx.db.query('SELECT id FROM collections WHERE id=$1 AND owner_account_id=$2', [id, account.accountId]);
  if (!found.rowCount) throw new AppError('not_found');
  return { ctx, accountId: account.accountId };
}

export async function addMediaToCollection(ctx: ServiceContext, collectionId: string, assetId: string) {
  const grant = await collection(ctx, collectionId, true);
  // Selected agents cannot launder inaccessible media into their own grant.
  await authorizeMedia(grant.ctx, 'media:read', assetId);
  await ctx.db.query(
    `INSERT INTO collection_media_items(account_id,collection_id,asset_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [grant.accountId, collectionId, assetId],
  );
  return { collection_id: collectionId, asset_id: assetId };
}

export async function removeMediaFromCollection(ctx: ServiceContext, collectionId: string, assetId: string) {
  const grant = await collection(ctx, collectionId, true);
  await ctx.db.query('DELETE FROM collection_media_items WHERE account_id=$1 AND collection_id=$2 AND asset_id=$3',
    [grant.accountId, collectionId, assetId]);
  // Legacy membership is intentionally read-only here. Existing v1 collection
  // operations remain the only way to change saved discovery memberships.
  return { collection_id: collectionId, asset_id: assetId };
}

export interface CollectionMediaItem {
  id: string; kind: 'photo' | 'video'; title: string | null; status: string;
  generation: number; source: string; created_at: Date;
}

export async function listCollectionMedia(ctx: ServiceContext, collectionId: string): Promise<CollectionMediaItem[]> {
  const grant = await collection(ctx, collectionId);
  requireScopes(grant.ctx.principal, 'media:read');
  const { rows } = await ctx.db.query<CollectionMediaItem>(
    `SELECT DISTINCT m.id,m.kind,m.title,m.status,m.generation,m.source,m.created_at
     FROM media_assets m WHERE m.account_id=$1 AND m.deleted_at IS NULL AND m.hidden_at IS NULL
       AND m.status <> 'deleted' AND (
        EXISTS(SELECT 1 FROM collection_media_items cm WHERE cm.account_id=$1 AND cm.collection_id=$2 AND cm.asset_id=m.id)
        OR EXISTS(SELECT 1 FROM collection_items ci JOIN saved_items si ON si.id=ci.saved_item_id
          JOIN discovery_items di ON di.id=si.discovery_item_id JOIN captures c ON c.id=di.capture_id
          WHERE ci.owner_account_id=$1 AND ci.collection_id=$2 AND c.media_asset_id=m.id AND c.deleted_at IS NULL
           AND NOT EXISTS(SELECT 1 FROM item_exclusions e WHERE e.owner_account_id=$1 AND e.discovery_item_id=di.id)))
     ORDER BY m.created_at DESC,m.id LIMIT 100`,
    [grant.accountId, collectionId],
  );
  return rows;
}
