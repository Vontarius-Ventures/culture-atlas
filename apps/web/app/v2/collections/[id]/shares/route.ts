import { collectionShares } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';

export const GET = agentRoute(ROUTES.listShares, ({ ctx, params }) => collectionShares.listShares(ctx, params.id));
export const POST = agentRoute(ROUTES.createShare, ({ ctx, params, body }) => collectionShares.createShare(ctx, params.id, body));
