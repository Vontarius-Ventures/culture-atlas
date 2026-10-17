import { agentOAuth } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';

export const POST = agentRoute(ROUTES.oauthConsent, ({ ctx, body }) => agentOAuth.consent(ctx, body));
