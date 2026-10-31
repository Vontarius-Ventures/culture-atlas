import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { systemPrincipal } from '../principal';
import {
  closeTestDb,
  getTestDb,
  insertAccount,
  insertAnonymousSession,
  testConfig,
  testContext,
} from '../testing';
import { hashToken, randomToken, resolvePrincipal } from './auth';
import {
  androidIdentityCallback,
  iosIdentityCallback,
  completeEmail,
  DevIdentityOutbox,
  EmailStart,
  pkceChallenge,
  requireRecoverableAccount,
  revokeSession,
  setIdentityMail,
  signOutAll,
  startEmail,
} from './identity';
import {
  consumeNativeEnrollmentGrant,
  issueNativeSession,
  resolveNativePrincipal,
} from './native-sessions';
import { createAccountImpl, signIn } from './accounts';

const db = getTestDb();
const now = new Date('2026-10-15T12:00:00Z');
const outbox = new DevIdentityOutbox();
const email = () => `${randomUUID()}@example.test`;
const publicContext = () => testContext(systemPrincipal('test-email-exchange'), { now: () => now });
beforeEach(() => {
  outbox.clear();
  setIdentityMail(outbox);
});
afterAll(async () => {
  setIdentityMail(undefined);
  await closeTestDb();
});

async function begin(
  ctx = publicContext(),
  overrides: Partial<Parameters<typeof startEmail>[1]> = {},
) {
  const verifier = randomToken();
  const input = EmailStart.parse({
    email: email(),
    destination: 'ios',
    purpose: 'sign_in',
    state: randomToken(),
    nonce: randomToken(),
    code_challenge: pkceChallenge(verifier),
    ...overrides,
  });
  const result = await startEmail(ctx, input);
  const message = outbox.messages.at(-1);
  const fragment = message ? new URLSearchParams(new URL(message.callback).hash.slice(1)) : null;
  const proof = {
    challenge_id: fragment?.get('challenge_id') ?? randomUUID(),
    token: fragment?.get('token') ?? randomToken(),
    state: input.state,
    nonce: input.nonce,
    code_verifier: verifier,
  };
  return { input, proof, result, callback: message?.callback };
}

async function verifiedNative() {
  const request = await begin();
  const completed = await completeEmail(publicContext(), request.proof);
  if (!('enrollment_grant' in completed)) throw new Error('expected native grant');
  const pair = await db.transaction(async (tx) => {
    const grant = await consumeNativeEnrollmentGrant(tx, completed.enrollment_grant!, 'ios', now);
    return issueNativeSession(
      tx,
      {
        accountId: grant.accountId,
        installationId: randomUUID(),
        authenticatedAt: grant.authenticatedAt,
      },
      now,
    );
  });
  return { request, completed, pair };
}

describe('Android identity callback host', () => {
  it('keeps the store App Link on localhost and uses a public https APP_BASE_URL on a phone host', () => {
    expect(androidIdentityCallback('http://localhost:3000')).toBe(
      'https://app.cultureatlas.com/identity/callback',
    );
    expect(androidIdentityCallback('https://example.trycloudflare.com')).toBe(
      'https://example.trycloudflare.com/identity/callback',
    );
  });
});

describe('iOS email handoff', () => {
  it('uses a clickable HTTPS link on the configured host, not an app-only mail anchor', () => {
    expect(iosIdentityCallback('https://culture-atlas.example.ts.net')).toBe(
      'https://culture-atlas.example.ts.net/identity/callback?destination=ios',
    );
    for (const local of ['http://localhost:3000', 'https://localhost', 'https://127.0.0.1', 'invalid']) {
      expect(iosIdentityCallback(local)).toBe('cultureatlas://identity/callback');
    }
  });

  it('keeps proof in the fragment and still requires the initiating phone PKCE verifier', async () => {
    const ctx = testContext(systemPrincipal('test-ios-handoff'), {
      now: () => now,
      config: testConfig({ APP_BASE_URL: 'https://culture-atlas.example.ts.net' }),
    });
    const request = await begin(ctx);
    const callback = new URL(request.callback!);
    expect(callback.protocol).toBe('https:');
    expect(callback.search).toBe('?destination=ios');
    expect(callback.search).not.toContain(request.proof.token);
    expect(new URLSearchParams(callback.hash.slice(1)).get('token')).toBe(request.proof.token);
    await expect(completeEmail(ctx, { ...request.proof, code_verifier: randomToken() }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
    const completed = await completeEmail(ctx, request.proof);
    expect(completed).toHaveProperty('enrollment_grant');
  });
});

describe('verified email identity', () => {
  it('creates a recoverable identity, binds native grant to it, and never stores raw proofs', async () => {
    const { request, completed, pair } = await verifiedNative();
    expect(await resolveNativePrincipal(db, pair.access_token, now)).toMatchObject({
      accountId: completed.account_id,
    });
    const stored = await db.query('SELECT * FROM identity_challenges WHERE id=$1', [
      request.proof.challenge_id,
    ]);
    expect(stored.rows[0]!.token_hash).toBe(hashToken(request.proof.token));
    expect(JSON.stringify(stored.rows)).not.toContain(request.proof.token);
    const binding = await db.query('SELECT email FROM account_emails WHERE account_id=$1', [
      completed.account_id,
    ]);
    expect(binding.rows[0]!.email).toBe(request.input.email);
    expect(request.callback).toMatch(/^cultureatlas:\/\/identity\/callback#/);
    await expect(completeEmail(publicContext(), request.proof)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it.each(['state', 'nonce', 'code_verifier', 'token'] as const)(
    'rejects mismatched %s without consuming a valid proof',
    async (field) => {
      const request = await begin();
      await expect(
        completeEmail(publicContext(), { ...request.proof, [field]: randomToken() }),
      ).rejects.toMatchObject({ code: 'unauthenticated' });
      expect((await completeEmail(publicContext(), request.proof)).account_id).toBeTruthy();
    },
  );

  it('rejects expired proofs, arbitrary destinations, and caller account bindings', async () => {
    const request = await begin();
    await expect(
      completeEmail(
        testContext(systemPrincipal('test'), { now: () => new Date(now.getTime() + 15 * 60_000) }),
        request.proof,
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(() =>
      EmailStart.parse({ ...request.input, destination: 'https://attacker.test' }),
    ).toThrow();
    expect(() => EmailStart.parse({ ...request.input, account_id: randomUUID() })).toThrow();
  });

  it('preserves account UUID across independently verified devices', async () => {
    const first = await verifiedNative();
    const second = await begin(publicContext(), { email: first.request.input.email });
    const result = await completeEmail(publicContext(), second.proof);
    expect(result.account_id).toBe(first.completed.account_id);
  });

  it('serializes simultaneous new-email proofs to one internal UUID', async () => {
    const address = email();
    const first = await begin(publicContext(), { email: address });
    const second = await begin(publicContext(), { email: address });
    const results = await Promise.all([
      completeEmail(publicContext(), first.proof),
      completeEmail(publicContext(), second.proof),
    ]);
    expect(results[0]!.account_id).toBe(results[1]!.account_id);
  });

  it('does not link legacy password accounts by email alone; authenticated verification preserves UUID', async () => {
    const anon = await insertAnonymousSession(db);
    const legacy = await createAccountImpl(testContext(anon), {
      email: email(),
      password: 'long-enough-password',
      claim_session: false,
    });
    const creds = await db.query<{ email: string }>(
      'SELECT email FROM account_credentials WHERE account_id=$1',
      [legacy.account_id],
    );
    const address = creds.rows[0]!.email;
    const unknown = await begin(publicContext(), { email: address });
    expect(outbox.messages).toHaveLength(0);
    const other = await begin(publicContext(), { email: email(), purpose: 'recover' });
    expect(other.result).toEqual(unknown.result);
    const principal = await resolvePrincipal(db, { sessionToken: legacy.sessionToken });
    await expect(requireRecoverableAccount(testContext(principal!))).rejects.toMatchObject({
      code: 'account_required',
    });
    const ctx = testContext(principal!, { now: () => now });
    const verify = await begin(ctx, { email: address, destination: 'web', purpose: 'verify' });
    expect(outbox.messages).toHaveLength(1);
    const result = await completeEmail(ctx, verify.proof);
    expect(result.account_id).toBe(legacy.account_id);
    expect(await requireRecoverableAccount(ctx)).toBe(legacy.account_id);
  });

  it('lets an existing credentialless browser account verify an unused email without guessing an old account', async () => {
    const account = await insertAccount(db);
    const ctx = testContext(account, { now: () => now });
    const request = await begin(ctx, { destination: 'web', purpose: 'verify' });
    expect((await completeEmail(ctx, request.proof)).account_id).toBe(account.accountId);
    const attacker = await insertAccount(db);
    outbox.clear();
    await begin(testContext(attacker, { now: () => now }), {
      email: request.input.email,
      destination: 'web',
      purpose: 'verify',
    });
    expect(outbox.messages).toHaveLength(0);
  });

  it('requires the initiating browser session and explicitly preserves only claimed previews', async () => {
    const anon = await insertAnonymousSession(db);
    const other = await insertAnonymousSession(db);
    const ctx = testContext(anon, { now: () => now });
    const capture = await db.query<{ id: string }>(
      `INSERT INTO captures(owner_session_id,source,image_sha256,expires_at) VALUES($1,'camera',$2,$3) RETURNING id`,
      [anon.sessionId, randomToken(), anon.expiresAt],
    );
    const otherCapture = await db.query<{ id: string }>(
      `INSERT INTO captures(owner_session_id,source,image_sha256,expires_at) VALUES($1,'camera',$2,$3) RETURNING id`,
      [other.sessionId, randomToken(), other.expiresAt],
    );
    const request = await begin(ctx, { destination: 'web', claim_session: true });
    await expect(
      completeEmail(testContext(other, { now: () => now }), request.proof),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    const completed = await completeEmail(ctx, request.proof);
    expect(completed.claimed.captures).toBe(1);
    const owners = await db.query(
      'SELECT id,owner_account_id,owner_session_id FROM captures WHERE id=ANY($1::uuid[])',
      [[capture.rows[0]!.id, otherCapture.rows[0]!.id]],
    );
    expect(owners.rows.find((r) => r.id === capture.rows[0]!.id)).toMatchObject({
      owner_account_id: completed.account_id,
      owner_session_id: null,
    });
    expect(owners.rows.find((r) => r.id === otherCapture.rows[0]!.id)).toMatchObject({
      owner_session_id: other.sessionId,
      owner_account_id: null,
    });
    const unclaimed = await insertAnonymousSession(db);
    const noClaim = await begin(testContext(unclaimed, { now: () => now }), {
      destination: 'web',
      claim_session: false,
    });
    expect(
      (await completeEmail(testContext(unclaimed, { now: () => now }), noClaim.proof)).claimed
        .captures,
    ).toBe(0);
  });

  it('recovers verified accounts, revokes all sessions/grants/proofs, and removes compromised legacy passwords', async () => {
    const first = await verifiedNative();
    const address = first.request.input.email;
    const pending = await begin(publicContext(), { email: address });
    await db.query(
      'INSERT INTO account_credentials(account_id,email,password_hash) VALUES($1,$2,$3)',
      [first.completed.account_id, address, 'compromised-legacy-hash'],
    );
    const recovery = await begin(publicContext(), { email: address, purpose: 'recover' });
    const result = await completeEmail(publicContext(), recovery.proof);
    expect(result.account_id).toBe(first.completed.account_id);
    await expect(resolveNativePrincipal(db, first.pair.access_token, now)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    await expect(completeEmail(publicContext(), pending.proof)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    const passwords = await db.query('SELECT 1 FROM account_credentials WHERE account_id=$1', [
      result.account_id,
    ]);
    expect(passwords.rowCount).toBe(0);
    await expect(
      signIn(testContext(await insertAnonymousSession(db)), {
        email: address,
        password: 'old-password',
        claim_session: false,
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('requires recent verified reauthentication for session revoke and sign-out-all, with tenant-safe lookup', async () => {
    const first = await verifiedNative();
    const browser = await insertAnonymousSession(db);
    const ctx = testContext(browser, { now: () => now });
    const request = await begin(ctx, { email: first.request.input.email, destination: 'web' });
    const complete = await completeEmail(ctx, request.proof);
    if (!('sessionToken' in complete)) throw new Error('expected browser');
    const principal = await resolvePrincipal(db, { sessionToken: complete.sessionToken, now });
    const owner = testContext(principal!, { now: () => now });
    await expect(revokeSession(owner, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      signOutAll(testContext(principal!, { now: () => new Date(now.getTime() + 301_000) })),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    await revokeSession(owner, first.pair.session_id);
    await expect(resolveNativePrincipal(db, first.pair.access_token, now)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    await signOutAll(owner);
    expect(await resolvePrincipal(db, { sessionToken: complete.sessionToken, now })).toBeNull();
  });

  it('rate limits email dispatch uniformly and complete attempts per address', async () => {
    const address = email();
    let request = await begin(publicContext(), { email: address });
    for (let n = 1; n < 11; n++) await begin(publicContext(), { email: address });
    expect(outbox.messages).toHaveLength(10);
    for (let n = 0; n < 30; n++) {
      await expect(
        completeEmail(publicContext(), { ...request.proof, token: randomToken() }),
      ).rejects.toMatchObject({ code: 'unauthenticated' });
    }
    await expect(completeEmail(publicContext(), request.proof)).rejects.toMatchObject({
      code: 'rate_limited',
    });
    request = await begin(publicContext(), { email: email() });
    expect(request.result.accepted).toBe(true);
  });

  it('fails closed without a production mail adapter and hides delivery failure eligibility', async () => {
    setIdentityMail(undefined);
    await expect(
      startEmail(
        testContext(systemPrincipal('test'), {
          config: testConfig({ NODE_ENV: 'production', SESSION_SECRET: randomToken() }),
          now: () => now,
        }),
        EmailStart.parse({
          email: email(),
          destination: 'ios',
          purpose: 'sign_in',
          state: randomToken(),
          nonce: randomToken(),
          code_challenge: pkceChallenge(randomToken()),
        }),
      ),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    setIdentityMail({
      send: async () => {
        throw new Error('provider error');
      },
    });
    const failed = await begin();
    expect(failed.result.accepted).toBe(true);
  });
});
