import { agentConnections, agentPlatform } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';

export const PATCH = agentRoute(ROUTES.narrowConnectionV2, ({ ctx, params, body }) => agentPlatform.narrowConnection(ctx, params.id, body));
export const DELETE = agentRoute(ROUTES.revokeConnectionV2, ({ ctx, params }) => agentConnections.revokeAgentConnection(ctx, params));
