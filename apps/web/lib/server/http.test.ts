import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { agentConnections, auth, collections, preferences, setDbForTesting, setDomainConfigForTesting } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, testConfig, testProviders } from '@culture-atlas/domain/testing';
import { setProvidersForTesting } from '@culture-atlas/providers';

vi.mock('server-only', () => ({}));

const { abuseLimitIp, apiRoute, clientIp } = await import('./http');

/**
 * Route-level checks of the shared /v1 middleware: anonymous session cookies,
 * CSRF, auth levels, strict bodies, Idempotency-Key, bearer tokens, cookie
 * rotation on account creation and per-IP limits. Handlers mirror the route
 * files in app/v1 (which import this helper through the "@/" alias).
 */

const session = apiRoute(ROUTES.getSession, ({ ctx }) => auth.getSessionInfo(ctx));
const createAccountRoute = apiRoute(ROUTES.createAccount, async ({ ctx, body, setSession }) => {
  const { sessionToken, expiresAt, ...response } = await auth.createAccount(ctx, body);
  setSession(sessionToken, expiresAt);
  return response;
});
const signOutRoute = apiRoute(ROUTES.signOut, async ({ ctx, setSession }) => {
  const { sessionToken, expiresAt, ...response } = await auth.signOut(ctx);
  setSession(sessionToken, expiresAt);
  return response;
});
const listCollectionsRoute = apiRoute(ROUTES.listCollections, ({ ctx }) => collections.listCollections(ctx));
const createCollectionRoute = apiRoute(ROUTES.createCollection, ({ ctx, body }) => collections.createCollection(ctx, body));
const savedRoute = apiRoute(ROUTES.listSaved, ({ ctx, query }) => preferences.listSaved(ctx, query));
const createConnectionRoute = apiRoute(ROUTES.createAgentConnection, ({ ctx, body }) => agentConnections.createAgentConnection(ctx, body));

const noParams = { params: Promise.resolve({}) };
let ipCounter = 0;

function req(path: string, init: { method?: string; cookie?: string; csrf?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': init.ip ?? `198.51.100.${++ipCounter % 250}`, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = `${auth.SESSION_COOKIE}=${init.cookie}`;
  if (init.csrf) headers[auth.CSRF_HEADER] = init.csrf;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function cookieFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie') ?? '';
  const m = new RegExp(`${auth.SESSION_COOKIE}=([^;]+)`).exec(raw);
  return m ? m[1]! : null;
}

beforeAll(() => {
  setDbForTesting(getTestDb());
  setDomainConfigForTesting(testConfig());
  setProvidersForTesting(testProviders());
});
afterAll(async () => {
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  setProvidersForTesting(undefined);
  await closeTestDb();
});

async function anonymous() {
  const res = await session(req('/v1/session'), noParams);
  const body = (await res.json()) as { csrf_token: string; principal: { kind: string } };
  return { res, cookie: cookieFrom(res)!, csrf: body.csrf_token, body };
}

describe('apiRoute middleware', () => {
  it('rejects switched v2 browser accounts before CSRF, input, idempotency or handler effects', async () => {
    const anon = await anonymous();
    const created = await createAccountRoute(req('/v1/accounts', { method: 'POST', cookie: anon.cookie, csrf: anon.csrf,
      body: { email: `v2-${randomUUID()}@example.com`, password: 'a fine password' } }), noParams);
    const cookie = cookieFrom(created)!;
    const contract = { ...ROUTES.createCollection, path: '/v2/test-collection' } as const;
    const handler = vi.fn<Parameters<typeof apiRoute<typeof contract>>[1]>(async ({ ctx, body }) => collections.createCollection(ctx, body));
    const route = apiRoute(contract, handler);
    const headerCases: Record<string, string>[] = [{}, { 'X-Atlas-Expected-Account': randomUUID() }];
    for (const headers of headerCases) {
      const response = await route(req('/v2/test-collection', { method: 'POST', cookie,
        body: { invalid: true }, headers }), noParams);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'account_mismatch' });
    }
    expect(handler).not.toHaveBeenCalled();
  });
  it('creates an HttpOnly anonymous session cookie on first GET', async () => {
    const { res, cookie, body } = await anonymous();
    expect(res.status).toBe(200);
    expect(body.principal.kind).toBe('anonymous');
    expect(cookie).toBeTruthy();
    const header = res.headers.get('set-cookie')!.toLowerCase();
    expect(header).toContain('httponly');
    expect(header).toContain('samesite=lax');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    // The same cookie resolves to the same session (no new cookie issued).
    const again = await session(req('/v1/session', { cookie }), noParams);
    expect(cookieFrom(again)).toBeNull();
  });

  it('requires a session and a CSRF token for cookie mutations', async () => {
    const none = await createCollectionRoute(req('/v1/collections', { method: 'POST', body: { name: 'x' } }), noParams);
    expect(none.status).toBe(401);
    const { cookie, csrf } = await anonymous();
    const noCsrf = await createCollectionRoute(req('/v1/collections', { method: 'POST', cookie, body: { name: 'x' } }), noParams);
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toMatchObject({ code: 'csrf_failed', retryable: false, request_id: expect.any(String) });
    const anon = await createCollectionRoute(req('/v1/collections', { method: 'POST', cookie, csrf, body: { name: 'x' } }), noParams);
    expect(anon.status).toBe(403);
    expect((await anon.json()).code).toBe('account_required');
  });

  it('creates an account, rotates the cookie and then enforces strict bodies and idempotency', async () => {
    const { cookie, csrf } = await anonymous();
    const created = await createAccountRoute(
      req('/v1/accounts', { method: 'POST', cookie, csrf, body: { email: `u-${randomUUID().slice(0, 8)}@example.com`, password: 'a fine password' } }),
      noParams,
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('sessionToken');
    expect(body).not.toHaveProperty('expiresAt');
    const acctCookie = cookieFrom(created)!;
    expect(acctCookie).toBeTruthy();
    expect(acctCookie).not.toBe(cookie);
    const acctCsrf = body.csrf_token as string;

    // The old anonymous cookie no longer authenticates mutations.
    const stale = await createCollectionRoute(req('/v1/collections', { method: 'POST', cookie, csrf, body: { name: 'x' } }), noParams);
    expect(stale.status).toBe(401);

    const unknown = await createCollectionRoute(
      req('/v1/collections', { method: 'POST', cookie: acctCookie, csrf: acctCsrf, body: { name: 'Weekend', public: true } }),
      noParams,
    );
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).code).toBe('invalid_input');

    const key = randomUUID();
    const first = await createCollectionRoute(
      req('/v1/collections', { method: 'POST', cookie: acctCookie, csrf: acctCsrf, body: { name: 'Weekend' }, headers: { 'idempotency-key': key } }),
      noParams,
    );
    expect(first.status).toBe(201);
    const replay = await createCollectionRoute(
      req('/v1/collections', { method: 'POST', cookie: acctCookie, csrf: acctCsrf, body: { name: 'Weekend' }, headers: { 'idempotency-key': key } }),
      noParams,
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual(await first.clone().json());
    const changed = await createCollectionRoute(
      req('/v1/collections', { method: 'POST', cookie: acctCookie, csrf: acctCsrf, body: { name: 'Other' }, headers: { 'idempotency-key': key } }),
      noParams,
    );
    expect(changed.status).toBe(409);
    expect((await changed.json()).code).toBe('idempotency_conflict');
    const list = await listCollectionsRoute(req('/v1/collections', { cookie: acctCookie }), noParams);
    expect(((await list.json()) as { collections: unknown[] }).collections).toHaveLength(1);

    const out = await signOutRoute(req('/v1/session/sign-out', { method: 'POST', cookie: acctCookie, csrf: acctCsrf, body: {} }), noParams);
    expect(out.status).toBe(200);
    expect(((await out.json()) as { principal: { kind: string } }).principal.kind).toBe('anonymous');
    const after = await listCollectionsRoute(req('/v1/collections', { cookie: acctCookie }), noParams);
    expect(after.status).toBe(403);
  });

  it('accepts bearer agent tokens without CSRF and rejects revoked ones immediately', async () => {
    const account = await insertAccount(getTestDb());
    const { credential, principal } = await insertAgentConnection(account, { scopes: ['collections:read', 'collections:write'], libraryAccess: 'all' });
    const ok = await createCollectionRoute(
      req('/v1/collections', { method: 'POST', body: { name: 'Agent made' }, headers: { authorization: `Bearer ${credential}` } }),
      noParams,
    );
    expect(ok.status).toBe(201);
    const denied = await savedRoute(req('/v1/saved', { headers: { authorization: `Bearer ${credential}` } }), noParams);
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe('scope_denied');
    await getTestDb().query('UPDATE agent_connections SET revoked_at = now() WHERE id = $1', [principal.connectionId]);
    const revoked = await listCollectionsRoute(req('/v1/collections', { headers: { authorization: `Bearer ${credential}` } }), noParams);
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).code).toBe('token_revoked');
  });

  it('applies per-IP abuse limits to mutations', async () => {
    setDomainConfigForTesting(testConfig({ IP_DAILY_REQUESTS: '2' }));
    try {
      const ip = `192.0.2.${Math.floor(Math.random() * 250)}:${randomUUID()}`;
      const { cookie, csrf } = await anonymous();
      for (let i = 0; i < 2; i++) {
        const r = await createCollectionRoute(req('/v1/collections', { method: 'POST', cookie, csrf, body: { name: 'x' }, ip }), noParams);
        expect(r.status).toBe(403);
      }
      const limited = await createCollectionRoute(req('/v1/collections', { method: 'POST', cookie, csrf, body: { name: 'x' }, ip }), noParams);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
    } finally {
      setDomainConfigForTesting(testConfig());
    }
  });

  it('a client cannot escape the per-IP limit by sending its own X-Forwarded-For entries', async () => {
    setDomainConfigForTesting(testConfig({ IP_DAILY_REQUESTS: '2' }));
    try {
      const real = `192.0.2.${Math.floor(Math.random() * 250)}-${randomUUID()}`;
      const { cookie, csrf } = await anonymous();
      // The proxy appends the address it saw; the left entries are whatever the client sent.
      const spoofed = () => ({ ip: `${randomUUID()}, ${real}` });
      for (let i = 0; i < 2; i++) {
        const r = await createCollectionRoute(req('/v1/collections', { method: 'POST', cookie, csrf, body: { name: 'x' }, ...spoofed() }), noParams);
        expect(r.status).toBe(403);
      }
      const limited = await createCollectionRoute(req('/v1/collections', { method: 'POST', cookie, csrf, body: { name: 'x' }, ...spoofed() }), noParams);
      expect(limited.status).toBe(429);
    } finally {
      setDomainConfigForTesting(testConfig());
    }
  });

  it('creating an agent connection with an Idempotency-Key never stores or replays the credential', async () => {
    const { cookie, csrf } = await anonymous();
    const created = await createAccountRoute(req('/v1/accounts', { method: 'POST', cookie, csrf, body: {} }), noParams);
    const acctCookie = cookieFrom(created)!;
    const acctCsrf = ((await created.json()) as { csrf_token: string }).csrf_token;
    const key = randomUUID();
    const make = () =>
      createConnectionRoute(
        req('/v1/agent-connections', {
          method: 'POST',
          cookie: acctCookie,
          csrf: acctCsrf,
          body: { client_name: 'Demo agent', library_access: 'all' },
          headers: { 'idempotency-key': key },
        }),
        noParams,
      );
    const first = await make();
    expect(first.status).toBe(201);
    const credential = ((await first.json()) as { credential: string }).credential;
    expect(credential).toMatch(/^cat_/);
    const stored = await getTestDb().query<{ b: string }>(`SELECT response_body::text AS b FROM idempotency_keys WHERE key = $1`, [key]);
    expect(stored.rows[0]!.b).not.toContain(credential);
    const replay = await make();
    expect(replay.status).toBe(409);
    expect(JSON.stringify(await replay.json())).not.toContain(credential);
  });
});

describe('clientIp', () => {
  const r = (headers: Record<string, string>) => new Request('http://localhost:3000/v1/session', { headers });
  const cfg = (hops = 1, header?: string) => ({ TRUSTED_PROXY_HOPS: hops, CLIENT_IP_HEADER: header });

  it('reads the entry appended by the trusted proxy, never the client-supplied left-most one', () => {
    expect(clientIp(r({ 'x-forwarded-for': '203.0.113.9' }), cfg())).toBe('203.0.113.9');
    expect(clientIp(r({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), cfg())).toBe('203.0.113.9');
    expect(clientIp(r({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }), cfg(2))).toBe('203.0.113.9');
    // Fewer hops than configured proxies: the header did not come through them.
    expect(clientIp(r({ 'x-forwarded-for': '203.0.113.9' }), cfg(2))).toBeNull();
    // X-Real-IP is client-controllable unless the platform sets it: ignored by default.
    expect(clientIp(r({ 'x-real-ip': '6.6.6.6' }), cfg())).toBeNull();
  });

  it('prefers a configured platform header', () => {
    expect(clientIp(r({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6' }), cfg(1, 'cf-connecting-ip'))).toBe('203.0.113.7');
    expect(clientIp(r({ 'x-forwarded-for': '6.6.6.6' }), cfg(1, 'cf-connecting-ip'))).toBeNull();
  });

  it('fails closed in production when no address is available', () => {
    expect(abuseLimitIp(r({}), testConfig({ NODE_ENV: 'production', SESSION_SECRET: 'prod-secret-for-test' }))).toBe('unknown');
    expect(abuseLimitIp(r({}), testConfig())).toBeNull();
  });
});
