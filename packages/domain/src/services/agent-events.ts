import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { hasScope, requireAccount } from '../authz';
import { authorizeAgent } from '../authz/agent-authorization';
import { authorizeMedia } from '../authz/agent-resources';
import type { ServiceContext } from '../context';
import { AppError } from '../errors';
import { getCommand } from './agent-commands';

function encode(ctx: ServiceContext, sequence: number) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(ctx.config.SESSION_SECRET).digest(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({
    sequence, connection: ctx.principal.kind === 'agent' ? ctx.principal.connectionId : requireAccount(ctx.principal).accountId,
    issued: ctx.now().getTime(),
  })), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
function decode(ctx: ServiceContext, cursor?: string) {
  if (!cursor) return 0;
  try {
    if (cursor.length > 1024) throw new Error('size');
    const data = Buffer.from(cursor, 'base64url'), iv = data.subarray(0, 12), tag = data.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(ctx.config.SESSION_SECRET).digest(), iv);
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
    const connection = ctx.principal.kind === 'agent' ? ctx.principal.connectionId : requireAccount(ctx.principal).accountId;
    if (parsed.connection !== connection || !Number.isSafeInteger(parsed.sequence) || parsed.sequence < 0) throw new Error('cursor');
    if (ctx.now().getTime() - parsed.issued > 86_400_000) throw new AppError('cursor_expired');
    return parsed.sequence as number;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('invalid_input', { message: 'Invalid event cursor.' });
  }
}

export async function readEvents(ctx: ServiceContext, cursor?: string) {
  const account = requireAccount(ctx.principal);
  if (ctx.principal.kind === 'agent') {
    const scope = (['media:read', 'devices:command', 'preferences:read', 'setup:read'] as const)
      .find((s) => hasScope(ctx.principal, s));
    if (!scope) throw new AppError('scope_denied');
    ctx = await authorizeAgent(ctx, scope);
  }
  const after = decode(ctx, cursor);
  await ctx.db.query('DELETE FROM agent_platform_events WHERE account_id=$1 AND created_at<$2', [account.accountId, new Date(ctx.now().getTime() - 86_400_000)]);
  const { rows } = await ctx.db.query<{ sequence: number; resource_kind: string; resource_id: string; status: string }>(
    `SELECT sequence,resource_kind,resource_id,status FROM agent_platform_events
     WHERE account_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100`, [account.accountId, after],
  );
  const items: Array<{ id: string; kind: string; status: string }> = [];
  for (const row of rows) {
    try {
      if (row.resource_kind === 'media') await authorizeMedia(ctx, 'media:read', row.resource_id);
      else if (row.resource_kind === 'command') await getCommand(ctx, row.resource_id);
      else if (!hasScope(ctx.principal, 'preferences:read')) continue;
      // Account ID is not exposed in preference-change events.
      items.push({ id: row.resource_kind === 'preferences' ? 'preferences' : row.resource_id, kind: row.resource_kind, status: row.status });
    } catch (err) {
      if (!(err instanceof AppError) || !['not_found', 'scope_denied'].includes(err.code)) throw err;
    }
  }
  return { schema_version: '2.1' as const, request_id: ctx.requestId, items,
    next_cursor: encode(ctx, rows.at(-1)?.sequence ?? after) };
}
