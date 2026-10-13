import { items } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.getItem, ({ ctx, params, query }) => items.getItem(ctx, { id: params.id, query }));
