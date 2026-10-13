import { items } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const POST = apiRoute(ROUTES.discoverRelated, ({ ctx, params, body }) =>
  items.startRelatedDiscovery(ctx, { id: params.id, body }),
);
