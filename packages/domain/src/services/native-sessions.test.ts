import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { authorizeOperation, hasScope, requireAccountOwner } from '../authz';
import { ownerOf, principalKey } from '../principal';
import { closeTestDb, getTestDb, insertAccount, testContext } from '../testing';
import { randomToken, resolvePrincipal } from './auth';
import { switchAccount } from './identity';
import {
  consumeNativeEnrollmentGrant,
  issueNativeSession,
  peekNativeEnrollmentGrant,
  resolveNativePrincipal,
  revokeInstallationSessions,
  rotateNativeSession,
  setAuthorityLifecycle,
} from './native-sessions';
import { hashToken } from './auth';

const db = getTestDb();
const now = new Date('2026-10-15T12:00:00Z');
afterAll(closeTestDb);
afterEach(() => setAuthorityLifecycle(undefined));

async function session() {
  const account = await insertAccount(db);
  await db.query('INSERT INTO account_emails(account_id,email,verified_at) VALUES($1,$2,$3)', [
    account.accountId,
    `${randomUUID()}@example.test`,
    now,
  ]);
  const installationId = randomUUID();
  const pair = await db.transaction((tx) =>
    issueNativeSession(
      tx,
      { accountId: account.accountId, installationId, authenticatedAt: now },
      now,
    ),
  );
  return { account, installationId, pair };
}

describe('native session families', () => {
  it('issues only for verified accounts in an enrollment transaction', async () => {
    const account = await insertAccount(db);
    await expect(
      db.transaction((tx) =>
        issueNativeSession(
          tx,
          {
            accountId: account.accountId,
            installationId: randomUUID(),
            authenticatedAt: now,
          },
          now,
        ),
      ),
    ).rejects.toMatchObject({ code: 'account_required' });
    await expect(
      issueNativeSession(
        db,
        {
          accountId: account.accountId,
          installationId: randomUUID(),
          authenticatedAt: now,
        },
        now,
      ),
    ).rejects.toThrow('enrollment transaction');
  });

  it('resolves a restricted installation principal with no browser/v1 authority', async () => {
    const { account, installationId, pair } = await session();
    const p = await resolvePrincipal(db, { authorization: `Bearer ${pair.access_token}`, now });
    expect(p).toMatchObject({ kind: 'installation', accountId: account.accountId, installationId });
    expect(ownerOf(p!)).toEqual({ kind: 'account', accountId: account.accountId });
    expect(principalKey(p!)).toContain(installationId);
    expect(hasScope(p!, 'captures:write')).toBe(false);
    expect(() => requireAccountOwner(p!)).toThrow();
    expect(() =>
      authorizeOperation(p!, { method: 'GET', path: '/v1/session', auth: 'any', scopes: [] }),
    ).toThrow();
    await expect(
      resolveNativePrincipal(db, pair.access_token, new Date(now.getTime() + 601_000)),
    ).rejects.toMatchObject({ code: 'token_expired' });
    await expect(resolveNativePrincipal(db, pair.refresh_token, now)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('rotates refresh secrets and durably revokes the family on strict reuse', async () => {
    const { pair } = await session();
    const next = await rotateNativeSession(db, pair.refresh_token, now);
    expect(next.refresh_token).not.toBe(pair.refresh_token);
    await expect(rotateNativeSession(db, pair.refresh_token, now)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    await expect(resolveNativePrincipal(db, next.access_token, now)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    await expect(rotateNativeSession(db, next.refresh_token, now)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    const event = await db.query(
      'SELECT reason FROM identity_authority_events WHERE session_id=$1',
      [pair.session_id],
    );
    expect(event.rows).toMatchObject([{ reason: 'refresh_reuse' }]);
  });

  it('recovers a lost response with the same persisted request proof and invalidates unseen successor', async () => {
    const { pair, installationId } = await session();
    const retry = { installationId, refreshRequestId: randomToken() };
    const unseen = await rotateNativeSession(db, pair.refresh_token, now, retry);
    const replacement = await rotateNativeSession(
      db,
      pair.refresh_token,
      new Date(now.getTime() + 59_000),
      retry,
    );
    expect(replacement.refresh_token).not.toBe(unseen.refresh_token);
    await expect(resolveNativePrincipal(db, unseen.access_token, now)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(await resolveNativePrincipal(db, replacement.access_token, now)).toMatchObject({
      installationId,
    });
    // Even the grace caller cannot retry once its replacement has been used.
    await expect(rotateNativeSession(db, pair.refresh_token, now, retry)).rejects.toMatchObject({
      code: 'token_revoked',
    });
  });

  it.each([
    'wrong_request',
    'wrong_installation',
    'late',
    'used_refresh',
    'used_access',
    'invalidated',
  ] as const)('revokes refresh retries on %s', async (mode) => {
    const { pair, installationId } = await session();
    const retry = { installationId, refreshRequestId: randomToken() };
    const next = await rotateNativeSession(db, pair.refresh_token, now, retry);
    if (mode === 'used_access') await resolveNativePrincipal(db, next.access_token, now);
    if (mode === 'used_refresh') await rotateNativeSession(db, next.refresh_token, now);
    let replay = pair.refresh_token;
    if (mode === 'invalidated') {
      await rotateNativeSession(db, pair.refresh_token, now, retry);
      replay = next.refresh_token;
    }
    await expect(
      rotateNativeSession(
        db,
        replay,
        new Date(now.getTime() + (mode === 'late' ? 61_000 : 1_000)),
        {
          installationId: mode === 'wrong_installation' ? randomUUID() : installationId,
          refreshRequestId: mode === 'wrong_request' ? randomToken() : retry.refreshRequestId,
        },
      ),
    ).rejects.toMatchObject({ code: 'token_revoked' });
    const family = await db.query('SELECT revoked_at FROM native_sessions WHERE id=$1', [
      pair.session_id,
    ]);
    expect(family.rows[0]!.revoked_at).not.toBeNull();
  });

  it('handles concurrent rotations without permitting two valid families', async () => {
    const { pair, installationId } = await session();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        rotateNativeSession(db, pair.refresh_token, now, {
          installationId,
          refreshRequestId: randomToken(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(resolveNativePrincipal(db, pair.access_token, now)).rejects.toMatchObject({
      code: 'token_revoked',
    });
  });

  it('enforces idle and absolute expiry', async () => {
    const { pair } = await session();
    await expect(
      rotateNativeSession(db, pair.refresh_token, new Date(now.getTime() + 31 * 86400_000)),
    ).rejects.toMatchObject({ code: 'token_expired' });
    let active = pair;
    for (const day of [29, 58, 87])
      active = await rotateNativeSession(
        db,
        active.refresh_token,
        new Date(now.getTime() + day * 86400_000),
      );
    expect(new Date(active.refresh_expires_at).getTime()).toBe(now.getTime() + 90 * 86400_000);
    await expect(
      rotateNativeSession(db, active.refresh_token, new Date(now.getTime() + 90 * 86400_000)),
    ).rejects.toMatchObject({ code: 'token_expired' });
  });

  it('revokes an installation without affecting another account or installation', async () => {
    const first = await session();
    const other = await session();
    await db.transaction((tx) =>
      revokeInstallationSessions(tx, first.account.accountId, first.installationId, now),
    );
    await expect(resolveNativePrincipal(db, first.pair.access_token, now)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    expect(await resolveNativePrincipal(db, other.pair.access_token, now)).toMatchObject({
      accountId: other.account.accountId,
    });
  });

  it('ends switch authority transactionally and never supplies a new owner for pending bytes', async () => {
    const { account, pair, installationId } = await session();
    const principal = await resolveNativePrincipal(db, pair.access_token, now);
    let hooked = false;
    setAuthorityLifecycle(async (tx, event) => {
      expect(tx.inTransaction).toBe(true);
      expect(event).toMatchObject({
        accountId: account.accountId,
        installationId,
        reason: 'account_switch',
      });
      hooked = true;
    });
    const result = await switchAccount(testContext(principal, { now: () => now }));
    expect(hooked).toBe(true);
    expect(result).toMatchObject({
      pending_upload_account_id: account.accountId,
      pending_upload_policy: 'original_account_only',
    });
    await expect(resolveNativePrincipal(db, pair.access_token, now)).rejects.toMatchObject({
      code: 'token_revoked',
    });
  });

  it('rolls back revocation if the capture/upload fencing hook fails', async () => {
    const { account, pair, installationId } = await session();
    setAuthorityLifecycle(async () => {
      throw new Error('fence failed');
    });
    await expect(
      db.transaction((tx) =>
        revokeInstallationSessions(tx, account.accountId, installationId, now),
      ),
    ).rejects.toThrow('fence failed');
    expect(await resolveNativePrincipal(db, pair.access_token, now)).toMatchObject({
      installationId,
    });
  });

  it('keeps grants platform-bound, five-minute, single-use, and transactional', async () => {
    const { account } = await session();
    const token = `cne_${randomToken()}`;
    await db.query(
      'INSERT INTO native_enrollment_grants(account_id,token_hash,platform,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$5)',
      [account.accountId, hashToken(token), 'ios', now, new Date(now.getTime() + 300_000)],
    );
    await expect(peekNativeEnrollmentGrant(db, token, 'android', now)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(await peekNativeEnrollmentGrant(db, token, 'ios', now)).toMatchObject({
      accountId: account.accountId,
    });
    expect(await peekNativeEnrollmentGrant(db, token, 'ios', now)).toMatchObject({
      accountId: account.accountId,
    });
    await expect(
      peekNativeEnrollmentGrant(db, token, 'ios', new Date(now.getTime() + 300_000)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(
      db.transaction(async (tx) => {
        await consumeNativeEnrollmentGrant(tx, token, 'ios', now);
        throw new Error('enrollment failed');
      }),
    ).rejects.toThrow();
    expect(
      await db.transaction((tx) => consumeNativeEnrollmentGrant(tx, token, 'ios', now)),
    ).toMatchObject({ accountId: account.accountId });
    await expect(
      db.transaction((tx) => consumeNativeEnrollmentGrant(tx, token, 'ios', now)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
