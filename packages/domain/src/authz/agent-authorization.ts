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

/** v1 mutations an owner should see in agent activity, by REST route path + method. */
const V1_ACTIVITY: Record<string, string> = {
  'POST /v1/uploads': 'captures.upload',
  'POST /v1/captures': 'captures.create',
  'POST /v1/captures/{id}/corrections': 'captures.correct',
  'DELETE /v1/captures/{id}': 'captures.delete',
  'POST /v1/preferences': 'preferences.record',
  'POST /v1/items/{id}/discoveries': 'items.discover_related',
  'POST /v1/collections': 'collections.create',
  'PATCH /v1/collections/{id}': 'collections.update',
  'DELETE /v1/collections/{id}': 'collections.delete',
  'PUT /v1/collections/{id}/items/{item_id}': 'collections.add_item',
  'DELETE /v1/collections/{id}/items/{item_id}': 'collections.remove_item',
  'PUT /v1/collections/{id}/order': 'collections.reorder',
  'POST /v1/plans': 'plans.create',
  'POST /v1/plans/{id}/replacements': 'plans.replace_section',
  'DELETE /v1/plans/{id}': 'plans.delete',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function firstId(...candidates: unknown[]): string | undefined {
  for (const c of candidates) if (typeof c === 'string' && UUID_RE.test(c)) return c;
  return undefined;
}

/**
 * Records a successful v1 (REST or MCP) agent mutation in agent_activity, so
 * the owner sees what an agent changed in their library. v2 services record
 * their own activity. Target: the collection when one is involved (so the
 * owner sees its name), else the plan, item or created record.
 */
export async function recordAgentMutation(
  ctx: ServiceContext,
  route: { method: string; path: string },
  input: { params?: unknown; body?: unknown; args?: unknown },
  result: unknown,
): Promise<void> {
  if (ctx.principal.kind !== 'agent' || ctx.principal.purpose !== 'agent') return;
  const action = V1_ACTIVITY[`${route.method} ${route.path}`];
  if (!action) return;
  const p = (input.params ?? {}) as Record<string, unknown>;
  const b = (input.body ?? {}) as Record<string, unknown>;
  const a = (input.args ?? {}) as Record<string, unknown>;
  const r = (result ?? {}) as Record<string, unknown>;
  const collectionScoped = route.path.startsWith('/v1/collections');
  const target = collectionScoped
    ? firstId(p.id, a.collection_id, r.id)
    : firstId(a.plan_id, a.collection_id, b.collection_id, r.plan_id, r.capture_id, r.upload_id, p.id, a.item_id, a.target_id, b.target_id, r.id);
  try {
    await agentActivity(ctx, action, target);
  } catch (err) {
    // Activity is an audit aid; it never fails the mutation that already committed.
    console.error('[agent-activity] could not record', action, err instanceof Error ? err.message : err);
  }
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
