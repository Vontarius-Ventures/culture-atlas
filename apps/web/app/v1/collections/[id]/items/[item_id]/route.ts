import { collections } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const PUT = apiRoute(ROUTES.addCollectionItem, ({ ctx, params, body }) =>
  collections.addCollectionItem(ctx, { ...params, body }),
);
export const DELETE = apiRoute(ROUTES.removeCollectionItem, ({ ctx, params }) =>
  collections.removeCollectionItem(ctx, params),
);
