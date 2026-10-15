import type { LibraryAccess, Scope } from './enums';

/** Anonymous visitor: isolated temporary session (24h). */
export interface AnonymousPrincipal {
  kind: 'anonymous';
  sessionId: string;
  expiresAt: Date;
}

/** Signed-in account using a browser session. Has every scope over its own data. */
export interface AccountPrincipal {
  kind: 'account';
  accountId: string;
  sessionId: string | null;
  isDemoOwner: boolean;
}

/** First-party native client, restricted to installation-specific v2 APIs. */
export interface InstallationPrincipal {
  kind: 'installation';
  accountId: string;
  installationId: string;
  sessionId: string;
  expiresAt: Date;
}

/**
 * Agent connection (bearer token). Acts for `accountId` limited by scopes and
 * library grant. `purpose: 'sensor_bridge'` is the restricted capture-write
 * token used by apps/sensor-bridge for exactly one sensor connection.
 */
export interface AgentPrincipal {
  kind: 'agent';
  accountId: string;
  connectionId: string;
  clientName: string;
  purpose: 'agent' | 'sensor_bridge';
  scopes: readonly Scope[];
  libraryAccess: LibraryAccess;
  /** Only meaningful when libraryAccess === 'selected_collections'. */
  allowedCollectionIds: readonly string[];
  sensorConnectionId: string | null;
  expiresAt: Date;
}

/** Worker / maintenance code acting outside a request. Never exposed over HTTP. */
export interface SystemPrincipal {
  kind: 'system';
  reason: string;
}

export type Principal = AnonymousPrincipal | AccountPrincipal | InstallationPrincipal | AgentPrincipal | SystemPrincipal;

/** Owner of a private record: one account or one anonymous session. */
export type Owner = { kind: 'account'; accountId: string } | { kind: 'session'; sessionId: string };

/** The owner whose data a principal acts on. Throws for system principals. */
export function ownerOf(principal: Principal): Owner {
  switch (principal.kind) {
    case 'anonymous':
      return { kind: 'session', sessionId: principal.sessionId };
    case 'account':
    case 'agent':
    case 'installation':
      return { kind: 'account', accountId: principal.accountId };
    case 'system':
      throw new Error('system principal has no owner');
  }
}

/** Column values for the (owner_account_id, owner_session_id) pair. */
export function ownerColumns(owner: Owner): { owner_account_id: string | null; owner_session_id: string | null } {
  return owner.kind === 'account'
    ? { owner_account_id: owner.accountId, owner_session_id: null }
    : { owner_account_id: null, owner_session_id: owner.sessionId };
}

/**
 * SQL predicate restricting `alias` to rows owned by `owner`.
 * Usage: const w = ownerPredicate(owner, 'c', 2); query(`... WHERE c.id = $1 AND ${w.sql}`, [id, ...w.params])
 */
export function ownerPredicate(
  owner: Owner,
  alias: string,
  firstParamIndex: number,
): { sql: string; params: string[] } {
  const prefix = alias ? `${alias}.` : '';
  return owner.kind === 'account'
    ? { sql: `${prefix}owner_account_id = $${firstParamIndex}`, params: [owner.accountId] }
    : { sql: `${prefix}owner_session_id = $${firstParamIndex}`, params: [owner.sessionId] };
}

/** Stable key used for idempotency scoping and rate-limit buckets. */
export function principalKey(principal: Principal): string {
  switch (principal.kind) {
    case 'anonymous':
      return `session:${principal.sessionId}`;
    case 'account':
      return `account:${principal.accountId}`;
    case 'agent':
      return `agent:${principal.connectionId}`;
    case 'installation':
      return `installation:${principal.accountId}:${principal.installationId}:${principal.sessionId}`;
    case 'system':
      return `system:${principal.reason}`;
  }
}

export const systemPrincipal = (reason: string): SystemPrincipal => ({ kind: 'system', reason });
