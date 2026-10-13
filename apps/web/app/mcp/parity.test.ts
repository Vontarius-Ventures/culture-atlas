import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { agentConnections, collections, plans, setDbForTesting, setDomainConfigForTesting, taste } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { closeTestDb, getTestDb, testConfig, testProviders } from '@culture-atlas/domain/testing';
import { setProvidersForTesting } from '@culture-atlas/providers';
import { buildLibrary, connect, mcpClient, rawMcp } from '../../../../packages/agent-gateway/src/test-helpers';

vi.mock('server-only', () => ({}));
const { apiRoute } = await import('../../lib/server/http');

/**
 * REST and MCP must refuse the same token for the same reason with the same
 * code (spec: "Scope violations, expired tokens, and revoked connections have
 * matching REST/MCP behavior"). Handlers mirror the app/v1 route files.
 */

const rest = {
  getCollection: apiRoute(ROUTES.getCollection, ({ ctx, params, query }) => collections.getCollection(ctx, { id: params.id, query })),
  listCollections: apiRoute(ROUTES.listCollections, ({ ctx }) => collections.listCollections(ctx)),
  createCollection: apiRoute(ROUTES.createCollection, ({ ctx, body }) => collections.createCollection(ctx, body)),
  getTaste: apiRoute(ROUTES.getTaste, ({ ctx, query }) => taste.getTaste(ctx, query)),
  createPlan: apiRoute(ROUTES.createPlan, ({ ctx, body }) => plans.createPlan(ctx, body)),
};

let ip = 0;
function req(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-forwarded-for': `203.0.113.${++ip % 250}` };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const seg = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });

beforeAll(() => {
  setDbForTesting(getTestDb());
  setDomainConfigForTesting(testConfig());
  setProvidersForTesting(testProviders());
});
afterAll(async () => {
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  setProvidersForTesting(undefined);
  await closeTestDb();
});

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};

describe('REST/MCP parity for a read-only selected-collection connection', () => {
  it('returns the same codes (and status) for grant, scope and validation failures', async () => {
    const lib = await buildLibrary();
    const c = await connect(lib, { scopes: ['collections:read', 'taste:read', 'plans:read'] });
    const client = await mcpClient(c.credential);
    try {
      const cases: { name: string; rest: () => Promise<Response>; mcp: () => ReturnType<typeof client.callTool> }[] = [
        {
          name: 'ungranted collection',
          rest: () => rest.getCollection(req(`/v1/collections/${lib.other.id}`, c.credential), seg({ id: lib.other.id })),
          mcp: () => client.callTool('get_collection', { collection_id: lib.other.id }),
        },
        {
          name: 'global taste',
          rest: () => rest.getTaste(req('/v1/taste', c.credential), seg()),
          mcp: () => client.callTool('get_taste', {}),
        },
        {
          name: 'missing collections:write',
          rest: () => rest.createCollection(req('/v1/collections', c.credential, { method: 'POST', body: { name: 'x' } }), seg()),
          mcp: () => client.callTool('create_collection', { name: 'x' }),
        },
        {
          name: 'missing plans:write',
          rest: () =>
            rest.createPlan(
              req('/v1/plans', c.credential, {
                method: 'POST',
                body: { collection_id: lib.granted.id, expected_revision: lib.granted.revision, item_ids: [lib.artist, lib.film], template: 'movie_night' },
              }),
              seg(),
            ),
          mcp: () =>
            client.callTool('create_plan', {
              collection_id: lib.granted.id,
              expected_revision: lib.granted.revision,
              item_ids: [lib.artist, lib.film],
              template: 'movie_night',
            }),
        },
        {
          name: 'invalid input',
          rest: () => rest.getCollection(req('/v1/collections/nope', c.credential), seg({ id: 'nope' })),
          mcp: () => client.callTool('get_collection', { collection_id: 'nope' }),
        },
      ];

      const expected: Record<string, [number, string]> = {
        'ungranted collection': [404, 'not_found'],
        'global taste': [403, 'scope_denied'],
        'missing collections:write': [403, 'scope_denied'],
        'missing plans:write': [403, 'scope_denied'],
        'invalid input': [400, 'invalid_input'],
      };

      for (const k of cases) {
        const r = await k.rest();
        const restBody = (await r.json()) as { code: string; details?: unknown };
        const m = await k.mcp();
        expect(m.ok, k.name).toBe(false);
        const mcpErr = m.ok ? null : m.error;
        expect([r.status, restBody.code], k.name).toEqual(expected[k.name]);
        expect(mcpErr?.code, k.name).toBe(restBody.code);
        // Field paths differ by surface for validation issues (path param `id` vs tool arg `collection_id`).
        if (restBody.code !== 'invalid_input') expect(mcpErr?.details, k.name).toEqual(restBody.details);
      }
    } finally {
      await client.close();
    }
  });

  it('expired and revoked tokens fail on the next call on both surfaces with the same code', async () => {
    const lib = await buildLibrary();
    const c = await connect(lib);
    const ok = await rest.listCollections(req('/v1/collections', c.credential), seg());
    expect(ok.status).toBe(200);
    expect((await rawMcp(c.credential, INIT)).status).toBe(200);

    await agentConnections.revokeAgentConnection(lib.ownerCtx, { id: c.id });
    const restRevoked = await rest.listCollections(req('/v1/collections', c.credential), seg());
    const mcpRevoked = await rawMcp(c.credential, INIT);
    expect([restRevoked.status, (await restRevoked.json()).code]).toEqual([401, 'token_revoked']);
    expect([mcpRevoked.status, (await mcpRevoked.json()).code]).toEqual([401, 'token_revoked']);

    const e = await connect(lib);
    await getTestDb().query(`UPDATE agent_connections SET expires_at = now() - interval '1 second' WHERE id = $1`, [e.id]);
    const restExpired = await rest.listCollections(req('/v1/collections', e.credential), seg());
    const mcpExpired = await rawMcp(e.credential, INIT);
    expect([restExpired.status, (await restExpired.json()).code]).toEqual([401, 'token_expired']);
    expect([mcpExpired.status, (await mcpExpired.json()).code]).toEqual([401, 'token_expired']);
  });
});
