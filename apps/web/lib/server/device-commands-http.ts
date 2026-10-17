import 'server-only';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError, agentCommands, schemas, toErrorBody } from '@culture-atlas/domain';
import { requireCaptureV2InstallationContext } from './capture-v2';

/**
 * Phone-side command delivery (GET /v2/device/commands, POST
 * /v2/device/commands/{id}/ack). Only an enrolled installation's native
 * session (`cna_`) may claim or acknowledge; cookies, agent tokens and share
 * sessions confer nothing. Each claim re-checks arming, the agent's live grant
 * and authorization version before handing a command to the phone.
 */

const headers = (requestId: string) => ({ 'x-request-id': requestId, 'cache-control': 'no-store' });

function failure(err: unknown, requestId: string): Response {
  const safe = err instanceof z.ZodError ? new AppError('invalid_input') : err;
  const { status, body } = toErrorBody(safe, requestId);
  return Response.json({ error: body }, { status, headers: headers(requestId) });
}

export async function claimDeviceCommandsRoute(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    const ctx = await requireCaptureV2InstallationContext(request);
    const query = schemas.NativeCommandQuery.parse(Object.fromEntries(request.nextUrl.searchParams));
    const deadline = Date.now() + query.wait * 1000;
    let batch = await agentCommands.claimCommands(ctx, query.after_sequence);
    // Bounded long poll: re-claim (and so re-authorize) every second.
    while (!batch.items.length && Date.now() < deadline && !request.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      batch = await agentCommands.claimCommands(ctx, query.after_sequence);
    }
    return Response.json({ schema_version: '2.1', request_id: requestId, ...batch }, { headers: headers(requestId) });
  } catch (err) {
    return failure(err, requestId);
  }
}

export async function acknowledgeDeviceCommandRoute(request: NextRequest, id: string): Promise<Response> {
  const requestId = randomUUID();
  try {
    const ctx = await requireCaptureV2InstallationContext(request);
    const commandId = z.uuid().parse(id);
    const text = await request.text();
    if (text.length > 16_384) throw new AppError('payload_too_large', { message: 'Request is too large.' });
    let body: unknown;
    try {
      body = JSON.parse(text || '{}');
    } catch {
      throw new AppError('invalid_input');
    }
    const result = await agentCommands.acknowledgeCommand(ctx, commandId, body, request.headers.get('idempotency-key') ?? undefined);
    return Response.json({ schema_version: '2.1', request_id: requestId, ...result }, { headers: headers(requestId) });
  } catch (err) {
    return failure(err, requestId);
  }
}
