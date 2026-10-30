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
import * as O from './onboarding';
import * as P from './plans';
import * as Pref from './preferences';
import * as IG from './interest-graph';
import * as R from './references';
import * as S from './sensor-connections';
import * as T from './taste';
import * as Tr from './traces';
import * as U from './uploads';
import * as AD from './account-deletion';
import { AGENT_ROUTES } from './agent-routes';
import { SHARE_ROUTES } from './share-routes';

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
  /**
   * Response fields that are shown once (bearer credentials, CSRF tokens). They
   * are never written to the idempotency replay store; replaying the same key
   * is refused with 409 instead of returning the secret again.
   */
  oneTimeSecrets?: readonly string[];
  /** Matching MCP tool name, if any. */
  mcpTool?: string;
  /** True for routes added beyond the spec REST table. */
  extension?: boolean;
}

const JobParams = z.object({ id: Uuid });

export const ROUTES = {
  ...AGENT_ROUTES,
  ...SHARE_ROUTES,
  getSession: { method: 'GET', path: '/v1/session', auth: 'public', scopes: [], response: Auth.SessionResponse, status: 200, idempotent: false, extension: true },
  createAccount: { method: 'POST', path: '/v1/accounts', auth: 'any', scopes: [], body: Auth.CreateAccountRequest, response: Auth.CreateAccountResponse, status: 201, idempotent: true, oneTimeSecrets: ['csrf_token'], extension: true },
  signIn: { method: 'POST', path: '/v1/session/sign-in', auth: 'any', scopes: [], body: Auth.SignInRequest, response: Auth.SignInResponse, status: 200, idempotent: false, extension: true },
  signOut: { method: 'POST', path: '/v1/session/sign-out', auth: 'any', scopes: [], body: Auth.SignOutRequest, response: Auth.SessionResponse, status: 200, idempotent: false, extension: true },
  createUpload: { method: 'POST', path: '/v1/uploads', auth: 'any', scopes: ['captures:write'], body: 'multipart', response: U.UploadResponse, status: 201, idempotent: true, extension: true },

  createCapture: { method: 'POST', path: '/v1/captures', auth: 'any', scopes: ['captures:write'], body: 'json_or_multipart', response: Cap.CreateCaptureResponse, status: 202, idempotent: true, mcpTool: 'analyze_capture' },
  listCaptures: { method: 'GET', path: '/v1/captures', auth: 'any', scopes: ['captures:read'], query: Cap.CapturesQuery, response: Cap.CapturesListResponse, status: 200, idempotent: false, mcpTool: 'list_captures', extension: true },
  getJob: { method: 'GET', path: '/v1/jobs/{id}', auth: 'any', scopes: [], params: JobParams, response: J.JobResponse, status: 200, idempotent: false, mcpTool: 'get_job' },
  getCapture: { method: 'GET', path: '/v1/captures/{id}', auth: 'any', scopes: ['captures:read'], params: IdParams, response: Cap.CaptureResponse, status: 200, idempotent: false, mcpTool: 'get_capture' },
  correctCapture: { method: 'POST', path: '/v1/captures/{id}/corrections', auth: 'any', scopes: ['captures:write'], params: IdParams, body: Cap.CorrectionRequest, response: Cap.CorrectionResponse, status: 202, idempotent: true },
  deleteCapture: { method: 'DELETE', path: '/v1/captures/{id}', auth: 'any', scopes: ['captures:write'], params: IdParams, response: null, status: 204, idempotent: true },
  getReference: { method: 'GET', path: '/v1/references/{id}', auth: 'any', scopes: [], params: IdParams, query: R.ReferenceQuery, response: R.ReferenceResponse, status: 200, idempotent: false, mcpTool: 'explore_reference' },
  recordPreference: { method: 'POST', path: '/v1/preferences', auth: 'any', scopes: ['taste:write'], body: Pref.PreferenceRequest, response: Pref.PreferenceResponse, status: 200, idempotent: true, mcpTool: 'record_preference' },
  listSaved: { method: 'GET', path: '/v1/saved', auth: 'any', scopes: ['taste:read'], query: Pref.SavedQuery, response: Pref.SavedListResponse, status: 200, idempotent: false, mcpTool: 'list_saved' },
  getDiscoveries: { method: 'GET', path: '/v1/discoveries', auth: 'any', scopes: ['taste:read'], query: D.DiscoveriesQuery, response: D.DiscoveriesResponse, status: 200, idempotent: false, mcpTool: 'get_discoveries' },
  getItem: { method: 'GET', path: '/v1/items/{id}', auth: 'any', scopes: [], params: IdParams, query: I.ItemQuery, response: I.ItemDetailResponse, status: 200, idempotent: false, mcpTool: 'get_item' },
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
  listPlans: { method: 'GET', path: '/v1/plans', auth: 'account', scopes: ['plans:read'], query: P.PlansQuery, response: P.PlansListResponse, status: 200, idempotent: false, extension: true, mcpTool: 'list_plans' },
  createPlan: { method: 'POST', path: '/v1/plans', auth: 'account', scopes: ['plans:write', 'collections:read'], body: P.CreatePlanRequest, response: P.CreatePlanResponse, status: 202, idempotent: true, mcpTool: 'create_plan' },
  getPlan: { method: 'GET', path: '/v1/plans/{id}', auth: 'account', scopes: ['plans:read'], params: IdParams, response: P.PlanResponse, status: 200, idempotent: false, mcpTool: 'get_plan' },
  replacePlanSection: { method: 'POST', path: '/v1/plans/{id}/replacements', auth: 'account', scopes: ['plans:write'], params: IdParams, body: P.PlanReplacementRequest, response: P.PlanReplacementResponse, status: 202, idempotent: true, mcpTool: 'replace_plan_section' },
  deletePlan: { method: 'DELETE', path: '/v1/plans/{id}', auth: 'account', scopes: ['plans:write'], params: IdParams, response: null, status: 204, idempotent: true },
  listAgentConnections: { method: 'GET', path: '/v1/agent-connections', auth: 'owner', scopes: [], response: A.AgentConnectionsListResponse, status: 200, idempotent: false, extension: true },
  createAgentConnection: { method: 'POST', path: '/v1/agent-connections', auth: 'owner', scopes: [], body: A.CreateAgentConnectionRequest, response: A.CreateAgentConnectionResponse, status: 201, idempotent: true, oneTimeSecrets: ['credential'] },
  revokeAgentConnection: { method: 'DELETE', path: '/v1/agent-connections/{id}', auth: 'owner', scopes: [], params: IdParams, response: null, status: 204, idempotent: true },
  updateAgentConnection: { method: 'PATCH', path: '/v1/agent-connections/{id}', auth: 'owner', scopes: [], params: IdParams, body: A.UpdateAgentConnectionRequest, response: A.AgentConnectionDto, status: 200, idempotent: true, extension: true },
  listSensorConnections: { method: 'GET', path: '/v1/sensor-connections', auth: 'owner', scopes: [], response: S.SensorConnectionsListResponse, status: 200, idempotent: false, extension: true },
  // Not idempotent on purpose: a replay store would keep the shown-once bridge token in plaintext for 24 h.
  // A retried create is still safe: a second active connection to the same relay is a 409.
  createSensorConnection: { method: 'POST', path: '/v1/sensor-connections', auth: 'owner', scopes: [], body: S.CreateSensorConnectionRequest, response: S.CreateSensorConnectionResponse, status: 201, idempotent: false },
  deleteSensorConnection: { method: 'DELETE', path: '/v1/sensor-connections/{id}', auth: 'owner', scopes: [], params: IdParams, response: null, status: 204, idempotent: true },
  getTrace: { method: 'GET', path: '/v1/demo/traces/{job_id}', auth: 'demo', scopes: [], params: Tr.TraceParams, response: Tr.TraceResponse, status: 200, idempotent: false },

  // Taste onboarding (spec amendment 2.2, schemas/onboarding.ts). The questionnaire
  // is the account owner's own sign-up step: browser account sessions only, never
  // agents or anonymous visitors. Picks are explicit saves (taste); exclusions are
  // preferences. Feature flag onboarding_required gates whether it blocks the feed.
  getOnboardingCatalog: { method: 'GET', path: '/v1/onboarding/catalog', auth: 'owner', scopes: [], response: O.OnboardingCatalogResponse, status: 200, idempotent: false, extension: true },
  searchOnboarding: { method: 'GET', path: '/v1/onboarding/search', auth: 'owner', scopes: [], query: O.OnboardingSearchQuery, response: O.OnboardingSearchResponse, status: 200, idempotent: false, extension: true },
  createOnboardingPick: { method: 'POST', path: '/v1/onboarding/picks', auth: 'owner', scopes: [], body: O.CreatePickRequest, response: O.CreatePickResponse, status: 201, idempotent: true, extension: true },
  deleteOnboardingPick: { method: 'DELETE', path: '/v1/onboarding/picks/{id}', auth: 'owner', scopes: [], params: O.PickParams, response: O.DeletePickResponse, status: 200, idempotent: true, extension: true },
  putOnboardingExclusions: { method: 'PUT', path: '/v1/onboarding/exclusions', auth: 'owner', scopes: [], body: O.PutExclusionsRequest, response: O.ExclusionsResponse, status: 200, idempotent: true, extension: true },
  completeOnboarding: { method: 'POST', path: '/v1/onboarding/complete', auth: 'owner', scopes: [], body: O.CompleteOnboardingRequest, response: O.CompleteOnboardingResponse, status: 200, idempotent: true, extension: true },
  getOnboardingState: { method: 'GET', path: '/v1/onboarding/state', auth: 'owner', scopes: [], response: O.OnboardingStateResponse, status: 200, idempotent: false, extension: true },
  getOnboardingSeed: { method: 'GET', path: '/v1/onboarding/seed', auth: 'owner', scopes: [], response: O.TasteSeedStatus, status: 200, idempotent: false, extension: true },
  // Settings -> Taste (screen 18). Reading picks is taste:read under the existing
  // grant rules (selected-collection agents: whole-library access only); changing
  // them stays with the owner. Removing below the minimum is allowed here.
  listTastePicks: { method: 'GET', path: '/v1/taste/picks', auth: 'account', scopes: ['taste:read'], response: O.TastePicksResponse, status: 200, idempotent: false, extension: true },
  createTastePick: { method: 'POST', path: '/v1/taste/picks', auth: 'owner', scopes: [], body: O.CreatePickRequest, response: O.CreatePickResponse, status: 201, idempotent: true, extension: true },
  deleteTastePick: { method: 'DELETE', path: '/v1/taste/picks/{id}', auth: 'owner', scopes: [], params: O.PickParams, response: O.DeletePickResponse, status: 200, idempotent: true, extension: true },

  // Typed owner/native interest-graph controls (PR 8 package E; VAL-API-001).
  // Browser owner sessions and the four explicitly bridged native graph
  // operations only (authz/native-owner.ts): agents gain no graph authority,
  // there is no account id to name, and the mutations share one optimistic
  // revision. No MCP tools: agents keep their existing operation matrix.
  getMyInterestGraph: { method: 'GET', path: '/v2/me/interest-graph', auth: 'owner', scopes: [], query: IG.InterestGraphQuery, response: IG.InterestGraphSummaryResponse, status: 200, idempotent: false, extension: true },
  updateMyInterestGraphSettings: { method: 'PATCH', path: '/v2/me/interest-graph/settings', auth: 'owner', scopes: [], body: IG.UpdateInterestGraphSettingsRequest, response: IG.UpdateInterestGraphSettingsResponse, status: 200, idempotent: true, extension: true },
  updateMyInterestGraphInterest: { method: 'PATCH', path: '/v2/me/interest-graph/interests/{id}', auth: 'owner', scopes: [], params: IG.InterestGraphIdParams, body: IG.UpdateInterestGraphInterestRequest, response: IG.UpdateInterestGraphInterestResponse, status: 200, idempotent: true, extension: true },
  getMyRecommendationConnection: { method: 'GET', path: '/v2/me/recommendations/{id}/connection', auth: 'owner', scopes: [], params: IdParams, response: IG.RecommendationConnectionResponse, status: 200, idempotent: false, extension: true },

  // Account deletion lifecycle (VAL-DELETE-002/004). Owner operations: the
  // browser owner session or the owner's enrolled native phone (the v2
  // account-operation bridge), never agents. The acceptance transaction
  // revokes every credential and cancels every producer; the response's
  // status_token is the ONLY credential that keeps answering afterwards,
  // on the public status route below, and it restores no authority. No MCP
  // tools: agents never gain deletion authority.
  getMyAccountDeletion: { method: 'GET', path: '/v2/me/account-deletion', auth: 'owner', scopes: [], response: AD.AccountDeletionOverviewResponse, status: 200, idempotent: false, extension: true },
  // The shown-once status token is never stored in the idempotency replay
  // store (oneTimeSecrets); a retried acceptance returns the same durable
  // status without re-running or restoring anything.
  requestMyAccountDeletion: { method: 'POST', path: '/v2/me/account-deletion', auth: 'owner', scopes: [], body: AD.RequestAccountDeletionRequest, response: AD.RequestAccountDeletionResponse, status: 200, idempotent: true, oneTimeSecrets: ['status_token'], extension: true },
  // Capability-token gated public status: the token's hash answers the honest
  // lifecycle snapshot after every session, installation and agent token is
  // revoked. A wrong or missing token is a plain not_found (nothing disclosed).
  getAccountDeletionStatus: { method: 'GET', path: '/v2/account-deletion/status', auth: 'public', scopes: [], response: AD.AccountDeletionStatusResponse, status: 200, idempotent: false, extension: true },
} as const satisfies Record<string, RouteContract>;

export type RouteName = keyof typeof ROUTES;
