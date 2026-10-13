import { collections } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.getCollection, ({ ctx, params, query }) =>
  collections.getCollection(ctx, { id: params.id, query }),
);
export const PATCH = apiRoute(ROUTES.updateCollection, ({ ctx, params, body }) =>
  collections.updateCollection(ctx, { id: params.id, body }),
);
export const DELETE = apiRoute(ROUTES.deleteCollection, ({ ctx, params }) => collections.deleteCollection(ctx, params));
