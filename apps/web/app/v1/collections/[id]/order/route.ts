import { collections } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const PUT = apiRoute(ROUTES.reorderCollection, ({ ctx, params, body }) =>
  collections.reorderCollection(ctx, { id: params.id, body }),
);
