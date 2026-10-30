import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  auth,
  nativeSessions,
  setDbForTesting,
  setDomainConfigForTesting,
} from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAccount, testConfig, testProviders } from '@culture-atlas/domain/testing';
import { setProvidersForTesting } from '@culture-atlas/providers';

vi.mock('server-only', () => ({}));

const deletionRoute = (await import('../../app/v2/me/account-deletion/route')).GET;
const acceptRoute = (await import('../../app/v2/me/account-deletion/route')).POST;
const statusRoute = (await import('../../app/v2/account-deletion/status/route')).GET;

/**
 * Owner/native/public surface matrix for account deletion (VAL-DELETE-002):
 * the overview and the acceptance are owner operations (browser session with
 * CSRF, or the owner's enrolled phone naming the account); agents and
 * anonymous visitors are refused; the one-time status token answers the
 * public status route without restoring any authority; old cookies lose
 * access the moment acceptance commits.
 */

const db = getTestDb();
const config = testConfig();
let ipCounter = 0;

function req(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    csrf?: string;
    bearer?: string;
    expectedAccount?: string;
    deletionToken?: string;
    body?: unknown;
  } = {},
) {
  const headers: Record<string, string> = { 'x-forwarded-for': `198.51.100.${++ipCounter % 250}` };
  if (init.cookie) headers.cookie = `${auth.SESSION_COOKIE}=${init.cookie}`;
  if (init.csrf) headers[auth.CSRF_HEADER] = init.csrf;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.expectedAccount) headers['x-atlas-expected-account'] = init.expectedAccount;
  if (init.deletionToken) headers['x-atlas-deletion-token'] = init.deletionToken;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeAll(() => {
  setDbForTesting(db);
  setDomainConfigForTesting(config);
  setProvidersForTesting(testProviders());
});
afterAll(async () => {
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  setProvidersForTesting(undefined);
  await closeTestDb();
});

async function browserOwner() {
  const principal = await insertAccount(db);
  const token = randomUUID();
  await db.query('UPDATE sessions SET token_hash=$2 WHERE id=$1', [principal.sessionId, auth.hashToken(token)]);
  return { account: principal, cookie: token, csrf: auth.csrfTokenFor(principal.sessionId!, config.SESSION_SECRET) };
}

async function nativePhone(accountId: string) {
  await db.query('INSERT INTO account_emails(account_id,email,verified_at) VALUES($1,$2,now()) ON CONFLICT DO NOTHING', [
    accountId,
    `${randomUUID()}@example.test`,
  ]);
  const { rows: installation } = await db.query<{ id: string }>(
    `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version)
     VALUES($1,$2,'ios','1') RETURNING id`,
    [accountId, randomUUID()],
  );
  const now = new Date();
  const pair = await db.transaction((tx) =>
    nativeSessions.issueNativeSession(tx, { accountId, installationId: installation[0]!.id, authenticatedAt: now }, now),
  );
  return pair.access_token;
}

const noParams = { params: Promise.resolve({}) };

describe('account-deletion routes: principal matrix', () => {
  it('serves the owner the overview, accepts deletion with CSRF + expected account, and kills the cookie at once', async () => {
    const owner = await browserOwner();

    const overview = await deletionRoute(req('/v2/me/account-deletion', { cookie: owner.cookie }), noParams);
    expect(overview.status).toBe(200);
    const overviewBody = (await overview.json()) as { requested: boolean; state: string; disclosure: { retained: string[] } };
    expect(overviewBody.requested).toBe(false);
    expect(overviewBody.state).toBe('none');
    expect(overviewBody.disclosure.retained.length).toBeGreaterThan(0);

    // Mutations require the CSRF token and the expected-account header (the
    // v2 expected-account contract runs first, then the browser CSRF check).
    const bare = await acceptRoute(
      req('/v2/me/account-deletion', { method: 'POST', cookie: owner.cookie, body: { confirm: true } }),
      noParams,
    );
    expect(bare.status).toBe(409);
    expect((await bare.json()).code).toBe('account_mismatch');
    const noCsrf = await acceptRoute(
      req('/v2/me/account-deletion', {
        method: 'POST',
        cookie: owner.cookie,
        expectedAccount: owner.account.accountId,
        body: { confirm: true },
      }),
      noParams,
    );
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json()).code).toBe('csrf_failed');
    const mismatched = await acceptRoute(
      req('/v2/me/account-deletion', {
        method: 'POST',
        cookie: owner.cookie,
        csrf: owner.csrf,
        expectedAccount: randomUUID(),
        body: { confirm: true },
      }),
      noParams,
    );
    expect(mismatched.status).toBe(409);
    expect((await mismatched.json()).code).toBe('account_mismatch');

    const statusToken = auth.randomToken(32);
    const accepted = await acceptRoute(
      req('/v2/me/account-deletion', {
        method: 'POST',
        cookie: owner.cookie,
        csrf: owner.csrf,
        expectedAccount: owner.account.accountId,
        body: { confirm: true, status_token: statusToken },
      }),
      noParams,
    );
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { status: { state: string; retrying: boolean }; status_token: string };
    expect(body.status.state).toBe('pending');
    expect(body.status.retrying).toBe(true);
    expect(body.status_token).toBe(statusToken);

    // The old cookie no longer resolves: the next owner read is refused.
    const after = await deletionRoute(req('/v2/me/account-deletion', { cookie: owner.cookie }), noParams);
    expect(after.status).toBe(403);

    // The one-time token keeps answering on the public route.
    const status = await statusRoute(req('/v2/account-deletion/status', { deletionToken: statusToken }), noParams);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { status: { state: string; pending_steps: string[] } };
    expect(statusBody.status.state).toBe('pending');
    expect(statusBody.status.pending_steps.length).toBeGreaterThan(0);
  });

  it('bridges the owner\'s live native phone for the two owner operations', async () => {
    const principal = await insertAccount(db);
    const token = await nativePhone(principal.accountId);

    const bridged = await acceptRoute(
      req('/v2/me/account-deletion', {
        method: 'POST',
        bearer: token,
        expectedAccount: principal.accountId,
        body: { confirm: true },
      }),
      noParams,
    );
    expect(bridged.status).toBe(200);

    // A phone that does not name the account is refused.
    const other = await insertAccount(db);
    const otherToken = await nativePhone(other.accountId);
    const unnamed = await acceptRoute(
      req('/v2/me/account-deletion', { method: 'POST', bearer: otherToken, body: { confirm: true } }),
      noParams,
    );
    expect(unnamed.status).toBe(409);
    const overview = await deletionRoute(req('/v2/me/account-deletion', { bearer: otherToken }), noParams);
    expect(overview.status).toBe(200);
  });

  it('refuses agents and anonymous visitors, and the public status route discloses nothing without the token', async () => {
    const agentToken = `cat_seed_${randomUUID()}`;
    const owner = await browserOwner();
    await db.query(
      `INSERT INTO agent_connections (owner_account_id, client_name, credential_hash, credential_prefix, library_access, expires_at)
       VALUES ($1, 'seed agent', $2, 'cat_seed', 'all', now() + interval '30 days')`,
      [owner.account.accountId, auth.hashToken(agentToken)],
    );

    const agentOverview = await deletionRoute(req('/v2/me/account-deletion', { bearer: agentToken }), noParams);
    expect(agentOverview.status).toBe(403);
    const agentAccept = await acceptRoute(
      req('/v2/me/account-deletion', { method: 'POST', bearer: agentToken, body: { confirm: true } }),
      noParams,
    );
    expect(agentAccept.status).toBe(403);
    const anonOverview = await deletionRoute(req('/v2/me/account-deletion'), noParams);
    expect(anonOverview.status).toBe(403);

    const noToken = await statusRoute(req('/v2/account-deletion/status'), noParams);
    expect(noToken.status).toBe(404);
    const wrongToken = await statusRoute(req('/v2/account-deletion/status', { deletionToken: auth.randomToken(32) }), noParams);
    expect(wrongToken.status).toBe(404);
    const wrongTokenBody = (await wrongToken.json()) as { code: string };
    expect(wrongTokenBody.code).toBe('not_found');
  });
});
