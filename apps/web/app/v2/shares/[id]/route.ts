import { collectionShares } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';

export const PATCH = agentRoute(ROUTES.updateShare, ({ ctx, params, body, request }) =>
  collectionShares.updateShare(ctx, params.id, body, collectionShares.sharePolicyVersion(request.headers.get('if-match'))));
export const DELETE = agentRoute(ROUTES.revokeShare, ({ ctx, params }) => collectionShares.revokeShare(ctx, params.id));
