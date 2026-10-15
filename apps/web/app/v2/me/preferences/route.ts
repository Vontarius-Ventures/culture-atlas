import { agentPlatform } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';

export const GET = agentRoute(ROUTES.getPreferences, ({ ctx }) => agentPlatform.getPreferences(ctx));
export const PATCH = agentRoute(ROUTES.updatePreferences, ({ ctx, body, request }) =>
  agentPlatform.updatePreferences(ctx, body, agentPlatform.preferenceVersion(request.headers.get('if-match'))));
