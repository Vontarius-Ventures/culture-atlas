import { agentConnections } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const DELETE = apiRoute(ROUTES.revokeAgentConnection, ({ ctx, params }) =>
  agentConnections.revokeAgentConnection(ctx, params),
);
