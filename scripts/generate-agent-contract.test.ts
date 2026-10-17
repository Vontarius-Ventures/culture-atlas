import { describe, expect, it } from 'vitest';
import { buildAgentContract } from './generate-agent-contract';

describe('agent OpenAPI 3.1', () => {
  it('publishes the same scoped REST operations and OAuth/SSE contracts', () => {
    const doc = buildAgentContract();
    expect(doc.openapi).toBe('3.1.0');
    for (const path of ['/v2/me/setup', '/v2/me/preferences', '/v2/agent-connections', '/v2/library',
      '/v2/uploads', '/v2/devices/{id}/commands', '/v2/operations/{id}', '/v2/oauth/token', '/v2/events']) {
      expect(doc.paths[path]).toBeTruthy();
    }
    expect(doc.paths['/v2/me/preferences']?.patch).toMatchObject({ 'x-required-scopes': ['preferences:write'] });
  });
});
