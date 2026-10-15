import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAccountOwner } from '../authz';
import type { ServiceContext } from '../context';
import type { Db } from '../db/pool';
import { AppError } from '../errors';
import { tryConsume, utcDay, secondsUntilUtcMidnight } from '../quotas';
import { claimSession } from './accounts';
import { csrfTokenFor, hashToken, randomToken } from './auth';
import { getIdentityMail } from './identity-mail';
import { endAuthority } from './native-sessions';
import { normalizeEmail } from './passwords';

export { DevIdentityOutbox, setIdentityMail } from './identity-mail';
const secret = z.string().min(32).max(256);
export const EmailStart = z
  .object({
    email: z.string().trim().email().max(254),
    purpose: z.enum(['sign_in', 'verify', 'recover']),
    destination: z.enum(['web', 'ios', 'android']),
    state: secret,
    nonce: secret,
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    claim_session: z.boolean().default(false),
  })
  .strict();
export const EmailComplete = z
  .object({
    challenge_id: z.string().uuid(),
    token: secret,
    state: secret,
    nonce: secret,
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  })
  .strict();
type Start = z.infer<typeof EmailStart>;
type Complete = z.infer<typeof EmailComplete>;
export const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');
const accepted = {
  accepted: true,
  message: 'If this request is eligible, check your email to continue.',
} as const;

async function addressLimit(
  ctx: ServiceContext,
  email: string,
  metric: string,
  limit: number,
): Promise<boolean> {
  return (
    (await tryConsume(ctx.db, {
      bucket: `identity:${hashToken(`${ctx.config.SESSION_SECRET}:${email}`)}`,
      metric,
      day: utcDay(ctx.now()),
      limit,
    })) !== null
  );
}

/** Never returns whether an email/account exists, nor any email proof. */
export async function startEmail(ctx: ServiceContext, raw: Start): Promise<typeof accepted> {
  const input = EmailStart.parse(raw);
  const email = normalizeEmail(input.email);
  const mail = getIdentityMail(ctx.config.NODE_ENV);
  if (!(await addressLimit(ctx, email, 'email_start', 10))) return accepted;
  const existing = await ctx.db.query<{ account_id: string }>(
    'SELECT account_id FROM account_emails WHERE email=$1',
    [email],
  );
  const legacy = await ctx.db.query<{ account_id: string }>(
    'SELECT account_id FROM account_credentials WHERE email=$1',
    [email],
  );
  const verifiedId = existing.rows[0]?.account_id;
  const legacyId = legacy.rows[0]?.account_id;
  const p = ctx.principal;
  let accountId: string | null;
  if (input.purpose === 'verify') {
    // Current password/browser session proves the old UUID, email proves its address.
    if (p.kind !== 'account' || !p.sessionId) return accepted;
    if ((verifiedId && verifiedId !== p.accountId) || (legacyId && legacyId !== p.accountId))
      return accepted;
    const credential = await ctx.db.query<{ email: string }>(
      'SELECT email FROM account_credentials WHERE account_id=$1',
      [p.accountId],
    );
    if (credential.rows[0] && credential.rows[0].email !== email) return accepted;
    const bound = await ctx.db.query<{ email: string }>(
      'SELECT email FROM account_emails WHERE account_id=$1',
      [p.accountId],
    );
    if (bound.rows[0] && bound.rows[0].email !== email) return accepted;
    accountId = p.accountId;
  } else {
    // Never attach an unverified legacy identity merely by matching an email.
    if (!verifiedId && legacyId) return accepted;
    if (input.purpose === 'recover' && !verifiedId) return accepted;
    accountId = verifiedId ?? null;
  }
  if (input.claim_session && (input.destination !== 'web' || p.kind !== 'anonymous')) {
    throw new AppError('invalid_input', {
      message: 'Preview claims require the original browser session.',
    });
  }
  const token = randomToken();
  const now = ctx.now();
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO identity_challenges(email,account_id,initiating_session_id,purpose,destination,token_hash,
      state_hash,nonce_hash,code_challenge,claim_session,created_at,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      email,
      accountId,
      p.kind === 'account' || p.kind === 'anonymous' ? p.sessionId : null,
      input.purpose,
      input.destination,
      hashToken(token),
      hashToken(input.state),
      hashToken(input.nonce),
      input.code_challenge,
      input.claim_session,
      now,
      new Date(now.getTime() + 15 * 60_000),
    ],
  );
  const callback =
    input.destination === 'web'
      ? new URL('/identity/callback', ctx.config.APP_BASE_URL).toString()
      : input.destination === 'ios'
        ? 'cultureatlas://identity/callback'
        : 'https://app.cultureatlas.com/identity/callback';
  const fragment = new URLSearchParams({
    challenge_id: rows[0]!.id,
    token,
    state: input.state,
    nonce: input.nonce,
  });
  try {
    await mail.send({ to: email, purpose: input.purpose, callback: `${callback}#${fragment}` });
  } catch {
    // Provider failures must not turn account eligibility into an enumeration oracle.
    await ctx.db.query('UPDATE identity_challenges SET consumed_at=$2 WHERE id=$1', [
      rows[0]!.id,
      now,
    ]);
  }
  return accepted;
}

interface Challenge {
  id: string;
  email: string;
  account_id: string | null;
  initiating_session_id: string | null;
  purpose: Start['purpose'];
  destination: Start['destination'];
  token_hash: string;
  state_hash: string;
  nonce_hash: string;
  code_challenge: string;
  claim_session: boolean;
  expires_at: Date;
  consumed_at: Date | null;
}

export async function completeEmail(ctx: ServiceContext, raw: Complete) {
  const input = EmailComplete.parse(raw);
  const lookup = await ctx.db.query<Challenge>('SELECT * FROM identity_challenges WHERE id=$1', [
    input.challenge_id,
  ]);
  const hint = lookup.rows[0];
  if (!(await addressLimit(ctx, hint?.email ?? input.challenge_id, 'email_complete', 30))) {
    throw new AppError('rate_limited', { retryAfter: secondsUntilUtcMidnight(ctx.now()) });
  }
  return ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<Challenge>(
      'SELECT * FROM identity_challenges WHERE id=$1 FOR UPDATE',
      [input.challenge_id],
    );
    const c = rows[0];
    const now = ctx.now();
    if (
      !c ||
      c.consumed_at ||
      c.expires_at <= now ||
      c.token_hash !== hashToken(input.token) ||
      c.state_hash !== hashToken(input.state) ||
      c.nonce_hash !== hashToken(input.nonce) ||
      c.code_challenge !== pkceChallenge(input.code_verifier)
    )
      throw new AppError('unauthenticated');
    const p = ctx.principal;
    if (c.destination === 'web' || c.purpose === 'verify') {
      if (
        (p.kind !== 'anonymous' && p.kind !== 'account') ||
        !p.sessionId ||
        p.sessionId !== c.initiating_session_id
      )
        throw new AppError('unauthenticated');
    }
    if (c.purpose === 'verify' && (p.kind !== 'account' || p.accountId !== c.account_id)) {
      throw new AppError('unauthenticated');
    }
    // Serialize all identity creation/linking for this email, including parallel callbacks.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity:${c.email}`]);
    const binding = await tx.query<{ account_id: string }>(
      'SELECT account_id FROM account_emails WHERE email=$1',
      [c.email],
    );
    let accountId = c.account_id;
    if (binding.rows[0] && accountId && binding.rows[0].account_id !== accountId)
      throw new AppError('unauthenticated');
    accountId ??= binding.rows[0]?.account_id ?? null;
    if (!accountId) {
      const legacy = await tx.query('SELECT 1 FROM account_credentials WHERE email=$1', [c.email]);
      if (legacy.rowCount) throw new AppError('unauthenticated');
      const created = await tx.query<{ id: string }>(
        'INSERT INTO accounts(auth_subject) VALUES($1) RETURNING id',
        [`verified:${randomUUID()}`],
      );
      accountId = created.rows[0]!.id;
    }
    const accountBinding = await tx.query<{ email: string }>(
      'SELECT email FROM account_emails WHERE account_id=$1',
      [accountId],
    );
    if (accountBinding.rows[0] && accountBinding.rows[0].email !== c.email)
      throw new AppError('unauthenticated');
    const linked = await tx.query(
      `INSERT INTO account_emails(account_id,email,verified_at) VALUES($1,$2,$3)
       ON CONFLICT(account_id) DO UPDATE SET email=account_emails.email
       WHERE account_emails.email=EXCLUDED.email RETURNING account_id`,
      [accountId, c.email, now],
    );
    if (!linked.rowCount) throw new AppError('unauthenticated');
    await tx.query('UPDATE identity_challenges SET consumed_at=$2 WHERE id=$1', [c.id, now]);
    if (c.purpose === 'recover') {
      await revokeAll(tx, accountId, now, 'recovery');
      // Recovery removes a potentially compromised legacy password. Future
      // access uses verified email; the internal account UUID is unchanged.
      await tx.query('DELETE FROM account_credentials WHERE account_id=$1', [accountId]);
      // An older, undelivered proof cannot restore authority after recovery.
      await tx.query(
        'UPDATE identity_challenges SET consumed_at=$2 WHERE (account_id=$1 OR email=$3) AND consumed_at IS NULL',
        [accountId, now, c.email],
      );
      await tx.query(
        'UPDATE native_enrollment_grants SET consumed_at=$2 WHERE account_id=$1 AND consumed_at IS NULL',
        [accountId, now],
      );
    }
    const claimed =
      c.claim_session && c.initiating_session_id
        ? await claimSession(tx, c.initiating_session_id, accountId, now)
        : { captures: 0, saved_items: 0 };
    if (c.destination !== 'web') {
      const grant = `cne_${randomToken()}`;
      await tx.query(
        `INSERT INTO native_enrollment_grants(account_id,token_hash,platform,authenticated_at,expires_at)
         VALUES($1,$2,$3,$4,$5)`,
        [accountId, hashToken(grant), c.destination, now, new Date(now.getTime() + 5 * 60_000)],
      );
      return { account_id: accountId, enrollment_grant: grant, platform: c.destination, claimed };
    }
    if (p.kind === 'account' && p.sessionId) {
      await tx.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1', [
        p.sessionId,
        now,
      ]);
      if (p.accountId !== accountId)
        await endAuthority(tx, {
          accountId: p.accountId,
          installationId: null,
          sessionId: p.sessionId,
          reason: 'account_switch',
          now,
        });
    }
    const sessionToken = randomToken();
    const expiresAt = new Date(now.getTime() + ctx.config.ACCOUNT_SESSION_TTL_DAYS * 86400_000);
    const session = await tx.query<{ id: string }>(
      'INSERT INTO sessions(account_id,token_hash,expires_at,authenticated_at) VALUES($1,$2,$3,$4) RETURNING id',
      [accountId, hashToken(sessionToken), expiresAt, now],
    );
    return {
      account_id: accountId,
      session_id: session.rows[0]!.id,
      csrf_token: csrfTokenFor(session.rows[0]!.id, ctx.config.SESSION_SECRET),
      sessionToken,
      expiresAt,
      claimed,
    };
  });
}

export async function requireRecoverableAccount(ctx: ServiceContext): Promise<string> {
  const p = ctx.principal;
  if (p.kind !== 'account' && p.kind !== 'installation') throw new AppError('account_required');
  const result = await ctx.db.query('SELECT 1 FROM account_emails WHERE account_id=$1', [
    p.accountId,
  ]);
  if (!result.rowCount)
    throw new AppError('account_required', {
      message: 'Verify your email to use account devices and library.',
    });
  return p.accountId;
}

async function recentOwner(ctx: ServiceContext): Promise<string> {
  const p = requireAccountOwner(ctx.principal);
  const { rows } = await ctx.db.query<{ authenticated_at: Date | null }>(
    'SELECT authenticated_at FROM sessions WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL AND expires_at>$3',
    [p.sessionId, p.accountId, ctx.now()],
  );
  if (
    !rows[0]?.authenticated_at ||
    ctx.now().getTime() - rows[0].authenticated_at.getTime() > 5 * 60_000
  ) {
    throw new AppError('unauthenticated', {
      message: 'Verify your email again before changing account security.',
    });
  }
  await requireRecoverableAccount(ctx);
  return p.accountId;
}

async function revokeAll(tx: Db, accountId: string, now: Date, reason: string) {
  await tx.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE account_id=$1', [
    accountId,
    now,
  ]);
  await tx.query(
    'UPDATE native_sessions SET revoked_at=COALESCE(revoked_at,$2),revoke_reason=$3 WHERE account_id=$1',
    [accountId, now, reason],
  );
  await endAuthority(tx, { accountId, installationId: null, sessionId: null, reason, now });
}

export async function signOutAll(ctx: ServiceContext) {
  const accountId = await recentOwner(ctx);
  await ctx.db.transaction(async (tx) => {
    await revokeAll(tx, accountId, ctx.now(), 'sign_out_all');
    await tx.query(
      'UPDATE native_enrollment_grants SET consumed_at=$2 WHERE account_id=$1 AND consumed_at IS NULL',
      [accountId, ctx.now()],
    );
    await tx.query(
      `UPDATE identity_challenges SET consumed_at=$2 WHERE consumed_at IS NULL AND
       (account_id=$1 OR email IN (SELECT email FROM account_emails WHERE account_id=$1))`,
      [accountId, ctx.now()],
    );
  });
  return { signed_out: true };
}

export async function listSessions(ctx: ServiceContext) {
  const p = requireAccountOwner(ctx.principal);
  const { rows } = await ctx.db.query(
    `SELECT id,installation_id,'native' AS kind,created_at,absolute_expires_at AS expires_at,revoked_at
       FROM native_sessions WHERE account_id=$1
     UNION ALL
     SELECT id,NULL,'browser',created_at,expires_at,revoked_at FROM sessions WHERE account_id=$1
     ORDER BY created_at DESC LIMIT 100`,
    [p.accountId],
  );
  return { items: rows };
}

export async function revokeSession(ctx: ServiceContext, id: string) {
  const accountId = await recentOwner(ctx);
  await ctx.db.transaction(async (tx) => {
    const native = await tx.query<{ installation_id: string }>(
      `UPDATE native_sessions SET revoked_at=COALESCE(revoked_at,$3),revoke_reason='session_revoked'
       WHERE id=$1 AND account_id=$2 RETURNING installation_id`,
      [id, accountId, ctx.now()],
    );
    if (!native.rowCount) {
      const browser = await tx.query(
        'UPDATE sessions SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND account_id=$2',
        [id, accountId, ctx.now()],
      );
      if (!browser.rowCount) throw new AppError('not_found');
    }
    await endAuthority(tx, {
      accountId,
      installationId: native.rows[0]?.installation_id ?? null,
      sessionId: id,
      reason: 'session_revoked',
      now: ctx.now(),
    });
  });
  return { revoked: true };
}

/** Explicitly ends old authority; never binds old pending bytes to a new account. */
export async function switchAccount(ctx: ServiceContext) {
  const p = ctx.principal;
  if (p.kind !== 'account' && p.kind !== 'installation') throw new AppError('account_required');
  await ctx.db.transaction(async (tx) => {
    if (p.kind === 'installation') {
      // All families for this installation stop, not just the current access token.
      await tx.query(
        `UPDATE native_sessions SET revoked_at=COALESCE(revoked_at,$3),revoke_reason='account_switch'
         WHERE account_id=$1 AND installation_id=$2`,
        [p.accountId, p.installationId, ctx.now()],
      );
    } else {
      await tx.query(
        'UPDATE sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1 AND account_id=$3',
        [p.sessionId, ctx.now(), p.accountId],
      );
    }
    await endAuthority(tx, {
      accountId: p.accountId,
      installationId: p.kind === 'installation' ? p.installationId : null,
      sessionId: p.sessionId,
      reason: 'account_switch',
      now: ctx.now(),
    });
  });
  return {
    signed_out: true,
    pending_upload_account_id: p.accountId,
    pending_upload_policy: 'original_account_only',
  };
}
