import { style } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** Style design §D.2: "Try again" on a failed style reading (once per analysis). */
export const POST = apiRoute(ROUTES.retryStyle, ({ ctx, params }) => style.retryStyle(ctx, { id: params.id }));
