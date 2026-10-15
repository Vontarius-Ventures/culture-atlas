import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  AppError,
  auth,
  createServiceContext,
  enforceIpLimit,
  getDb,
  getDomainConfig,
  authorizeOperation,
  assertExpectedCaptureAccount,
  invalidInput,
  toErrorBody,
  withIdempotency,
  type DomainConfig,
  type Principal,
  type ServiceContext,
} from '@culture-atlas/domain';
import type { RouteContract } from '@culture-atlas/domain/schemas';

/**
 * One wrapper for every /v1 route handler. Route files stay one-liners:
 *
 *   export const GET = apiRoute(ROUTES.getCapture, ({ ctx, params }) => captures.getCapture(ctx, params));
 *
 * It (1) assigns a request id, (2) resolves the principal from the bearer
 * token or the `ca_session` cookie (GET routes create an anonymous session when
 * none exists; mutations require an existing session), (3) enforces the
 * contract's auth level and scopes, (4) checks CSRF for cookie-authenticated
 * mutations (`x-csrf-token`), (5) validates params/query/body with the
 * contract's zod schemas (strict bodies reject unknown fields), (6) applies
 * Idempotency-Key, (7) validates the response outside production, and
 * (8) maps errors to {code,message,retryable,request_id}.
 */

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;

export type RawBody =
  | { kind: 'json'; json: unknown }
  | { kind: 'multipart'; form: FormData }
  | { kind: 'empty' };

type BodyOf<C extends RouteContract> = C['body'] extends z.ZodType
  ? z.output<C['body']>
  : C['body'] extends 'multipart' | 'json_or_multipart'
    ? RawBody
    : undefined;

export interface HandlerArgs<C extends RouteContract> {
  ctx: ServiceContext;
  params: Out<C['params']>;
  query: Out<C['query']>;
  body: BodyOf<C>;
  request: NextRequest;
  /**
   * Replace the browser session cookie (account creation, sign-in, sign-out).
   * The session id rotates on every privilege change.
   */
  setSession(token: string, expiresAt: Date): void;
}

type ResponseOf<C extends RouteContract> = C['response'] extends z.ZodType ? z.input<C['response']> : void;

type Segment = { params: Promise<Record<string, string | string[] | undefined>> };

/** HttpOnly, SameSite=Lax; Secure in production or whenever the app is served over HTTPS. */
export function cookieOptions(maxAgeSeconds: number) {
  const config = getDomainConfig();
  const secure = config.NODE_ENV === 'production' || config.APP_BASE_URL.startsWith('https://');
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/', maxAge: Math.max(0, Math.floor(maxAgeSeconds)) };
}

/**
 * Client address for per-IP abuse limits. Proxies APPEND the address they saw
 * to X-Forwarded-For, so the left-most entries are whatever the client sent.
 * We take the entry TRUSTED_PROXY_HOPS from the right (the address our own
 * outermost proxy observed), or CLIENT_IP_HEADER when the platform sets a
 * verified one. Returns null when the header did not pass through the
 * configured proxies. Only a salted hash is stored.
 */
export function clientIp(
  request: Request,
  config: Pick<DomainConfig, 'TRUSTED_PROXY_HOPS' | 'CLIENT_IP_HEADER'> = getDomainConfig(),
): string | null {
  if (config.CLIENT_IP_HEADER) {
    return request.headers.get(config.CLIENT_IP_HEADER)?.split(',')[0]?.trim() || null;
  }
  const hops = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.length < config.TRUSTED_PROXY_HOPS) return null;
  return hops[hops.length - config.TRUSTED_PROXY_HOPS] ?? null;
}

/** Address bucket for abuse limits; in production a missing address shares one strict bucket (fail closed). */
export function abuseLimitIp(request: Request, config: DomainConfig = getDomainConfig()): string | null {
  return clientIp(request, config) ?? (config.NODE_ENV === 'production' ? 'unknown' : null);
}

async function readRawBody(request: NextRequest, contract: RouteContract): Promise<{ raw: RawBody; digest: string }> {
  if (!contract.body) return { raw: { kind: 'empty' }, digest: '' };
  const max = getDomainConfig().UPLOAD_MAX_BYTES + 1024 * 1024;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > max) throw new AppError('payload_too_large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > max) throw new AppError('payload_too_large');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength === 0) return { raw: { kind: 'empty' }, digest };
  const type = request.headers.get('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    if (contract.body !== 'multipart' && contract.body !== 'json_or_multipart') {
      throw new AppError('invalid_input', { message: 'Expected application/json.' });
    }
    const form = await new Request(request.url, { method: 'POST', headers: { 'content-type': type }, body: bytes }).formData();
    return { raw: { kind: 'multipart', form }, digest };
  }
  if (!type.startsWith('application/json')) {
    throw new AppError('invalid_input', { message: 'Unsupported content type.' });
  }
  try {
    return { raw: { kind: 'json', json: JSON.parse(new TextDecoder().decode(bytes)) }, digest };
  } catch {
    throw new AppError('invalid_input', { message: 'The request body is not valid JSON.' });
  }
}

function parseWith<T extends z.ZodType>(schema: T | undefined, value: unknown): z.output<T> | undefined {
  if (!schema) return undefined;
  const r = schema.safeParse(value);
  if (!r.success) throw invalidInput(r.error);
  return r.data;
}

/**
 * Auth level, scopes and the sensor-bridge restriction. Delegates to the shared
 * `authorizeOperation` (packages/domain/src/authz/operations.ts), which the MCP
 * gateway also calls with the same contract, so REST and MCP refuse a token
 * with the same error code.
 */
function enforceAuth(contract: RouteContract, principal: Principal): void {
  authorizeOperation(principal, contract, 'rest');
}

export function apiRoute<C extends RouteContract>(
  contract: C,
  handler: (args: HandlerArgs<C>) => Promise<ResponseOf<C>>,
) {
  return async (request: NextRequest, segment: Segment): Promise<Response> => {
    const requestId = randomUUID();
    let newSession: { token: string; expiresAt: Date } | null = null;
    try {
      const config = getDomainConfig();
      const db = getDb();
      const sessionToken = request.cookies.get(auth.SESSION_COOKIE)?.value ?? null;
      const authorization = request.headers.get('authorization');
      let principal = await auth.resolvePrincipal(db, { sessionToken, authorization });
      const isMutation = contract.method !== 'GET';
      if (contract.path.startsWith('/v2/') && principal?.kind === 'account') {
        assertExpectedCaptureAccount(principal, request.headers.get('x-atlas-expected-account'), isMutation);
      }
      const ip = abuseLimitIp(request, config);

      // Per-IP abuse limit on anything that creates state (never merges users' data).
      if (isMutation) await enforceIpLimit(db, { ip, config, now: new Date() });

      if (!principal) {
        if (isMutation) {
          throw new AppError('unauthenticated', { message: 'Start a session first (GET /v1/session).' });
        }
        await enforceIpLimit(db, { ip, config, now: new Date(), metric: 'sessions', limit: Math.max(50, Math.floor(config.IP_DAILY_REQUESTS / 4)) });
        const s = await auth.createAnonymousSession(db, config);
        newSession = { token: s.token, expiresAt: s.expiresAt };
        principal = { kind: 'anonymous', sessionId: s.sessionId, expiresAt: s.expiresAt };
      }

      if (isMutation && !authorization && (principal.kind === 'anonymous' || principal.kind === 'account')) {
        const sessionId = principal.sessionId;
        if (!sessionId || !auth.verifyCsrf(sessionId, config.SESSION_SECRET, request.headers.get(auth.CSRF_HEADER))) {
          throw new AppError('csrf_failed');
        }
      }

      if (contract.auth !== 'public') enforceAuth(contract, principal);

      const rawParams = await segment.params;
      const params = parseWith(contract.params, rawParams) as Out<C['params']>;
      const query = parseWith(contract.query, Object.fromEntries(request.nextUrl.searchParams)) as Out<C['query']>;
      const { raw, digest } = await readRawBody(request, contract);
      let body: unknown = undefined;
      if (contract.body instanceof z.ZodType) {
        body = parseWith(contract.body, raw.kind === 'json' ? raw.json : raw.kind === 'empty' ? {} : undefined);
      } else if (contract.body) {
        body = raw;
      }

      const ctx = createServiceContext(principal, { requestId, db, config, surface: 'rest' });
      const setSession = (token: string, expiresAt: Date) => {
        newSession = { token, expiresAt };
      };
      const run = async () => {
        const result = await handler({ ctx, params, query, body: body as BodyOf<C>, request, setSession });
        if (contract.response === null) return { status: 204, body: null };
        let out: unknown = result;
        if (config.NODE_ENV !== 'production') {
          const check = (contract.response as z.ZodType).safeParse(result);
          if (!check.success) {
            console.error(`[api] response for ${contract.method} ${contract.path} violates its schema`, check.error.issues);
            throw new AppError('internal', { message: 'Response failed schema validation.' });
          }
          out = check.data;
        }
        return { status: contract.status, body: out };
      };

      const idemKey = request.headers.get('idempotency-key');
      const result =
        contract.idempotent && idemKey
          ? await withIdempotency(db, { principal, route: `${contract.method} ${contract.path}`, key: idemKey, request: { params, query, digest }, secretFields: contract.oneTimeSecrets }, run)
          : { ...(await run()), replayed: false };

      const response =
        result.status === 204 ? new NextResponse(null, { status: 204 }) : NextResponse.json(result.body, { status: result.status });
      response.headers.set('x-request-id', requestId);
      if (result.replayed) response.headers.set('idempotent-replayed', 'true');
      const issued = newSession as { token: string; expiresAt: Date } | null;
      if (issued) {
        response.cookies.set(
          auth.SESSION_COOKIE,
          issued.token,
          cookieOptions((issued.expiresAt.getTime() - Date.now()) / 1000),
        );
      }
      return response;
    } catch (err) {
      const { status, body } = toErrorBody(err, requestId);
      if (status >= 500 && body.code === 'internal') console.error(`[api] ${requestId}`, err);
      const response = NextResponse.json(body, { status });
      response.headers.set('x-request-id', requestId);
      if (err instanceof AppError && err.retryAfter) response.headers.set('retry-after', String(err.retryAfter));
      return response;
    }
  };
}

/** Extracts an uploaded image from multipart form data (field name `image`). */
export async function readImageField(form: FormData, field = 'image') {
  const file = form.get(field);
  if (!(file instanceof File)) throw new AppError('invalid_input', { message: 'Attach a photo in the "image" field.' });
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    filename: file.name || undefined,
    declaredContentType: file.type || undefined,
  };
}

/** Plain-object view of non-file multipart fields. */
export function formFields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;
  return out;
}
