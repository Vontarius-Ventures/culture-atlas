import { agentCommands } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';
export const GET = agentRoute(ROUTES.getCommandV2, ({ ctx, params }) => agentCommands.getCommand(ctx, params.id));
