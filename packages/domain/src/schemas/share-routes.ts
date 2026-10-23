import { z } from 'zod';
import { IdParams, Uuid } from './common';
import * as S from './collection-shares';
import type { RouteContract } from './routes';

/**
 * Collection sharing REST contract. Owner routes are browser-owner only
 * ('owner': agents and share viewers are refused). Viewer routes
 * (/v2/shared/*) are served by a dedicated adapter with share-session
 * authentication and privacy headers, so they are 'public' here: the share
 * service performs the grant check on every call.
 */
export const SHARE_ROUTES = {
  listShares: { method: 'GET', path: '/v2/collections/{id}/shares', auth: 'owner', scopes: [], params: IdParams, response: S.ShareListResponse, status: 200, idempotent: false },
  createShare: { method: 'POST', path: '/v2/collections/{id}/shares', auth: 'owner', scopes: [], params: IdParams, body: S.CreateShareRequest, response: S.CreateShareResponse, status: 201, idempotent: true, oneTimeSecrets: ['link'] },
  updateShare: { method: 'PATCH', path: '/v2/shares/{id}', auth: 'owner', scopes: [], params: IdParams, body: S.UpdateShareRequest, response: S.UpdateShareResponse, status: 200, idempotent: false },
  revokeShare: { method: 'DELETE', path: '/v2/shares/{id}', auth: 'owner', scopes: [], params: IdParams, response: null, status: 204, idempotent: true },
  createShareInvitation: { method: 'POST', path: '/v2/shares/{id}/invitations', auth: 'owner', scopes: [], params: IdParams, body: S.CreateInvitationRequest, response: S.CreateInvitationResponse, status: 201, idempotent: true, oneTimeSecrets: ['link'] },
  acceptShareInvitation: { method: 'POST', path: '/v2/share-invitations/accept', auth: 'owner', scopes: [], body: S.AcceptInvitationRequest, response: S.AcceptInvitationResponse, status: 200, idempotent: false },
  redeemShare: { method: 'POST', path: '/v2/shared/redeem', auth: 'public', scopes: [], body: S.RedeemShareRequest, response: S.RedeemShareResponse, status: 200, idempotent: false },
  getSharedCollection: { method: 'GET', path: '/v2/shared/collection', auth: 'public', scopes: [], query: z.object({ share: Uuid.optional() }), response: S.SharedCollectionResponse, status: 200, idempotent: false },
  saveSharedItem: { method: 'POST', path: '/v2/shared/items/{id}/save', auth: 'owner', scopes: [], params: IdParams, query: z.object({ share: Uuid.optional() }), body: z.strictObject({ collection_id: Uuid.optional() }), response: S.SaveSharedItemResponse, status: 200, idempotent: true, extension: true },
} as const satisfies Record<string, RouteContract>;
