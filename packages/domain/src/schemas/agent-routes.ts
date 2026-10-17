import { z } from 'zod';
import { IdParams } from './common';
import { AgentConnectionDto, AgentConnectionsListResponse, CreateAgentConnectionResponse } from './agent-connections';
import * as A from './agent-platform';
import type { RouteContract } from './routes';
import { CaptureCommandRequest, CaptureCommandResponse } from './agent-commands';
import { AgentAnalysisResponse, AgentMediaQuery, AgentOperationResponse, AgentUploadRequest } from './agent-media';
import { AnalyzeMediaRequest, CompleteMediaUploadRequest, MediaDetailResponse, MediaLibraryResponse, MediaUploadResponse, UploadPartsRequest } from './capture-v2';
import { CollectionMediaParams, CollectionMediaResult, CollectionMediaResponse } from './collection-media';

const Meta = z.object({ schema_version: z.literal('2.1'), request_id: z.string() });
export const AGENT_ROUTES = {
  listCollectionMedia: { method: 'GET', path: '/v2/collections/{id}/media', auth: 'account', scopes: ['collections:read'], params: IdParams, response: CollectionMediaResponse, status: 200, idempotent: false },
  addCollectionMedia: { method: 'PUT', path: '/v2/collections/{id}/media/{asset_id}', auth: 'account', scopes: ['collections:write'], params: CollectionMediaParams, response: CollectionMediaResult, status: 200, idempotent: true },
  removeCollectionMedia: { method: 'DELETE', path: '/v2/collections/{id}/media/{asset_id}', auth: 'account', scopes: ['collections:write'], params: CollectionMediaParams, response: CollectionMediaResult, status: 200, idempotent: true },
  listAgentMedia: { method: 'GET', path: '/v2/library', auth: 'account', scopes: ['media:read'], query: AgentMediaQuery, response: MediaLibraryResponse, status: 200, idempotent: false, mcpTool: 'list_media' },
  getAgentMedia: { method: 'GET', path: '/v2/media/{id}', auth: 'account', scopes: ['media:read'], params: IdParams, response: MediaDetailResponse, status: 200, idempotent: false, mcpTool: 'get_media' },
  beginAgentUpload: { method: 'POST', path: '/v2/uploads', auth: 'account', scopes: ['media:write'], body: AgentUploadRequest, response: MediaUploadResponse, status: 201, idempotent: false, mcpTool: 'begin_upload' },
  completeAgentUpload: { method: 'POST', path: '/v2/uploads/{id}/complete', auth: 'account', scopes: ['media:write'], params: IdParams, body: CompleteMediaUploadRequest, response: MediaUploadResponse, status: 202, idempotent: false, mcpTool: 'complete_upload' },
  getAgentUpload: { method: 'GET', path: '/v2/uploads/{id}', auth: 'account', scopes: ['media:write'], params: IdParams, response: MediaUploadResponse, status: 200, idempotent: false },
  agentUploadParts: { method: 'POST', path: '/v2/uploads/{id}/parts', auth: 'account', scopes: ['media:write'], params: IdParams, body: UploadPartsRequest, response: MediaUploadResponse, status: 200, idempotent: false },
  abortAgentUpload: { method: 'DELETE', path: '/v2/uploads/{id}', auth: 'account', scopes: ['media:write'], params: IdParams, response: MediaUploadResponse, status: 202, idempotent: false },
  analyzeAgentMedia: { method: 'POST', path: '/v2/media/{id}/analysis', auth: 'account', scopes: ['media:analyze'], params: IdParams, body: AnalyzeMediaRequest, response: AgentAnalysisResponse, status: 202, idempotent: false, mcpTool: 'analyze_media' },
  getOperation: { method: 'GET', path: '/v2/operations/{id}', auth: 'account', scopes: [], params: IdParams, response: AgentOperationResponse, status: 200, idempotent: false, mcpTool: 'get_operation' },
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
