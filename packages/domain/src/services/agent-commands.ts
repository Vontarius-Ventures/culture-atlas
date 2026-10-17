import { createHash } from 'node:crypto';
import { requireAccount } from '../authz';
import { agentActivity, authorizeAgent } from '../authz/agent-authorization';
import type { CaptureV2Context, InstallationAuthority } from '../capture-v2/types';
import type { ServiceContext } from '../context';
import type { Db } from '../db/pool';
import { AppError } from '../errors';
import { Uuid } from '../schemas/common';
import { CaptureCommandRequest, CommandAck } from '../schemas/agent-commands';
import { stableStringify } from '../util/stable-json';
export type CommandContext = Pick<CaptureV2Context, 'db' | 'authority' | 'now'> & { glassesEnabled?: boolean };

interface Command {
  id: string; account_id: string; installation_id: string; capture_session_id: string; connection_id: string;
  authorization_version: number; generation: number; action: string; duration_seconds: number | null;
  capture_client_id: string; state: string; expires_at: Date; result_asset_id: string | null;
  error_code: string | null; ack_sequence: number; payload_hash: string;
  delivery_sequence: number;
}
const dto = (r: Command) => ({
  command_id: r.id, session_id: r.capture_session_id, generation: r.generation, action: r.action,
  delivery_sequence: r.delivery_sequence,
  duration_seconds: r.duration_seconds, capture_client_id: r.capture_client_id,
  authorization_version: r.authorization_version, state: r.state, expires_at: r.expires_at.toISOString(),
  result_asset_id: r.result_asset_id, error_code: r.error_code,
});

/** One policy for initial request, claim, and the phone's last pre-execution check. */
async function assertCommandLive(tx: Db, command: Pick<Command,
  'account_id' | 'installation_id' | 'capture_session_id' | 'generation' | 'connection_id' | 'authorization_version' | 'action'>,
  now: Date, glassesEnabled = false) {
  const { rows } = await tx.query<{
    state: string; remote_arm_expires_at: Date | null; allowed_agent_connection_ids: string[];
    generation: number; readiness: string; app_state: string; last_seen_at: Date; revoked_at: Date | null;
    scopes: string[]; installation_ids: string[]; authorization_version: number; agent_revoked: Date | null; agent_expires: Date;
    source: string; media_mode: string; capabilities: Record<string, boolean>;
    wearable_permission: string | null; wearable_disconnected: Date | null; wearable_capabilities: Record<string, boolean> | null;
  }>(
    `SELECT s.state,s.remote_arm_expires_at,s.allowed_agent_connection_ids,s.generation,s.source,s.media_mode,i.capabilities,
     i.readiness,i.app_state,i.last_seen_at,i.revoked_at,ac.scopes,ac.installation_ids,ac.authorization_version,
     ac.revoked_at AS agent_revoked,ac.expires_at AS agent_expires,
     w.permission_state AS wearable_permission,w.disconnected_at AS wearable_disconnected,w.capabilities AS wearable_capabilities
     FROM capture_sessions s JOIN mobile_installations i ON i.id=s.installation_id AND i.account_id=s.account_id
     JOIN agent_connections ac ON ac.id=$4 AND ac.owner_account_id=s.account_id
     LEFT JOIN wearable_connections w ON w.id=s.wearable_connection_id AND w.account_id=s.account_id
     WHERE s.id=$1 AND s.account_id=$2 AND s.installation_id=$3 FOR UPDATE OF s,ac`,
    [command.capture_session_id, command.account_id, command.installation_id, command.connection_id],
  );
  const r = rows[0];
  if (!r) throw new AppError('not_found');
  if (r.agent_revoked || r.agent_expires <= now || r.authorization_version !== command.authorization_version ||
      !r.scopes.includes('devices:command') || !r.installation_ids.includes(command.installation_id)) throw new AppError('token_revoked');
  if (r.revoked_at || r.state !== 'active' || r.generation !== command.generation) throw new AppError('action_required');
  const mode = command.action === 'capture_photo' ? 'photo' : 'video';
  if (r.media_mode !== mode || r.capabilities[mode] !== true ||
      (r.source === 'meta_glasses' && (!glassesEnabled || r.wearable_permission !== 'granted' ||
        r.wearable_disconnected || r.wearable_capabilities?.[mode] !== true))) {
    throw new AppError('action_required', { details: { action: 'check_source_and_capture_mode_locally' } });
  }
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

/** Post-commit notification that a NEW command is queued (push wake-ups). Never part of authorization. */
export type CommandQueuedListener = (event: {
  accountId: string; installationId: string; commandId: string;
}) => Promise<unknown> | unknown;
let commandQueued: CommandQueuedListener | undefined;
export function setCommandQueuedListener(listener: CommandQueuedListener | undefined): void {
  commandQueued = listener;
}
export function getCommandQueuedListener(): CommandQueuedListener | undefined {
  return commandQueued;
}

export async function requestCapture(ctx: ServiceContext, installationId: string, raw: unknown, idempotencyKey: string) {
  ctx = await authorizeAgent(ctx, 'devices:command');
  if (ctx.principal.kind !== 'agent') throw new AppError('scope_denied', { message: 'Use an explicitly authorized agent connection.' });
  const principal = ctx.principal;
  const body = CaptureCommandRequest.parse(raw);
  Uuid.parse(idempotencyKey);
  if (!principal.allowedInstallationIds?.includes(installationId)) throw new AppError('not_found');
  const hash = createHash('sha256').update(stableStringify({ installationId, ...body })).digest('hex');
  let created: string | null = null;
  const result = await ctx.db.transaction(async (tx) => {
    const command = { account_id: principal.accountId, installation_id: installationId,
      capture_session_id: body.session_id, generation: body.generation, connection_id: principal.connectionId,
      authorization_version: principal.authorizationVersion!, action: body.action };
    await assertCommandLive(tx, command, ctx.now(), ctx.captureV2?.glassesEnabled);
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
    created = rows[0]!.id;
    return dto(rows[0]!);
  });
  if (created && commandQueued) {
    const event = { accountId: principal.accountId, installationId, commandId: created };
    // Best effort, after commit: the phone's long poll is the delivery guarantee.
    void Promise.resolve().then(() => commandQueued?.(event)).catch(() => undefined);
  }
  return result;
}

function installation(ctx: CommandContext): InstallationAuthority {
  if (ctx.authority.kind !== 'installation' || ctx.authority.expiresAt <= ctx.now()) throw new AppError('unauthenticated');
  return ctx.authority;
}

export async function claimCommands(ctx: CommandContext, afterSequence = 0) {
  const caller = installation(ctx);
  return ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<Command>(
      `SELECT * FROM device_commands WHERE account_id=$1 AND installation_id=$2 AND state IN ('queued','delivered','awaiting_user')
       AND (delivery_sequence>$3 OR state IN ('delivered','awaiting_user'))
       ORDER BY delivery_sequence LIMIT 20 FOR UPDATE SKIP LOCKED`, [caller.accountId, caller.installationId, afterSequence],
    );
    const items = [];
    for (const command of rows) {
      try {
        if (command.expires_at <= ctx.now()) throw new AppError('token_expired');
        await assertCommandLive(tx, command, ctx.now(), ctx.glassesEnabled);
        await tx.query(`UPDATE device_commands SET state='delivered' WHERE id=$1`, [command.id]);
        items.push(dto({ ...command, state: 'delivered' }));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        await tx.query(`UPDATE device_commands SET state=$2,error_code=$3 WHERE id=$1`,
          [command.id, command.expires_at <= ctx.now() ? 'expired' : 'cancelled', err.code]);
      }
    }
    return { items, next_sequence: Math.max(afterSequence, ...rows.map((r) => r.delivery_sequence)) };
  });
}

export async function acknowledgeCommand(ctx: CommandContext, id: string, raw: unknown, idempotencyKey?: string) {
  const caller = installation(ctx), body = CommandAck.parse(raw);
  return ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<Command>(
      'SELECT * FROM device_commands WHERE id=$1 AND account_id=$2 AND installation_id=$3 FOR UPDATE',
      [id, caller.accountId, caller.installationId],
    );
    const row = rows[0];
    if (!row) throw new AppError('not_found');
    if (idempotencyKey) {
      Uuid.parse(idempotencyKey);
      const fingerprint = createHash('sha256').update(stableStringify({ id, ...body })).digest('hex');
      const prior = await tx.query<{ payload_hash: string }>(
        `INSERT INTO device_command_ack_keys(account_id,installation_id,key,command_id,payload_hash) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(account_id,installation_id,key) DO UPDATE SET payload_hash=device_command_ack_keys.payload_hash RETURNING payload_hash`,
        [caller.accountId, caller.installationId, idempotencyKey, id, fingerprint],
      );
      if (prior.rows[0]!.payload_hash !== fingerprint) throw new AppError('idempotency_conflict');
    }
    if (body.state === 'executing' && ['delivered', 'awaiting_user', 'executing'].includes(row.state)) {
      if (row.expires_at <= ctx.now()) throw new AppError('action_required');
      await assertCommandLive(tx, row, ctx.now(), ctx.glassesEnabled);
    }
    if (body.sequence <= row.ack_sequence) return dto(row);
    if (['succeeded', 'failed', 'expired', 'cancelled', 'unknown'].includes(row.state)) throw new AppError('conflict');
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
