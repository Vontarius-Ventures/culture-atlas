import { SCOPES, type Scope } from '../enums';
import { AppError } from '../errors';
import type { AccountPrincipal, AgentPrincipal, Principal } from '../principal';

/**
 * Pure authorization checks shared by REST, MCP and the web UI. Services call
 * these first, then additionally constrain SQL by owner (ownerPredicate) and,
 * for agents, by collection grant. Ownership failures are always 404 (never
 * reveal that a private record exists); missing scopes are 403.
 */

/** Scopes an anonymous session implicitly holds over its own temporary records. */
export const ANONYMOUS_SCOPES: readonly Scope[] = [
  'captures:read',
  'captures:write',
  'taste:read',
  'taste:write',
];

export function effectiveScopes(principal: Principal): readonly Scope[] {
  switch (principal.kind) {
    case 'account':
    case 'system':
      return SCOPES;
    case 'anonymous':
      return ANONYMOUS_SCOPES;
    case 'agent':
      return principal.scopes;
  }
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return effectiveScopes(principal).includes(scope);
}

/**
 * Require all scopes. Anonymous sessions get `account_required` (UI prompts
 * account creation); agents get `scope_denied`.
 */
export function requireScopes(principal: Principal, ...scopes: Scope[]): void {
  const missing = scopes.filter((s) => !hasScope(principal, s));
  if (missing.length === 0) return;
  if (principal.kind === 'anonymous') throw new AppError('account_required');
  throw new AppError('scope_denied', { details: { missing_scopes: missing } });
}

/** Account principal (browser) or agent acting for an account. Rejects anonymous. */
export function requireAccount(principal: Principal): AccountPrincipal | AgentPrincipal {
  if (principal.kind === 'account' || principal.kind === 'agent') return principal;
  if (principal.kind === 'anonymous') throw new AppError('account_required');
  throw new AppError('unauthenticated');
}

/**
 * Account owner acting in the browser. Agent and sensor connection management
 * is never available to agents or anonymous sessions.
 */
export function requireAccountOwner(principal: Principal): AccountPrincipal {
  if (principal.kind === 'account') return principal;
  if (principal.kind === 'anonymous') throw new AppError('account_required');
  if (principal.kind === 'agent') throw new AppError('scope_denied');
  throw new AppError('unauthenticated');
}

/** True when the principal can see the whole library (unfiled saves, global taste, global feed). */
export function hasWholeLibrary(principal: Principal): boolean {
  switch (principal.kind) {
    case 'account':
    case 'anonymous':
    case 'system':
      return true;
    case 'agent':
      return principal.libraryAccess === 'all';
  }
}

/**
 * Global unsave, global hide/unhide, capture deletion, global feed and global
 * taste require whole-library access for agents.
 */
export function requireWholeLibrary(principal: Principal): void {
  if (!hasWholeLibrary(principal)) {
    throw new AppError('scope_denied', {
      message: 'This connection only has access to selected collections.',
    });
  }
}

/**
 * Whether the principal's grant covers a collection. Does NOT check ownership
 * (services must still constrain SQL by owner).
 */
export function collectionGranted(principal: Principal, collectionId: string): boolean {
  if (principal.kind !== 'agent') return true;
  if (principal.libraryAccess === 'all') return true;
  if (principal.libraryAccess === 'selected_collections') {
    return principal.allowedCollectionIds.includes(collectionId);
  }
  return false;
}

/** Throws not_found (not 403) so ungranted collections are indistinguishable from missing ones. */
export function requireCollectionGrant(principal: Principal, collectionId: string): void {
  if (!collectionGranted(principal, collectionId)) throw new AppError('not_found');
}

/**
 * Collection ids an agent may read, or null meaning "all owned collections".
 * Services filter list/read queries with this.
 */
export function grantedCollectionFilter(principal: Principal): readonly string[] | null {
  if (principal.kind !== 'agent' || principal.libraryAccess === 'all') return null;
  if (principal.libraryAccess === 'selected_collections') return principal.allowedCollectionIds;
  return [];
}

/**
 * Agents may create a collection only with collections:write AND whole-library access.
 */
export function requireCanCreateCollection(principal: Principal): void {
  requireAccount(principal);
  requireScopes(principal, 'collections:write');
  requireWholeLibrary(principal);
}

/** Scope of a taste read: global, or limited to one collection (selected-collection agents). */
export type TasteScope = { kind: 'global' } | { kind: 'collection'; collectionId: string };

export function resolveTasteScope(principal: Principal, collectionId?: string): TasteScope {
  requireScopes(principal, 'taste:read');
  if (collectionId) {
    requireCollectionGrant(principal, collectionId);
    return { kind: 'collection', collectionId };
  }
  if (!hasWholeLibrary(principal)) {
    throw new AppError('scope_denied', {
      message: 'This connection must request taste for a granted collection.',
    });
  }
  return { kind: 'global' };
}

/**
 * Operation-level authorization used by BOTH the REST middleware and the MCP
 * gateway (same contract, same error codes), plus the connection-access
 * summary shown during agent connection setup.
 */
export * from './operations';
export * from './connection-access';

/** The sensor-bridge token may only create captures for its own sensor connection. */
export function requireNotSensorBridge(principal: Principal): void {
  if (principal.kind === 'agent' && principal.purpose === 'sensor_bridge') {
    throw new AppError('scope_denied');
  }
}
