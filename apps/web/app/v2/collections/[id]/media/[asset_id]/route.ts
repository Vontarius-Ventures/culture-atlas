import { collectionMedia } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';
export const PUT = agentRoute(ROUTES.addCollectionMedia, ({ ctx, params }) => collectionMedia.addMediaToCollection(ctx, params.id, params.asset_id));
export const DELETE = agentRoute(ROUTES.removeCollectionMedia, ({ ctx, params }) => collectionMedia.removeMediaFromCollection(ctx, params.id, params.asset_id));
