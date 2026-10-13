import { agentConnections } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.listAgentConnections, ({ ctx }) => agentConnections.listAgentConnections(ctx));
export const POST = apiRoute(ROUTES.createAgentConnection, ({ ctx, body }) =>
  agentConnections.createAgentConnection(ctx, body),
);
