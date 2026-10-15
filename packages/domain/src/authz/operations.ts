import type { Scope } from '../enums';
import { AppError } from '../errors';
import type { Principal } from '../principal';
import { requireAccount, requireAccountOwner, requireScopes } from './index';

/**
 * Operation-level authorization shared by every surface.
 *
 * REST (`apps/web/lib/server/http.ts#apiRoute`) and MCP
 * (`packages/agent-gateway/src/server.ts`) both call `authorizeOperation`
 * with the same route contract (`ROUTES[...]`, which records the matching MCP
 * tool), so a token that is refused on one surface is refused on the other with
 * the same error code. This is the fast pre-check; services repeat the scope
 * checks and additionally constrain every query by owner and CURRENT grant
 * (see `authz/index.ts` and `library/access.ts`).
 */

/** Minimal shape of a route contract that authorization needs (RouteContract satisfies it). */
export interface OperationPolicy {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /**
   * 'any'     anonymous session, account session or agent bearer
   * 'account' account session or agent (anonymous -> 403 account_required)
   * 'owner'   account browser session only (agents -> 403 scope_denied)
   * 'demo'    account browser session only; the service then requires a demo owner (else 404)
   * 'public'  no principal needed
   */
  auth: 'any' | 'account' | 'owner' | 'demo' | 'public';
  scopes: readonly Scope[];
}

export type Surface = 'rest' | 'mcp';

/** The only REST operations the restricted sensor-bridge token may call. */
export const SENSOR_BRIDGE_OPERATIONS: ReadonlySet<string> = new Set([
  'POST /v1/uploads',
  'POST /v1/captures',
  'GET /v1/jobs/{id}',
]);

export const operationKey = (op: Pick<OperationPolicy, 'method' | 'path'>): string => `${op.method} ${op.path}`;

/**
 * Throws the spec error for a principal that may not call this operation:
 *  - sensor-bridge tokens: only SENSOR_BRIDGE_OPERATIONS over REST, nothing over MCP (scope_denied);
 *  - auth level (account_required / scope_denied / unauthenticated);
 *  - required scopes (scope_denied with missing_scopes, account_required for anonymous).
 */
export function authorizeOperation(principal: Principal, op: OperationPolicy, surface: Surface = 'rest'): void {
  if (principal.kind === 'system') throw new AppError('unauthenticated');
  // Native installation policy belongs to v2; never inherit browser/v1 authority.
  if (principal.kind === 'installation') throw new AppError('scope_denied');
  if (principal.kind === 'agent' && principal.purpose === 'sensor_bridge') {
    if (surface !== 'rest' || !SENSOR_BRIDGE_OPERATIONS.has(operationKey(op))) {
      throw new AppError('scope_denied', { message: 'This connection may only import sensor photos.' });
    }
  }
  switch (op.auth) {
    case 'public':
      return;
    case 'any':
      break;
    case 'account':
      requireAccount(principal);
      break;
    case 'owner':
    case 'demo':
      requireAccountOwner(principal);
      break;
  }
  if (op.scopes.length > 0) requireScopes(principal, ...op.scopes);
}

/** Agent principals only (MCP never serves browser sessions or anonymous visitors). */
export function requireAgentConnection(principal: Principal | null): asserts principal is Extract<Principal, { kind: 'agent' }> {
  if (!principal || principal.kind !== 'agent') {
    throw new AppError('unauthenticated', { message: 'Use an agent connection token (Authorization: Bearer cat_...).' });
  }
}
