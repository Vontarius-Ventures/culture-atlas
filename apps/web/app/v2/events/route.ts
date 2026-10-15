import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { auth, agentEvents, AppError, createServiceContext, enforceAgentRate, getDb, toErrorBody } from '@culture-atlas/domain';

export async function GET(request: NextRequest) {
  const requestId = randomUUID(), db = getDb();
  try {
    const principal = await auth.resolvePrincipal(db, { authorization: request.headers.get('authorization'), sessionToken: request.cookies.get(auth.SESSION_COOKIE)?.value });
    if (!principal) throw new AppError('unauthenticated');
    const ctx = createServiceContext(principal, { requestId, db });
    await enforceAgentRate(ctx, false);
    let batch = await agentEvents.readEvents(ctx, request.nextUrl.searchParams.get('after_cursor') ?? request.headers.get('last-event-id') ?? undefined);
    const encoder = new TextEncoder(), started = Date.now();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (!cancelled && !request.signal.aborted && Date.now() - started < 25_000) {
            controller.enqueue(encoder.encode(`id: ${batch.next_cursor}\nevent: batch\ndata: ${JSON.stringify(batch)}\n\n`));
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (cancelled || request.signal.aborted) break;
            batch = await agentEvents.readEvents(ctx, batch.next_cursor);
          }
        } catch (err) {
          if (!cancelled && !request.signal.aborted) controller.enqueue(encoder.encode(`event: authorization_changed\ndata: ${JSON.stringify({ error: toErrorBody(err, requestId).body })}\n\n`));
        } finally { if (!cancelled) controller.close(); }
      },
      cancel() { cancelled = true; },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-request-id': requestId, 'x-accel-buffering': 'no' } });
  } catch (err) {
    const result = toErrorBody(err, requestId);
    return Response.json({ error: result.body }, { status: result.status, headers: { 'cache-control': 'no-store' } });
  }
}
