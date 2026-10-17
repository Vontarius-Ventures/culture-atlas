import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ROUTES } from '../../domain/src/schemas/routes';
import { OAuthExchange } from '../../domain/src/schemas/agent-platform';
import type { RouteContract } from '../../domain/src/schemas/routes';
import { TOOLS } from './tools';

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
export function buildAgentContract() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [name, route] of Object.entries(ROUTES)) {
    if (!route.path.startsWith('/v2/')) continue;
    const r: RouteContract = route;
    const parameters: unknown[] = [];
    for (const match of r.path.matchAll(/\{(\w+)\}/g)) parameters.push({ name: match[1], in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
    if (r.query) {
      const query = schema(r.query);
      for (const [key, value] of Object.entries(query.properties ?? {})) parameters.push({ name: key, in: 'query', schema: value });
    }
    if (r.method !== 'GET') parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } });
    if (r.method === 'PATCH' && r.path === '/v2/me/preferences') parameters.push({ name: 'If-Match', in: 'header', required: true, schema: { type: 'string', pattern: '^"[1-9][0-9]*"$' } });
    const op = {
      operationId: name, security: r.auth === 'owner' ? [{ accountSession: [] }] : [{ bearerAuth: [] }, { accountSession: [] }],
      'x-required-scopes': r.scopes, parameters,
      ...(r.body instanceof z.ZodType ? { requestBody: { required: true, content: { 'application/json': { schema: schema(r.body) } } } } : {}),
      responses: {
        [r.status]: { description: 'Authorized result', ...(r.response ? { content: { 'application/json': { schema: schema(r.response) } } } : {}) },
        '401': { description: 'Invalid, expired or revoked credential' }, '403': { description: 'Missing permission' },
        '404': { description: 'Missing or inaccessible resource' }, '412': { description: 'Preference version changed' },
        '429': { description: 'Rate limit, see Retry-After' },
      },
    };
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }
  paths['/v2/oauth/token'] = { post: { operationId: 'oauthToken', security: [], requestBody: {
    required: true, content: { 'application/json': { schema: schema(OAuthExchange) } },
  }, responses: { '200': { description: '10-minute bearer and rotating refresh, no-store' }, '401': { description: 'Generic invalid grant' } } } };
  paths['/v2/events'] = { get: { operationId: 'agentEvents', security: [{ bearerAuth: [] }], parameters: [
    { name: 'after_cursor', in: 'query', schema: { type: 'string', maxLength: 1024 } },
  ], responses: { '200': { description: 'Resumable scoped batches, grant rechecked every second, no media URLs',
    content: { 'text/event-stream': { schema: { type: 'string' } } } }, '410': { description: 'Cursor expired, resync current state' } } } };
  return {
    openapi: '3.1.0', info: { title: 'Culture Atlas agent platform', version: '2.1.0' },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    servers: [{ url: 'https://your-atlas.example' }], paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, accountSession: {
      type: 'apiKey', in: 'cookie', name: 'ca_session', description: 'Owner browser session. Mutations also require x-csrf-token and X-Atlas-Expected-Account.',
    } } },
  };
}
export async function generateAgentContract(root: string) {
  const output = resolve(root, 'docs/api');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'agent-platform.openapi.json'), `${JSON.stringify(buildAgentContract(), null, 2)}\n`);
  await writeFile(resolve(output, 'agent-tools-v2.json'), `${JSON.stringify({
    schema_version: '2.1', catalog_version: '2.1.0',
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, scopes: t.scopes, input_schema: schema(t.input) })),
  }, null, 2)}\n`);
}
