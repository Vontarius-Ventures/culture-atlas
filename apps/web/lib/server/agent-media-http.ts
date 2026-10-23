import 'server-only';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  AppError,
  agentMedia,
  auth,
  createServiceContext,
  enforceAgentRequest,
  getDb,
  requireAgentConnection,
  toErrorBody,
  type AgentPrincipal,
  type CaptureV2Context,
  type ServiceContext,
} from '@culture-atlas/domain';
import { createCaptureV2HttpContext } from './capture-v2';

/**
 * Agent REST media (gap G7). REST is authoritative; MCP media tools call the
 * same `agentMedia` services through the same capture context. Bearer `cat_`
 * agent credentials reach /v2/library, /v2/media/** and /v2/uploads/** here;
 * every call re-reads the live grant (scopes, collections, version).
 * Owner-only capture routes (devices, capabilities, batch delete…) stay closed.
 */

/** Capture context bound to the agent's account and live grant version (also used by MCP). */
export async function agentCaptureContext(principal: AgentPrincipal): Promise<CaptureV2Context> {
  const db = getDb();
  const { rows } = await db.query<{ authorization_version: number }>(
    `SELECT authorization_version FROM agent_connections WHERE id = $1 AND owner_account_id = $2
        AND purpose = 'agent' AND revoked_at IS NULL`,
    [principal.connectionId, principal.accountId],
  );
  if (!rows[0]) throw new AppError('token_revoked');
  return createCaptureV2HttpContext(
    { kind: 'account', accountId: principal.accountId, sessionId: null },
    { db, agent: { connectionId: principal.connectionId, authorizationVersion: rows[0].authorization_version } },
  );
}

const Uuid = z.uuid();

function idempotencyKey(request: NextRequest): string {
  const key = request.headers.get('idempotency-key') ?? '';
  if (!Uuid.safeParse(key).success) throw new AppError('invalid_input', { message: 'Idempotency-Key must be a UUID.' });
  return key;
}

async function json(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (text.length > 1_048_576) throw new AppError('payload_too_large', { message: 'Request metadata is too large.' });
  if (!text) return {};
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('invalid_input');
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('invalid_input');
  }
}

async function contentResponse(ctx: ServiceContext, request: NextRequest, id: string, variant: string, headers: Record<string, string>) {
  const object = await agentMedia.mediaContent(ctx, id, variant);
  const range = request.headers.get('range');
  let start = 0;
  let end = object.byteSize - 1;
  if (range) {
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!parsed || (!parsed[1] && !parsed[2])) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${object.byteSize}` } });
    start = parsed[1] ? Number(parsed[1]) : Math.max(0, object.byteSize - Number(parsed[2]));
    end = parsed[1] && parsed[2] ? Math.min(Number(parsed[2]), end) : end;
    if (start > end || start >= object.byteSize) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${object.byteSize}` } });
  }
  async function* slices() {
    let offset = 0;
    for await (const chunk of object.body) {
      if (offset + chunk.length > start && offset <= end) {
        yield chunk.subarray(Math.max(0, start - offset), Math.min(chunk.length, end - offset + 1));
      }
      offset += chunk.length;
      if (offset > end) break;
    }
  }
  return new Response(Readable.toWeb(Readable.from(slices())) as ReadableStream, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      'content-type': object.contentType,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${object.byteSize}` } : {}),
    },
  });
}

export async function agentMediaRoute(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const headers = { 'x-request-id': requestId, 'cache-control': 'no-store' };
  try {
    const db = getDb();
    const principal = await auth.resolvePrincipal(db, { authorization: request.headers.get('authorization') });
    requireAgentConnection(principal);
    if (principal.purpose !== 'agent') throw new AppError('scope_denied');
    const method = request.method;
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    let ctx = createServiceContext(principal, { requestId, db, surface: 'rest' });
    await enforceAgentRequest(ctx, method !== 'GET');
    ctx = { ...ctx, captureV2: await agentCaptureContext(principal) };
    let result: unknown;
    let status = 200;
    let match: RegExpExecArray | null;
    if (path === '/v2/library' && method === 'GET') {
      result = await agentMedia.listMedia(ctx, Object.fromEntries(new URL(request.url).searchParams));
    } else if ((match = /^\/v2\/(?:agent-)?media\/([^/]+)\/content\/([^/]+)$/.exec(path)) && method === 'GET') {
      return await contentResponse(ctx, request, Uuid.parse(match[1]), match[2]!, headers);
    } else if ((match = /^\/v2\/media\/([^/]+)\/analysis$/.exec(path)) && method === 'POST') {
      result = await agentMedia.analyzeMedia(ctx, Uuid.parse(match[1]), await json(request), idempotencyKey(request));
      status = 202;
    } else if ((match = /^\/v2\/media\/([^/]+)$/.exec(path)) && method === 'GET') {
      result = await agentMedia.getMedia(ctx, Uuid.parse(match[1]));
    } else if (path === '/v2/uploads' && method === 'POST') {
      result = await agentMedia.beginUpload(ctx, await json(request), idempotencyKey(request));
      status = 201;
    } else if ((match = /^\/v2\/uploads\/([^/]+)(?:\/(parts|complete))?$/.exec(path))) {
      const id = Uuid.parse(match[1]);
      if (method === 'GET' && !match[2]) result = await agentMedia.getUpload(ctx, id);
      else if (method === 'POST' && match[2] === 'parts') result = await agentMedia.uploadParts(ctx, id, await json(request), idempotencyKey(request));
      else if (method === 'POST' && match[2] === 'complete') {
        result = await agentMedia.completeUpload(ctx, id, await json(request), idempotencyKey(request));
        status = (result as { state?: string }).state === 'committed' ? 200 : 202;
      } else if (method === 'DELETE' && !match[2]) {
        result = await agentMedia.abortUpload(ctx, id, idempotencyKey(request));
        status = 202;
      } else throw new AppError('not_found');
    } else {
      // Device, capability and owner library management are not agent operations.
      throw new AppError('scope_denied');
    }
    const body = { ...(result as Record<string, unknown>), schema_version: '2.1', request_id: requestId };
    return Response.json(body, { status, headers });
  } catch (err) {
    const safe = err instanceof z.ZodError ? new AppError('invalid_input') : err;
    const { status, body } = toErrorBody(safe, requestId);
    const extra: Record<string, string> = safe instanceof AppError && safe.retryAfter ? { 'retry-after': String(safe.retryAfter) } : {};
    return Response.json({ error: body }, { status, headers: { ...headers, ...extra } });
  }
}
