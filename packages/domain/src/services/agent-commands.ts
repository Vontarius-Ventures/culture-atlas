import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireAccount } from '../authz';
import { agentActivity, authorizeAgent } from '../authz/agent-authorization';
import type { CaptureV2Context, InstallationAuthority } from '../capture-v2/types';
import type { ServiceContext } from '../context';
import type { Db } from '../db/pool';
import { AppError } from '../errors';
import { Uuid } from '../schemas/common';
import { stableStringify } from '../util/stable-json';

export const CaptureCommandRequest = z.strictObject({
  session_id: Uuid, generation: z.number().int().positive(),
  action: z.enum(['capture_photo', 'start_video', 'stop_video']),
  capture_client_id: Uuid, duration_seconds: z.number().int().min(1).max(60).optional(),
  expires_in_seconds: z.number().int().min(1).max(30).default(30),
});
export const CommandAck = z.strictObject({
  sequence: z.number().int().nonnegative(),
  state: z.enum(['awaiting_user', 'executing', 'succeeded', 'failed', 'unknown']),
  result_asset_id: Uuid.optional(),
  safe_error: z.enum(['device_unavailable', 'permission_denied', 'interrupted', 'storage_full', 'outcome_unknown']).optional(),
});
interface Command {
  id: string; account_id: string; installation_id: string; capture_session_id: string; connection_id: string;
  authorization_version: number; generation: number; action: string; duration_seconds: number | null;
  capture_client_id: string; state: string; expires_at: Date; result_asset_id: string | null;
  error_code: string | null; ack_sequence: number; payload_hash: string;
}
const dto = (r: Command) => ({
  command_id: r.id, session_id: r.capture_session_id, generation: r.generation, action: r.action,
  duration_seconds: r.duration_seconds, capture_client_id: r.capture_client_id,
  authorization_version: r.authorization_version, state: r.state, expires_at: r.expires_at.toISOString(),
  result_asset_id: r.result_asset_id, error_code: r.error_code,
});

/** One policy for initial request, claim, and the phone's last pre-execution check. */
async function assertCommandLive(tx: Db, command: Pick<Command,
  'account_id' | 'installation_id' | 'capture_session_id' | 'generation' | 'connection_id' | 'authorization_version' | 'action'>,
  now: Date) {
  const { rows } = await tx.query<{
    state: string; remote_arm_expires_at: Date | null; allowed_agent_connection_ids: string[];
    generation: number; readiness: string; app_state: string; last_seen_at: Date; revoked_at: Date | null;
    scopes: string[]; installation_ids: string[]; authorization_version: number; agent_revoked: Date | null; agent_expires: Date;
  }>(
    `SELECT s.state,s.remote_arm_expires_at,s.allowed_agent_connection_ids,s.generation,
     i.readiness,i.app_state,i.last_seen_at,i.revoked_at,ac.scopes,ac.installation_ids,ac.authorization_version,
     ac.revoked_at AS agent_revoked,ac.expires_at AS agent_expires
     FROM capture_sessions s JOIN mobile_installations i ON i.id=s.installation_id AND i.account_id=s.account_id
     JOIN agent_connections ac ON ac.id=$4 AND ac.owner_account_id=s.account_id
     WHERE s.id=$1 AND s.account_id=$2 AND s.installation_id=$3 FOR UPDATE OF s,ac`,
    [command.capture_session_id, command.account_id, command.installation_id, command.connection_id],
  );
  const r = rows[0];
  if (!r) throw new AppError('not_found');
  if (r.agent_revoked || r.agent_expires <= now || r.authorization_version !== command.authorization_version ||
      !r.scopes.includes('devices:command') || !r.installation_ids.includes(command.installation_id)) throw new AppError('token_revoked');
  if (r.revoked_at || r.state !== 'active' || r.generation !== command.generation) throw new AppError('action_required');
  if (!r.allowed_agent_connection_ids.includes(command.connection_id) ||
      (command.action !== 'stop_video' && (!r.remote_arm_expires_at || r.remote_arm_expires_at <= now))) {
    throw new AppError('action_required', { details: { action: 'arm_selected_agent_locally' } });
  }
  if (r.app_state !== 'foreground' || r.readiness !== 'ready' || now.getTime() - r.last_seen_at.getTime() > 30_000) {
    throw new AppError('action_required', { details: { action: 'open_phone_and_check_permissions' } });
  }
  if (command.action === 'stop_video') {
    const initiating = await tx.query(
      `SELECT id FROM device_commands WHERE capture_session_id=$1 AND connection_id=$2 AND action='start_video'
       AND state IN ('executing','succeeded')`, [command.capture_session_id, command.connection_id],
    );
    if (!initiating.rowCount) throw new AppError('not_found');
  }
}

export async function requestCapture(ctx: ServiceContext, installationId: string, raw: unknown, idempotencyKey: string) {
  ctx = await authorizeAgent(ctx, 'devices:command');
  if (ctx.principal.kind !== 'agent') throw new AppError('scope_denied', { message: 'Use an explicitly authorized agent connection.' });
  const principal = ctx.principal;
  const body = CaptureCommandRequest.parse(raw);
  Uuid.parse(idempotencyKey);
  if (!principal.allowedInstallationIds?.includes(installationId)) throw new AppError('not_found');
  const hash = createHash('sha256').update(stableStringify({ installationId, ...body })).digest('hex');
  return ctx.db.transaction(async (tx) => {
    const command = { account_id: principal.accountId, installation_id: installationId,
      capture_session_id: body.session_id, generation: body.generation, connection_id: principal.connectionId,
      authorization_version: principal.authorizationVersion!, action: body.action };
    await assertCommandLive(tx, command, ctx.now());
    const prior = await tx.query<Command>(
      'SELECT * FROM device_commands WHERE account_id=$1 AND connection_id=$2 AND idempotency_key=$3',
      [principal.accountId, principal.connectionId, idempotencyKey],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].payload_hash !== hash) throw new AppError('idempotency_conflict');
      return dto(prior.rows[0]);
    }
    const active = await tx.query(
      `SELECT id FROM device_commands WHERE capture_session_id=$1 AND action IN ('capture_photo','start_video')
       AND state IN ('queued','delivered','awaiting_user','executing')`, [body.session_id],
    );
    if (body.action !== 'stop_video' && active.rowCount) throw new AppError('conflict');
    const { rows } = await tx.query<Command>(
      `INSERT INTO device_commands(account_id,installation_id,capture_session_id,connection_id,authorization_version,generation,
       action,duration_seconds,capture_client_id,idempotency_key,payload_hash,expires_at,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [principal.accountId, installationId, body.session_id, principal.connectionId, principal.authorizationVersion,
        body.generation, body.action, body.action === 'start_video' ? (body.duration_seconds ?? 60) : null,
        body.capture_client_id, idempotencyKey, hash, new Date(ctx.now().getTime() + body.expires_in_seconds * 1000), ctx.now()],
    );
    await agentActivity(ctx, `capture.${body.action}`, installationId, tx);
    return dto(rows[0]!);
  });
}

function installation(ctx: CaptureV2Context): InstallationAuthority {
  if (ctx.authority.kind !== 'installation' || ctx.authority.expiresAt <= ctx.now()) throw new AppError('unauthenticated');
  return ctx.authority;
}

export async function claimCommands(ctx: CaptureV2Context) {
  const caller = installation(ctx);
  return ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<Command>(
      `SELECT * FROM device_commands WHERE account_id=$1 AND installation_id=$2 AND state IN ('queued','delivered','awaiting_user')
       ORDER BY created_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`, [caller.accountId, caller.installationId],
    );
    const items = [];
    for (const command of rows) {
      try {
        if (command.expires_at <= ctx.now()) throw new AppError('token_expired');
        await assertCommandLive(tx, command, ctx.now());
        await tx.query(`UPDATE device_commands SET state='delivered' WHERE id=$1`, [command.id]);
        items.push(dto({ ...command, state: 'delivered' }));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        await tx.query(`UPDATE device_commands SET state=$2,error_code=$3 WHERE id=$1`,
          [command.id, command.expires_at <= ctx.now() ? 'expired' : 'cancelled', err.code]);
      }
    }
    return { items };
  });
}

export async function acknowledgeCommand(ctx: CaptureV2Context, id: string, raw: unknown) {
  const caller = installation(ctx), body = CommandAck.parse(raw);
  return ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<Command>(
      'SELECT * FROM device_commands WHERE id=$1 AND account_id=$2 AND installation_id=$3 FOR UPDATE',
      [id, caller.accountId, caller.installationId],
    );
    const row = rows[0];
    if (!row) throw new AppError('not_found');
    if (body.sequence <= row.ack_sequence) return dto(row);
    if (['succeeded', 'failed', 'expired', 'cancelled', 'unknown'].includes(row.state)) throw new AppError('conflict');
    if (body.state === 'executing') {
      if (row.expires_at <= ctx.now()) throw new AppError('action_required');
      await assertCommandLive(tx, row, ctx.now());
    }
    const transitions: Record<string, string[]> = {
      delivered: ['awaiting_user', 'executing', 'failed', 'unknown'],
      awaiting_user: ['executing', 'failed', 'unknown'],
      executing: ['succeeded', 'failed', 'unknown'],
    };
    if (!transitions[row.state]?.includes(body.state)) throw new AppError('conflict');
    if (body.result_asset_id) {
      const asset = await tx.query('SELECT id FROM media_assets WHERE id=$1 AND account_id=$2 AND installation_id=$3 AND capture_session_id=$4 AND deleted_at IS NULL',
        [body.result_asset_id, caller.accountId, caller.installationId, row.capture_session_id]);
      if (!asset.rowCount) throw new AppError('not_found');
    }
    const updated = await tx.query<Command>(
      'UPDATE device_commands SET state=$2,ack_sequence=$3,result_asset_id=$4,error_code=$5 WHERE id=$1 RETURNING *',
      [id, body.state, body.sequence, body.result_asset_id ?? null, body.safe_error ?? null],
    );
    return dto(updated.rows[0]!);
  });
}

export async function getCommand(ctx: ServiceContext, id: string) {
  const account = requireAccount(ctx.principal);
  if (ctx.principal.kind === 'agent') ctx = await authorizeAgent(ctx, 'devices:command');
  const { rows } = await ctx.db.query<Command>('SELECT * FROM device_commands WHERE id=$1 AND account_id=$2', [id, account.accountId]);
  const row = rows[0];
  if (!row || (ctx.principal.kind === 'agent' &&
      (row.connection_id !== ctx.principal.connectionId || !ctx.principal.allowedInstallationIds?.includes(row.installation_id)))) throw new AppError('not_found');
  return dto(row);
}
