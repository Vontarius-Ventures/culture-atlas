import type { CaptureIdentityAdapter, InstallationAuthority } from '../capture-v2/types';
import type { Queryable } from '../db/pool';
import { AppError } from '../errors';
import {
  consumeNativeEnrollmentGrant,
  issueNativeSession,
  peekNativeEnrollmentGrant,
  resolveNativePrincipal,
  revokeInstallationSessions,
} from './native-sessions';

/**
 * Production identity adapter for capture v2 (gap G1). It is a thin wrapper:
 * every rule lives in `identity.ts` / `native-sessions.ts`, so HTTP and native
 * adapters never duplicate policy.
 *
 * `requireRecoverableAccount` accepts an owner only when the account has a
 * verified email (identity's recoverability rule) and, for browser authority,
 * the session that authenticated this request is still live for that account.
 */
export function createCaptureIdentityAdapter(db: () => Queryable): CaptureIdentityAdapter {
  return {
    async requireRecoverableAccount(accountId, sessionId) {
      const { rows } = await db().query<{ verified: boolean; session_live: boolean | null }>(
        `SELECT EXISTS(SELECT 1 FROM account_emails WHERE account_id=$1) AS verified,
           CASE WHEN $2::uuid IS NULL THEN NULL ELSE EXISTS(
             SELECT 1 FROM sessions WHERE id=$2::uuid AND account_id=$1 AND revoked_at IS NULL AND expires_at>now()
           ) END AS session_live`,
        [accountId, sessionId],
      );
      const row = rows[0];
      if (row?.session_live === false) throw new AppError('unauthenticated');
      if (!row?.verified)
        throw new AppError('account_required', {
          message: 'Verify your email to use account devices and library.',
        });
    },
    peekNativeEnrollmentGrant: (tx, token, platform, now) =>
      peekNativeEnrollmentGrant(tx, token, platform, now),
    consumeNativeEnrollmentGrant: (tx, token, platform, now) =>
      consumeNativeEnrollmentGrant(tx, token, platform, now),
    issueNativeSession: async (tx, input, now) => ({
      ...(await issueNativeSession(tx, input, now)),
    }),
    revokeInstallationSessions: (tx, accountId, installationId, now) =>
      revokeInstallationSessions(tx, accountId, installationId, now),
  };
}

/** Resolves a `cna_` bearer against live family revocation on every call. */
export function createNativePrincipalResolver(
  db: () => Queryable,
): (token: string) => Promise<InstallationAuthority> {
  return (token) => resolveNativePrincipal(db(), token);
}
