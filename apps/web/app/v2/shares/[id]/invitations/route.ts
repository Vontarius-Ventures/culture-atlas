import { collectionShares } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';

export const POST = agentRoute(ROUTES.createShareInvitation, ({ ctx, params, body }) =>
  collectionShares.createInvitation(ctx, params.id, body));
