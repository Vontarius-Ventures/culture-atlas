import { auth } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** POST /v1/session/sign-in — email + password; claims the anonymous session and rotates the cookie. */
export const POST = apiRoute(ROUTES.signIn, async ({ ctx, body, setSession }) => {
  const { sessionToken, expiresAt, ...response } = await auth.signIn(ctx, body);
  setSession(sessionToken, expiresAt);
  return response;
});
