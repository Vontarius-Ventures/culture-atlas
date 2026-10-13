import { discovery } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.getDiscoveries, ({ ctx, query }) => discovery.getDiscoveries(ctx, query));
