import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAccount, testConfig, testContext } from '../testing';
import type { CommandContext } from './agent-commands';
import { createConnection, getSetup, rotateConnection } from './agent-platform';
import { resolvePrincipal } from './auth';
import { revokeAgentConnection } from './agent-connections';
import { acknowledgeCommand, claimCommands, getCommand, requestCapture } from './agent-commands';
import { liftFeatureKill, setFeatureKill } from '../flags/feature-flags';

const db = getTestDb();
afterAll(closeTestDb);
/** Agent remote capture is off by default; these fixtures run as an operator who opted in. */
const optedIn = { AGENT_REMOTE_CAPTURE_ENABLED: 'true' };
async function fixture() {
  const owner = await insertAccount(), ctx = testContext(owner);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version,readiness,app_state,capabilities)
     VALUES($1,$2,'ios','1.2','ready','foreground',$3) RETURNING id`,
    [owner.accountId, randomUUID(), { photo: true, video: true, hardware_serial: 'secret', push_token: 'secret', ip_address: 'secret' }],
  );
  const id = rows[0]!.id;
  const created = await createConnection(ctx, { client_name: 'Camera agent', scopes: ['devices:command', 'setup:read'], installation_ids: [id] });
  const agent = testContext((await resolvePrincipal(db, { authorization: `Bearer ${created.credential}` }))!, { config: testConfig(optedIn) });
  const sessions = await db.query<{ id: string }>(
    `INSERT INTO capture_sessions(account_id,installation_id,source,media_mode,remote_arm_expires_at,allowed_agent_connection_ids)
     VALUES($1,$2,'phone_camera','photo',now()+interval '10 minutes',$3) RETURNING id`,
    [owner.accountId, id, [created.connection.id]],
  );
  const sessionId = sessions.rows[0]!.id;
  const phone = { db, authority: { kind: 'installation', accountId: owner.accountId, installationId: id, sessionId: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
    now: () => new Date(), config: optedIn } satisfies CommandContext;
  const input = { session_id: sessionId, generation: 1, action: 'capture_photo', capture_client_id: randomUUID() };
  return { owner, ctx, id, created, agent, sessionId, phone, input };
}

describe('AGT-01 / DEV-02 locally armed device commands', () => {
  it('requires local arming and the explicitly allowed agent', async () => {
    const f = await fixture();
    await db.query('UPDATE capture_sessions SET remote_arm_expires_at=NULL WHERE id=$1', [f.sessionId]);
    await expect(requestCapture(f.agent, f.id, f.input, randomUUID())).rejects.toMatchObject({ code: 'action_required' });
    await db.query(`UPDATE capture_sessions SET remote_arm_expires_at=now()+interval '10 minutes',allowed_agent_connection_ids='{}' WHERE id=$1`, [f.sessionId]);
    await expect(requestCapture(f.agent, f.id, f.input, randomUUID())).rejects.toMatchObject({ code: 'action_required' });
  });
  it('denies unselected or other-account installations without details', async () => {
    const f = await fixture();
    await expect(requestCapture(f.agent, randomUUID(), f.input, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    const other = await fixture();
    await expect(requestCapture(f.agent, other.id, f.input, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
  });
  it('denies stale heartbeat and background phones', async () => {
    const f = await fixture();
    await db.query(`UPDATE mobile_installations SET last_seen_at=now()-interval '31 seconds' WHERE id=$1`, [f.id]);
    await expect(requestCapture(f.agent, f.id, f.input, randomUUID())).rejects.toMatchObject({ code: 'action_required' });
    await db.query(`UPDATE mobile_installations SET last_seen_at=now(),app_state='background' WHERE id=$1`, [f.id]);
    await expect(requestCapture(f.agent, f.id, f.input, randomUUID())).rejects.toMatchObject({ code: 'action_required' });
  });
  it('replays requests without duplicate command creation and rejects changed payloads', async () => {
    const f = await fixture(), key = randomUUID();
    const first = await requestCapture(f.agent, f.id, f.input, key);
    expect(await requestCapture(f.agent, f.id, f.input, key)).toEqual(first);
    await expect(requestCapture(f.agent, f.id, { ...f.input, capture_client_id: randomUUID() }, key)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(requestCapture(f.agent, f.id, f.input, randomUUID())).rejects.toMatchObject({ code: 'conflict' });
  });
  it('revoked agents cannot claim a queued command', async () => {
    const f = await fixture();
    const command = await requestCapture(f.agent, f.id, f.input, randomUUID());
    await revokeAgentConnection(f.ctx, { id: f.created.connection.id });
    expect((await claimCommands(f.phone)).items).toEqual([]);
    expect((await getCommand(f.ctx, command.command_id)).state).toBe('cancelled');
  });
  it('rotation after delivery prevents pre-execution authorization', async () => {
    const f = await fixture();
    const command = await requestCapture(f.agent, f.id, f.input, randomUUID());
    expect((await claimCommands(f.phone)).items).toHaveLength(1);
    await rotateConnection(f.ctx, f.created.connection.id);
    await expect(acknowledgeCommand(f.phone, command.command_id, { sequence: 1, state: 'executing' })).rejects.toMatchObject({ code: 'token_revoked' });
  });
  it('expires starts instead of executing after reconnection', async () => {
    const f = await fixture();
    const command = await requestCapture(f.agent, f.id, f.input, randomUUID());
    await db.query(`UPDATE device_commands SET expires_at=now()-interval '1 second' WHERE id=$1`, [command.command_id]);
    expect((await claimCommands(f.phone)).items).toEqual([]);
    expect((await getCommand(f.ctx, command.command_id)).state).toBe('expired');
  });
  it('validates monotonic acknowledgement and records unknown outcomes without retrying capture', async () => {
    const f = await fixture();
    const command = await requestCapture(f.agent, f.id, f.input, randomUUID());
    await claimCommands(f.phone);
    await acknowledgeCommand(f.phone, command.command_id, { sequence: 2, state: 'executing' });
    expect((await acknowledgeCommand(f.phone, command.command_id, { sequence: 1, state: 'awaiting_user' })).state).toBe('executing');
    expect((await acknowledgeCommand(f.phone, command.command_id, { sequence: 3, state: 'unknown', safe_error: 'outcome_unknown' })).state).toBe('unknown');
    expect((await claimCommands(f.phone)).items).toEqual([]);
  });
  it('rechecks revocation when an executing acknowledgement is replayed', async () => {
    const f = await fixture(), key = randomUUID();
    const command = await requestCapture(f.agent, f.id, f.input, randomUUID());
    await claimCommands(f.phone);
    await acknowledgeCommand(f.phone, command.command_id, { sequence: 1, state: 'executing' }, key);
    await revokeAgentConnection(f.ctx, { id: f.created.connection.id });
    await expect(acknowledgeCommand(f.phone, command.command_id, { sequence: 1, state: 'executing' }, key)).rejects.toMatchObject({ code: 'token_revoked' });
  });
  it('rejects changed acknowledgements under one idempotency key', async () => {
    const f = await fixture(), key = randomUUID();
    const command = await requestCapture(f.agent, f.id, f.input, randomUUID());
    await claimCommands(f.phone);
    await acknowledgeCommand(f.phone, command.command_id, { sequence: 1, state: 'executing' }, key);
    await expect(acknowledgeCommand(f.phone, command.command_id, { sequence: 2, state: 'succeeded' }, key)).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('never exposes setup identifiers or raw capability data, and stale devices are not ready', async () => {
    const f = await fixture();
    await db.query(`UPDATE mobile_installations SET last_seen_at=now()-interval '31 seconds' WHERE id=$1`, [f.id]);
    const setup = await getSetup(f.agent);
    expect(setup.installations[0]).toMatchObject({ stale: true, capabilities: { photo: false, video: false } });
    const serialized = JSON.stringify(setup);
    for (const forbidden of [f.id, 'hardware_serial', 'push_token', 'ip_address', 'secret']) expect(serialized).not.toContain(forbidden);
  });
});

describe('agent remote capture flag is enforced on the server', () => {
  const commandCount = async (installationId: string) =>
    (await db.query('SELECT id FROM device_commands WHERE installation_id=$1', [installationId])).rowCount;

  it('is off by default: an armed phone and an allowed agent still cannot queue a capture', async () => {
    const f = await fixture();
    const agent = testContext(f.agent.principal); // default configuration, no operator opt-in
    await expect(requestCapture(agent, f.id, f.input, randomUUID())).rejects.toMatchObject({
      code: 'service_unavailable', retryable: false,
      details: { feature: 'agent_remote_capture_enabled', reasons: ['not_enabled'] },
    });
    expect(await commandCount(f.id)).toBe(0);
  });

  it('an account kill stops new requests, cancels queued commands on claim and blocks execution', async () => {
    const f = await fixture();
    const queued = await requestCapture(f.agent, f.id, f.input, randomUUID());
    await setFeatureKill(db, { flag: 'agent_remote_capture_enabled', accountId: f.owner.accountId, reason: 'test', actor: 'test' });
    await expect(requestCapture(f.agent, f.id, { ...f.input, capture_client_id: randomUUID() }, randomUUID()))
      .rejects.toMatchObject({ code: 'service_unavailable', retryable: true });
    expect((await claimCommands(f.phone)).items).toEqual([]);
    expect(await getCommand(f.ctx, queued.command_id)).toMatchObject({ state: 'cancelled', error_code: 'service_unavailable' });
    await liftFeatureKill(db, { flag: 'agent_remote_capture_enabled', accountId: f.owner.accountId });
    const next = await requestCapture(f.agent, f.id, { ...f.input, capture_client_id: randomUUID() }, randomUUID());
    expect(next.state).toBe('queued');
  });

  it('a kill after delivery blocks the phone\'s pre-execution check', async () => {
    const f = await fixture();
    const command = await requestCapture(f.agent, f.id, f.input, randomUUID());
    expect((await claimCommands(f.phone)).items).toHaveLength(1);
    await setFeatureKill(db, { flag: 'agent_remote_capture_enabled', accountId: f.owner.accountId, reason: 'test', actor: 'test' });
    await expect(acknowledgeCommand(f.phone, command.command_id, { sequence: 1, state: 'executing' }))
      .rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('killing the agent API (environment or account) also stops remote capture', async () => {
    const f = await fixture();
    const envKilled = testContext(f.agent.principal, { config: testConfig({ ...optedIn, FEATURE_KILL_SWITCHES: 'agent_api_enabled' }) });
    await expect(requestCapture(envKilled, f.id, f.input, randomUUID())).rejects.toMatchObject({
      code: 'service_unavailable', details: { reasons: ['agent_api_disabled'] },
    });
    await setFeatureKill(db, { flag: 'agent_api_enabled', accountId: f.owner.accountId, reason: 'test', actor: 'test' });
    await expect(requestCapture(f.agent, f.id, f.input, randomUUID())).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await commandCount(f.id)).toBe(0);
  });
});
