import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import {
  AppError,
  agentEvents,
  assertCaptureAuthority,
  auth,
  createServiceContext,
  enforceAgentRate,
  getDb,
  toErrorBody,
  type Principal,
  type ServiceContext,
} from '@culture-atlas/domain';
import { requireCaptureV2InstallationContext } from './capture-v2';

export interface EventStreamOptions {
  /** Poll interval for new events. */
  pollMs?: number;
  /** Comment keepalive interval so proxies keep the stream open. */
  keepaliveMs?: number;
  /** Streams end after this window; clients reconnect with Last-Event-ID. */
  maxStreamMs?: number;
}

/**
 * Authenticated SSE of the caller's own media/command (and preference) events.
 * Browser sessions, scoped agent tokens and enrolled installations (cna_) are
 * accepted; share viewers and anonymous callers are not. Cursors are encrypted,
 * account/connection-bound and expire after 24h; an expired cursor emits a
 * `resync` event so the client reloads state instead of silently skipping events.
 * Every poll reauthorizes (revoked installations and agents stop receiving).
 */
export async function eventStream(
  request: NextRequest,
  options: EventStreamOptions = {},
): Promise<Response> {
  const requestId = randomUUID(),
    db = getDb();
  const pollMs = options.pollMs ?? 1000,
    keepaliveMs = options.keepaliveMs ?? 15_000,
    maxStreamMs = options.maxStreamMs ?? 25_000;
  try {
    const authorization = request.headers.get('authorization');
    let principal: Principal | null;
    let recheck: () => Promise<void> = async () => {};
    if (authorization?.startsWith('Bearer cna_')) {
      // Installation tokens resolve to their bound account; revocation is rechecked each poll.
      const capture = await requireCaptureV2InstallationContext(request);
      principal = {
        kind: 'account',
        accountId: capture.authority.accountId,
        sessionId: null,
        isDemoOwner: false,
      };
      recheck = () => assertCaptureAuthority(capture, capture.db);
    } else {
      if (
        request.headers.has('x-atlas-share-session') ||
        request.headers.has('x-atlas-share-token') ||
        request.cookies.getAll().some((cookie) => /^ca_(?:share|shared)/i.test(cookie.name))
      )
        throw new AppError('scope_denied');
      principal = await auth.resolvePrincipal(db, {
        authorization,
        sessionToken: request.cookies.get(auth.SESSION_COOKIE)?.value,
      });
    }
    if (!principal) throw new AppError('unauthenticated');
    if (principal.kind !== 'account' && principal.kind !== 'agent')
      throw new AppError('scope_denied');
    const ctx: ServiceContext = createServiceContext(principal, { requestId, db });
    await enforceAgentRate(ctx, false);
    const cursor =
      request.nextUrl.searchParams.get('after_cursor') ??
      request.headers.get('last-event-id') ??
      undefined;
    const encoder = new TextEncoder(),
      started = Date.now();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (text: string) => controller.enqueue(encoder.encode(text));
        let next = cursor,
          lastWrite = Date.now(),
          first = true;
        try {
          send(`retry: 2000\n\n`);
          while (!cancelled && !request.signal.aborted && Date.now() - started < maxStreamMs) {
            await recheck();
            const batch = await agentEvents.readEvents(ctx, next);
            if (first || batch.items.length) {
              send(`id: ${batch.next_cursor}\nevent: batch\ndata: ${JSON.stringify(batch)}\n\n`);
              lastWrite = Date.now();
              first = false;
            } else if (Date.now() - lastWrite >= keepaliveMs) {
              send(`: keepalive\n\n`);
              lastWrite = Date.now();
            }
            next = batch.next_cursor;
            await new Promise((resolve) => setTimeout(resolve, pollMs));
          }
        } catch (err) {
          if (!cancelled && !request.signal.aborted) {
            const body = toErrorBody(err, requestId).body;
            const event =
              err instanceof AppError && err.code === 'cursor_expired'
                ? 'resync'
                : 'authorization_changed';
            send(`event: ${event}\ndata: ${JSON.stringify({ error: body })}\n\n`);
          }
        } finally {
          if (!cancelled) controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-request-id': requestId,
        'x-accel-buffering': 'no',
      },
    });
  } catch (err) {
    const result = toErrorBody(err, requestId);
    return Response.json(
      { error: result.body },
      {
        status: result.status,
        headers: { 'cache-control': 'no-store', 'x-request-id': requestId },
      },
    );
  }
}
