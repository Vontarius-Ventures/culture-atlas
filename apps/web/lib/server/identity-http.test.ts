import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  auth,
  identity,
  nativeSessions,
  setDbForTesting,
  setDomainConfigForTesting,
} from '@culture-atlas/domain';
import { closeTestDb, getTestDb, testConfig } from '@culture-atlas/domain/testing';

vi.mock('server-only', () => ({}));
const { identityRoute } = await import('./identity-http');
const db = getTestDb();
const outbox = new identity.DevIdentityOutbox();
let ip = 0;
function request(
  path: string,
  body?: unknown,
  options: {
    cookie?: string;
    csrf?: string;
    ip?: string;
    authorization?: string;
    method?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': options.ip ?? `203.0.113.${++ip % 250}`,
  };
  if (options.cookie) headers.cookie = `ca_session=${options.cookie}`;
  if (options.csrf) headers['x-csrf-token'] = options.csrf;
  if (options.authorization) headers.authorization = options.authorization;
  return new NextRequest(`http://localhost:3306/v2/identity/${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeAll(() => {
  setDbForTesting(db);
  setDomainConfigForTesting(testConfig());
});
beforeEach(() => {
  outbox.clear();
  identity.setIdentityMail(outbox);
});
afterAll(async () => {
  identity.setIdentityMail(undefined);
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  await closeTestDb();
});

async function start(destination: 'web' | 'ios' = 'ios', cookie?: string, csrf?: string) {
  const verifier = auth.randomToken();
  const body = {
    email: `${randomUUID()}@example.test`,
    purpose: 'sign_in',
    destination,
    state: auth.randomToken(),
    nonce: auth.randomToken(),
    code_challenge: identity.pkceChallenge(verifier),
  };
  const response = await identityRoute(
    request('email/start', body, { cookie, csrf }),
    'email/start',
  );
  expect(response.status).toBe(200);
  const fragment = new URLSearchParams(new URL(outbox.messages.at(-1)!.callback).hash.slice(1));
  return {
    body,
    response,
    proof: {
      challenge_id: fragment.get('challenge_id'),
      token: fragment.get('token'),
      state: body.state,
      nonce: body.nonce,
      code_verifier: verifier,
    },
  };
}

describe('identity HTTP boundary', () => {
  it('allows only proof-based native bootstrap, with no cookie required or secrets in start responses', async () => {
    const first = await start();
    const accepted = await first.response.json();
    expect(accepted).toEqual({ accepted: true, message: expect.any(String) });
    const result = await identityRoute(request('email/complete', first.proof), 'email/complete');
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    const grant = await result.json();
    expect(grant.enrollment_grant).toMatch(/^cne_/);
    expect(grant).not.toHaveProperty('sessionToken');
    const replay = await identityRoute(request('email/complete', first.proof), 'email/complete');
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({
      error: { code: 'unauthenticated', request_id: expect.any(String) },
    });
  });

  it('checks browser CSRF on both exchanges, rotates HttpOnly cookie, and omits private session token from JSON', async () => {
    const anon = await auth.createAnonymousSession(db, testConfig());
    const csrf = auth.csrfTokenFor(anon.sessionId, testConfig().SESSION_SECRET);
    const denied = await identityRoute(
      request('email/start', {}, { cookie: anon.token }),
      'email/start',
    );
    expect(denied.status).toBe(403);
    const first = await start('web', anon.token, csrf);
    const noCsrf = await identityRoute(
      request('email/complete', first.proof, { cookie: anon.token }),
      'email/complete',
    );
    expect(noCsrf.status).toBe(403);
    const complete = await identityRoute(
      request('email/complete', first.proof, { cookie: anon.token, csrf }),
      'email/complete',
    );
    expect(complete.status).toBe(200);
    const cookie = complete.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=lax');
    expect(cookie).not.toContain(anon.token);
    expect(await complete.json()).not.toHaveProperty('sessionToken');
  });

  it('rotates native refresh without an expired bearer and enforces retry installation binding', async () => {
    const first = await start();
    const complete = await identityRoute(request('email/complete', first.proof), 'email/complete');
    const grant = await complete.json();
    const pair = await db.transaction(async (tx) => {
      const proof = await nativeSessions.consumeNativeEnrollmentGrant(
        tx,
        grant.enrollment_grant,
        'ios',
      );
      return nativeSessions.issueNativeSession(tx, {
        accountId: proof.accountId,
        authenticatedAt: proof.authenticatedAt,
        installationId: randomUUID(),
      });
    });
    const body = {
      refresh_token: pair.refresh_token,
      installation_id: pair.installation_id,
      refresh_request_id: auth.randomToken(),
    };
    const rotated = await identityRoute(request('native/refresh', body), 'native/refresh');
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get('cache-control')).toBe('no-store');
    const replay = await identityRoute(
      request('native/refresh', { ...body, installation_id: randomUUID() }),
      'native/refresh',
    );
    expect(replay.status).toBe(401);
    await expect(
      nativeSessions.resolveNativePrincipal(db, (await rotated.json()).access_token),
    ).rejects.toMatchObject({ code: 'token_revoked' });
  });

  it('rate limits email starts by trusted IP, independent of address eligibility', async () => {
    const address = '198.18.0.66';
    for (let n = 0; n < 30; n++) {
      const response = await identityRoute(
        request(
          'email/start',
          {
            email: `${randomUUID()}@example.test`,
            purpose: 'recover',
            destination: 'ios',
            state: auth.randomToken(),
            nonce: auth.randomToken(),
            code_challenge: identity.pkceChallenge(auth.randomToken()),
          },
          { ip: address },
        ),
        'email/start',
      );
      expect(response.status).toBe(200);
    }
    const denied = await identityRoute(request('email/start', {}, { ip: address }), 'email/start');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).toBeTruthy();
    expect(outbox.messages).toHaveLength(0);
  });

  it('rejects unknown fields, oversized bodies, untrusted callbacks, and owner endpoints without identity', async () => {
    expect(
      (
        await identityRoute(
          request('email/start', { redirect_uri: 'https://attacker.test' }),
          'email/start',
        )
      ).status,
    ).toBe(400);
    expect(
      (await identityRoute(request('email/start', { padding: 'x'.repeat(9000) }), 'email/start'))
        .status,
    ).toBe(413);
    expect(
      (await identityRoute(request('sessions', undefined, { method: 'GET' }), 'sessions')).status,
    ).toBe(401);
    expect((await identityRoute(request('switch', {}), 'switch')).status).toBe(401);
  });
});
