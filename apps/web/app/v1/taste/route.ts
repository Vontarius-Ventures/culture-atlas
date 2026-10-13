import { taste } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.getTaste, ({ ctx, query }) => taste.getTaste(ctx, query));
