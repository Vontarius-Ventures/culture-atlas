import { createHash } from 'node:crypto';
import { requireAccountOwner } from '../authz';
import type { ServiceContext } from '../context';
import type { Db } from '../db/pool';
import { AppError } from '../errors';
import { OAuthConsent, OAuthExchange } from '../schemas/agent-platform';
import { createConnection } from './agent-platform';
import { hashToken, randomToken } from './auth';

/** Authorization code + PKCE S256. Only an authenticated owner can consent. */
export async function consent(ctx: ServiceContext, raw: unknown) {
  const owner = requireAccountOwner(ctx.principal);
  const body = OAuthConsent.parse(raw);
  const resource = `${ctx.config.APP_BASE_URL.replace(/\/+$/, '')}/mcp`;
  if (body.resource !== resource) throw new AppError('invalid_input', { message: 'Unknown OAuth resource.' });
  return ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<{ name: string; redirect_uris: string[] }>(
      'SELECT name,redirect_uris FROM agent_oauth_clients WHERE id=$1', [body.client_id],
    );
    if (!rows[0]?.redirect_uris.includes(body.redirect_uri)) throw new AppError('invalid_input');
    const created = await createConnection({ ...ctx, db: tx }, { ...body.grant, client_name: rows[0].name });
    // OAuth grants never expose a parallel personal credential. Replace its
    // hash with an unissued random value before the transaction is visible.
    await tx.query('UPDATE agent_connections SET credential_hash=$2 WHERE id=$1', [created.connection.id, hashToken(randomToken())]);
    const code = randomToken();
    await tx.query(
      `INSERT INTO agent_oauth_codes(code_hash,client_id,account_id,connection_id,redirect_uri,code_challenge,resource,state_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [hashToken(code), body.client_id, owner.accountId, created.connection.id, body.redirect_uri,
        body.code_challenge, resource, hashToken(body.state), new Date(ctx.now().getTime() + 60_000)],
    );
    const redirect = new URL(body.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', body.state);
    return { schema_version: '2.1' as const, request_id: ctx.requestId, redirect_uri: redirect.toString() };
  });
}

interface Family {
  id: string; client_id: string; connection_id: string; resource: string;
  authorization_version: number; absolute_expires_at: Date; idle_expires_at: Date; revoked_at: Date | null;
}

async function issue(tx: Db, family: Family, now: Date) {
  const access = randomToken(), refresh = randomToken();
  const expires = new Date(Math.min(now.getTime() + 600_000, family.absolute_expires_at.getTime()));
  const idle = new Date(Math.min(now.getTime() + 30 * 86_400_000, family.absolute_expires_at.getTime()));
  await tx.query('INSERT INTO agent_oauth_access_tokens(token_hash,family_id,expires_at) VALUES($1,$2,$3)',
    [hashToken(access), family.id, expires]);
  await tx.query('INSERT INTO agent_oauth_refresh_tokens(token_hash,family_id) VALUES($1,$2)', [hashToken(refresh), family.id]);
  await tx.query('UPDATE agent_oauth_families SET idle_expires_at=$2 WHERE id=$1', [family.id, idle]);
  return { token_type: 'Bearer' as const, access_token: access, refresh_token: refresh,
    expires_in: Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 1000)) };
}

/** Public token endpoint. No cookie or supplied account ID is consulted. */
export async function exchange(db: Db, raw: unknown, now: Date) {
  const body = OAuthExchange.parse(raw);
  // Reuse revocation MUST commit before returning the generic failure.
  const result = await db.transaction(async (tx) => {
    if (body.grant_type === 'authorization_code') {
      const { rows } = await tx.query<{
        client_id: string; connection_id: string; redirect_uri: string; resource: string;
        code_challenge: string; consumed_at: Date | null; expires_at: Date;
      }>('SELECT * FROM agent_oauth_codes WHERE code_hash=$1 FOR UPDATE', [hashToken(body.code)]);
      const code = rows[0];
      if (!code || code.consumed_at || code.expires_at <= now || code.client_id !== body.client_id ||
          code.redirect_uri !== body.redirect_uri || code.resource !== body.resource ||
          code.code_challenge !== createHash('sha256').update(body.code_verifier).digest('base64url')) return null;
      const grant = await tx.query<{ authorization_version: number; expires_at: Date }>(
        'SELECT authorization_version,expires_at FROM agent_connections WHERE id=$1 AND revoked_at IS NULL AND expires_at>$2 FOR UPDATE',
        [code.connection_id, now],
      );
      if (!grant.rows[0]) return null;
      await tx.query('UPDATE agent_oauth_codes SET consumed_at=$2 WHERE code_hash=$1', [hashToken(body.code), now]);
      const absolute = new Date(Math.min(now.getTime() + 90 * 86_400_000, grant.rows[0].expires_at.getTime()));
      const created = await tx.query<Family>(
        `INSERT INTO agent_oauth_families(client_id,connection_id,resource,authorization_version,created_at,absolute_expires_at,idle_expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
        [body.client_id, code.connection_id, code.resource, grant.rows[0].authorization_version, now, absolute],
      );
      return issue(tx, created.rows[0]!, now);
    }
    const token = await tx.query<{ family_id: string; consumed_at: Date | null }>(
      'SELECT * FROM agent_oauth_refresh_tokens WHERE token_hash=$1 FOR UPDATE', [hashToken(body.refresh_token)],
    );
    if (!token.rows[0]) return null;
    const { rows } = await tx.query<Family>('SELECT * FROM agent_oauth_families WHERE id=$1 FOR UPDATE', [token.rows[0].family_id]);
    const family = rows[0]!;
    if (family.client_id !== body.client_id || family.resource !== body.resource) return null;
    if (token.rows[0].consumed_at) {
      await tx.query('UPDATE agent_oauth_families SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1', [family.id, now]);
      return null;
    }
    if (family.revoked_at || family.absolute_expires_at <= now || family.idle_expires_at <= now) return null;
    const grant = await tx.query(
      `SELECT 1 FROM agent_connections WHERE id=$1 AND authorization_version=$2 AND revoked_at IS NULL AND expires_at>$3 FOR UPDATE`,
      [family.connection_id, family.authorization_version, now],
    );
    if (!grant.rows.length) return null;
    await tx.query('UPDATE agent_oauth_refresh_tokens SET consumed_at=$2 WHERE token_hash=$1', [hashToken(body.refresh_token), now]);
    return issue(tx, family, now);
  });
  if (!result) throw new AppError('unauthenticated', { message: 'Invalid OAuth grant.' });
  return result;
}
