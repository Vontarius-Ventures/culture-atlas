import { enforceAgentRate } from '@culture-atlas/domain';
import type { RouteContract } from '@culture-atlas/domain/schemas';
import { apiRoute } from './http';

/** Keep session, CSRF, input and authorization behavior shared with v1. */
export function agentRoute<C extends RouteContract>(contract: C, handler: Parameters<typeof apiRoute<C>>[1]) {
  const run = apiRoute(contract, async (args) => {
    await enforceAgentRate(args.ctx, contract.method !== 'GET');
    return handler(args);
  });
  return async (...args: Parameters<typeof run>) => {
    const response = await run(...args);
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    let body: Record<string, unknown> | null = response.status === 204 ? null : await response.json();
    if (response.status >= 400) body = { error: body };
    else if (body) {
      body = { ...body, schema_version: '2.1', request_id: headers.get('x-request-id') };
      if (typeof body.version === 'number') headers.set('etag', `"${body.version}"`);
    }
    return new Response(body ? JSON.stringify(body) : null, { status: response.status, headers });
  };
}
