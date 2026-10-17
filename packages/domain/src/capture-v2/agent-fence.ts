import type { Db } from '../db/pool';
import { AppError } from '../errors';
import type {
  CaptureLease,
  CaptureV2Context,
  CaptureAgentAuthorization,
  CaptureAgentOperation,
} from './types';
import { captureAgentAuthorization } from '../authz/capture-agent-authorization';

export async function authorizeCaptureAgent(
  ctx: CaptureV2Context,
  db: Db,
  operation: CaptureAgentOperation,
  resourceId: string | null,
): Promise<void> {
  if (!ctx.agent) return;
  // Production default (G5): the live grant check. Tests may inject another.
  const authorization = ctx.agentAuthorization ?? captureAgentAuthorization;
  const allowed = await authorization.authorize(db, {
    accountId: ctx.authority.accountId,
    connectionId: ctx.agent.connectionId,
    operation,
    resourceId,
    authorizationVersion: ctx.agent.authorizationVersion,
  });
  if (allowed.authorizationVersion !== ctx.agent.authorizationVersion)
    throw new AppError('scope_denied');
}
/** Fetch actor/version from persisted work, not from caller-supplied lease metadata. */
export async function assertCaptureWorkAgent(
  db: Db,
  lease: CaptureLease,
  authorization: CaptureAgentAuthorization = captureAgentAuthorization,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT created_by_agent_connection_id,authorization_version,asset_id FROM capture_work WHERE account_id=$1 AND id=$2`,
    [lease.account_id, lease.job_id],
  );
  const row = rows[0];
  if (!row) throw new AppError('not_found');
  if (!row.created_by_agent_connection_id) return;
  const allowed = await authorization.authorize(db, {
    accountId: lease.account_id,
    connectionId: row.created_by_agent_connection_id,
    operation:
      lease.kind === 'analyze_media'
        ? 'media.analyze'
        : lease.kind === 'verify_upload'
          ? 'upload.complete'
          : 'media.prepare',
    resourceId: lease.kind === 'verify_upload' ? lease.upload_id : row.asset_id,
    authorizationVersion: row.authorization_version,
  });
  if (allowed.authorizationVersion !== row.authorization_version)
    throw new AppError('scope_denied');
}
