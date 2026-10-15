import type { Db, Queryable } from '../db/pool';
import { AppError } from '../errors';
import type { InstallationPrincipal } from '../principal';
import { hashToken, randomToken } from './auth';

export interface AuthorityEnded {
  accountId: string;
  installationId: string | null;
  sessionId: string | null;
  reason: string;
  now: Date;
}
export type AuthorityLifecycle = (tx: Db, event: AuthorityEnded) => Promise<void>;
let lifecycle: AuthorityLifecycle | undefined;
export function setAuthorityLifecycle(hook: AuthorityLifecycle | undefined): void {
  lifecycle = hook;
}

/** Must be called within the same transaction that revokes authority. */
export async function endAuthority(tx: Db, event: AuthorityEnded): Promise<void> {
  if (!tx.inTransaction) throw new Error('Authority changes require a transaction');
  await tx.query(
    `INSERT INTO identity_authority_events(account_id,installation_id,session_id,reason,created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [event.accountId, event.installationId, event.sessionId, event.reason, event.now],
  );
  await lifecycle?.(tx, event);
}

export interface NativeSessionTokens {
  session_id: string;
  installation_id: string;
  account_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
}
interface Family {
  id: string;
  account_id: string;
  installation_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}
const after = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

async function tokens(tx: Db, family: Family, now: Date): Promise<NativeSessionTokens> {
  const access = `cna_${randomToken()}`;
  const refresh = `cnr_${randomToken()}`;
  const accessExpiry = new Date(
    Math.min(after(now, 600).getTime(), family.absolute_expires_at.getTime()),
  );
  const refreshExpiry = new Date(
    Math.min(after(now, 30 * 86400).getTime(), family.absolute_expires_at.getTime()),
  );
  await tx.query('INSERT INTO native_refresh_tokens(token_hash,session_id) VALUES($1,$2)', [
    hashToken(refresh),
    family.id,
  ]);
  await tx.query(
    'INSERT INTO native_access_tokens(token_hash,session_id,expires_at,refresh_hash) VALUES($1,$2,$3,$4)',
    [hashToken(access), family.id, accessExpiry, hashToken(refresh)],
  );
  await tx.query('UPDATE native_sessions SET idle_expires_at=$2 WHERE id=$1', [
    family.id,
    refreshExpiry,
  ]);
  return {
    session_id: family.id,
    installation_id: family.installation_id,
    account_id: family.account_id,
    access_token: access,
    refresh_token: refresh,
    access_expires_at: accessExpiry.toISOString(),
    refresh_expires_at: refreshExpiry.toISOString(),
  };
}

/**
 * Trusted enrollment integration only. Caller verifies installation/account
 * binding and consumes enrollment proof inside this same transaction.
 */
export async function issueNativeSession(
  tx: Db,
  input: { accountId: string; installationId: string; authenticatedAt: Date },
  now = new Date(),
): Promise<NativeSessionTokens> {
  if (!tx.inTransaction) throw new Error('Native issuance requires the enrollment transaction');
  const verified = await tx.query('SELECT 1 FROM account_emails WHERE account_id=$1', [
    input.accountId,
  ]);
  if (!verified.rowCount)
    throw new AppError('account_required', { message: 'Verify your account email first.' });
  if (input.authenticatedAt > now || now.getTime() - input.authenticatedAt.getTime() > 5 * 60_000) {
    throw new AppError('unauthenticated');
  }
  const { rows } = await tx.query<Family>(
    `INSERT INTO native_sessions(account_id,installation_id,created_at,authenticated_at,idle_expires_at,absolute_expires_at)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      input.accountId,
      input.installationId,
      now,
      input.authenticatedAt,
      after(now, 30 * 86400),
      after(now, 90 * 86400),
    ],
  );
  return tokens(tx, rows[0]!, now);
}

export async function resolveNativePrincipal(
  db: Queryable,
  token: string,
  now = new Date(),
): Promise<InstallationPrincipal> {
  if (!/^cna_[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('unauthenticated');
  const { rows } = await db.query<Family & { access_expiry: Date; accepted: boolean }>(
    `WITH family AS (
       SELECT s.*,a.expires_at AS access_expiry
       FROM native_sessions s JOIN native_access_tokens a ON a.session_id=s.id
       WHERE a.token_hash=$1 FOR UPDATE OF s
     ), used AS (
       UPDATE native_access_tokens a SET used_at=COALESCE(a.used_at,$2)
       FROM family f WHERE a.token_hash=$1 AND a.session_id=f.id
         AND f.revoked_at IS NULL AND f.access_expiry>$2
         AND f.idle_expires_at>$2 AND f.absolute_expires_at>$2
       RETURNING a.token_hash
     )
     SELECT f.*,EXISTS(SELECT 1 FROM used) AS accepted FROM family f`,
    [hashToken(token), now],
  );
  const row = rows[0];
  if (!row) throw new AppError('unauthenticated');
  if (row.revoked_at) throw new AppError('token_revoked');
  if (row.access_expiry <= now || row.idle_expires_at <= now || row.absolute_expires_at <= now) {
    throw new AppError('token_expired');
  }
  if (!row.accepted) throw new AppError('unauthenticated');
  return {
    kind: 'installation',
    accountId: row.account_id,
    installationId: row.installation_id,
    sessionId: row.id,
    expiresAt: row.access_expiry,
  };
}

/** Root transaction: reuse revocation must commit BEFORE returning an error. */
export async function rotateNativeSession(
  db: Db,
  refreshToken: string,
  now = new Date(),
  retry?: { installationId: string; refreshRequestId: string },
): Promise<NativeSessionTokens> {
  if (db.inTransaction) throw new Error('Refresh rotation requires a root database handle');
  if (!/^cnr_[A-Za-z0-9_-]{43}$/.test(refreshToken)) throw new AppError('unauthenticated');
  const result = await db.transaction(async (tx) => {
    const { rows } = await tx.query<
      Family & {
        consumed_at: Date | null;
        rotation_key_hash: string | null;
        successor_hash: string | null;
        invalidated_at: Date | null;
      }
    >(
      `SELECT s.*,r.consumed_at,r.rotation_key_hash,r.successor_hash,r.invalidated_at
       FROM native_refresh_tokens r JOIN native_sessions s ON s.id=r.session_id
       WHERE r.token_hash=$1 FOR UPDATE OF s,r`,
      [hashToken(refreshToken)],
    );
    const row = rows[0];
    if (!row) return { error: 'unauthenticated' } as const;
    if (row.revoked_at) return { error: 'token_revoked' } as const;
    const wrongInstallation = retry && retry.installationId !== row.installation_id;
    if (row.consumed_at || row.invalidated_at || wrongInstallation) {
      const grace =
        !row.invalidated_at &&
        !wrongInstallation &&
        row.consumed_at &&
        retry &&
        /^[A-Za-z0-9_-]{43}$/.test(retry.refreshRequestId) &&
        row.rotation_key_hash === hashToken(retry.refreshRequestId) &&
        now.getTime() - row.consumed_at.getTime() >= 0 &&
        now.getTime() - row.consumed_at.getTime() <= 60_000 &&
        row.idle_expires_at > now &&
        row.absolute_expires_at > now;
      if (grace && row.successor_hash) {
        const successor = await tx.query(
          `SELECT 1 FROM native_refresh_tokens r WHERE r.token_hash=$1 AND r.consumed_at IS NULL
           AND r.invalidated_at IS NULL AND NOT EXISTS (
             SELECT 1 FROM native_access_tokens a WHERE a.refresh_hash=r.token_hash AND a.used_at IS NOT NULL)`,
          [row.successor_hash],
        );
        if (successor.rowCount) {
          await tx.query('UPDATE native_refresh_tokens SET invalidated_at=$2 WHERE token_hash=$1', [
            row.successor_hash,
            now,
          ]);
          await tx.query('DELETE FROM native_access_tokens WHERE refresh_hash=$1', [
            row.successor_hash,
          ]);
          const replacement = await tokens(tx, row, now);
          await tx.query('UPDATE native_refresh_tokens SET successor_hash=$2 WHERE token_hash=$1', [
            hashToken(refreshToken),
            hashToken(replacement.refresh_token),
          ]);
          return { value: replacement };
        }
      }
      await tx.query(
        `UPDATE native_sessions SET revoked_at=$2,revoke_reason='refresh_reuse' WHERE id=$1`,
        [row.id, now],
      );
      await endAuthority(tx, {
        accountId: row.account_id,
        installationId: row.installation_id,
        sessionId: row.id,
        reason: 'refresh_reuse',
        now,
      });
      return { error: 'token_revoked' } as const;
    }
    if (row.idle_expires_at <= now || row.absolute_expires_at <= now)
      return { error: 'token_expired' } as const;
    const issued = await tokens(tx, row, now);
    await tx.query(
      'UPDATE native_refresh_tokens SET consumed_at=$2,rotation_key_hash=$3,successor_hash=$4 WHERE token_hash=$1',
      [
        hashToken(refreshToken),
        now,
        retry ? hashToken(retry.refreshRequestId) : null,
        hashToken(issued.refresh_token),
      ],
    );
    return { value: issued };
  });
  if ('error' in result) throw new AppError(result.error!);
  return result.value;
}

export async function revokeInstallationSessions(
  tx: Db,
  accountId: string,
  installationId: string,
  now = new Date(),
): Promise<void> {
  await tx.query(
    `UPDATE native_sessions SET revoked_at=COALESCE(revoked_at,$3),revoke_reason='installation_revoked'
     WHERE account_id=$1 AND installation_id=$2`,
    [accountId, installationId, now],
  );
  await endAuthority(tx, {
    accountId,
    installationId,
    sessionId: null,
    reason: 'installation_revoked',
    now,
  });
}

export async function consumeNativeEnrollmentGrant(
  tx: Db,
  token: string,
  platform: 'ios' | 'android',
  now = new Date(),
): Promise<{ accountId: string; authenticatedAt: Date }> {
  if (!tx.inTransaction) throw new Error('Enrollment proof requires a transaction');
  const { rows } = await tx.query<{ account_id: string; authenticated_at: Date }>(
    `UPDATE native_enrollment_grants SET consumed_at=$3
     WHERE token_hash=$1 AND platform=$2 AND consumed_at IS NULL AND expires_at>$3
     RETURNING account_id,authenticated_at`,
    [hashToken(token), platform, now],
  );
  if (!rows[0]) throw new AppError('unauthenticated');
  return { accountId: rows[0].account_id, authenticatedAt: rows[0].authenticated_at };
}

/** P1 challenge bootstrap only. This proof grants no general account authority. */
export async function peekNativeEnrollmentGrant(
  db: Queryable,
  token: string,
  platform: 'ios' | 'android',
  now = new Date(),
): Promise<{ accountId: string; authenticatedAt: Date }> {
  const { rows } = await db.query<{ account_id: string; authenticated_at: Date }>(
    `SELECT account_id,authenticated_at FROM native_enrollment_grants
     WHERE token_hash=$1 AND platform=$2 AND consumed_at IS NULL AND expires_at>$3`,
    [hashToken(token), platform, now],
  );
  if (!rows[0]) throw new AppError('unauthenticated');
  return { accountId: rows[0].account_id, authenticatedAt: rows[0].authenticated_at };
}
