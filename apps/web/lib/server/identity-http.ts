import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  AppError,
  auth,
  createServiceContext,
  enforceIpLimit,
  getDb,
  getDomainConfig,
  identity,
  nativeSessions,
  systemPrincipal,
  toErrorBody,
} from '@culture-atlas/domain';
import { abuseLimitIp, cookieOptions } from './http';

const Refresh = z
  .object({
    refresh_token: z.string().regex(/^cnr_[A-Za-z0-9_-]{43}$/),
    installation_id: z.string().uuid(),
    refresh_request_id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const Empty = z.object({}).strict();

/** Dedicated exchanges: no generic idempotency cache may retain identity secrets. */
export async function identityRoute(request: NextRequest, path: string): Promise<Response> {
  const requestId = randomUUID();
  const headers = {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId,
  };
  try {
    const db = getDb();
    const config = getDomainConfig();
    const now = new Date();
    const principal = await auth.resolvePrincipal(db, {
      authorization: request.headers.get('authorization'),
      sessionToken: request.cookies.get(auth.SESSION_COOKIE)?.value,
    });
    const exchange = ['email/start', 'email/complete', 'native/refresh'].includes(path);
    if (!principal && !exchange) throw new AppError('unauthenticated');
    if (request.method !== 'GET') {
      await enforceIpLimit(db, {
        ip: abuseLimitIp(request, config) ?? 'unknown',
        config,
        now,
        metric: `identity:${path}`,
        limit: path === 'email/start' ? 30 : 120,
      });
      if (principal?.kind === 'account' || principal?.kind === 'anonymous') {
        if (
          !principal.sessionId ||
          !auth.verifyCsrf(
            principal.sessionId,
            config.SESSION_SECRET,
            request.headers.get(auth.CSRF_HEADER),
          )
        ) {
          throw new AppError('csrf_failed');
        }
      }
    }
    const ctx = createServiceContext(principal ?? systemPrincipal('identity-public-exchange'), {
      db,
      config,
      requestId,
      surface: 'rest',
    });
    let body: unknown = {};
    if (request.method !== 'GET') {
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        throw new AppError('invalid_input');
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 8192) {
            await reader.cancel();
            throw new AppError('payload_too_large');
          }
          chunks.push(next.value);
        }
      }
      try {
        body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        throw new AppError('invalid_input');
      }
    }
    let result: unknown;
    if (path === 'email/start' && request.method === 'POST') {
      result = await identity.startEmail(ctx, identity.EmailStart.parse(body));
    } else if (path === 'email/complete' && request.method === 'POST') {
      const completed = await identity.completeEmail(ctx, identity.EmailComplete.parse(body));
      if ('sessionToken' in completed && completed.sessionToken && completed.expiresAt) {
        const { sessionToken, expiresAt, ...publicResult } = completed;
        const response = NextResponse.json(publicResult, { headers });
        response.cookies.set(
          auth.SESSION_COOKIE,
          sessionToken,
          cookieOptions((expiresAt.getTime() - now.getTime()) / 1000),
        );
        return response;
      }
      result = completed;
    } else if (path === 'native/refresh' && request.method === 'POST') {
      const input = Refresh.parse(body);
      result = await nativeSessions.rotateNativeSession(db, input.refresh_token, now, {
        installationId: input.installation_id,
        refreshRequestId: input.refresh_request_id,
      });
    } else if (path === 'sessions' && request.method === 'GET') {
      result = await identity.listSessions(ctx);
    } else if (/^sessions\/[a-f0-9-]+\/revoke$/.test(path) && request.method === 'POST') {
      Empty.parse(body);
      const id = z.string().uuid().parse(path.split('/')[1]);
      result = await identity.revokeSession(ctx, id);
    } else if (path === 'sign-out-all' && request.method === 'POST') {
      Empty.parse(body);
      result = await identity.signOutAll(ctx);
    } else if (path === 'switch' && request.method === 'POST') {
      Empty.parse(body);
      result = await identity.switchAccount(ctx);
    } else throw new AppError('not_found');
    return NextResponse.json(result, { headers });
  } catch (error) {
    const err = error instanceof z.ZodError ? new AppError('invalid_input') : error;
    const { status, body } = toErrorBody(err, requestId);
    const response = NextResponse.json({ error: body }, { status, headers });
    if (err instanceof AppError && err.retryAfter)
      response.headers.set('retry-after', String(err.retryAfter));
    return response;
  }
}
