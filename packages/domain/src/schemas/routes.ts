import { z } from 'zod';
import type { Scope } from '../enums';
import * as A from './agent-connections';
import * as Auth from './auth';
import * as C from './collections';
import * as Cap from './captures';
import { IdParams, Uuid } from './common';
import * as D from './discoveries';
import * as I from './items';
import * as J from './jobs';
import * as P from './plans';
import * as Pref from './preferences';
import * as R from './references';
import * as S from './sensor-connections';
import * as T from './taste';
import * as Tr from './traces';
import * as U from './uploads';

/**
 * Machine-readable REST contract. apps/web route handlers, the MCP gateway,
 * docs and contract tests all derive from this table.
 *
 * auth:
 *   'any'     anonymous session, account session or agent bearer
 *   'account' account session or agent (anonymous -> 403 account_required)
 *   'owner'   account browser session only (agents -> 403)
 *   'demo'    demo owner/developer only
 *   'public'  no principal needed
 * scopes: required for agents (accounts implicitly hold all; anonymous holds ANONYMOUS_SCOPES).
 * body: zod schema, 'multipart', 'json_or_multipart', or undefined.
 */
export interface RouteContract {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  auth: 'any' | 'account' | 'owner' | 'demo' | 'public';
  scopes: readonly Scope[];
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType | 'multipart' | 'json_or_multipart';
  response: z.ZodType | null;
  status: 200 | 201 | 202 | 204;
  /** Accepts Idempotency-Key (all mutations do). */
  idempotent: boolean;
  /** Matching MCP tool name, if any. */
  mcpTool?: string;
  /** True for routes added beyond the spec REST table. */
  extension?: boolean;
}

const JobParams = z.object({ id: Uuid });

export const ROUTES = {
  getSession: { method: 'GET', path: '/v1/session', auth: 'public', scopes: [], response: Auth.SessionResponse, status: 200, idempotent: false, extension: true },
  createAccount: { method: 'POST', path: '/v1/accounts', auth: 'any', scopes: [], body: Auth.CreateAccountRequest, response: Auth.CreateAccountResponse, status: 201, idempotent: true, extension: true },
  createUpload: { method: 'POST', path: '/v1/uploads', auth: 'any', scopes: ['captures:write'], body: 'multipart', response: U.UploadResponse, status: 201, idempotent: true, extension: true },

  createCapture: { method: 'POST', path: '/v1/captures', auth: 'any', scopes: ['captures:write'], body: 'json_or_multipart', response: Cap.CreateCaptureResponse, status: 202, idempotent: true, mcpTool: 'analyze_capture' },
  getJob: { method: 'GET', path: '/v1/jobs/{id}', auth: 'any', scopes: [], params: JobParams, response: J.JobResponse, status: 200, idempotent: false, mcpTool: 'get_job' },
  getCapture: { method: 'GET', path: '/v1/captures/{id}', auth: 'any', scopes: ['captures:read'], params: IdParams, response: Cap.CaptureResponse, status: 200, idempotent: false, mcpTool: 'get_capture' },
  correctCapture: { method: 'POST', path: '/v1/captures/{id}/corrections', auth: 'any', scopes: ['captures:write'], params: IdParams, body: Cap.CorrectionRequest, response: Cap.CorrectionResponse, status: 202, idempotent: true },
  deleteCapture: { method: 'DELETE', path: '/v1/captures/{id}', auth: 'any', scopes: ['captures:write'], params: IdParams, response: null, status: 204, idempotent: true },
  getReference: { method: 'GET', path: '/v1/references/{id}', auth: 'any', scopes: [], params: IdParams, query: R.ReferenceQuery, response: R.ReferenceResponse, status: 200, idempotent: false, mcpTool: 'explore_reference' },
  recordPreference: { method: 'POST', path: '/v1/preferences', auth: 'any', scopes: ['taste:write'], body: Pref.PreferenceRequest, response: Pref.PreferenceResponse, status: 200, idempotent: true, mcpTool: 'record_preference' },
  listSaved: { method: 'GET', path: '/v1/saved', auth: 'any', scopes: ['taste:read'], query: Pref.SavedQuery, response: Pref.SavedListResponse, status: 200, idempotent: false },
  getDiscoveries: { method: 'GET', path: '/v1/discoveries', auth: 'any', scopes: ['taste:read'], query: D.DiscoveriesQuery, response: D.DiscoveriesResponse, status: 200, idempotent: false },
  getItem: { method: 'GET', path: '/v1/items/{id}', auth: 'any', scopes: [], params: IdParams, query: I.ItemQuery, response: I.ItemDetailResponse, status: 200, idempotent: false },
  discoverRelated: { method: 'POST', path: '/v1/items/{id}/discoveries', auth: 'any', scopes: [], params: IdParams, body: I.RelatedDiscoveryRequest, response: I.RelatedDiscoveryResponse, status: 202, idempotent: true, mcpTool: 'discover_related' },
  listCollections: { method: 'GET', path: '/v1/collections', auth: 'account', scopes: ['collections:read'], response: C.CollectionsListResponse, status: 200, idempotent: false, mcpTool: 'list_collections' },
  createCollection: { method: 'POST', path: '/v1/collections', auth: 'account', scopes: ['collections:write'], body: C.CreateCollectionRequest, response: C.CollectionSummary, status: 201, idempotent: true, mcpTool: 'create_collection' },
  getCollection: { method: 'GET', path: '/v1/collections/{id}', auth: 'account', scopes: ['collections:read'], params: IdParams, query: C.CollectionQuery, response: C.CollectionDetailResponse, status: 200, idempotent: false, mcpTool: 'get_collection' },
  updateCollection: { method: 'PATCH', path: '/v1/collections/{id}', auth: 'account', scopes: ['collections:write'], params: IdParams, body: C.UpdateCollectionRequest, response: C.CollectionSummary, status: 200, idempotent: true },
  deleteCollection: { method: 'DELETE', path: '/v1/collections/{id}', auth: 'account', scopes: ['collections:write'], params: IdParams, response: null, status: 204, idempotent: true },
  addCollectionItem: { method: 'PUT', path: '/v1/collections/{id}/items/{item_id}', auth: 'account', scopes: ['collections:write'], params: C.CollectionItemParams, body: C.AddCollectionItemRequest, response: C.AddCollectionItemResponse, status: 200, idempotent: true, mcpTool: 'add_collection_item' },
  removeCollectionItem: { method: 'DELETE', path: '/v1/collections/{id}/items/{item_id}', auth: 'account', scopes: ['collections:write'], params: C.CollectionItemParams, response: C.RemoveCollectionItemResponse, status: 200, idempotent: true, mcpTool: 'remove_collection_item' },
  reorderCollection: { method: 'PUT', path: '/v1/collections/{id}/order', auth: 'account', scopes: ['collections:write'], params: IdParams, body: C.ReorderCollectionRequest, response: C.ReorderCollectionResponse, status: 200, idempotent: true },
  getTaste: { method: 'GET', path: '/v1/taste', auth: 'any', scopes: ['taste:read'], query: T.TasteQuery, response: T.TasteResponse, status: 200, idempotent: false, mcpTool: 'get_taste' },
  listPlans: { method: 'GET', path: '/v1/plans', auth: 'account', scopes: ['plans:read'], query: P.PlansQuery, response: P.PlansListResponse, status: 200, idempotent: false, extension: true },
  createPlan: { method: 'POST', path: '/v1/plans', auth: 'account', scopes: ['plans:write', 'collections:read'], body: P.CreatePlanRequest, response: P.CreatePlanResponse, status: 202, idempotent: true, mcpTool: 'create_plan' },
  getPlan: { method: 'GET', path: '/v1/plans/{id}', auth: 'account', scopes: ['plans:read'], params: IdParams, response: P.PlanResponse, status: 200, idempotent: false, mcpTool: 'get_plan' },
  replacePlanSection: { method: 'POST', path: '/v1/plans/{id}/replacements', auth: 'account', scopes: ['plans:write'], params: IdParams, body: P.PlanReplacementRequest, response: P.PlanReplacementResponse, status: 202, idempotent: true, mcpTool: 'replace_plan_section' },
  deletePlan: { method: 'DELETE', path: '/v1/plans/{id}', auth: 'account', scopes: ['plans:write'], params: IdParams, response: null, status: 204, idempotent: true },
  listAgentConnections: { method: 'GET', path: '/v1/agent-connections', auth: 'owner', scopes: [], response: A.AgentConnectionsListResponse, status: 200, idempotent: false, extension: true },
  createAgentConnection: { method: 'POST', path: '/v1/agent-connections', auth: 'owner', scopes: [], body: A.CreateAgentConnectionRequest, response: A.CreateAgentConnectionResponse, status: 201, idempotent: true },
  revokeAgentConnection: { method: 'DELETE', path: '/v1/agent-connections/{id}', auth: 'owner', scopes: [], params: IdParams, response: null, status: 204, idempotent: true },
  listSensorConnections: { method: 'GET', path: '/v1/sensor-connections', auth: 'owner', scopes: [], response: S.SensorConnectionsListResponse, status: 200, idempotent: false, extension: true },
  // Not idempotent on purpose: a replay store would keep the shown-once bridge token in plaintext for 24 h.
  // A retried create is still safe: a second active connection to the same relay is a 409.
  createSensorConnection: { method: 'POST', path: '/v1/sensor-connections', auth: 'owner', scopes: [], body: S.CreateSensorConnectionRequest, response: S.CreateSensorConnectionResponse, status: 201, idempotent: false },
  deleteSensorConnection: { method: 'DELETE', path: '/v1/sensor-connections/{id}', auth: 'owner', scopes: [], params: IdParams, response: null, status: 204, idempotent: true },
  getTrace: { method: 'GET', path: '/v1/demo/traces/{job_id}', auth: 'demo', scopes: [], params: Tr.TraceParams, response: Tr.TraceResponse, status: 200, idempotent: false },
} as const satisfies Record<string, RouteContract>;

export type RouteName = keyof typeof ROUTES;
