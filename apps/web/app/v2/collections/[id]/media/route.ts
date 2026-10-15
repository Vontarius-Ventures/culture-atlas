import { collectionMedia } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';
export const GET = agentRoute(ROUTES.listCollectionMedia, async ({ ctx, params }) => ({
  items: (await collectionMedia.listCollectionMedia(ctx, params.id)).map((m) => ({ ...m, created_at: m.created_at.toISOString() })), next_cursor: null,
}));
