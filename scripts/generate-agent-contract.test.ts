import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as schemas from '../packages/domain/src/schemas';
import { SPEC_TOOL_NAMES, TOOLS } from '../packages/agent-gateway/src/tools';
import { SCOPES } from '../packages/domain/src/enums';
import { buildAgentContract, buildAgentContractFiles, buildAgentsReference, NAMED_SCHEMAS, withAgentsReference } from './generate-agent-contract';

const root = resolve(import.meta.dirname, '..');

describe('agent OpenAPI 3.1', () => {
  it('publishes the same scoped REST operations and OAuth/SSE contracts', () => {
    const doc = buildAgentContract();
    expect(doc.openapi).toBe('3.1.0');
    for (const path of ['/v2/me/setup', '/v2/me/preferences', '/v2/agent-connections', '/v2/library',
      '/v2/uploads', '/v2/devices/{id}/commands', '/v2/operations/{id}', '/v2/oauth/token', '/v2/events',
      '/v2/media/{id}/analysis', '/v2/device/commands', '/v2/device/commands/{id}/ack']) {
      expect(doc.paths[path]).toBeTruthy();
    }
    expect(doc.paths['/v2/me/preferences']?.patch).toMatchObject({ 'x-required-scopes': ['preferences:write'] });
  });

  it('publishes all eight sharing routes with share-session security and If-Match on policy changes', () => {
    const doc = buildAgentContract();
    const routes: Array<[string, string]> = [
      ['/v2/collections/{id}/shares', 'get'], ['/v2/collections/{id}/shares', 'post'], ['/v2/shares/{id}', 'patch'],
      ['/v2/shares/{id}', 'delete'], ['/v2/shares/{id}/invitations', 'post'], ['/v2/share-invitations/accept', 'post'],
      ['/v2/shared/redeem', 'post'], ['/v2/shared/collection', 'get'], ['/v2/shared/media/{id}/{variant}', 'get'],
    ];
    for (const [path, method] of routes) expect(doc.paths[path]?.[method], `${method} ${path}`).toBeTruthy();
    expect(doc.paths['/v2/shared/redeem']!.post).toMatchObject({ security: [] });
    expect(doc.paths['/v2/shared/collection']!.get).toMatchObject({ security: [{ shareSession: [] }, { accountSession: [] }] });
    expect(doc.paths['/v2/collections/{id}/shares']!.post).toMatchObject({ security: [{ accountSession: [] }] });
    const patch = doc.paths['/v2/shares/{id}']!.patch as { parameters: Array<{ name: string }> };
    expect(patch.parameters.map((p) => p.name)).toContain('If-Match');
  });

  it('maps MCP tools one-to-one onto the spec list, including analyze_media', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...SPEC_TOOL_NAMES].sort());
    for (const name of ['get_setup', 'get_preferences', 'update_preferences', 'list_media', 'get_media', 'begin_upload',
      'complete_upload', 'analyze_media', 'list_collections', 'get_collection', 'add_collection_item',
      'remove_collection_item', 'request_capture', 'get_operation']) {
      expect(SPEC_TOOL_NAMES).toContain(name);
    }
    // No tool creates or broadens a share grant.
    expect(TOOLS.some((t) => /share/i.test(t.name))).toBe(false);
  });

  it('committed docs/api files match the generator (run: pnpm exec tsx scripts/generate-agent-contract.ts)', async () => {
    for (const [path, expected] of Object.entries(buildAgentContractFiles())) {
      expect(await readFile(resolve(root, 'docs/api', path), 'utf8'), path).toBe(expected);
    }
    expect(Object.keys(NAMED_SCHEMAS).length).toBeGreaterThan(10);
  });

  it('docs/agents.md carries the generated scope and tool reference (every SCOPE and TOOL)', async () => {
    const doc = await readFile(resolve(root, 'docs/agents.md'), 'utf8');
    expect(withAgentsReference(doc)).toBe(doc);
    const reference = buildAgentsReference();
    for (const scope of SCOPES) expect(reference).toContain(`| \`${scope}\` |`);
    for (const tool of TOOLS) expect(reference).toContain(`| \`${tool.name}\` |`);
    // The upload field name and the v2 connection route are documented.
    expect(doc).toContain('**`image`**');
    expect(doc).toContain('POST /v2/agent-connections');
  });

  it('documented examples validate against the live schemas', async () => {
    const examples = JSON.parse(await readFile(resolve(root, 'docs/api/examples/sharing.json'), 'utf8')) as Record<string, unknown>;
    expect(schemas.CreateShareRequest.safeParse(examples.create_link_share_request).success).toBe(true);
    expect(schemas.CreateShareResponse.safeParse(examples.create_link_share_response).success).toBe(true);
    expect(schemas.CreateInvitationResponse.safeParse(examples.create_invitation_response).success).toBe(true);
    expect(schemas.SharedCollectionResponse.safeParse(examples.shared_collection_response).success).toBe(true);
    const agent = JSON.parse(await readFile(resolve(root, 'docs/api/examples/agents.json'), 'utf8')) as Record<string, unknown>;
    expect(schemas.CreateAgentV2.safeParse(agent.create_connection_request).success).toBe(true);
    expect(schemas.PreferencesResponse.safeParse(agent.preferences_response).success).toBe(true);
    expect(schemas.AgentOperationResponse.safeParse(agent.analysis_operation_response).success).toBe(true);
  });
});
