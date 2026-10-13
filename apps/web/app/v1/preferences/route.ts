import { preferences } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const POST = apiRoute(ROUTES.recordPreference, ({ ctx, body }) => preferences.recordPreference(ctx, body));
