import { agentPlatform } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';

export const POST = agentRoute(ROUTES.rotateConnectionV2, ({ ctx, params }) => agentPlatform.rotateConnection(ctx, params.id));
