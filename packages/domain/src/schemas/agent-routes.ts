import { z } from 'zod';
import { IdParams } from './common';
import { AgentConnectionDto, AgentConnectionsListResponse, CreateAgentConnectionResponse } from './agent-connections';
import * as A from './agent-platform';
import type { RouteContract } from './routes';
import { CaptureCommandRequest, CaptureCommandResponse } from './agent-commands';

const Meta = z.object({ schema_version: z.literal('2.1'), request_id: z.string() });
export const AGENT_ROUTES = {
  requestCapture: { method: 'POST', path: '/v2/devices/{id}/commands', auth: 'account', scopes: ['devices:command'], params: IdParams, body: CaptureCommandRequest, response: CaptureCommandResponse, status: 202, idempotent: false, mcpTool: 'request_capture' },
  getCommandV2: { method: 'GET', path: '/v2/commands/{id}', auth: 'account', scopes: ['devices:command'], params: IdParams, response: CaptureCommandResponse, status: 200, idempotent: false },
  getSetup: { method: 'GET', path: '/v2/me/setup', auth: 'account', scopes: ['setup:read'], response: A.SetupResponse, status: 200, idempotent: false, mcpTool: 'get_setup' },
  getPreferences: { method: 'GET', path: '/v2/me/preferences', auth: 'account', scopes: ['preferences:read'], response: A.PreferencesResponse, status: 200, idempotent: false, mcpTool: 'get_preferences' },
  updatePreferences: { method: 'PATCH', path: '/v2/me/preferences', auth: 'account', scopes: ['preferences:write'], body: A.PatchOrdinaryPreferences, response: A.PreferencesResponse, status: 200, idempotent: false, mcpTool: 'update_preferences' },
  listConnectionsV2: { method: 'GET', path: '/v2/agent-connections', auth: 'owner', scopes: [], response: AgentConnectionsListResponse.and(Meta), status: 200, idempotent: false },
  createConnectionV2: { method: 'POST', path: '/v2/agent-connections', auth: 'owner', scopes: [], body: A.CreateAgentV2, response: CreateAgentConnectionResponse.and(Meta), status: 201, idempotent: true, oneTimeSecrets: ['credential'] },
  narrowConnectionV2: { method: 'PATCH', path: '/v2/agent-connections/{id}', auth: 'owner', scopes: [], params: IdParams, body: A.NarrowAgentV2, response: Meta.extend({ connection: AgentConnectionDto }), status: 200, idempotent: true },
  rotateConnectionV2: { method: 'POST', path: '/v2/agent-connections/{id}/rotate', auth: 'owner', scopes: [], params: IdParams, response: Meta.extend({ credential: z.string() }), status: 200, idempotent: false, oneTimeSecrets: ['credential'] },
  revokeConnectionV2: { method: 'DELETE', path: '/v2/agent-connections/{id}', auth: 'owner', scopes: [], params: IdParams, response: null, status: 204, idempotent: true },
  agentActivity: { method: 'GET', path: '/v2/agent-activity', auth: 'owner', scopes: [], response: A.AgentActivityResponse, status: 200, idempotent: false },
  oauthConsent: { method: 'POST', path: '/v2/oauth/authorize', auth: 'owner', scopes: [], body: A.OAuthConsent, response: Meta.extend({ redirect_uri: z.url() }), status: 200, idempotent: false, oneTimeSecrets: ['redirect_uri'] },
} as const satisfies Record<string, RouteContract>;
