import 'server-only';
import { cookies, headers } from 'next/headers';
import { auth, createServiceContext, getDb, type Principal, type ServiceContext } from '@culture-atlas/domain';

/**
 * Server components / server actions: resolve the current principal from the
 * session cookie. Returns null when the visitor has no session yet (the client
 * calls GET /v1/session on first load, which sets the cookie).
 */
export async function getServerPrincipal(): Promise<Principal | null> {
  const token = (await cookies()).get(auth.SESSION_COOKIE)?.value ?? null;
  try {
    return await auth.resolvePrincipal(getDb(), { sessionToken: token });
  } catch {
    return null;
  }
}

export async function getServerContext(): Promise<ServiceContext | null> {
  const principal = await getServerPrincipal();
  if (!principal) return null;
  const requestId = (await headers()).get('x-request-id') ?? undefined;
  return createServiceContext(principal, { surface: 'web', requestId });
}
