import { references } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.getReference, ({ ctx, params, query }) =>
  references.getReference(ctx, { id: params.id, capture_id: query.capture_id }),
);
