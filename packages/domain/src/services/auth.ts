import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DomainConfig } from '../config';
import type { Db, Queryable } from '../db/pool';
import type { LibraryAccess, Scope } from '../enums';
import { AppError } from '../errors';
import { createAccountImpl } from './accounts';
import type { Principal } from '../principal';
import type { CreateAccountRequest, CreateAccountResponse, SessionResponse } from '../schemas/auth';
import type { ServiceContext } from '../context';
import { addHours, iso } from '../util/time';
import { resolveNativePrincipal } from './native-sessions';

/**
 * Sessions, principals and credentials.
 *  - Browser: HttpOnly cookie `ca_session` holds a random token; DB stores sha256.
 *    Anonymous sessions expire after ANON_SESSION_TTL_HOURS (24h).
 *  - CSRF: double-submit; `ca_csrf` cookie + `x-csrf-token` header must both
 *    equal HMAC(session_id, SESSION_SECRET) for cookie-authenticated mutations.
 *  - Agents: `Authorization: Bearer cat_<prefix>_<secret>`; DB stores sha256.
 */

export const SESSION_COOKIE = 'ca_session';
export const CSRF_COOKIE = 'ca_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const AGENT_TOKEN_PREFIX = 'cat_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Random URL-safe secret. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** New agent/bridge credential: "cat_<prefix>_<secret>"; store only hash + prefix. */
export function generateAgentCredential(): { credential: string; hash: string; prefix: string } {
  const prefix = randomBytes(4).toString('hex');
  const credential = `${AGENT_TOKEN_PREFIX}${prefix}_${randomToken(32)}`;
  return { credential, hash: hashToken(credential), prefix };
}

export function csrfTokenFor(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');
}

export function verifyCsrf(sessionId: string, secret: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const expected = Buffer.from(csrfTokenFor(sessionId, secret));
  const got = Buffer.from(provided);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export async function createAnonymousSession(
  db: Queryable,
  config: Pick<DomainConfig, 'ANON_SESSION_TTL_HOURS'>,
  now: Date = new Date(),
): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = addHours(now, config.ANON_SESSION_TTL_HOURS);
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO sessions (token_hash, expires_at) VALUES ($1, $2) RETURNING id',
    [hashToken(token), expiresAt],
  );
  return { sessionId: rows[0]!.id, token, expiresAt };
}

interface SessionRow {
  id: string;
  account_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  is_demo_owner: boolean | null;
}

interface AgentRow {
  id: string;
  owner_account_id: string;
  client_name: string;
  purpose: 'agent' | 'sensor_bridge';
  scopes: Scope[];
  library_access: LibraryAccess;
  sensor_connection_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  collection_ids: string[] | null;
}

/**
 * Resolve the caller. Bearer credentials take precedence over cookies.
 * Returns null when no credential is presented (route decides whether to
 * create an anonymous session). Throws unauthenticated / token_expired /
 * token_revoked for presented-but-invalid credentials.
 */
export async function resolvePrincipal(
  db: Queryable,
  input: { sessionToken?: string | null; authorization?: string | null; now?: Date },
): Promise<Principal | null> {
  const now = input.now ?? new Date();
  const auth = input.authorization?.trim();
  if (auth) {
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!match) throw new AppError('unauthenticated');
    if (match[1]!.startsWith('cna_')) return resolveNativePrincipal(db, match[1]!, now);
    const { rows } = await db.query<AgentRow>(
      `SELECT ac.id, ac.owner_account_id, ac.client_name, ac.purpose, ac.scopes, ac.library_access,
              ac.sensor_connection_id, ac.expires_at, ac.revoked_at,
              ARRAY(SELECT collection_id FROM agent_connection_collections acc
                     WHERE acc.agent_connection_id = ac.id) AS collection_ids
         FROM agent_connections ac WHERE ac.credential_hash = $1`,
      [hashToken(match[1]!)],
    );
    const row = rows[0];
    if (!row) throw new AppError('unauthenticated');
    if (row.revoked_at) throw new AppError('token_revoked');
    if (row.expires_at <= now) throw new AppError('token_expired');
    await db.query('UPDATE agent_connections SET last_used_at = $2 WHERE id = $1', [row.id, now]);
    return {
      kind: 'agent',
      accountId: row.owner_account_id,
      connectionId: row.id,
      clientName: row.client_name,
      purpose: row.purpose,
      scopes: row.scopes,
      libraryAccess: row.library_access,
      allowedCollectionIds: row.collection_ids ?? [],
      sensorConnectionId: row.sensor_connection_id,
      expiresAt: row.expires_at,
    };
  }

  if (!input.sessionToken) return null;
  const { rows } = await db.query<SessionRow>(
    `SELECT s.id, s.account_id, s.expires_at, s.revoked_at, a.is_demo_owner
       FROM sessions s LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1`,
    [hashToken(input.sessionToken)],
  );
  const row = rows[0];
  // Expired/unknown cookies are treated as absent so the visitor gets a fresh session.
  if (!row || row.revoked_at || row.expires_at <= now) return null;
  if (row.account_id) {
    return { kind: 'account', accountId: row.account_id, sessionId: row.id, isDemoOwner: !!row.is_demo_owner };
  }
  return { kind: 'anonymous', sessionId: row.id, expiresAt: row.expires_at };
}

/** GET /v1/session */
export async function getSessionInfo(ctx: ServiceContext): Promise<SessionResponse> {
  const p = ctx.principal;
  if (p.kind === 'anonymous') {
    return {
      principal: { kind: 'anonymous', account_id: null, session_id: p.sessionId, expires_at: iso(p.expiresAt), is_demo_owner: false },
      csrf_token: csrfTokenFor(p.sessionId, ctx.config.SESSION_SECRET),
    };
  }
  if (p.kind === 'account' && p.sessionId) {
    const { rows } = await ctx.db.query<{ expires_at: Date }>('SELECT expires_at FROM sessions WHERE id = $1', [p.sessionId]);
    return {
      principal: { kind: 'account', account_id: p.accountId, session_id: p.sessionId, expires_at: iso(rows[0]?.expires_at ?? null), is_demo_owner: p.isDemoOwner },
      csrf_token: csrfTokenFor(p.sessionId, ctx.config.SESSION_SECRET),
    };
  }
  throw new AppError('scope_denied', { message: 'Session info is only available to browser sessions.' });
}

/**
 * POST /v1/accounts — create an account and claim the current anonymous
 * session (move its captures, saved items, preference events, taste profile,
 * jobs and discovery items to the account; dedupe by canonical_key), then
 * perform `pending_save` if given. Returns the new session token for the cookie.
 * Returning users sign in with email + password (services/accounts.ts).
 */
export async function createAccount(
  ctx: ServiceContext,
  input: CreateAccountRequest,
): Promise<CreateAccountResponse & { sessionToken: string; expiresAt: Date }> {
  return createAccountImpl(ctx, input);
}

export { signIn, signOut, claimSession } from './accounts';

export type { Db };
