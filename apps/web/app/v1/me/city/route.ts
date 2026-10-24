import { style } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** Style design §C.6: the user's own city for place rails ({ "city": "Los Angeles, CA" } or null). */
export const PUT = apiRoute(ROUTES.setCity, ({ ctx, body }) => style.setCity(ctx, { body }));
