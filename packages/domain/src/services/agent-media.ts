import { requireAccount } from '../authz';
import { agentActivity, authorizeAgent } from '../authz/agent-authorization';
import { authorizeMedia, authorizeUploadDestination, mediaGrantPredicate } from '../authz/agent-resources';
import { MediaAnalysis } from '../capture-v2/analysis';
import { MediaIntake } from '../capture-v2/intake';
import type { CaptureV2Context } from '../capture-v2/types';
import type { ServiceContext } from '../context';
import { AppError } from '../errors';
import { AgentMediaQuery, AgentUploadRequest } from '../schemas/agent-media';
import { Uuid } from '../schemas/common';
import { attachAgentUpload } from './collection-media';


/**
 * A trusted, explicit bridge. The adapter can never choose a different owner,
 * and an agent principal always reaches the capture modules AS that agent, so
 * their own live fence (CaptureAgentAuthorization) runs at every checkpoint.
 */
function capture(ctx: ServiceContext): CaptureV2Context {
  const account = requireAccount(ctx.principal);
  if (!ctx.captureV2 || ctx.captureV2.authority.accountId !== account.accountId) {
    throw new AppError('service_unavailable', { message: 'Media services are not configured for this connection.' });
  }
  const agent = ctx.principal.kind === 'agent' && ctx.principal.authorizationVersion !== undefined
    ? { connectionId: ctx.principal.connectionId, authorizationVersion: ctx.principal.authorizationVersion }
    : ctx.captureV2.agent;
  return { ...ctx.captureV2, db: ctx.db, now: ctx.now, agent };
}

export async function getMedia(ctx: ServiceContext, id: string) {
  ({ ctx } = await authorizeMedia(ctx, 'media:read', id));
  const detail = await new MediaIntake(capture(ctx)).detail(id);
  const rewrite = (url: string | null) => url?.replace('/v2/media/', '/v2/agent-media/') ?? null;
  // Owner analysis links can reveal capture reasoning. Media read alone cannot.
  return { ...detail, links: { original: null, playback: rewrite(detail.links.playback), poster: rewrite(detail.links.poster), analysis: null },
    frames: detail.frames.map((f) => ({ ...f, thumbnail_url: rewrite(f.thumbnail_url) })) };
}

export async function listMedia(ctx: ServiceContext, raw: unknown) {
  ctx = await authorizeAgent(ctx, 'media:read');
  const account = requireAccount(ctx.principal), input = AgentMediaQuery.parse(raw);
  let after: { at: string; id: string } | null = null;
  if (input.cursor) {
    try {
      const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) throw new Error('cursor');
      after = { at: value.at, id: Uuid.parse(value.id) };
    } catch { throw new AppError('invalid_input'); }
  }
  const grant = mediaGrantPredicate(ctx.principal, 9);
  const { rows } = await ctx.db.query<{ id: string; created_at: Date }>(
    `SELECT m.id,m.created_at FROM media_assets m WHERE m.account_id=$1 AND m.deleted_at IS NULL AND m.hidden_at IS NULL
     AND ($2::text IS NULL OR m.kind=$2) AND ($3::text IS NULL OR m.status=$3) AND ($4::text IS NULL OR m.source=$4)
     AND ($5::timestamptz IS NULL OR (m.created_at,m.id)<($5,$6::uuid))
     AND ($7::text IS NULL OR m.title ILIKE '%' || $7 || '%') AND ${grant.sql}
     ORDER BY m.created_at DESC,m.id DESC LIMIT $8`,
    [account.accountId, input.kind, input.status, input.source, after?.at, after?.id, input.search, input.limit + 1, ...grant.params],
  );
  const selected = rows.slice(0, input.limit), last = selected.at(-1);
  const items = [];
  for (const row of selected) {
    try { items.push(await getMedia(ctx, row.id)); }
    catch (err) { if (!(err instanceof AppError) || err.code !== 'not_found') throw err; }
  }
  await agentActivity(ctx, 'media.list');
  return { items, next_cursor: rows.length > input.limit && last
    ? Buffer.from(JSON.stringify({ at: last.created_at.toISOString(), id: last.id })).toString('base64url') : null };
}

export async function mediaContent(ctx: ServiceContext, id: string, variant: string) {
  ({ ctx } = await authorizeMedia(ctx, variant === 'original' ? 'media:download' : 'media:read', id));
  if (variant === 'original') await agentActivity(ctx, 'media.original_download', id);
  return new MediaIntake(capture(ctx)).content(id, variant);
}

export async function beginUpload(ctx: ServiceContext, raw: unknown, key: string) {
  const body = AgentUploadRequest.parse(raw);
  ctx = await authorizeUploadDestination(ctx, body.destination_collection_id);
  const account = requireAccount(ctx.principal);
  if (ctx.principal.kind !== 'agent') throw new AppError('scope_denied');
  const principal = ctx.principal;
  if (body.source !== 'upload' || body.capture_session_id) throw new AppError('invalid_input', { message: 'Agent uploads must use signed byte intake, not device source claims.' });
  return ctx.db.transaction(async (tx) => {
    await authorizeUploadDestination({ ...ctx, db: tx }, body.destination_collection_id);
    const { destination_collection_id: destination, ...input } = body;
    const result = await new MediaIntake({ ...capture(ctx), db: tx }).createUpload(input, key);
    const existing = await tx.query<{ connection_id: string; destination_collection_id: string | null }>(
      'SELECT connection_id,destination_collection_id FROM agent_media_uploads WHERE upload_id=$1', [result.upload_id],
    );
    if (existing.rows[0] && (existing.rows[0].connection_id !== principal.connectionId ||
      existing.rows[0].destination_collection_id !== (destination ?? null))) throw new AppError('idempotency_conflict');
    await tx.query(
      `INSERT INTO agent_media_uploads(account_id,upload_id,connection_id,destination_collection_id,authorization_version)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [account.accountId, result.upload_id, principal.connectionId, destination, principal.authorizationVersion],
    );
    // The creator and the grant version it acted under are recorded together
    // (055 pairing check), so later queued work is fenced to that version.
    await tx.query(
      'UPDATE media_assets SET created_by_agent_connection_id=$3,authorization_version=$4 WHERE account_id=$1 AND id=$2',
      [account.accountId, result.asset_id, principal.connectionId, principal.authorizationVersion],
    );
    if (destination) {
      // This is the sole agent-created-draft exception. Destination authorization
      // is checked above; arbitrary inaccessible existing media cannot enter it.
      await attachAgentUpload({ ...ctx, db: tx }, destination, result.asset_id);
    }
    await agentActivity(ctx, 'media.begin_upload', result.asset_id, tx);
    return result;
  });
}

async function ownedUpload(ctx: ServiceContext, id: string) {
  ctx = await authorizeAgent(ctx, 'media:write');
  const account = requireAccount(ctx.principal);
  if (ctx.principal.kind !== 'agent') throw new AppError('scope_denied');
  const { rows } = await ctx.db.query<{ destination_collection_id: string | null }>(
    'SELECT destination_collection_id FROM agent_media_uploads WHERE upload_id=$1 AND account_id=$2 AND connection_id=$3',
    [id, account.accountId, ctx.principal.connectionId],
  );
  if (!rows[0]) throw new AppError('not_found');
  return authorizeUploadDestination(ctx, rows[0].destination_collection_id ?? undefined);
}
export async function getUpload(ctx: ServiceContext, id: string) {
  ctx = await ownedUpload(ctx, id);
  return new MediaIntake(capture(ctx)).getUpload(id);
}
export async function uploadParts(ctx: ServiceContext, id: string, input: unknown, key: string) {
  ctx = await ownedUpload(ctx, id);
  return new MediaIntake(capture(ctx)).parts(id, input, key);
}
export async function completeUpload(ctx: ServiceContext, id: string, input: unknown, key: string) {
  ctx = await ownedUpload(ctx, id);
  return new MediaIntake(capture(ctx)).completeUpload(id, input, key);
}
export async function abortUpload(ctx: ServiceContext, id: string, key: string) {
  ctx = await ownedUpload(ctx, id);
  return new MediaIntake(capture(ctx)).abortUpload(id, key);
}

/**
 * POST /v2/media/{id}/analysis for agents (MCP analyze_media). Requires
 * media:analyze on media inside the live grant; the analysis module enforces
 * explicit request, readiness, the daily allowance and spend limits, and the
 * queued work is fenced to this connection's authorization version.
 */
export async function analyzeMedia(ctx: ServiceContext, id: string, raw: unknown, key: string) {
  ({ ctx } = await authorizeMedia(ctx, 'media:analyze', id));
  const result = await new MediaAnalysis(capture(ctx)).request(id, raw, key);
  await agentActivity(ctx, 'media.analyze', id);
  // Owner result links can reveal capture reasoning; agents poll get_operation.
  return { analysis_id: result.analysis_id, job_id: result.job_id, state: result.state, reused: result.reused };
}

/** Current state of an analysis this agent may read (media:read on the analyzed media). */
export async function getAnalysis(ctx: ServiceContext, analysisId: string) {
  ctx = await authorizeAgent(ctx, 'media:read');
  const account = requireAccount(ctx.principal);
  const { rows } = await ctx.db.query<{ asset_id: string; state: string; error_code: string | null }>(
    'SELECT asset_id, state, error_code FROM media_analysis_requests WHERE account_id = $1 AND id = $2',
    [account.accountId, analysisId],
  );
  if (!rows[0]) return null;
  await authorizeMedia(ctx, 'media:read', rows[0].asset_id);
  return { id: analysisId, asset_id: rows[0].asset_id, state: rows[0].state, error_code: rows[0].error_code };
}
