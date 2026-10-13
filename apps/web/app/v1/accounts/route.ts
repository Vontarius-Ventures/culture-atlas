import { auth } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/**
 * POST /v1/accounts — create an account (optionally with email + password for
 * sign-in elsewhere), claim the anonymous session and perform the pending save.
 * The session cookie is rotated to the new account session.
 */
export const POST = apiRoute(ROUTES.createAccount, async ({ ctx, body, setSession }) => {
  const { sessionToken, expiresAt, ...response } = await auth.createAccount(ctx, body);
  setSession(sessionToken, expiresAt);
  return response;
});
