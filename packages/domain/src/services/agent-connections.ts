import { requireAccountOwner } from '../authz';
import { describeConnectionAccess } from '../authz/connection-access';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { SCOPES, type LibraryAccess, type Scope } from '../enums';
import { AppError } from '../errors';
import type {
  AgentConnectionDto,
  AgentConnectionsListResponse,
  CreateAgentConnectionRequest,
  CreateAgentConnectionResponse,
  UpdateAgentConnectionRequest,
} from '../schemas/agent-connections';
import { addDays, iso } from '../util/time';
import { generateAgentCredential } from './auth';

/**
 * Agent connections (account owner, browser session only: requireAccountOwner).
 *
 *  - The credential ("cat_<prefix>_<secret>") is returned exactly once by
 *    create; only its sha256 and display prefix are stored.
 *  - Every connection expires (1-90 days, default 30) and can be revoked;
 *    auth.resolvePrincipal rejects revoked/expired tokens on the very next
 *    call (REST and MCP alike).
 *  - selected_collections grants are rows in agent_connection_collections and
 *    must reference collections the owner owns (unknown/foreign ids -> 404).
 *    New collections never join a selected grant automatically. Collection
 *    deletion cascades the grant row away.
 *  - Sensor-bridge tokens (purpose 'sensor_bridge') are managed by sensor
 *    connections and are not listed or editable here.
 */

interface ConnectionRow {
  id: string;
  client_name: string;
  scopes: Scope[];
  library_access: LibraryAccess;
  credential_prefix: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  collection_ids: string[] | null;
  collection_names: string[] | null;
  installation_ids: string[];
  authorization_version: number;
}

const SELECT_CONNECTION = `
  SELECT ac.id, ac.client_name, ac.scopes, ac.library_access, ac.credential_prefix, ac.created_at,
         ac.expires_at, ac.revoked_at, ac.last_used_at, ac.installation_ids, ac.authorization_version,
         ARRAY(SELECT acc.collection_id FROM agent_connection_collections acc
                 JOIN collections c ON c.id = acc.collection_id
                WHERE acc.agent_connection_id = ac.id ORDER BY acc.granted_at, c.name) AS collection_ids,
         ARRAY(SELECT c.name FROM agent_connection_collections acc
                 JOIN collections c ON c.id = acc.collection_id
                WHERE acc.agent_connection_id = ac.id ORDER BY acc.granted_at, c.name) AS collection_names
    FROM agent_connections ac`;

/** Order scopes canonically and drop duplicates. */
export function normalizeScopes(scopes: readonly Scope[]): Scope[] {
  const set = new Set(scopes);
  return SCOPES.filter((s) => set.has(s));
}

function toDto(row: ConnectionRow, now: Date): AgentConnectionDto {
  const status = row.revoked_at ? 'revoked' : row.expires_at <= now ? 'expired' : 'active';
  return {
    id: row.id,
    client_name: row.client_name,
    scopes: normalizeScopes(row.scopes),
    library_access: row.library_access,
    collection_ids: row.collection_ids ?? [],
    installation_ids: row.installation_ids ?? [],
    authorization_version: row.authorization_version,
    credential_prefix: `cat_${row.credential_prefix}_…`,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    revoked_at: iso(row.revoked_at),
    last_used_at: iso(row.last_used_at),
    status,
    access_summary: describeConnectionAccess(row.scopes, row.library_access, row.collection_names ?? []),
  };
}

async function loadConnection(db: Queryable, accountId: string, id: string, lock = false): Promise<ConnectionRow> {
  const { rows } = await db.query<ConnectionRow>(
    `${SELECT_CONNECTION} WHERE ac.id = $1 AND ac.owner_account_id = $2 AND ac.purpose = 'agent'${lock ? ' FOR UPDATE OF ac' : ''}`,
    [id, accountId],
  );
  if (!rows[0]) throw new AppError('not_found');
  return rows[0];
}

/** Every id must be a collection owned by the account; otherwise 404 (never reveal foreign ids). */
async function assertOwnedCollections(db: Queryable, accountId: string, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return unique;
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM collections WHERE owner_account_id = $1 AND id = ANY($2::uuid[])',
    [accountId, unique],
  );
  if (rows.length !== unique.length) {
    throw new AppError('not_found', { message: 'One or more collections were not found.' });
  }
  return unique;
}

/** GET /v1/agent-connections — the owner's personal agent connections, newest first. */
export async function listAgentConnections(ctx: ServiceContext): Promise<AgentConnectionsListResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const { rows } = await ctx.db.query<ConnectionRow>(
    `${SELECT_CONNECTION} WHERE ac.owner_account_id = $1 AND ac.purpose = 'agent' ORDER BY ac.created_at DESC, ac.id`,
    [owner.accountId],
  );
  const now = ctx.now();
  return { connections: rows.map((r) => toDto(r, now)) };
}

/** POST /v1/agent-connections (201). The credential is shown once and never stored in clear. */
export async function createAgentConnection(
  ctx: ServiceContext,
  body: CreateAgentConnectionRequest,
): Promise<CreateAgentConnectionResponse> {
  const owner = requireAccountOwner(ctx.principal);
  const scopes = normalizeScopes(body.scopes);
  if (scopes.length === 0) throw new AppError('invalid_input', { message: 'Choose at least one permission.' });
  const now = ctx.now();
  const cred = generateAgentCredential();
  const expiresAt = addDays(now, body.expires_in_days);

  const id = await ctx.db.transaction(async (tx) => {
    const collectionIds =
      body.library_access === 'selected_collections' ? await assertOwnedCollections(tx, owner.accountId, body.collection_ids) : [];
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO agent_connections (owner_account_id, client_name, purpose, credential_hash, credential_prefix,
                                      scopes, library_access, expires_at, created_at)
       VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [owner.accountId, body.client_name, cred.hash, cred.prefix, scopes, body.library_access, expiresAt, now],
    );
    const connectionId = rows[0]!.id;
    for (const cid of collectionIds) {
      await tx.query(
        'INSERT INTO agent_connection_collections (agent_connection_id, collection_id, granted_at) VALUES ($1, $2, $3)',
        [connectionId, cid, now],
      );
    }
    return connectionId;
  });

  const row = await loadConnection(ctx.db, owner.accountId, id);
  return {
    connection: toDto(row, now),
    credential: cred.credential,
    mcp_url: `${ctx.config.APP_BASE_URL.replace(/\/+$/, '')}/mcp`,
  };
}

/**
 * PATCH /v1/agent-connections/{id} (extension) — rename, or replace the
 * collection grant of a selected_collections connection. Narrowing applies to
 * the agent's next call because every request re-reads the grant.
 */
export async function updateAgentConnection(
  ctx: ServiceContext,
  input: { id: string; body: UpdateAgentConnectionRequest },
): Promise<AgentConnectionDto> {
  const owner = requireAccountOwner(ctx.principal);
  await ctx.db.transaction(async (tx) => {
    const row = await loadConnection(tx, owner.accountId, input.id, true);
    if (row.revoked_at) throw new AppError('conflict', { message: 'This connection was revoked.' });
    if (input.body.client_name !== undefined) {
      await tx.query('UPDATE agent_connections SET client_name = $2 WHERE id = $1', [row.id, input.body.client_name]);
    }
    if (input.body.collection_ids !== undefined) {
      if (row.library_access !== 'selected_collections') {
        throw new AppError('invalid_input', { message: 'Only connections limited to selected collections have a collection list.' });
      }
      const ids = await assertOwnedCollections(tx, owner.accountId, input.body.collection_ids);
      await tx.query(
        'DELETE FROM agent_connection_collections WHERE agent_connection_id = $1 AND NOT (collection_id = ANY($2::uuid[]))',
        [row.id, ids],
      );
      for (const cid of ids) {
        await tx.query(
          `INSERT INTO agent_connection_collections (agent_connection_id, collection_id, granted_at)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [row.id, cid, ctx.now()],
        );
      }
    }
  });
  return toDto(await loadConnection(ctx.db, owner.accountId, input.id), ctx.now());
}

/** DELETE /v1/agent-connections/{id} — revoke immediately (idempotent for the owner; 404 otherwise). */
export async function revokeAgentConnection(ctx: ServiceContext, input: { id: string }): Promise<void> {
  const owner = requireAccountOwner(ctx.principal);
  const { rowCount } = await ctx.db.query(
    `UPDATE agent_connections SET revoked_at = COALESCE(revoked_at, $3)
      WHERE id = $1 AND owner_account_id = $2 AND purpose = 'agent'`,
    [input.id, owner.accountId, ctx.now()],
  );
  if (!rowCount) throw new AppError('not_found');
}
