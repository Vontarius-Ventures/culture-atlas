import { agentPlatform } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';

export const GET = agentRoute(ROUTES.agentActivity, ({ ctx }) => agentPlatform.getActivity(ctx));
