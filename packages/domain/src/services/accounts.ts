import { createHash, randomUUID } from 'node:crypto';
import type { ServiceContext } from '../context';
import type { Db, Queryable } from '../db/pool';
import { AppError, isAppError } from '../errors';
import type { AccountPrincipal, AnonymousPrincipal } from '../principal';
import { currentUsage, tryConsume, utcDay, secondsUntilUtcMidnight } from '../quotas';
import type { ProjectionGateConfig } from '../interest-graph/intent';
import { noteExplicitIntent } from '../interest-graph/intent';
import type {
  ClaimSummary,
  CreateAccountRequest,
  CreateAccountResponse,
  PendingSave,
  PendingSaveResult,
  SessionResponse,
  SignInRequest,
  SignInResponse,
} from '../schemas/auth';
import { addDays, iso } from '../util/time';
import { createAnonymousSession, csrfTokenFor, hashToken, randomToken } from './auth';
import { addCollectionItem, createCollection } from './collections';
import { dummyPasswordHash, hashPassword, normalizeEmail, verifyPassword } from './passwords';
import { recordPreference } from './preferences';
import { bumpTasteRevision, getTasteRevision, rebuildTasteProfile } from './taste';
import { endAuthority } from './native-sessions';
import { evaluateSignInTrigger, initForNewAccount } from './onboarding';

/**
 * Accounts, demo sign-in and anonymous-session claim.
 *
 * Mechanism (documented in docs/ARCHITECTURE.md): email + password hashed with
 * scrypt. Creating an account or signing in CLAIMS the current anonymous
 * session: its captures, uploads, saved items, hides, preference events,
 * discovery items, related-discovery contexts, jobs and taste profile move to
 * the account (discovery items are merged by canonical_key), and then the
 * visitor's intended save (`pending_save`) is performed. The session token is
 * rotated on every privilege change, so a pre-login cookie can never act as
 * the account.
 */

export interface NewSession {
  sessionId: string;
  sessionToken: string;
  expiresAt: Date;
}

const SIGN_IN_FAILURES_PER_DAY = 10;

async function createAccountSession(db: Queryable, accountId: string, ctx: ServiceContext): Promise<NewSession> {
  const token = randomToken();
  const expiresAt = addDays(ctx.now(), ctx.config.ACCOUNT_SESSION_TTL_DAYS);
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO sessions (account_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id',
    [accountId, hashToken(token), expiresAt],
  );
  return { sessionId: rows[0]!.id, sessionToken: token, expiresAt };
}

/**
 * Move everything owned by an anonymous session to an account. Idempotent for
 * an already-claimed session (returns zero counts). Must run in a transaction.
 * With a projection config, the merged canonical state also commits its graph
 * projection intent here, so the claim projects exactly once and a retried
 * claim adds nothing.
 */
export async function claimSession(
  db: Queryable,
  sessionId: string,
  accountId: string,
  now: Date,
  config?: ProjectionGateConfig,
): Promise<ClaimSummary> {
  const s = await db.query<{ account_id: string | null; claimed_at: Date | null }>(
    'SELECT account_id, claimed_at FROM sessions WHERE id = $1 FOR UPDATE',
    [sessionId],
  );
  const session = s.rows[0];
  if (!session || session.account_id || session.claimed_at) return { captures: 0, saved_items: 0 };

  // 1. Merge discovery items that the account already has (same canonical identity).
  const pairs = `(SELECT s.id AS sid, a.id AS aid FROM discovery_items s
       JOIN discovery_items a ON a.owner_account_id = $2 AND a.canonical_key = s.canonical_key
      WHERE s.owner_session_id = $1)`;
  const ids = [sessionId, accountId];
  // Saved items pointing at a merged item: drop when the account already saved it.
  await db.query(
    `DELETE FROM saved_items si USING ${pairs} p
      WHERE si.owner_session_id = $1 AND si.discovery_item_id = p.sid
        AND EXISTS (SELECT 1 FROM saved_items x WHERE x.owner_account_id = $2 AND x.discovery_item_id = p.aid)`,
    ids,
  );
  await db.query(
    `UPDATE saved_items si SET discovery_item_id = p.aid FROM ${pairs} p
      WHERE si.owner_session_id = $1 AND si.discovery_item_id = p.sid`,
    ids,
  );
  await db.query(`UPDATE recommendations r SET discovery_item_id = p.aid FROM ${pairs} p WHERE r.discovery_item_id = p.sid`, ids);
  await db.query(`UPDATE discovery_jobs d SET origin_item_id = p.aid FROM ${pairs} p WHERE d.origin_item_id = p.sid`, ids);
  // Hides of a merged item are handled by canonical key below; drop the item link first.
  await db.query(`UPDATE item_exclusions e SET discovery_item_id = p.aid FROM ${pairs} p WHERE e.discovery_item_id = p.sid`, ids);
  await db.query(`DELETE FROM discovery_items d USING ${pairs} p WHERE d.id = p.sid`, ids);
  await db.query(
    `UPDATE discovery_items SET owner_account_id = $2, owner_session_id = NULL, updated_at = now() WHERE owner_session_id = $1`,
    [sessionId, accountId],
  );

  // 2. Saved items (remaining ones cannot conflict any more).
  await db.query(
    `DELETE FROM saved_items si WHERE si.owner_session_id = $1
        AND EXISTS (SELECT 1 FROM saved_items x WHERE x.owner_account_id = $2 AND x.discovery_item_id = si.discovery_item_id)`,
    [sessionId, accountId],
  );
  const saved = await db.query(
    'UPDATE saved_items SET owner_account_id = $2, owner_session_id = NULL WHERE owner_session_id = $1',
    [sessionId, accountId],
  );

  // 3. Hides (unique per owner + canonical key).
  await db.query(
    `DELETE FROM item_exclusions e WHERE e.owner_session_id = $1
        AND EXISTS (SELECT 1 FROM item_exclusions x WHERE x.owner_account_id = $2 AND x.canonical_key = e.canonical_key)`,
    [sessionId, accountId],
  );
  await db.query('UPDATE item_exclusions SET owner_account_id = $2, owner_session_id = NULL WHERE owner_session_id = $1', [
    sessionId,
    accountId,
  ]);

  // 4. Captures persist until deletion once they belong to an account.
  const captures = await db.query(
    `UPDATE captures SET owner_account_id = $2, owner_session_id = NULL, expires_at = NULL, updated_at = now()
      WHERE owner_session_id = $1`,
    [sessionId, accountId],
  );
  for (const table of ['uploads', 'preference_events', 'discovery_jobs', 'jobs', 'trace_events']) {
    await db.query(`UPDATE ${table} SET owner_account_id = $2, owner_session_id = NULL WHERE owner_session_id = $1`, [
      sessionId,
      accountId,
    ]);
  }
  await db.query('DELETE FROM feed_snapshots WHERE owner_session_id = $1', [sessionId]);

  // 5. Taste: the account revision must move forward so cached feeds/recommendations refresh.
  const taste = await db.query<{ revision: number }>('DELETE FROM taste_profiles WHERE owner_session_id = $1 RETURNING revision', [
    sessionId,
  ]);
  await bumpTasteRevision(db, { kind: 'account', accountId });
  if ((taste.rows[0]?.revision ?? 0) > 0) {
    await db.query('UPDATE taste_profiles SET revision = revision + $2 WHERE owner_account_id = $1', [
      accountId,
      taste.rows[0]!.revision,
    ]);
  }
  await rebuildTasteProfile(db, { kind: 'account', accountId });

  // 6. The anonymous token stops working; the caller issues a fresh account session.
  await db.query('UPDATE sessions SET claimed_at = $2, revoked_at = $2 WHERE id = $1', [sessionId, now]);
  // 7. PR 8: the claim projects the canonical merged state once, in this same
  //    transaction; the revision above is the one the projection must reach.
  if (config) {
    await noteExplicitIntent(db, {
      ownerAccountId: accountId,
      kind: 'claim',
      action: 'claim',
      targetTasteRevision: await getTasteRevision(db, { kind: 'account', accountId }),
      config,
      payload: { captures: captures.rowCount ?? 0, saved_items: saved.rowCount ?? 0 },
    });
  }
  return { captures: captures.rowCount ?? 0, saved_items: saved.rowCount ?? 0 };
}

/** Save the item the visitor was trying to save before the account existed. */
async function performPendingSave(
  ctx: ServiceContext,
  tx: Db,
  principal: AccountPrincipal,
  pending: PendingSave | undefined,
): Promise<PendingSaveResult | null> {
  if (!pending) return null;
  const actx: ServiceContext = { ...ctx, principal, db: tx };
  try {
    return await tx.transaction(async (inner) => {
      const c: ServiceContext = { ...actx, db: inner };
      const pref = await recordPreference(c, {
        action: 'save',
        target_type: pending.target_type,
        target_id: pending.target_id,
      });
      if (!pref.saved_item) return null;
      let collectionId: string | null = null;
      if (pending.new_collection_name) {
        collectionId = (await createCollection(c, { name: pending.new_collection_name })).id;
      } else if (pending.collection_id) {
        collectionId = pending.collection_id;
      }
      if (collectionId) {
        await addCollectionItem(c, { id: collectionId, item_id: pref.saved_item.discovery_item_id, body: {} });
      }
      return {
        saved_item_id: pref.saved_item.id,
        discovery_item_id: pref.saved_item.discovery_item_id,
        collection_id: collectionId,
      };
    });
  } catch (err) {
    // The intended save may refer to something that expired; the account is still created.
    if (isAppError(err) && (err.code === 'not_found' || err.code === 'invalid_input')) return null;
    throw err;
  }
}

function sessionResponse(ctx: ServiceContext, p: { accountId: string | null; sessionId: string; expiresAt: Date; isDemoOwner: boolean }): SessionResponse {
  return {
    principal: {
      kind: p.accountId ? 'account' : 'anonymous',
      account_id: p.accountId,
      session_id: p.sessionId,
      expires_at: iso(p.expiresAt),
      is_demo_owner: p.isDemoOwner,
    },
    csrf_token: csrfTokenFor(p.sessionId, ctx.config.SESSION_SECRET),
  };
}

/** POST /v1/accounts */
export async function createAccountImpl(
  ctx: ServiceContext,
  input: CreateAccountRequest,
): Promise<CreateAccountResponse & { sessionToken: string; expiresAt: Date }> {
  const p = ctx.principal;
  if (p.kind === 'account') throw new AppError('conflict', { message: 'You are already signed in.' });
  if (p.kind !== 'anonymous') throw new AppError('scope_denied', { message: 'Accounts are created in the browser.' });
  const anon: AnonymousPrincipal = p;
  const email = input.email ? normalizeEmail(input.email) : null;
  const passwordHash = input.password ? await hashPassword(input.password) : null;

  return ctx.db.transaction(async (tx) => {
    if (email) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity:${email}`]);
      const taken = await tx.query('SELECT 1 FROM account_credentials WHERE email = $1 UNION ALL SELECT 1 FROM account_emails WHERE email=$1', [email]);
      if (taken.rowCount) throw new AppError('conflict', { message: 'An account with this email already exists. Sign in instead.' });
    }
    const subject = email ? `email:${email}` : `device:${randomUUID()}`;
    const { rows } = await tx.query<{ id: string; is_demo_owner: boolean }>(
      'INSERT INTO accounts (auth_subject, display_name) VALUES ($1, $2) RETURNING id, is_demo_owner',
      [subject, input.display_name ?? null],
    );
    const accountId = rows[0]!.id;
    if (email && passwordHash) {
      await tx.query('INSERT INTO account_credentials (account_id, email, password_hash) VALUES ($1, $2, $3)', [
        accountId,
        email,
        passwordHash,
      ]);
    }
    const claimed = input.claim_session
      ? await claimSession(tx, anon.sessionId, accountId, ctx.now(), ctx.config)
      : { captures: 0, saved_items: 0 };
    const session = await createAccountSession(tx, accountId, ctx);
    const principal: AccountPrincipal = { kind: 'account', accountId, sessionId: session.sessionId, isDemoOwner: rows[0]!.is_demo_owner };
    const pending = await performPendingSave(ctx, tx, principal, input.pending_save);
    // Amendment 2.2: the taste questionnaire follows account creation; the
    // intended save is kept and counts as one pick.
    const onboardingRequired = await initForNewAccount(ctx, tx, accountId, pending);
    return {
      account_id: accountId,
      session_id: session.sessionId,
      claimed,
      csrf_token: csrfTokenFor(session.sessionId, ctx.config.SESSION_SECRET),
      pending_save: pending,
      onboarding_required: onboardingRequired,
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt,
    };
  });
}

function signInBucket(email: string): string {
  return `signin:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
}

/** POST /v1/session/sign-in */
export async function signIn(
  ctx: ServiceContext,
  input: SignInRequest,
): Promise<SignInResponse & { sessionToken: string; expiresAt: Date }> {
  const p = ctx.principal;
  if (p.kind !== 'anonymous' && p.kind !== 'account') {
    throw new AppError('scope_denied', { message: 'Sign in from the browser.' });
  }
  const email = normalizeEmail(input.email);
  const day = utcDay(ctx.now());
  const bucket = signInBucket(email);
  if ((await currentUsage(ctx.db, bucket, 'sign_in_failures', day)) >= SIGN_IN_FAILURES_PER_DAY) {
    throw new AppError('rate_limited', {
      message: 'Too many sign-in attempts. Try again later.',
      retryAfter: secondsUntilUtcMidnight(ctx.now()),
    });
  }
  const { rows } = await ctx.db.query<{ account_id: string; password_hash: string; is_demo_owner: boolean }>(
    `SELECT c.account_id, c.password_hash, a.is_demo_owner
       FROM account_credentials c JOIN accounts a ON a.id = c.account_id WHERE c.email = $1`,
    [email],
  );
  const row = rows[0];
  const ok = await verifyPassword(input.password, row?.password_hash ?? (await dummyPasswordHash()));
  if (!row || !ok) {
    await tryConsume(ctx.db, { bucket, metric: 'sign_in_failures', day, limit: SIGN_IN_FAILURES_PER_DAY + 1 });
    throw new AppError('unauthenticated', { message: 'Email or password is incorrect.' });
  }

  return ctx.db.transaction(async (tx) => {
    let claimed: ClaimSummary = { captures: 0, saved_items: 0 };
    if (p.kind === 'anonymous' && input.claim_session) {
      claimed = await claimSession(tx, p.sessionId, row.account_id, ctx.now(), ctx.config);
    } else if (p.sessionId) {
      await tx.query('UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1', [p.sessionId, ctx.now()]);
      if (p.kind === 'account' && p.accountId !== row.account_id) {
        await endAuthority(tx, { accountId: p.accountId, installationId: null, sessionId: p.sessionId,
          reason: 'account_switch', now: ctx.now() });
      }
    }
    const session = await createAccountSession(tx, row.account_id, ctx);
    const principal: AccountPrincipal = {
      kind: 'account',
      accountId: row.account_id,
      sessionId: session.sessionId,
      isDemoOwner: row.is_demo_owner,
    };
    const pending = await performPendingSave(ctx, tx, principal, input.pending_save);
    // Amendment 2.2: an existing account with fewer than 3 explicit saves sees
    // the questionnaire once (evaluated once per account, here).
    const onboardingRequired = await evaluateSignInTrigger(ctx, tx, row.account_id);
    return {
      ...sessionResponse(ctx, { accountId: row.account_id, sessionId: session.sessionId, expiresAt: session.expiresAt, isDemoOwner: row.is_demo_owner }),
      claimed,
      pending_save: pending,
      onboarding_required: onboardingRequired,
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt,
    };
  });
}

/** POST /v1/session/sign-out — revoke this browser session and start a fresh anonymous one. */
export async function signOut(ctx: ServiceContext): Promise<SessionResponse & { sessionToken: string; expiresAt: Date }> {
  const p = ctx.principal;
  if (p.kind !== 'anonymous' && p.kind !== 'account') {
    throw new AppError('scope_denied', { message: 'Sign out from the browser.' });
  }
  const s = await ctx.db.transaction(async (tx) => {
    if (p.sessionId) {
      await tx.query('UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1', [p.sessionId, ctx.now()]);
      if (p.kind === 'account') {
        await endAuthority(tx, { accountId: p.accountId, installationId: null, sessionId: p.sessionId,
          reason: 'sign_out', now: ctx.now() });
      }
    }
    return createAnonymousSession(tx, ctx.config, ctx.now());
  });
  return {
    ...sessionResponse(ctx, { accountId: null, sessionId: s.sessionId, expiresAt: s.expiresAt, isDemoOwner: false }),
    sessionToken: s.token,
    expiresAt: s.expiresAt,
  };
}
