import { requireAccount, requireAccountOwner } from '../authz';
import { agentActivity, authorizeAgent } from '../authz/agent-authorization';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { AppError, invalidInput } from '../errors';
import { CreateAgentV2, NarrowAgentV2, OrdinaryPreferences, PatchOrdinaryPreferences } from '../schemas/agent-platform';
import { createAgentConnection, listAgentConnections } from './agent-connections';
import { generateAgentCredential } from './auth';

const defaults = {
  theme: 'system' as const, language: 'en' as const, default_capture_mode: 'photo' as const, video_muted: true,
  exploration: 'balanced' as const, food: { exclusions: [] as string[] },
};
const meta = (ctx: ServiceContext) => ({ schema_version: '2.1' as const, request_id: ctx.requestId });

export function preferenceVersion(ifMatch?: string | null): number {
  if (!ifMatch) throw new AppError('precondition_required');
  const match = /^"([1-9]\d*)"$/.exec(ifMatch);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new AppError('invalid_input', { message: 'Use the quoted version from the preferences response.' });
  return Number(match[1]);
}

export async function getPreferences(ctx: ServiceContext) {
  ctx = await authorizeAgent(ctx, 'preferences:read');
  const account = requireAccount(ctx.principal);
  const { rows } = await ctx.db.query<{ preferences: Record<string, unknown>; preferences_version: number }>(
    'SELECT preferences,preferences_version FROM accounts WHERE id=$1', [account.accountId],
  );
  if (!rows[0]) throw new AppError('not_found');
  // A positive projection, never spread the account's general preferences.
  const userSet: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    const value = rows[0].preferences[key];
    if (value !== undefined) {
      const parsed = OrdinaryPreferences.safeParse({ [key]: value });
      if (parsed.success) Object.assign(userSet, parsed.data);
    }
  }
  await agentActivity(ctx, 'preferences.read');
  return {
    ...meta(ctx), version: rows[0].preferences_version, user_set: userSet,
    effective: { ...defaults, ...userSet },
    analysis_consent: { automatic_analysis: false as const, requires_explicit_request: true as const },
  };
}

export async function updatePreferences(ctx: ServiceContext, patch: unknown, version: number) {
  ctx = await authorizeAgent(ctx, 'preferences:write');
  const account = requireAccount(ctx.principal);
  const parsed = PatchOrdinaryPreferences.safeParse(patch);
  if (!parsed.success) throw invalidInput(parsed.error);
  await ctx.db.transaction(async (tx) => {
    await authorizeAgent(ctx, 'preferences:write', tx);
    const { rowCount } = await tx.query(
      `UPDATE accounts SET preferences=preferences || $2::jsonb,preferences_version=preferences_version+1,updated_at=$4
       WHERE id=$1 AND preferences_version=$3`, [account.accountId, JSON.stringify(parsed.data), version, ctx.now()],
    );
    if (!rowCount) throw new AppError('precondition_failed');
    if (parsed.data.food !== undefined) {
      // Eat exclusions are applied when a feed snapshot is built (ONB-05): drop the
      // account's cached snapshots so the next read filters with the new list.
      await tx.query('DELETE FROM feed_snapshots WHERE owner_account_id = $1', [account.accountId]);
    }
    await agentActivity(ctx, 'preferences.update', undefined, tx);
  });
  // Write-only grants need not acquire preferences:read to receive their result.
  return getPreferences({ ...ctx, principal: { kind: 'account', accountId: account.accountId, sessionId: null, isDemoOwner: false } });
}

export async function getSetup(ctx: ServiceContext) {
  ctx = await authorizeAgent(ctx, 'setup:read');
  const account = requireAccount(ctx.principal);
  const { rows } = await ctx.db.query<{
    id: string; platform: string; app_version: string; last_seen_at: Date; app_state: string; readiness: string; capabilities: Record<string, unknown>;
  }>(
    `SELECT id,platform,app_version,last_seen_at,app_state,readiness,capabilities FROM mobile_installations
     WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at,id LIMIT 100`, [account.accountId],
  );
  // Connections allowed to command a phone learn that phone's id and any
  // session the owner armed for them, so request_capture is callable from MCP.
  const commandable = new Set<string>(
    ctx.principal.kind === 'agent' && ctx.principal.scopes.includes('devices:command')
      ? (ctx.principal.allowedInstallationIds ?? []) : [],
  );
  const armed = new Map<string, { session_id: string; generation: number; mode: string; source: string; remote_arm_expires_at: string }>();
  if (commandable.size && ctx.principal.kind === 'agent') {
    const sessions = await ctx.db.query<{ id: string; installation_id: string; generation: number; media_mode: string; source: string; remote_arm_expires_at: Date }>(
      `SELECT id,installation_id,generation,media_mode,source,remote_arm_expires_at FROM capture_sessions
       WHERE account_id=$1 AND installation_id=ANY($2::uuid[]) AND state='active' AND remote_arm_expires_at>$3
         AND $4=ANY(allowed_agent_connection_ids)
       ORDER BY remote_arm_expires_at DESC`,
      [account.accountId, [...commandable], ctx.now(), ctx.principal.connectionId],
    );
    for (const r of sessions.rows)
      if (!armed.has(r.installation_id))
        armed.set(r.installation_id, { session_id: r.id, generation: r.generation, mode: r.media_mode, source: r.source,
          remote_arm_expires_at: r.remote_arm_expires_at.toISOString() });
  }
  await agentActivity(ctx, 'setup.read');
  return {
    ...meta(ctx), observed_at: ctx.now().toISOString(),
    installations: rows.map((r) => {
      const control = commandable.has(r.id) ? { id: r.id, armed_session: armed.get(r.id) ?? null } : {};
      const stale = ctx.now().getTime() - r.last_seen_at.getTime() > 30_000 || r.app_state !== 'foreground';
      const capabilities: Record<string, boolean> = {};
      for (const key of ['photo', 'video', 'phone_camera', 'meta_glasses', 'microphone']) {
        capabilities[key] = !stale && r.readiness === 'ready' && r.capabilities[key] === true;
      }
      return { ...control, alias: `${r.platform} phone`, app_version: r.app_version, last_seen_at: r.last_seen_at.toISOString(),
        stale, capabilities, unavailable_reasons: stale ? ['device_disconnected_or_stale'] : r.readiness === 'ready' ? [] : ['local_permission_required'] };
    }),
    available_actions: ['view_preferences', 'upload_files', ...(armed.size ? ['request_capture'] : [])],
    permission_summary: 'Observed permissions only. OS access and remote capture require local consent.' as const,
  };
}

/** Ownership validation happens in one transaction with grant creation. */
async function ownedInstallations(db: Queryable, accountId: string, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM mobile_installations WHERE account_id=$1 AND id=ANY($2::uuid[]) AND revoked_at IS NULL',
    [accountId, unique],
  );
  if (rows.length !== unique.length) throw new AppError('not_found');
  return unique;
}

export async function createConnection(ctx: ServiceContext, raw: unknown) {
  const owner = requireAccountOwner(ctx.principal);
  const body = CreateAgentV2.parse(raw);
  const result = await ctx.db.transaction(async (tx) => {
    const ids = await ownedInstallations(tx, owner.accountId, body.installation_ids);
    // Reuse the existing hashed credential and selected-collection foundation.
    const transactionalCtx = { ...ctx, db: tx };
    const created = await createAgentConnection(transactionalCtx, body);
    await tx.query('UPDATE agent_connections SET installation_ids=$2 WHERE id=$1', [created.connection.id, ids]);
    return created;
  });
  const connection = (await listAgentConnections(ctx)).connections.find((c) => c.id === result.connection.id)!;
  return { ...meta(ctx), ...result, connection, installation_ids: body.installation_ids, authorization_version: 1 };
}

export async function narrowConnection(ctx: ServiceContext, id: string, raw: unknown) {
  const owner = requireAccountOwner(ctx.principal);
  const body = NarrowAgentV2.parse(raw);
  await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<{
      scopes: string[]; installation_ids: string[]; expires_at: Date; library_access: string; collection_ids: string[];
    }>(
      `SELECT ac.*, ARRAY(SELECT collection_id FROM agent_connection_collections WHERE agent_connection_id=ac.id) AS collection_ids
       FROM agent_connections ac WHERE id=$1 AND owner_account_id=$2 AND purpose='agent' AND revoked_at IS NULL FOR UPDATE`,
      [id, owner.accountId],
    );
    const row = rows[0];
    if (!row) throw new AppError('not_found');
    if (body.scopes?.some((s) => !row.scopes.includes(s)) ||
        body.installation_ids?.some((i) => !row.installation_ids.includes(i)) ||
        body.collection_ids?.some((i) => !row.collection_ids.includes(i)) ||
        (body.expires_at && (new Date(body.expires_at) > row.expires_at || new Date(body.expires_at) <= ctx.now()))) {
      throw new AppError('scope_denied', { message: 'Wider access requires a new owner consent transaction.' });
    }
    if (body.collection_ids && row.library_access !== 'selected_collections') throw new AppError('invalid_input');
    await tx.query(
      `UPDATE agent_connections SET client_name=COALESCE($3,client_name),scopes=COALESCE($4,scopes),
       installation_ids=COALESCE($5,installation_ids),expires_at=COALESCE($6,expires_at),
       authorization_version=authorization_version+1 WHERE id=$1 AND owner_account_id=$2`,
      [id, owner.accountId, body.client_name, body.scopes, body.installation_ids, body.expires_at],
    );
    if (body.collection_ids) await tx.query(
      'DELETE FROM agent_connection_collections WHERE agent_connection_id=$1 AND NOT(collection_id=ANY($2::uuid[]))',
      [id, body.collection_ids],
    );
  });
  return { ...meta(ctx), connection: (await listAgentConnections(ctx)).connections.find((c) => c.id === id)! };
}

export async function rotateConnection(ctx: ServiceContext, id: string) {
  const owner = requireAccountOwner(ctx.principal);
  const credential = generateAgentCredential();
  const { rowCount } = await ctx.db.query(
    `UPDATE agent_connections SET credential_hash=$3,credential_prefix=$4,authorization_version=authorization_version+1
     WHERE id=$1 AND owner_account_id=$2 AND purpose='agent' AND revoked_at IS NULL AND expires_at>$5`,
    [id, owner.accountId, credential.hash, credential.prefix, ctx.now()],
  );
  if (!rowCount) throw new AppError('not_found');
  return { ...meta(ctx), credential: credential.credential };
}

export async function getActivity(ctx: ServiceContext) {
  const owner = requireAccountOwner(ctx.principal);
  const { rows } = await ctx.db.query<{
    id: string; connection_id: string; client_name: string; action: string; target_id: string | null;
    target_label: string | null; created_at: Date;
  }>(
    `SELECT a.id,a.connection_id,ac.client_name,a.action,a.target_id,
       COALESCE(c.name,(SELECT pv.title FROM plans p JOIN plan_versions pv ON pv.plan_id=p.id
          WHERE p.id=a.target_id AND p.owner_account_id=a.account_id ORDER BY pv.version DESC LIMIT 1),
         (SELECT di.title FROM discovery_items di WHERE di.id=a.target_id
            AND (di.owner_account_id IS NULL OR di.owner_account_id=a.account_id))) AS target_label,
       a.created_at FROM agent_activity a
     JOIN agent_connections ac ON ac.id=a.connection_id AND ac.owner_account_id=a.account_id
     LEFT JOIN collections c ON c.id=a.target_id AND c.owner_account_id=a.account_id
     WHERE a.account_id=$1 AND ac.purpose='agent' ORDER BY a.created_at DESC,a.id LIMIT 100`, [owner.accountId],
  );
  return { ...meta(ctx), items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })), next_cursor: null };
}
