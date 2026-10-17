import 'server-only';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import {
  AppError,
  auth,
  clampShareRange,
  collectionShares,
  segmentByteLimit,
  createServiceContext,
  enforceIpLimit,
  getDb,
  getDomainConfig,
  ipBucket,
  toErrorBody,
  type Principal,
  type ServiceContext,
} from '@culture-atlas/domain';
import { getCaptureV2Storage } from './capture-v2';
import { abuseLimitIp, cookieOptions } from './http';

/**
 * HTTP adapter for share VIEWERS (/v2/shared/*). Viewers are not owners:
 *  - a bearer link session lives in an HttpOnly, SameSite=Strict cookie scoped
 *    to /v2/shared, so it is never sent to owner, agent or capture routes
 *    (and capture-v2 additionally rejects any share cookie it does see);
 *  - every response carries no-referrer, no-store and noindex;
 *  - the share service re-checks the grant on every request.
 */

export const SHARE_COOKIE = 'ca_share';
export const SHARE_COOKIE_PATH = '/v2/shared';

export const SHARE_PRIVACY_HEADERS: Record<string, string> = {
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'x-content-type-options': 'nosniff',
};

export function shareHeaders(requestId: string, extra: Record<string, string> = {}): Headers {
  return new Headers({ ...SHARE_PRIVACY_HEADERS, 'x-request-id': requestId, ...extra });
}

export function shareError(err: unknown, requestId: string): Response {
  const { status, body } = toErrorBody(err, requestId);
  if (status >= 500 && body.code === 'internal') console.error(`[share] ${requestId}`, err);
  const headers = shareHeaders(requestId, { 'content-type': 'application/json' });
  if (err instanceof AppError && err.retryAfter) headers.set('retry-after', String(err.retryAfter));
  return new Response(JSON.stringify({ error: body }), { status, headers });
}

/** Viewer context: the signed-in account (if any) for restricted membership; never anonymous session creation. */
export async function viewerContext(request: NextRequest, requestId: string): Promise<ServiceContext> {
  const db = getDb();
  let principal: Principal | null;
  // Bearer agent tokens never authorize share endpoints, and share tokens never authorize agents.
  if (request.headers.get('authorization')) throw new AppError('scope_denied', { message: 'Share links do not authorize agents.' });
  try {
    principal = await auth.resolvePrincipal(db, { sessionToken: request.cookies.get(auth.SESSION_COOKIE)?.value ?? null });
  } catch {
    principal = null;
  }
  // Without a browser session the viewer is an ephemeral, unpersisted anonymous
  // principal: it owns nothing, so it can only ever reach the share projection.
  return createServiceContext(principal ?? { kind: 'anonymous', sessionId: randomUUID(), expiresAt: new Date() }, {
    requestId, db, surface: 'rest',
  });
}

export function viewerFrom(request: NextRequest) {
  return {
    sessionToken: request.cookies.get(SHARE_COOKIE)?.value ?? null,
    shareId: request.nextUrl.searchParams.get('share'),
  };
}

/** Same-origin check for the cookie-setting redemption POST (no CSRF session exists yet). */
function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const allowed = new Set([new URL(getDomainConfig().APP_BASE_URL).origin, request.nextUrl.origin]);
  if (!allowed.has(origin)) throw new AppError('csrf_failed');
}

async function readSmallJson(request: NextRequest): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('invalid_input');
  const text = await request.text();
  if (text.length > 4096) throw new AppError('payload_too_large', { message: 'Request is too large.' });
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('invalid_input');
  }
}

/** POST /v2/shared/redeem */
export async function redeemShareRoute(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    assertSameOrigin(request);
    const config = getDomainConfig();
    const db = getDb();
    const ip = abuseLimitIp(request, config);
    const now = new Date();
    await enforceIpLimit(db, { ip, config, now, metric: 'share_redeem', limit: 500 });
    await collectionShares.enforceRedeemLimit(db, ip ? ipBucket(ip, config.SESSION_SECRET) : 'ip:unknown', now);
    const ctx = await viewerContext(request, requestId);
    const result = await collectionShares.redeemLink(ctx, await readSmallJson(request));
    const { sessionToken, expiresAt, ...body } = result;
    const options = cookieOptions((expiresAt.getTime() - Date.now()) / 1000);
    const cookie = [
      `${SHARE_COOKIE}=${sessionToken}`,
      `Path=${SHARE_COOKIE_PATH}`,
      `Max-Age=${options.maxAge}`,
      'HttpOnly',
      'SameSite=Strict',
      ...(options.secure ? ['Secure'] : []),
    ].join('; ');
    const headers = shareHeaders(requestId, { 'content-type': 'application/json', 'set-cookie': cookie });
    return new Response(JSON.stringify(body), { status: 200, headers });
  } catch (err) {
    return shareError(err, requestId);
  }
}

/**
 * GET /v2/shared/media/{id}/{variant} — recipient-authorized media gateway.
 * The grant (session or membership, collection membership, include_media,
 * allow_originals, share-safe derivative) is re-checked on EVERY request, and
 * every response is at most one authorized segment (about 30 seconds of video,
 * never more than 8 MiB), so a revoked share denies the next range.
 */
export async function sharedMediaRoute(request: NextRequest, assetId: string, variant: string): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (!/^[0-9a-f-]{36}$/i.test(assetId) || !['poster', 'playback', 'original'].includes(variant)) {
      throw new AppError('not_found');
    }
    const ctx = await viewerContext(request, requestId);
    const object = await collectionShares.getSharedMedia(ctx, viewerFrom(request), assetId,
      variant as 'poster' | 'playback' | 'original');
    const rangeHeader = request.headers.get('range');
    const range = clampShareRange(rangeHeader, object.byteSize, segmentByteLimit(object));
    if (!range) {
      return new Response(null, { status: 416, headers: shareHeaders(requestId, { 'content-range': `bytes */${object.byteSize}` }) });
    }
    const slice = await getCaptureV2Storage().getRange(object.objectKey, range);
    const whole = !rangeHeader && slice.start === 0 && slice.end === slice.totalSize - 1;
    const headers = shareHeaders(requestId, {
      'content-type': slice.contentType,
      'content-length': String(slice.end - slice.start + 1),
      'accept-ranges': 'bytes',
      'content-disposition': variant === 'original' ? 'attachment' : 'inline',
      ...(whole ? {} : { 'content-range': `bytes ${slice.start}-${slice.end}/${slice.totalSize}` }),
    });
    const body = Readable.toWeb(Readable.from(slice.body)) as ReadableStream;
    return new Response(body, { status: whole ? 200 : 206, headers });
  } catch (err) {
    return shareError(err, requestId);
  }
}

/** GET /v2/shared/collection */
export async function sharedCollectionRoute(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    const ctx = await viewerContext(request, requestId);
    const body = await collectionShares.getSharedCollection(ctx, viewerFrom(request));
    return new Response(JSON.stringify(body), { status: 200, headers: shareHeaders(requestId, { 'content-type': 'application/json' }) });
  } catch (err) {
    return shareError(err, requestId);
  }
}
