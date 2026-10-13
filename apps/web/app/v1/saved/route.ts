import { preferences } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.listSaved, ({ ctx, query }) => preferences.listSaved(ctx, query));
