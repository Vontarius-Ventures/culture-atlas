import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { AppError, auth, getDb, getDomainConfig, toErrorBody } from '@culture-atlas/domain';
import { checkHandoffToken, createHandoffToken } from './token';

export const runtime = 'nodejs';

/**
 * POST /capture/handoff — signed-in browser creates a 10-minute phone link for
 * the glasses setup (cookie session + CSRF). GET /capture/handoff?token= — the
 * phone checks the link against its own session; the answer reveals only
 * valid/expired/invalid and whether it matches the signed-in account.
 */
const HEADERS = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

async function viewer(request: NextRequest) {
  const principal = await auth.resolvePrincipal(getDb(), {
    sessionToken: request.cookies.get(auth.SESSION_COOKIE)?.value,
  });
  return principal;
}

function fail(error: unknown) {
  const requestId = randomUUID();
  const result = toErrorBody(error, requestId);
  return Response.json({ error: result.body }, { status: result.status, headers: HEADERS });
}

export async function POST(request: NextRequest) {
  try {
    const config = getDomainConfig();
    const principal = await viewer(request);
    if (!principal) throw new AppError('unauthenticated');
    if (principal.kind !== 'account' || !principal.sessionId)
      throw new AppError('account_required');
    if (
      !auth.verifyCsrf(
        principal.sessionId,
        config.SESSION_SECRET,
        request.headers.get(auth.CSRF_HEADER),
      )
    )
      throw new AppError('csrf_failed');
    const { token, expiresAt } = createHandoffToken(config.SESSION_SECRET, principal.accountId);
    const url = new URL('/capture/glasses', config.APP_BASE_URL);
    url.searchParams.set('handoff', token);
    return Response.json(
      { url: url.toString(), expires_at: expiresAt.toISOString() },
      { status: 201, headers: HEADERS },
    );
  } catch (error) {
    return fail(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token') ?? '';
    const principal = await viewer(request);
    const accountId = principal?.kind === 'account' ? principal.accountId : null;
    const result = checkHandoffToken(getDomainConfig().SESSION_SECRET, token, accountId);
    return Response.json(
      result.status === 'valid'
        ? {
            status: 'valid',
            expires_at: result.expiresAt.toISOString(),
            same_account: result.sameAccount,
          }
        : { status: result.status, expires_at: null, same_account: null },
      { headers: HEADERS },
    );
  } catch (error) {
    return fail(error);
  }
}
