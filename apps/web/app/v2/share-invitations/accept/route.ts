import { collectionShares } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';

export const POST = agentRoute(ROUTES.acceptShareInvitation, ({ ctx, body }) => collectionShares.acceptInvitation(ctx, body));
