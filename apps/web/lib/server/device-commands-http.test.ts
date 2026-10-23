import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentCommands, agentPlatform, auth, setDbForTesting, setDomainConfigForTesting, type InstallationAuthority } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAccount, testConfig, testContext } from '@culture-atlas/domain/testing';
import { LocalMultipartStorage } from '@culture-atlas/providers';

vi.mock('server-only', () => ({}));
const { setCaptureV2Runtime } = await import('./capture-v2');
const claim = await import('../../app/v2/device/commands/route');
const ack = await import('../../app/v2/device/commands/[id]/ack/route');

const db = getTestDb();
// The operator has opted in to agent remote capture (default off).
const config = testConfig({ AGENT_REMOTE_CAPTURE_ENABLED: 'true' });
const BASE = 'http://localhost:3304';
let root: string;
const phones = new Map<string, InstallationAuthority>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-device-commands-'));
  setDbForTesting(db);
  setDomainConfigForTesting(config);
  setCaptureV2Runtime({
    storage: new LocalMultipartStorage(root, BASE, 'private-test-key'),
    // Stand-in for the identity module's native session resolver.
    resolveNativePrincipal: async (token) => {
      const authority = phones.get(token);
      if (!authority) throw new Error('unknown token');
      return authority;
    },
  });
});
afterAll(async () => {
  setCaptureV2Runtime({});
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const owner = await insertAccount();
  const ctx = testContext(owner);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO mobile_installations (account_id, installation_public_id, platform, app_version, readiness, app_state, capabilities)
     VALUES ($1, $2, 'android', '1.0', 'ready', 'foreground', '{"photo":true}') RETURNING id`,
    [owner.accountId, randomUUID()],
  );
  const installationId = rows[0]!.id;
  const created = await agentPlatform.createConnection(ctx, { client_name: 'Camera agent', scopes: ['devices:command'], installation_ids: [installationId] });
  const agent = testContext((await auth.resolvePrincipal(db, { authorization: `Bearer ${created.credential}` }))!, { config });
  const session = await db.query<{ id: string }>(
    `INSERT INTO capture_sessions (account_id, installation_id, source, media_mode, remote_arm_expires_at, allowed_agent_connection_ids)
     VALUES ($1, $2, 'phone_camera', 'photo', now() + interval '10 minutes', $3) RETURNING id`,
    [owner.accountId, installationId, [created.connection.id]],
  );
  const token = `cna_${randomUUID()}`;
  phones.set(token, { kind: 'installation', accountId: owner.accountId, installationId, sessionId: randomUUID(), expiresAt: new Date(Date.now() + 600_000) });
  return { owner, ctx, agent, installationId, sessionId: session.rows[0]!.id, token, connectionId: created.connection.id };
}

const phone = (path: string, token: string | null, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
  new NextRequest(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

describe('DEV-02 phone-side command delivery routes', () => {
  it('delivers a locally armed command once, accepts ordered acks and never delivers to another phone', async () => {
    const f = await fixture();
    const other = await fixture();
    const command = await agentCommands.requestCapture(f.agent, f.installationId, {
      session_id: f.sessionId, generation: 1, action: 'capture_photo', capture_client_id: randomUUID(),
    }, randomUUID());
    const foreign = await claim.GET(phone('/v2/device/commands', other.token));
    expect((await foreign.json()).items).toEqual([]);
    const res = await claim.GET(phone('/v2/device/commands', f.token));
    expect(res.status).toBe(200);
    const batch = await res.json();
    expect(batch.items.map((c: { command_id: string; state: string }) => [c.command_id, c.state])).toEqual([[command.command_id, 'delivered']]);
    const seg = { params: Promise.resolve({ id: command.command_id }) };
    const executing = await ack.POST(phone(`/v2/device/commands/${command.command_id}/ack`, f.token, { method: 'POST', body: { sequence: 1, state: 'executing' } }), seg);
    expect(executing.status).toBe(200);
    expect((await executing.json()).state).toBe('executing');
    const wrongPhone = await ack.POST(phone(`/v2/device/commands/${command.command_id}/ack`, other.token, { method: 'POST', body: { sequence: 2, state: 'failed' } }), seg);
    expect(wrongPhone.status).toBe(404);
  });

  it('cancels a queued command on claim when the agent was revoked before delivery', async () => {
    const f = await fixture();
    const command = await agentCommands.requestCapture(f.agent, f.installationId, {
      session_id: f.sessionId, generation: 1, action: 'capture_photo', capture_client_id: randomUUID(),
    }, randomUUID());
    await db.query('UPDATE agent_connections SET revoked_at = now() WHERE id = $1', [f.connectionId]);
    const batch = await (await claim.GET(phone('/v2/device/commands', f.token))).json();
    expect(batch.items).toEqual([]);
    const state = await db.query<{ state: string }>('SELECT state FROM device_commands WHERE id = $1', [command.command_id]);
    expect(state.rows[0]!.state).toBe('cancelled');
  });

  it('refuses browser sessions, agent tokens and missing credentials', async () => {
    const f = await fixture();
    const agentToken = (await agentPlatform.createConnection(f.ctx, { client_name: 'x', scopes: ['setup:read'] })).credential;
    expect((await claim.GET(phone('/v2/device/commands', null))).status).toBe(401);
    expect((await claim.GET(phone('/v2/device/commands', agentToken))).status).toBe(401);
    expect((await claim.GET(phone('/v2/device/commands', null, { cookie: 'ca_session=whatever' }))).status).toBe(401);
  });
});
