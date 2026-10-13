import { auth } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** POST /v1/session/sign-out — revokes this session and starts a fresh anonymous one. */
export const POST = apiRoute(ROUTES.signOut, async ({ ctx, setSession }) => {
  const { sessionToken, expiresAt, ...response } = await auth.signOut(ctx);
  setSession(sessionToken, expiresAt);
  return response;
});
