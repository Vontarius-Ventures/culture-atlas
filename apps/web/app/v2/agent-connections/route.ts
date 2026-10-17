import { agentConnections, agentPlatform } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';

export const GET = agentRoute(ROUTES.listConnectionsV2, async ({ ctx }) => ({
  ...(await agentConnections.listAgentConnections(ctx)), schema_version: '2.1' as const, request_id: ctx.requestId,
}));
export const POST = agentRoute(ROUTES.createConnectionV2, ({ ctx, body }) => agentPlatform.createConnection(ctx, body));
