import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CreateCollectionRequest, UpdateCollectionRequest } from './collections';
import { CreateCaptureJsonRequest, CorrectionRequest } from './captures';
import { CreatePlanRequest } from './plans';
import { CreateAgentConnectionRequest } from './agent-connections';
import { ROUTES } from './routes';

describe('request schemas', () => {
  it('reject unknown mutation fields', () => {
    expect(CreateCollectionRequest.safeParse({ name: 'Weekend', public: true }).success).toBe(false);
    expect(CreateCollectionRequest.safeParse({ name: 'Weekend' }).success).toBe(true);
  });

  it('cap collection names at 80 characters and trim', () => {
    expect(CreateCollectionRequest.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(CreateCollectionRequest.parse({ name: '  Rooms  ' }).name).toBe('Rooms');
    expect(UpdateCollectionRequest.safeParse({ expected_revision: 1 }).success).toBe(false);
  });

  it('validate the spec plan example', () => {
    const photo = randomUUID();
    const artist = randomUUID();
    const parsed = CreatePlanRequest.parse({
      collection_id: randomUUID(),
      expected_revision: 3,
      item_ids: [photo, artist],
      template: 'movie_night',
      constraints: { dietary_exclusions: ['peanuts'], instruction: 'A relaxed evening' },
      exploration: 'balanced',
    });
    expect(parsed.item_ids).toHaveLength(2);
    expect(CreatePlanRequest.safeParse({ ...parsed, item_ids: [photo] }).success).toBe(false);
    expect(CreatePlanRequest.safeParse({ ...parsed, item_ids: [photo, photo] }).success).toBe(false);
    expect(CreatePlanRequest.safeParse({ ...parsed, fixed_film_item_id: randomUUID() }).success).toBe(false);
    expect(CreatePlanRequest.parse({ ...parsed, exploration: undefined }).exploration).toBe('balanced');
  });

  it('require exactly one capture source', () => {
    expect(CreateCaptureJsonRequest.safeParse({}).success).toBe(false);
    expect(CreateCaptureJsonRequest.safeParse({ sample_id: 'outfit' }).success).toBe(true);
    expect(CreateCaptureJsonRequest.safeParse({ sample_id: 'outfit', upload_id: randomUUID() }).success).toBe(false);
    expect(CorrectionRequest.safeParse({ expected_analysis_version: 1 }).success).toBe(false);
  });

  it('default agent connections to read-only scopes', () => {
    const c = CreateAgentConnectionRequest.parse({ client_name: 'demo', library_access: 'selected_collections', collection_ids: [randomUUID()] });
    expect(c.scopes.every((s) => s.endsWith(':read'))).toBe(true);
    expect(CreateAgentConnectionRequest.safeParse({ client_name: 'demo', library_access: 'selected_collections' }).success).toBe(false);
  });
});

describe('route contract', () => {
  it('covers every route in the spec REST table', () => {
    const spec = [
      'POST /v1/captures', 'GET /v1/jobs/{id}', 'GET /v1/captures/{id}', 'POST /v1/captures/{id}/corrections',
      'DELETE /v1/captures/{id}', 'GET /v1/references/{id}', 'POST /v1/preferences', 'GET /v1/saved',
      'GET /v1/discoveries', 'GET /v1/items/{id}', 'POST /v1/items/{id}/discoveries', 'GET /v1/collections',
      'POST /v1/collections', 'GET /v1/collections/{id}', 'PATCH /v1/collections/{id}', 'DELETE /v1/collections/{id}',
      'PUT /v1/collections/{id}/items/{item_id}', 'DELETE /v1/collections/{id}/items/{item_id}',
      'PUT /v1/collections/{id}/order', 'GET /v1/taste', 'POST /v1/plans', 'GET /v1/plans/{id}',
      'POST /v1/plans/{id}/replacements', 'DELETE /v1/plans/{id}', 'POST /v1/agent-connections',
      'DELETE /v1/agent-connections/{id}', 'POST /v1/sensor-connections', 'DELETE /v1/sensor-connections/{id}',
      'GET /v1/demo/traces/{job_id}',
    ];
    const have = new Set(Object.values(ROUTES).map((r) => `${r.method} ${r.path}`));
    for (const route of spec) expect(have, route).toContain(route);
  });

  it('maps every spec MCP tool to a route except get_job which is shared', () => {
    const tools = Object.values(ROUTES).flatMap((r) => ('mcpTool' in r && r.mcpTool ? [r.mcpTool] : []));
    for (const t of [
      'analyze_capture', 'get_job', 'get_capture', 'explore_reference', 'get_taste', 'record_preference',
      'list_collections', 'get_collection', 'create_collection', 'add_collection_item', 'remove_collection_item',
      'discover_related', 'create_plan', 'get_plan', 'replace_plan_section',
    ]) {
      expect(tools).toContain(t);
    }
  });
});
