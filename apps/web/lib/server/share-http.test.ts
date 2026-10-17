import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auth, collections, setDbForTesting, setDomainConfigForTesting } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, testConfig, testContext } from '@culture-atlas/domain/testing';
import { LocalMultipartStorage } from '@culture-atlas/providers';

vi.mock('server-only', () => ({}));
const { setCaptureV2Runtime, captureV2Route } = await import('./capture-v2');
const shares = await import('../../app/v2/collections/[id]/shares/route');
const share = await import('../../app/v2/shares/[id]/route');
const invitations = await import('../../app/v2/shares/[id]/invitations/route');
const accept = await import('../../app/v2/share-invitations/accept/route');
const redeem = await import('../../app/v2/shared/redeem/route');
const shared = await import('../../app/v2/shared/collection/route');
const media = await import('../../app/v2/shared/media/[id]/[variant]/route');

const db = getTestDb();
const config = testConfig({ APP_BASE_URL: 'http://localhost:3302' });
const BASE = 'http://localhost:3302';
let root: string;
let storage: LocalMultipartStorage;
let ip = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-share-http-'));
  storage = new LocalMultipartStorage(root, BASE, 'private-test-key');
  setDbForTesting(db);
  setDomainConfigForTesting(config);
  setCaptureV2Runtime({ storage });
});
afterAll(async () => {
  setCaptureV2Runtime({});
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});

async function browser(email?: string) {
  const principal = await insertAccount();
  const token = randomUUID();
  await db.query('UPDATE sessions SET token_hash = $2 WHERE id = $1', [principal.sessionId, auth.hashToken(token)]);
  if (email) await db.query('INSERT INTO account_emails (account_id, email, verified_at) VALUES ($1, $2, now())', [principal.accountId, email]);
  return { principal, token, csrf: auth.csrfTokenFor(principal.sessionId!, config.SESSION_SECRET) };
}
type Browser = Awaited<ReturnType<typeof browser>>;

function ownerRequest(path: string, owner: Browser, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${BASE}${path}`, {
    method,
    headers: {
      cookie: `ca_session=${owner.token}`,
      'x-csrf-token': owner.csrf,
      'x-atlas-expected-account': owner.principal.accountId,
      'idempotency-key': randomUUID(),
      'x-forwarded-for': `198.51.100.${++ip % 250}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function viewerRequest(path: string, cookie?: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'x-forwarded-for': `192.0.2.${++ip % 250}`,
      ...(cookie ? { cookie } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const seg = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

function expectPrivacyHeaders(res: Response) {
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-robots-tag')).toContain('noindex');
}

async function fixture() {
  const owner = await browser(`owner-${randomUUID()}@example.com`);
  const ctx = testContext(owner.principal);
  const col = await collections.createCollection(ctx, { name: 'Quiet weekends' });
  const bytes = randomBytes(600_000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_assets (account_id, client_capture_id, kind, source, status, byte_size, content_type, duration_ms, original_key)
     VALUES ($1, $2, 'video', 'phone_camera', 'ready', 600000, 'video/mp4', 60000, $3) RETURNING id`,
    [owner.principal.accountId, randomUUID(), `originals/${randomUUID()}`],
  );
  const assetId = rows[0]!.id;
  const key = `derivatives/${randomUUID()}.mp4`;
  await storage.put(key, (async function* () { yield bytes; })(), 'video/mp4', bytes.length);
  await db.query(
    `INSERT INTO media_derivatives (account_id, asset_id, generation, kind, processing_version, object_key, checksum,
                                    byte_size, width, height, duration_ms, share_safe)
     VALUES ($1, $2, 1, 'playback', 'test', $3, $4, $5, 640, 360, 60000, true)`,
    [owner.principal.accountId, assetId, key, 'b'.repeat(64), bytes.length],
  );
  await db.query('INSERT INTO collection_media_items (account_id, collection_id, asset_id) VALUES ($1, $2, $3)', [owner.principal.accountId, col.id, assetId]);
  return { owner, col, assetId, bytes };
}

async function createLink(f: Awaited<ReturnType<typeof fixture>>, body: Record<string, unknown> = {}) {
  const res = await shares.POST(ownerRequest(`/v2/collections/${f.col.id}/shares`, f.owner, 'POST',
    { audience: 'link', confirm_policy: true, include_media: true, ...body }), seg({ id: f.col.id }));
  expect(res.status).toBe(201);
  const json = await res.json();
  return { share: json.share, token: new URL(json.link).hash.replace('#share=', ''), link: json.link as string };
}

async function redeemCookie(token: string) {
  const res = await redeem.POST(viewerRequest('/v2/shared/redeem', undefined, { method: 'POST', body: { token }, headers: { origin: BASE } }));
  expect(res.status).toBe(200);
  expectPrivacyHeaders(res);
  const setCookie = res.headers.get('set-cookie')!;
  return { res, setCookie, cookie: setCookie.split(';')[0]! };
}

describe('SHR-01 share transport', () => {
  it('exchanges the fragment secret for an HttpOnly, Strict, path-scoped session and never echoes it', async () => {
    const f = await fixture();
    const { token, link } = await createLink(f);
    expect(link.startsWith(`${BASE}/shared#share=cas_`)).toBe(true);
    const { res, setCookie, cookie } = await redeemCookie(token);
    expect(setCookie).toMatch(/^ca_share=[A-Za-z0-9_-]{43}; Path=\/v2\/shared; Max-Age=\d+; HttpOnly; SameSite=Strict/);
    expect(setCookie).not.toContain(token);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(token);
    const view = await shared.GET(viewerRequest('/v2/shared/collection', cookie));
    expect(view.status).toBe(200);
    expectPrivacyHeaders(view);
    expect((await view.json()).collection.title).toBe('Quiet weekends');
    // Cross-site redemption is refused before any lookup.
    const cross = await redeem.POST(viewerRequest('/v2/shared/redeem', undefined, { method: 'POST', body: { token }, headers: { origin: 'https://evil.example' } }));
    expect(cross.status).toBe(403);
  });

  it('serves at most a 30-second segment per range and denies the next range after revocation', async () => {
    const f = await fixture();
    const { share: created, token } = await createLink(f);
    const { cookie } = await redeemCookie(token);
    const path = `/v2/shared/media/${f.assetId}/playback`;
    const first = await media.GET(viewerRequest(path, cookie, { headers: { range: 'bytes=0-' } }), seg({ id: f.assetId, variant: 'playback' }));
    expect(first.status).toBe(206);
    expectPrivacyHeaders(first);
    expect(first.headers.get('content-range')).toBe('bytes 0-299999/600000');
    const firstBytes = Buffer.from(await first.arrayBuffer());
    expect(firstBytes.equals(f.bytes.subarray(0, 300_000))).toBe(true);
    // No Range header still yields a single bounded segment.
    const plain = await media.GET(viewerRequest(path, cookie), seg({ id: f.assetId, variant: 'playback' }));
    expect(plain.status).toBe(206);
    expect(Number(plain.headers.get('content-length'))).toBe(300_000);
    await plain.arrayBuffer();
    const revoke = await share.DELETE(ownerRequest(`/v2/shares/${created.id}`, f.owner, 'DELETE'), seg({ id: created.id }));
    expect(revoke.status).toBe(204);
    const next = await media.GET(viewerRequest(path, cookie, { headers: { range: 'bytes=300000-' } }), seg({ id: f.assetId, variant: 'playback' }));
    expect(next.status).toBe(404);
    expect((await next.json()).error.message).toBe('This collection is no longer shared.');
    const again = await shared.GET(viewerRequest('/v2/shared/collection', cookie));
    expect(again.status).toBe(404);
  });

  it('original download off cannot be reached through the share gateway or owner media endpoints', async () => {
    const f = await fixture();
    const { token } = await createLink(f);
    const { cookie } = await redeemCookie(token);
    const original = await media.GET(viewerRequest(`/v2/shared/media/${f.assetId}/original`, cookie), seg({ id: f.assetId, variant: 'original' }));
    expect(original.status).toBe(404);
    // The share session is path-scoped, and the owner capture API refuses any share cookie it is handed.
    const owner = await captureV2Route(viewerRequest(`/v2/media/${f.assetId}/content/original`, cookie));
    expect(owner.status).toBe(403);
    const library = await captureV2Route(viewerRequest('/v2/library', cookie));
    expect(library.status).toBe(403);
  });

  it('refuses agents on every sharing route and refuses share secrets as agent credentials', async () => {
    const f = await fixture();
    const agent = await insertAgentConnection(f.owner.principal, { libraryAccess: 'all' });
    const bearer = (path: string, method = 'GET', body?: unknown) => new NextRequest(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${agent.credential}`, 'x-forwarded-for': '203.0.113.9', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    expect((await shares.POST(bearer(`/v2/collections/${f.col.id}/shares`, 'POST', { audience: 'restricted' }), seg({ id: f.col.id }))).status).toBe(403);
    expect((await shares.GET(bearer(`/v2/collections/${f.col.id}/shares`), seg({ id: f.col.id }))).status).toBe(403);
    const { token } = await createLink(f);
    expect((await shared.GET(bearer('/v2/shared/collection'))).status).toBe(403);
    const asAgent = await shares.GET(new NextRequest(`${BASE}/v2/collections/${f.col.id}/shares`, {
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.10' },
    }), seg({ id: f.col.id }));
    expect(asAgent.status).toBe(401);
  });

  it('restricted invitations: uniform creation, exact verified acceptance, member-only viewing', async () => {
    const f = await fixture();
    const created = await shares.POST(ownerRequest(`/v2/collections/${f.col.id}/shares`, f.owner, 'POST', {}), seg({ id: f.col.id }));
    const restricted = (await created.json()).share;
    const email = `viewer-${randomUUID()}@example.com`;
    const recipient = await browser(email);
    const one = await invitations.POST(ownerRequest(`/v2/shares/${restricted.id}/invitations`, f.owner, 'POST', { email }), seg({ id: restricted.id }));
    const two = await invitations.POST(ownerRequest(`/v2/shares/${restricted.id}/invitations`, f.owner, 'POST', { email: `unknown-${randomUUID()}@example.com` }), seg({ id: restricted.id }));
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    const a = await one.json();
    const b = await two.json();
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    const inviteToken = new URL(a.link).hash.replace('#invite=', '');
    const stranger = await browser(`stranger-${randomUUID()}@example.com`);
    const denied = await accept.POST(ownerRequest('/v2/share-invitations/accept', stranger, 'POST', { token: inviteToken }), seg({}));
    expect(denied.status).toBe(404);
    const ok = await accept.POST(ownerRequest('/v2/share-invitations/accept', recipient, 'POST', { token: inviteToken }), seg({}));
    expect(ok.status).toBe(200);
    const memberView = await shared.GET(viewerRequest(`/v2/shared/collection?share=${restricted.id}`, `ca_session=${recipient.token}`));
    expect(memberView.status).toBe(200);
    const strangerView = await shared.GET(viewerRequest(`/v2/shared/collection?share=${restricted.id}`, `ca_session=${stranger.token}`));
    expect(strangerView.status).toBe(404);
    // Policy change requires If-Match.
    const noMatch = await share.PATCH(ownerRequest(`/v2/shares/${restricted.id}`, f.owner, 'PATCH', { include_media: true, confirm_broaden: true }), seg({ id: restricted.id }));
    expect(noMatch.status).toBe(428);
    const patched = await share.PATCH(ownerRequest(`/v2/shares/${restricted.id}`, f.owner, 'PATCH', { include_media: true, confirm_broaden: true },
      { 'if-match': `"${restricted.policy_version}"` }), seg({ id: restricted.id }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).share.include_media).toBe(true);
  });

  it('limits redemption attempts per address', async () => {
    let statuses: number[] = [];
    // Windows are per minute; repeat with a fresh address if a boundary fell inside the burst.
    for (let attempt = 0; attempt < 3; attempt++) {
      const minute = Math.floor(Date.now() / 60_000);
      const address = `198.18.${attempt}.${Math.floor(Math.random() * 250)}`;
      statuses = [];
      for (let i = 0; i < 12; i++) {
        const res = await redeem.POST(new NextRequest(`${BASE}/v2/shared/redeem`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
          body: JSON.stringify({ token: `cas_${randomUUID()}${randomUUID()}` }),
        }));
        statuses.push(res.status);
      }
      if (Math.floor(Date.now() / 60_000) === minute) break;
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
