import type { Queryable } from '../db/pool';
import type { Scope } from '../enums';
import { AppError } from '../errors';
import type { AgentPrincipal } from '../principal';
import type { CaptureAgentAuthorization, CaptureAgentOperation } from '../capture-v2/types';
import { mediaGrantPredicate } from './agent-resources';

/**
 * Production CaptureAgentAuthorization (gap G5). The capture-v2 deep modules
 * call this at every agent checkpoint: request time (HTTP/MCP façade), queued
 * work (verify/prepare/analyze in the worker) and command delivery. It never
 * trusts a cached grant: the connection row, its scopes, collection grant,
 * selected installations and authorization version are re-read each call.
 *
 * Fails closed: unknown operations, revoked/expired connections, version
 * changes (narrowing, rotation) and resources outside the live grant all
 * throw. Resource failures are `not_found` so they are indistinguishable from
 * missing records; missing scopes are `scope_denied`.
 */

const OPERATION_SCOPES: Record<CaptureAgentOperation, Scope> = {
  'upload.create': 'media:write',
  'upload.read': 'media:write',
  'upload.part': 'media:write',
  'upload.complete': 'media:write',
  'upload.abort': 'media:write',
  'media.read': 'media:read',
  'media.download': 'media:download',
  'media.delete': 'media:write',
  'media.update': 'media:write',
  'media.prepare': 'media:write',
  'media.analyze': 'media:analyze',
  'analysis.read': 'media:read',
  'command.create': 'devices:command',
  'command.claim': 'devices:command',
};

interface ConnectionRow {
  scopes: Scope[];
  library_access: AgentPrincipal['libraryAccess'];
  installation_ids: string[];
  authorization_version: number;
  expires_at: Date;
  revoked_at: Date | null;
  collection_ids: string[];
}

async function liveConnection(db: Queryable, accountId: string, connectionId: string): Promise<ConnectionRow> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT ac.scopes, ac.library_access, ac.installation_ids, ac.authorization_version, ac.expires_at, ac.revoked_at,
            ARRAY(SELECT collection_id FROM agent_connection_collections WHERE agent_connection_id = ac.id) AS collection_ids
       FROM agent_connections ac
      WHERE ac.id = $1 AND ac.owner_account_id = $2 AND ac.purpose = 'agent'`,
    [connectionId, accountId],
  );
  const row = rows[0];
  if (!row || row.revoked_at) throw new AppError('token_revoked');
  if (row.expires_at <= new Date()) throw new AppError('token_expired');
  return row;
}

async function mediaVisible(db: Queryable, accountId: string, connectionId: string, row: ConnectionRow, assetId: string, createdOnly: boolean) {
  const principal = {
    kind: 'agent', accountId, connectionId, libraryAccess: row.library_access, allowedCollectionIds: row.collection_ids,
  } as unknown as AgentPrincipal;
  const grant = mediaGrantPredicate(principal, 4);
  const { rows } = await db.query(
    `SELECT 1 FROM media_assets m WHERE m.id = $1 AND m.account_id = $2 AND m.deleted_at IS NULL
        AND (${createdOnly ? 'FALSE' : grant.sql} OR m.created_by_agent_connection_id = $3)`,
    [assetId, accountId, connectionId, ...grant.params],
  );
  return rows.length > 0;
}

export const captureAgentAuthorization: CaptureAgentAuthorization = {
  async authorize(db, input) {
    const scope = OPERATION_SCOPES[input.operation];
    if (!scope) throw new AppError('scope_denied');
    const row = await liveConnection(db, input.accountId, input.connectionId);
    if (input.authorizationVersion !== undefined && input.authorizationVersion !== row.authorization_version) {
      throw new AppError('token_revoked');
    }
    if (!row.scopes.includes(scope)) throw new AppError('scope_denied', { details: { missing_scopes: [scope] } });
    const id = input.resourceId;
    switch (input.operation) {
      case 'upload.create':
        // A named destination must be inside the live grant (and owned).
        if (id) {
          const owned = await db.query('SELECT 1 FROM collections WHERE id = $1 AND owner_account_id = $2', [id, input.accountId]);
          if (!owned.rowCount || (row.library_access !== 'all' && !row.collection_ids.includes(id))) throw new AppError('not_found');
        } else if (row.library_access !== 'all') {
          throw new AppError('invalid_input', { message: 'A granted destination collection is required.' });
        }
        break;
      case 'upload.read':
      case 'upload.part':
      case 'upload.complete':
      case 'upload.abort': {
        if (!id) throw new AppError('not_found');
        const owned = await db.query(
          'SELECT 1 FROM agent_media_uploads WHERE account_id = $1 AND upload_id = $2 AND connection_id = $3',
          [input.accountId, id, input.connectionId],
        );
        if (!owned.rowCount) throw new AppError('not_found');
        break;
      }
      case 'media.read':
      case 'media.download':
      case 'media.analyze':
        if (!id || !(await mediaVisible(db, input.accountId, input.connectionId, row, id, false))) throw new AppError('not_found');
        break;
      case 'media.delete':
      case 'media.update':
      case 'media.prepare':
        // Agents may only manage drafts they created themselves.
        if (!id || !(await mediaVisible(db, input.accountId, input.connectionId, row, id, true))) throw new AppError('not_found');
        break;
      case 'analysis.read': {
        if (!id) throw new AppError('not_found');
        const analysis = await db.query<{ asset_id: string }>(
          'SELECT asset_id FROM media_analysis_requests WHERE account_id = $1 AND id = $2',
          [input.accountId, id],
        );
        const assetId = analysis.rows[0]?.asset_id;
        if (!assetId || !(await mediaVisible(db, input.accountId, input.connectionId, row, assetId, false))) throw new AppError('not_found');
        break;
      }
      case 'command.create':
      case 'command.claim':
        if (!id || !row.installation_ids.includes(id)) throw new AppError('not_found');
        break;
      default:
        throw new AppError('scope_denied');
    }
    return { authorizationVersion: row.authorization_version };
  },
};
