import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auth, setDbForTesting, setDomainConfigForTesting } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, testConfig, testProviders } from '@culture-atlas/domain/testing';
import { ProviderError, setProvidersForTesting } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';

vi.mock('server-only', () => ({}));

/**
 * The real /v1/onboarding/* and /v1/taste/picks route files through the shared
 * middleware: owner-only auth, CSRF, strict bodies, response contracts, the
 * 409 below three picks, Qloo-down search and agent scopes on taste picks.
 */
const session = await import('../../app/v1/session/route');
const accounts = await import('../../app/v1/accounts/route');
const catalogRoute = await import('../../app/v1/onboarding/catalog/route');
const searchRoute = await import('../../app/v1/onboarding/search/route');
const picksRoute = await import('../../app/v1/onboarding/picks/route');
const pickRoute = await import('../../app/v1/onboarding/picks/[id]/route');
const exclusionsRoute = await import('../../app/v1/onboarding/exclusions/route');
const completeRoute = await import('../../app/v1/onboarding/complete/route');
const stateRoute = await import('../../app/v1/onboarding/state/route');
const seedRoute = await import('../../app/v1/onboarding/seed/route');
const tastePicks = await import('../../app/v1/taste/picks/route');
const tastePick = await import('../../app/v1/taste/picks/[id]/route');

const noParams = { params: Promise.resolve({}) };
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
let ip = 0;

function req(path: string, init: { method?: string; cookie?: string; csrf?: string; body?: unknown; bearer?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': `203.0.113.${++ip % 250}` };
  if (init.cookie) headers.cookie = `${auth.SESSION_COOKIE}=${init.cookie}`;
  if (init.csrf) headers[auth.CSRF_HEADER] = init.csrf;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.method && init.method !== 'GET') headers['idempotency-key'] = randomUUID();
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function cookieFrom(res: Response): string {
  const m = new RegExp(`${auth.SESSION_COOKIE}=([^;]+)`).exec(res.headers.get('set-cookie') ?? '');
  return m![1]!;
}

async function signedUp() {
  const anon = await session.GET(req('/v1/session'), noParams);
  const a = (await anon.json()) as { csrf_token: string };
  const created = await accounts.POST(
    req('/v1/accounts', { method: 'POST', cookie: cookieFrom(anon), csrf: a.csrf_token, body: { email: `h-${randomUUID()}@example.com`, password: 'a long password' } }),
    noParams,
  );
  const body = (await created.json()) as { csrf_token: string; onboarding_required: boolean; account_id: string };
  return { cookie: cookieFrom(created), csrf: body.csrf_token, body };
}

let qlooDown = false;
beforeAll(() => {
  setDbForTesting(getTestDb());
  setDomainConfigForTesting(testConfig());
  setProvidersForTesting(
    testProviders({
      qloo: new FakeQloo(
        {
          search: (q) =>
            qlooDown
              ? new ProviderError('qloo', 'server', 'down')
              : [{ entity_id: `E-${q}`, name: 'Nina Simone', types: ['urn:entity:artist'], properties: {}, tags: [] }],
        },
        { live: true },
      ),
    }),
  );
});
afterAll(async () => {
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  setProvidersForTesting(undefined);
  await closeTestDb();
});

describe('/v1/onboarding over HTTP', () => {
  it('runs the questionnaire end to end for a new account', async () => {
    const { cookie, csrf, body } = await signedUp();
    expect(body.onboarding_required).toBe(true);
    const me = await (await session.GET(req('/v1/session', { cookie }), noParams)).json();
    expect(me).toMatchObject({ onboarding_required: true });

    const catalog = await catalogRoute.GET(req('/v1/onboarding/catalog', { cookie }), noParams);
    expect(catalog.status).toBe(200);
    const c = (await catalog.json()) as { images: { id: string }[]; chips: Record<string, { id: string }[]> };

    // CSRF and strict bodies (a client cannot submit its own Qloo id).
    const noCsrf = await picksRoute.POST(req('/v1/onboarding/picks', { method: 'POST', cookie, body: { source: 'catalog', catalog_item_id: c.images[0]!.id } }), noParams);
    expect(noCsrf.status).toBe(403);
    const forged = await picksRoute.POST(
      req('/v1/onboarding/picks', { method: 'POST', cookie, csrf, body: { source: 'catalog', catalog_item_id: c.images[0]!.id, qloo_id: 'urn:tag:x' } }),
      noParams,
    );
    expect(forged.status).toBe(400);

    const first = await picksRoute.POST(req('/v1/onboarding/picks', { method: 'POST', cookie, csrf, body: { source: 'catalog', catalog_item_id: c.images[0]!.id } }), noParams);
    expect(first.status).toBe(201);
    const firstPick = ((await first.json()) as { pick: { id: string } }).pick;
    await picksRoute.POST(req('/v1/onboarding/picks', { method: 'POST', cookie, csrf, body: { source: 'catalog', catalog_item_id: c.chips.eat![0]!.id } }), noParams);

    const early = await completeRoute.POST(req('/v1/onboarding/complete', { method: 'POST', cookie, csrf, body: {} }), noParams);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: 'conflict', message: 'Pick at least 3 so your feed starts with you.' });

    const found = (await (await searchRoute.GET(req('/v1/onboarding/search?q=nina', { cookie }), noParams)).json()) as {
      status: string;
      results: { result_id: string; name: string; type_label: string }[];
    };
    expect(found).toMatchObject({ status: 'ok', results: [{ name: 'Nina Simone', type_label: 'Artist' }] });
    const third = await picksRoute.POST(req('/v1/onboarding/picks', { method: 'POST', cookie, csrf, body: { source: 'search', result_id: found.results[0]!.result_id } }), noParams);
    expect(third.status).toBe(201);

    const excl = await exclusionsRoute.PUT(req('/v1/onboarding/exclusions', { method: 'PUT', cookie, csrf, body: { food_exclusions: ['peanuts'] } }), noParams);
    expect(await excl.json()).toEqual({ food_exclusions: ['peanuts'] });

    const done = await completeRoute.POST(req('/v1/onboarding/complete', { method: 'POST', cookie, csrf, body: {} }), noParams);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ state: { required: false, picks_count: 3 }, seed: { state: 'queued' } });
    expect((await (await seedRoute.GET(req('/v1/onboarding/seed', { cookie }), noParams)).json()) as object).toMatchObject({ state: 'queued' });

    const state = await (await stateRoute.GET(req('/v1/onboarding/state', { cookie }), noParams)).json();
    expect(state).toMatchObject({ state: { picks_count: 3, required: false }, food_exclusions: ['peanuts'] });

    // Settings -> Taste: remove below the minimum is allowed.
    const listed = await (await tastePicks.GET(req('/v1/taste/picks', { cookie }), noParams)).json();
    expect(listed).toMatchObject({ picks_count: 3, food_exclusions: ['peanuts'] });
    const removed = await tastePick.DELETE(req(`/v1/taste/picks/${firstPick.id}`, { method: 'DELETE', cookie, csrf }), withId(firstPick.id));
    expect(await removed.json()).toMatchObject({ removed_pick_id: firstPick.id, state: { picks_count: 2 } });
    const gone = await pickRoute.DELETE(req(`/v1/onboarding/picks/${firstPick.id}`, { method: 'DELETE', cookie, csrf }), withId(firstPick.id));
    expect(gone.status).toBe(404);
  });

  it('reports search unavailable when Qloo is down, and refuses anonymous visitors', async () => {
    const { cookie } = await signedUp();
    qlooDown = true;
    try {
      const res = await searchRoute.GET(req('/v1/onboarding/search?q=nina', { cookie }), noParams);
      expect(await res.json()).toEqual({ status: 'unavailable', results: [] });
    } finally {
      qlooDown = false;
    }
    const anon = await session.GET(req('/v1/session'), noParams);
    const denied = await catalogRoute.GET(req('/v1/onboarding/catalog', { cookie: cookieFrom(anon) }), noParams);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'account_required' });
  });

  it('agents: taste picks need taste:read, exclusions need preferences:read, onboarding is owner-only', async () => {
    const owner = await insertAccount();
    const tasteOnly = await insertAgentConnection(owner, { scopes: ['taste:read'] });
    const withPrefs = await insertAgentConnection(owner, { scopes: ['taste:read', 'preferences:read'] });
    const noTaste = await insertAgentConnection(owner, { scopes: ['collections:read'] });

    const a = await tastePicks.GET(req('/v1/taste/picks', { bearer: tasteOnly.credential }), noParams);
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ picks_count: 0, food_exclusions: null });
    const b = await tastePicks.GET(req('/v1/taste/picks', { bearer: withPrefs.credential }), noParams);
    expect(await b.json()).toMatchObject({ food_exclusions: [] });
    expect((await tastePicks.GET(req('/v1/taste/picks', { bearer: noTaste.credential }), noParams)).status).toBe(403);
    for (const res of [
      await catalogRoute.GET(req('/v1/onboarding/catalog', { bearer: withPrefs.credential }), noParams),
      await tastePicks.POST(req('/v1/taste/picks', { method: 'POST', bearer: withPrefs.credential, body: { source: 'catalog', catalog_item_id: 'chip-play-jazz' } }), noParams),
    ]) {
      expect(res.status).toBe(403);
    }
  });
});
