import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { MultipartStorage, PushDriver, PushTarget } from '@culture-atlas/providers';
import { closeTestDb, getTestDb, insertAccount, testConfig, testContext } from '../testing';
import { createCaptureV2Context } from '../capture-v2/context';
import { endCaptureAuthority } from '../capture-v2/devices';
import type { CaptureAuthority } from '../capture-v2/types';
import { createConnection } from './agent-platform';
import { resolvePrincipal } from './auth';
import { requestCapture, setCommandQueuedListener } from './agent-commands';
import { clearPushToken, registerPushToken, wakeInstallation } from './device-push';

const db = getTestDb();
const KEY = randomBytes(32).toString('base64');
const APNS = 'ab'.repeat(32);
afterAll(closeTestDb);
afterEach(() => setCommandQueuedListener(undefined));

async function phone(platform: 'ios' | 'android' = 'ios') {
  const owner = await insertAccount();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version,readiness,app_state,capabilities)
     VALUES($1,$2,$3,'1.0','ready','foreground','{"photo":true}') RETURNING id`,
    [owner.accountId, randomUUID(), platform],
  );
  const installationId = rows[0]!.id;
  const authority: CaptureAuthority = {
    kind: 'installation',
    accountId: owner.accountId,
    installationId,
    sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000),
  };
  const ctx = createCaptureV2Context({ db, authority, storage: {} as MultipartStorage });
  return { owner, installationId, ctx };
}
class RecordingDriver implements PushDriver {
  readonly name = 'recording';
  calls: { target: PushTarget; reference: string }[] = [];
  constructor(private outcome: 'sent' | 'invalid_token' = 'sent') {}
  async wake(target: PushTarget, reference: string) {
    this.calls.push({ target, reference });
    return this.outcome;
  }
}

describe('push token registration', () => {
  it('encrypts the token, binds it to the installation and never stores it in idempotency records', async () => {
    const p = await phone();
    const key = randomUUID();
    const body = { provider: 'apns', token: APNS, environment: 'sandbox' };
    expect(await registerPushToken(p.ctx, body, key, KEY)).toEqual({
      registered: true,
      provider: 'apns',
    });
    expect(await registerPushToken(p.ctx, body, key, KEY)).toEqual({
      registered: true,
      provider: 'apns',
    });
    const stored = await db.query(
      `SELECT push_token_ciphertext,push_provider,push_environment FROM mobile_installations WHERE id=$1`,
      [p.installationId],
    );
    expect(stored.rows[0]).toMatchObject({ push_provider: 'apns', push_environment: 'sandbox' });
    expect(Buffer.from(stored.rows[0]!.push_token_ciphertext).toString('latin1')).not.toContain(
      APNS,
    );
    const idem = await db.query(
      `SELECT request_hash::text,response::text FROM capture_v2_idempotency WHERE account_id=$1`,
      [p.owner.accountId],
    );
    expect(JSON.stringify(idem.rows)).not.toContain(APNS);
    // A ciphertext copied onto another installation does not decrypt there.
    const other = await phone();
    await db.query(
      `UPDATE mobile_installations SET push_provider='apns',push_environment='sandbox',push_token_key_id=src.push_token_key_id,
         push_token_ciphertext=src.push_token_ciphertext FROM mobile_installations src WHERE src.id=$1 AND mobile_installations.id=$2`,
      [p.installationId, other.installationId],
    );
    const driver = new RecordingDriver();
    expect(
      await wakeInstallation(
        db,
        { accountId: other.owner.accountId, installationId: other.installationId },
        { encryptionKey: KEY, driver },
      ),
    ).toBe('failed');
    expect(driver.calls).toHaveLength(0);
  });

  it('rejects the wrong provider for the platform, browser authority and a missing key', async () => {
    const p = await phone('android');
    await expect(
      registerPushToken(
        p.ctx,
        { provider: 'apns', token: APNS, environment: 'production' },
        randomUUID(),
        KEY,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      registerPushToken(
        { ...p.ctx, authority: { kind: 'account', accountId: p.owner.accountId, sessionId: null } },
        { provider: 'fcm', token: 'x'.repeat(40), environment: 'production' },
        randomUUID(),
        KEY,
      ),
    ).rejects.toMatchObject({ code: 'scope_denied' });
    await expect(
      registerPushToken(
        p.ctx,
        { provider: 'fcm', token: 'x'.repeat(40), environment: 'production' },
        randomUUID(),
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('wakes with an opaque random reference, clears invalid tokens, and clears on authority end', async () => {
    const p = await phone();
    await registerPushToken(
      p.ctx,
      { provider: 'apns', token: APNS, environment: 'production' },
      randomUUID(),
      KEY,
    );
    const target = { accountId: p.owner.accountId, installationId: p.installationId };
    const ok = new RecordingDriver('sent');
    expect(await wakeInstallation(db, target, { encryptionKey: KEY, driver: ok })).toBe('sent');
    expect(await wakeInstallation(db, target, { encryptionKey: KEY, driver: ok })).toBe('sent');
    expect(ok.calls[0]!.target).toEqual({
      provider: 'apns',
      token: APNS,
      environment: 'production',
    });
    expect(ok.calls[0]!.reference).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ok.calls[0]!.reference).not.toBe(ok.calls[1]!.reference);
    expect(
      await wakeInstallation(db, target, {
        encryptionKey: KEY,
        driver: new RecordingDriver('invalid_token'),
      }),
    ).toBe('invalid_token');
    expect(await wakeInstallation(db, target, { encryptionKey: KEY, driver: ok })).toBe(
      'not_configured',
    );

    await registerPushToken(
      p.ctx,
      { provider: 'apns', token: APNS, environment: 'production' },
      randomUUID(),
      KEY,
    );
    await db.transaction((tx) =>
      endCaptureAuthority(tx, {
        ...target,
        sessionId: null,
        reason: 'sign_out_all',
        now: new Date(),
      }),
    );
    const cleared = await db.query(
      `SELECT push_provider,push_token_ciphertext FROM mobile_installations WHERE id=$1`,
      [p.installationId],
    );
    expect(cleared.rows[0]).toEqual({ push_provider: null, push_token_ciphertext: null });
    // A signed-out phone cannot re-register until it re-enrolls.
    await expect(
      registerPushToken(
        p.ctx,
        { provider: 'apns', token: APNS, environment: 'production' },
        randomUUID(),
        KEY,
      ),
    ).rejects.toMatchObject({ code: 'token_revoked' });
    await expect(clearPushToken(p.ctx, randomUUID())).rejects.toMatchObject({
      code: 'token_revoked',
    });
  });
});

describe('command queued wake-up', () => {
  it('fires once per new command after commit, not on idempotent replay', async () => {
    const p = await phone();
    const ctx = testContext(p.owner);
    const created = await createConnection(ctx, {
      client_name: 'Camera agent',
      scopes: ['devices:command'],
      installation_ids: [p.installationId],
    });
    // Agent remote capture is off by default; this operator opts in.
    const agent = testContext(
      (await resolvePrincipal(db, { authorization: `Bearer ${created.credential}` }))!,
      { config: testConfig({ AGENT_REMOTE_CAPTURE_ENABLED: 'true' }) },
    );
    const session = await db.query<{ id: string }>(
      `INSERT INTO capture_sessions(account_id,installation_id,source,media_mode,remote_arm_expires_at,allowed_agent_connection_ids)
       VALUES($1,$2,'phone_camera','photo',now()+interval '10 minutes',$3) RETURNING id`,
      [p.owner.accountId, p.installationId, [created.connection.id]],
    );
    let committedState: string | undefined;
    const listener = vi.fn(async (event: { commandId: string }) => {
      // Runs after commit: the command is visible to another connection.
      committedState = (
        await db.query(`SELECT state FROM device_commands WHERE id=$1`, [event.commandId])
      ).rows[0]?.state;
    });
    setCommandQueuedListener(listener);
    const input = {
      session_id: session.rows[0]!.id,
      generation: 1,
      action: 'capture_photo',
      capture_client_id: randomUUID(),
    };
    const key = randomUUID();
    const command = await requestCapture(agent, p.installationId, input, key);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener).toHaveBeenCalledWith({
      accountId: p.owner.accountId,
      installationId: p.installationId,
      commandId: command.command_id,
    });
    await vi.waitFor(() => expect(committedState).toBe('queued'));
    await requestCapture(agent, p.installationId, input, key);
    await new Promise((r) => setTimeout(r, 20));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a failing listener never fails command creation', async () => {
    const p = await phone();
    const ctx = testContext(p.owner);
    const created = await createConnection(ctx, {
      client_name: 'Camera agent',
      scopes: ['devices:command'],
      installation_ids: [p.installationId],
    });
    // Agent remote capture is off by default; this operator opts in.
    const agent = testContext(
      (await resolvePrincipal(db, { authorization: `Bearer ${created.credential}` }))!,
      { config: testConfig({ AGENT_REMOTE_CAPTURE_ENABLED: 'true' }) },
    );
    const session = await db.query<{ id: string }>(
      `INSERT INTO capture_sessions(account_id,installation_id,source,media_mode,remote_arm_expires_at,allowed_agent_connection_ids)
       VALUES($1,$2,'phone_camera','photo',now()+interval '10 minutes',$3) RETURNING id`,
      [p.owner.accountId, p.installationId, [created.connection.id]],
    );
    setCommandQueuedListener(async () => {
      throw new Error('push provider down');
    });
    const command = await requestCapture(
      agent,
      p.installationId,
      {
        session_id: session.rows[0]!.id,
        generation: 1,
        action: 'capture_photo',
        capture_client_id: randomUUID(),
      },
      randomUUID(),
    );
    expect(command.state).toBe('queued');
  });
});
