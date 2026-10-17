import 'server-only';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError, devicePush, getDomainConfig, toErrorBody } from '@culture-atlas/domain';
import { requireCaptureV2InstallationContext } from './capture-v2';

/**
 * PUT /v2/device/push-token {provider, token, environment} and
 * DELETE /v2/device/push-token. Only the enrolled phone's own `cna_` session
 * may register; the token is encrypted at rest and never echoed back.
 * Additive to BACKEND-CONTRACTS (mobile_installations "push token encrypted").
 */
const headers = (requestId: string) => ({
  'x-request-id': requestId,
  'cache-control': 'no-store',
});

export async function devicePushTokenRoute(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    const ctx = await requireCaptureV2InstallationContext(request);
    const key = request.headers.get('idempotency-key') ?? '';
    if (request.method === 'DELETE')
      return Response.json(await devicePush.clearPushToken(ctx, key), {
        headers: headers(requestId),
      });
    if (request.method !== 'PUT') throw new AppError('not_found');
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      throw new AppError('invalid_input');
    const text = await request.text();
    if (text.length > 8192) throw new AppError('payload_too_large');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AppError('invalid_input');
    }
    const result = await devicePush.registerPushToken(
      ctx,
      body,
      key,
      getDomainConfig().CREDENTIAL_ENCRYPTION_KEY,
    );
    return Response.json(result, { headers: headers(requestId) });
  } catch (error) {
    const safe = error instanceof z.ZodError ? new AppError('invalid_input') : error;
    const { status, body } = toErrorBody(safe, requestId);
    return Response.json({ error: body }, { status, headers: headers(requestId) });
  }
}
