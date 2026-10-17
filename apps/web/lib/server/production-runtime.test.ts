import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  auth,
  enrollmentSignaturePayload,
  identity,
  nativeSessions,
  setDbForTesting,
  setDomainConfigForTesting,
  endCaptureAuthority,
  setFeatureKill,
  liftFeatureKill,
} from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAccount, testConfig } from '@culture-atlas/domain/testing';
import { LocalMultipartStorage } from '@culture-atlas/providers';

/**
 * Exercises the production composition root (runtime.ts) with NO test
 * adapters for identity: the capture routes must reach the real identity and
 * native-session services, and revocations must run endCaptureAuthority in the
 * revoking transaction. This is the regression test for gaps G1, G2 and G8.
 */
vi.mock('server-only', () => ({}));
const { captureV2Route, installCaptureV2Defaults } = await import('./capture-v2');
const { identityRoute } = await import('./identity-http');
const { ensureServerRuntime, resetServerRuntimeForTesting } = await import('./runtime');

const db = getTestDb();
const config = testConfig();
const outbox = new identity.DevIdentityOutbox();
let root: string;
let ip = 0;
const nextIp = () => `198.51.100.${(++ip % 250) + 1}`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-runtime-'));
  setDbForTesting(db);
  setDomainConfigForTesting(config);
  // Only storage is supplied, through the same non-explicit path production uses.
  installCaptureV2Defaults({
    storage: new LocalMultipartStorage(root, 'http://localhost:3310', 'runtime-test-key'),
  });
  identity.setIdentityMail(outbox);
});
afterAll(async () => {
  identity.setIdentityMail(undefined);
  nativeSessions.setAuthorityLifecycle(undefined);
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});

function identityRequest(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return identityRoute(
    new NextRequest(`http://localhost:3310/v2/identity/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-forwarded-for': nextIp(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    path,
  );
}
function capture(path: string, method: string, body: unknown, headers: Record<string, string>) {
  return captureV2Route(
    new NextRequest(`http://localhost:3310${path}`, {
      method,
      headers: {
        'x-forwarded-for': nextIp(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** Verified email sign-in from the iOS app, as IDENTITY-CONTRACT describes. */
async function nativeSignIn(email = `${randomUUID()}@example.test`) {
  const verifier = auth.randomToken();
  const start = {
    email,
    purpose: 'sign_in',
    destination: 'ios',
    state: auth.randomToken(),
    nonce: auth.randomToken(),
    code_challenge: identity.pkceChallenge(verifier),
  };
  expect((await identityRequest('email/start', start)).status).toBe(200);
  const fragment = new URLSearchParams(new URL(outbox.messages.at(-1)!.callback).hash.slice(1));
  const completed = await identityRequest('email/complete', {
    challenge_id: fragment.get('challenge_id'),
    token: fragment.get('token'),
    state: start.state,
    nonce: start.nonce,
    code_verifier: verifier,
  });
  expect(completed.status).toBe(200);
  return (await completed.json()) as { account_id: string; enrollment_grant: string };
}

async function enrollPhone(
  grant: string,
  key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
) {
  const publicKey = key.publicKey.export({ format: 'jwk' });
  const publicId = randomUUID();
  const challenge = await capture(
    '/v2/devices/enrollment/challenge',
    'POST',
    {
      enrollment_grant: grant,
      installation_public_id: publicId,
      platform: 'ios',
      public_key: publicKey,
    },
    {},
  );
  expect(challenge.status).toBe(201);
  const { nonce } = await challenge.json();
  const signature = sign(
    'sha256',
    Buffer.from(enrollmentSignaturePayload(nonce, publicId, 'ios', grant)),
    { key: key.privateKey as KeyObject, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
  const enrolled = await capture(
    '/v2/devices/enroll',
    'POST',
    {
      enrollment_grant: grant,
      platform: 'ios',
      app_version: '1.0.0',
      installation_public_id: publicId,
      proof: { nonce, signature, public_key: publicKey },
      capabilities: { photo: true, video: true },
    },
    {},
  );
  expect(enrolled.status).toBe(201);
  return (await enrolled.json()) as {
    installation: { id: string; revision: number };
    native_session: {
      access_token: string;
      refresh_token: string;
      account_id: string;
      installation_id: string;
    };
  };
}
const phone = (token: string, accountId: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  'x-atlas-expected-account': accountId,
  'idempotency-key': randomUUID(),
  ...extra,
});
async function browserSession(accountId: string, authenticatedAt = new Date()) {
  const token = auth.randomToken();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sessions(account_id,token_hash,expires_at,authenticated_at) VALUES($1,$2,$3,$4) RETURNING id`,
    [accountId, auth.hashToken(token), new Date(Date.now() + 86400_000), authenticatedAt],
  );
  return {
    cookie: `ca_session=${token}`,
    csrf: auth.csrfTokenFor(rows[0]!.id, config.SESSION_SECRET),
  };
}

describe('production identity runtime (G1, G2, G8)', () => {
  it('installs the authority lifecycle hook without replacing one already registered', () => {
    const custom = vi.fn();
    resetServerRuntimeForTesting();
    nativeSessions.setAuthorityLifecycle(custom);
    ensureServerRuntime({});
    expect(nativeSessions.getAuthorityLifecycle()).toBe(custom);
    nativeSessions.setAuthorityLifecycle(undefined);
    resetServerRuntimeForTesting();
    ensureServerRuntime({});
    expect(nativeSessions.getAuthorityLifecycle()).toBe(endCaptureAuthority);
  });

  it('registers the configured mail driver only when none is registered, and fails closed on bad config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-runtime-mail-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      identity.setIdentityMail(undefined);
      resetServerRuntimeForTesting();
      ensureServerRuntime({
        IDENTITY_MAIL_DRIVER: 'file',
        IDENTITY_MAIL_FILE_DIR: dir,
        NODE_ENV: 'test',
      });
      expect(identity.hasIdentityMail()).toBe(true);
      identity.setIdentityMail(undefined);
      resetServerRuntimeForTesting();
      ensureServerRuntime({ IDENTITY_MAIL_DRIVER: 'ses' });
      expect(identity.hasIdentityMail()).toBe(false);
      // Logged without any configuration values.
      expect(errors.mock.calls.flat().join(' ')).toBe(
        '{"level":"error","event":"identity_mail_misconfigured"}',
      );
    } finally {
      errors.mockRestore();
      identity.setIdentityMail(outbox);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('verified email → authenticated challenge → enrollment → native calls work end to end', async () => {
    const signedIn = await nativeSignIn();
    const enrolled = await enrollPhone(signedIn.enrollment_grant);
    const { access_token: access, account_id: accountId } = enrolled.native_session;
    expect(accountId).toBe(signedIn.account_id);

    const status = await capture(
      '/v2/device/status',
      'PUT',
      {
        sequence: 1,
        capabilities: { photo: true, video: true },
        readiness: 'ready',
        app_state: 'foreground',
      },
      phone(access, accountId),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ accepted_sequence: 1 });
    // Out-of-order heartbeat is ignored, not applied.
    const stale = await capture(
      '/v2/device/status',
      'PUT',
      { sequence: 0, capabilities: {}, readiness: 'unavailable', app_state: 'background' },
      phone(access, accountId),
    );
    expect(await stale.json()).toEqual({ accepted_sequence: 1 });

    const session = await capture(
      '/v2/device/capture-sessions',
      'POST',
      { source: 'phone_camera', mode: 'photo' },
      phone(access, accountId),
    );
    expect(session.status).toBe(201);
    const { session_id } = await session.json();
    const tooLong = await capture(
      `/v2/device/capture-sessions/${session_id}/arm`,
      'POST',
      { enabled: true, duration_seconds: 601 },
      phone(access, accountId),
    );
    expect(tooLong.status).toBe(400);
    const armed = await capture(
      `/v2/device/capture-sessions/${session_id}/arm`,
      'POST',
      { enabled: true, duration_seconds: 600 },
      phone(access, accountId),
    );
    expect(armed.status).toBe(200);
    expect((await armed.json()).remote_arm_expires_at).not.toBeNull();

    // Backgrounding disarms; returning to the foreground never re-arms.
    for (const [sequence, app_state] of [
      [2, 'background'],
      [3, 'foreground'],
    ] as const)
      await capture(
        '/v2/device/status',
        'PUT',
        { sequence, capabilities: { photo: true }, readiness: 'ready', app_state },
        phone(access, accountId),
      );
    const arm = await db.query(`SELECT remote_arm_expires_at FROM capture_sessions WHERE id=$1`, [
      session_id,
    ]);
    expect(arm.rows[0]!.remote_arm_expires_at).toBeNull();

    const wearable = await capture(
      '/v2/device/wearables',
      'POST',
      {
        sdk_reference: 'opaque-sdk-ref',
        display_name: 'Glasses',
        capabilities: { photo: true },
        permission_state: 'granted',
      },
      phone(access, accountId),
    );
    expect(wearable.status).toBe(201);
    const { connection_id } = await wearable.json();
    const unlink = await capture(
      `/v2/device/wearables/${connection_id}`,
      'DELETE',
      undefined,
      phone(access, accountId),
    );
    expect(unlink.status).toBe(204);
  });

  it('refresh reuse revokes the family and runs the capture lifecycle hook in the same transaction', async () => {
    const signedIn = await nativeSignIn();
    const enrolled = await enrollPhone(signedIn.enrollment_grant);
    const {
      access_token: access,
      refresh_token: refresh,
      account_id: accountId,
      installation_id: installationId,
    } = enrolled.native_session;
    await capture(
      '/v2/device/status',
      'PUT',
      { sequence: 1, capabilities: { photo: true }, readiness: 'ready', app_state: 'foreground' },
      phone(access, accountId),
    );
    const session = await (
      await capture(
        '/v2/device/capture-sessions',
        'POST',
        { source: 'phone_camera', mode: 'photo' },
        phone(access, accountId),
      )
    ).json();

    const rotate = (requestId = auth.randomToken()) =>
      identityRequest('native/refresh', {
        refresh_token: refresh,
        installation_id: installationId,
        refresh_request_id: requestId,
      });
    const first = await rotate();
    expect(first.status).toBe(200);
    const reused = await rotate();
    expect(reused.status).toBe(401);
    expect((await reused.json()).error.code).toBe('token_revoked');

    const ended = await db.query(
      `SELECT s.state,i.authority_ended_at,e.reason FROM capture_sessions s
       JOIN mobile_installations i ON i.id=s.installation_id
       JOIN identity_authority_events e ON e.installation_id=i.id
       WHERE s.id=$1`,
      [session.session_id],
    );
    expect(ended.rows[0]).toMatchObject({ state: 'ended', reason: 'refresh_reuse' });
    expect(ended.rows[0]!.authority_ended_at).toBeInstanceOf(Date);
    const denied = await capture('/v2/devices', 'GET', undefined, {
      authorization: `Bearer ${access}`,
    });
    expect(denied.status).toBe(401);
  });

  it('owner lists and revokes a device; sign-out-all needs recent reauthentication and fences every phone', async () => {
    const signedIn = await nativeSignIn();
    const accountId = signedIn.account_id;
    const one = await enrollPhone(signedIn.enrollment_grant);
    const two = await enrollPhone(
      (
        await nativeSignIn(
          (
            await db.query<{ email: string }>(
              'SELECT email FROM account_emails WHERE account_id=$1',
              [accountId],
            )
          ).rows[0]!.email,
        )
      ).enrollment_grant,
    );
    const owner = await browserSession(accountId);
    const list = await capture('/v2/devices', 'GET', undefined, { cookie: owner.cookie });
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.items.map((d: { id: string }) => d.id).sort()).toEqual(
      [one.installation.id, two.installation.id].sort(),
    );
    expect(JSON.stringify(listed)).not.toMatch(/public_key|installation_public_id|cna_|cnr_/);

    const revoke = await capture(
      `/v2/devices/${one.installation.id}`,
      'DELETE',
      { expected_revision: one.installation.revision },
      {
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
        'x-atlas-expected-account': accountId,
        'idempotency-key': randomUUID(),
      },
    );
    expect(revoke.status).toBe(202);
    const revoked = await capture('/v2/devices', 'GET', undefined, {
      authorization: `Bearer ${one.native_session.access_token}`,
    });
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error.code).toBe('token_revoked');
    // The other phone keeps working.
    expect(
      (
        await capture('/v2/devices', 'GET', undefined, {
          authorization: `Bearer ${two.native_session.access_token}`,
        })
      ).status,
    ).toBe(200);

    const stale = await browserSession(accountId, new Date(Date.now() - 10 * 60_000));
    const tooOld = await identityRequest(
      'sign-out-all',
      {},
      { cookie: stale.cookie, 'x-csrf-token': stale.csrf },
    );
    expect(tooOld.status).toBe(401);
    const fresh = await browserSession(accountId);
    const all = await identityRequest(
      'sign-out-all',
      {},
      { cookie: fresh.cookie, 'x-csrf-token': fresh.csrf },
    );
    expect(all.status).toBe(200);
    const after = await capture('/v2/devices', 'GET', undefined, {
      authorization: `Bearer ${two.native_session.access_token}`,
    });
    expect(after.status).toBe(401);
    const events = await db.query(
      `SELECT reason FROM identity_authority_events WHERE account_id=$1 ORDER BY created_at`,
      [accountId],
    );
    expect(events.rows.map((r) => r.reason)).toEqual(
      expect.arrayContaining(['installation_revoked', 'sign_out_all']),
    );
    const fenced = await db.query(
      `SELECT count(*)::int AS n FROM mobile_installations WHERE account_id=$1 AND authority_ended_at IS NULL`,
      [accountId],
    );
    expect(fenced.rows[0]!.n).toBe(0);
  });

  it('a browser account without a verified email cannot start enrollment', async () => {
    const legacy = await insertAccount();
    const token = auth.randomToken();
    await db.query(`UPDATE sessions SET token_hash=$2 WHERE id=$1`, [
      legacy.sessionId,
      auth.hashToken(token),
    ]);
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const response = await capture(
      '/v2/devices/enrollment/challenge',
      'POST',
      {
        installation_public_id: randomUUID(),
        platform: 'android',
        public_key: key.publicKey.export({ format: 'jwk' }),
      },
      {
        cookie: `ca_session=${token}`,
        'x-csrf-token': auth.csrfTokenFor(legacy.sessionId!, config.SESSION_SECRET),
        'x-atlas-expected-account': legacy.accountId,
      },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('account_required');
  });
});

describe('server-side feature flags and kill switches over HTTP', () => {
  const glassesEnv = {
    META_GLASSES_QUALIFIED_BUILDS: 'ios@1.0.0',
    META_GLASSES_ENTITLED_PLATFORMS: 'ios',
    META_GLASSES_ROLLOUT: 'all',
  };
  async function readyGlassesPhone() {
    const signedIn = await nativeSignIn();
    const enrolled = await enrollPhone(signedIn.enrollment_grant);
    const { access_token: access, account_id: accountId } = enrolled.native_session;
    const capabilities = {
      photo: true,
      meta_wearables_sdk: true,
      meta_wearables_supported_os: true,
    };
    await capture(
      '/v2/device/status',
      'PUT',
      { sequence: 1, capabilities, readiness: 'ready', app_state: 'foreground' },
      phone(access, accountId),
    );
    const wearable = await (
      await capture(
        '/v2/device/wearables',
        'POST',
        {
          sdk_reference: 'opaque',
          display_name: 'Glasses',
          capabilities: { photo: true },
          permission_state: 'granted',
        },
        phone(access, accountId),
      )
    ).json();
    return { access, accountId, connectionId: wearable.connection_id as string };
  }
  const glassesSession = (p: { access: string; accountId: string; connectionId: string }) =>
    capture(
      '/v2/device/capture-sessions',
      'POST',
      { source: 'meta_glasses', mode: 'photo', connection_id: p.connectionId },
      phone(p.access, p.accountId),
    );

  it('capabilities explain why glasses are off and never trust client flags', async () => {
    const p = await readyGlassesPhone();
    const response = await capture(
      '/v2/capabilities?meta_glasses_capture_enabled=true',
      'GET',
      undefined,
      {
        authorization: `Bearer ${p.access}`,
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.flags).toMatchObject({
      media_library: true,
      meta_glasses_entry_visible: true,
      meta_glasses_label: 'Experimental',
      meta_glasses_capture_enabled: false,
      remote_glasses_capture_enabled: false,
    });
    expect(body.availability.meta_glasses.reasons).toEqual(
      expect.arrayContaining([
        'build_unsupported',
        'release_channel_ineligible',
        'rollout_unavailable',
      ]),
    );
    expect((await glassesSession(p)).status).toBe(403);
  });

  it('activation rules enable glasses sessions; an account kill disables them while reads continue', async () => {
    Object.assign(process.env, glassesEnv);
    try {
      const p = await readyGlassesPhone();
      const other = await readyGlassesPhone();
      const caps = await (
        await capture('/v2/capabilities', 'GET', undefined, { authorization: `Bearer ${p.access}` })
      ).json();
      expect(caps.flags.meta_glasses_capture_enabled).toBe(true);
      expect((await glassesSession(p)).status).toBe(201);

      await setFeatureKill(db, {
        flag: 'meta_glasses_capture_enabled',
        accountId: p.accountId,
        reason: 'glasses incident drill',
        actor: 'vitest',
      });
      const killed = await glassesSession(p);
      expect(killed.status).toBe(403);
      const after = await (
        await capture('/v2/capabilities', 'GET', undefined, { authorization: `Bearer ${p.access}` })
      ).json();
      expect(after.availability.meta_glasses).toEqual({
        available: false,
        reasons: ['temporarily_disabled'],
      });
      // Other accounts and library reads are unaffected.
      expect((await glassesSession(other)).status).toBe(201);
      expect(
        (await capture('/v2/library', 'GET', undefined, { authorization: `Bearer ${p.access}` }))
          .status,
      ).toBe(200);
      await liftFeatureKill(db, { flag: 'meta_glasses_capture_enabled', accountId: p.accountId });
      expect((await glassesSession(p)).status).toBe(201);
    } finally {
      for (const key of Object.keys(glassesEnv)) delete process.env[key];
    }
  });

  it('a global (env) photo kill pauses new uploads for everyone without blocking the library', async () => {
    const p = await readyGlassesPhone();
    const upload = () =>
      capture(
        '/v2/uploads',
        'POST',
        {
          client_capture_id: randomUUID(),
          kind: 'photo',
          source: 'upload',
          filename: 'a.jpg',
          content_type: 'image/jpeg',
          byte_size: 1024,
          sha256: 'a'.repeat(64),
        },
        phone(p.access, p.accountId),
      );
    // Env kill (process-local): a global database kill would leak into other test files sharing this DB.
    process.env.FEATURE_KILL_SWITCHES = 'file_photo_upload';
    try {
      const paused = await upload();
      expect(paused.status).toBe(503);
      expect((await paused.json()).error.message).toBe('New captures are temporarily paused.');
      expect(
        (await capture('/v2/library', 'GET', undefined, { authorization: `Bearer ${p.access}` }))
          .status,
      ).toBe(200);
    } finally {
      delete process.env.FEATURE_KILL_SWITCHES;
    }
    expect((await upload()).status).toBe(201);
  });
});
