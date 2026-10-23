import { requireAccount, requireNotSensorBridge, requireScopes } from './index';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import type { Scope } from '../enums';
import { AppError } from '../errors';
import { requireServiceFeature } from '../flags/feature-flags';
import type { AgentPrincipal } from '../principal';

/**
 * Live authorization boundary for every v2 adapter and asynchronous checkpoint.
 * A persisted principal is a reference, never a cached grant. Re-read scopes,
 * collections, devices and authorization version before dispatch/publication.
 */
export async function authorizeAgent(
  ctx: ServiceContext,
  scope: Scope,
  db: Queryable = ctx.db,
): Promise<ServiceContext> {
  requireAccount(ctx.principal);
  requireNotSensorBridge(ctx.principal);
  let principal = ctx.principal;
  if (principal.kind === 'agent') {
    const { rows } = await db.query<{
      scopes: Scope[]; library_access: AgentPrincipal['libraryAccess']; installation_ids: string[];
      authorization_version: number; expires_at: Date; revoked_at: Date | null; collection_ids: string[];
    }>(
      `SELECT ac.*, ARRAY(SELECT collection_id FROM agent_connection_collections
        WHERE agent_connection_id=ac.id) AS collection_ids FROM agent_connections ac
        WHERE ac.id=$1 AND ac.owner_account_id=$2 AND ac.purpose='agent'`,
      [principal.connectionId, principal.accountId],
    );
    const row = rows[0];
    if (!row || row.revoked_at) throw new AppError('token_revoked');
    if (row.expires_at <= ctx.now()) throw new AppError('token_expired');
    if (principal.authorizationVersion !== undefined && principal.authorizationVersion !== row.authorization_version) {
      throw new AppError('token_revoked');
    }
    principal = {
      ...principal, scopes: row.scopes, libraryAccess: row.library_access,
      allowedCollectionIds: row.collection_ids, allowedInstallationIds: row.installation_ids,
      authorizationVersion: row.authorization_version, expiresAt: row.expires_at,
    };
  }
  requireScopes(principal, scope);
  return { ...ctx, principal };
}

export async function agentActivity(ctx: ServiceContext, action: string, targetId?: string, db: Queryable = ctx.db) {
  if (ctx.principal.kind !== 'agent') return;
  await db.query(
    'INSERT INTO agent_activity(account_id,connection_id,action,target_id,created_at) VALUES($1,$2,$3,$4,$5)',
    [ctx.principal.accountId, ctx.principal.connectionId, action, targetId ?? null, ctx.now()],
  );
}

/**
 * agent_api_enabled is enforced on every agent request (REST v1/v2, MCP,
 * media gateway, events), so an operator kill stops agent access during an
 * incident without a deploy. Grants are never deleted. The World Observer
 * sensor bridge (purpose sensor_bridge) is not an agent API client.
 */
export async function enforceAgentAccess(ctx: ServiceContext): Promise<void> {
  if (ctx.principal.kind !== 'agent' || ctx.principal.purpose !== 'agent') return;
  await requireServiceFeature(ctx, ctx.principal.accountId, 'agent_api_enabled');
}

/** Agent API gate plus the per-connection request budget. */
export async function enforceAgentRequest(ctx: ServiceContext, mutation: boolean): Promise<void> {
  await enforceAgentAccess(ctx);
  await enforceAgentRate(ctx, mutation);
}

export async function enforceAgentRate(ctx: ServiceContext, mutation: boolean) {
  if (ctx.principal.kind !== 'agent') return;
  const minute = new Date(Math.floor(ctx.now().getTime() / 60_000) * 60_000);
  const { rows } = await ctx.db.query<{ count: number }>(
    `INSERT INTO agent_rate_windows(connection_id,window_at,mutation,count) VALUES($1,$2,$3,1)
     ON CONFLICT(connection_id,window_at,mutation) DO UPDATE SET count=agent_rate_windows.count+1 RETURNING count`,
    [ctx.principal.connectionId, minute, mutation],
  );
  if (rows[0]!.count > (mutation ? 10 : 60)) throw new AppError('rate_limited', { retryAfter: 60 });
}
