import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  agentPlatform,
  auth,
  setDbForTesting,
  setDomainConfigForTesting,
  type InstallationAuthority,
} from '@culture-atlas/domain';
import {
  closeTestDb,
  getTestDb,
  insertAccount,
  testConfig,
  testContext,
} from '@culture-atlas/domain/testing';
import { LocalMultipartStorage } from '@culture-atlas/providers';

vi.mock('server-only', () => ({}));
const { setCaptureV2Runtime } = await import('./capture-v2');
const { GET, POST } = await import('../../app/v2/agent-connections/route');

const db = getTestDb();
const config = testConfig();
const BASE = 'http://localhost:3312';
let root: string;
const phones = new Map<string, InstallationAuthority>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-arming-agents-'));
  setDbForTesting(db);
  setDomainConfigForTesting(config);
  setCaptureV2Runtime({
    storage: new LocalMultipartStorage(root, BASE, 'arming-test-key'),
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
     VALUES ($1, $2, 'ios', '1.0', 'ready', 'foreground', '{"photo":true}') RETURNING id`,
    [owner.accountId, randomUUID()],
  );
  const installationId = rows[0]!.id;
  const { rows: otherRows } = await db.query<{ id: string }>(
    `INSERT INTO mobile_installations (account_id, installation_public_id, platform, app_version, readiness, app_state, capabilities)
     VALUES ($1, $2, 'android', '1.0', 'ready', 'foreground', '{"photo":true}') RETURNING id`,
    [owner.accountId, randomUUID()],
  );
  const otherInstallationId = otherRows[0]!.id;
  const commandable = await agentPlatform.createConnection(ctx, {
    client_name: 'Camera agent',
    scopes: ['devices:command', 'setup:read'],
    installation_ids: [installationId],
  });
  const otherPhoneOnly = await agentPlatform.createConnection(ctx, {
    client_name: 'Other phone agent',
    scopes: ['devices:command', 'setup:read'],
    installation_ids: [otherInstallationId],
  });
  const libraryOnly = await agentPlatform.createConnection(ctx, {
    client_name: 'Library reader',
    scopes: ['media:read', 'setup:read'],
  });
  const token = `cna_${randomUUID().replace(/-/g, '').slice(0, 32)}aaaa`;
  phones.set(token, {
    kind: 'installation',
    accountId: owner.accountId,
    installationId,
    sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000),
  });
  const sessionToken = auth.randomToken();
  await db.query(`UPDATE sessions SET token_hash=$2 WHERE id=$1`, [
    owner.sessionId,
    auth.hashToken(sessionToken),
  ]);
  return {
    owner,
    token,
    sessionToken,
    csrf: auth.csrfTokenFor(owner.sessionId!, config.SESSION_SECRET),
    commandable,
    otherPhoneOnly,
    libraryOnly,
  };
}

const call = (
  token: string | null,
  init: { cookie?: string; csrf?: string; method?: string; body?: unknown } = {},
) =>
  new NextRequest(`${BASE}/v2/agent-connections`, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.cookie ? { cookie: `ca_session=${init.cookie}` } : {}),
      ...(init.csrf ? { 'x-csrf-token': init.csrf } : {}),
      ...(init.body === undefined
        ? {}
        : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

describe('GET /v2/agent-connections for an enrolled phone', () => {
  it('returns only this installation’s commandable agent names, never a credential', async () => {
    const f = await fixture();
    const response = await GET(call(f.token), { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connections).toEqual([
      {
        id: f.commandable.connection.id,
        client_name: 'Camera agent',
        scopes: expect.arrayContaining(['devices:command']),
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/cat_|credential/);
    expect(body.connections[0]).not.toHaveProperty('credential_prefix');
    expect(body.connections.map((c: { id: string }) => c.id)).not.toContain(
      f.otherPhoneOnly.connection.id,
    );
    expect(body.connections.map((c: { id: string }) => c.id)).not.toContain(
      f.libraryOnly.connection.id,
    );
  });

  it('keeps the owner list on a cookie session and refuses agent tokens', async () => {
    const f = await fixture();
    expect(
      (await GET(call(f.commandable.credential), { params: Promise.resolve({}) })).status,
    ).toBe(403);
    const ownerList = await GET(call(null, { cookie: f.sessionToken }), {
      params: Promise.resolve({}),
    });
    expect(ownerList.status).toBe(200);
    const listed = await ownerList.json();
    expect(listed.connections.length).toBeGreaterThanOrEqual(3);
    expect(listed.connections[0]).toHaveProperty('credential_prefix');
  });

  it('does not let an installation create connections', async () => {
    const f = await fixture();
    const created = await POST(
      call(f.token, {
        method: 'POST',
        body: { client_name: 'Nope', scopes: ['setup:read'], library_access: 'none' },
      }),
      { params: Promise.resolve({}) },
    );
    expect(created.status).toBe(403);
    expect((await created.json()).error.code).toBe('scope_denied');
  });
});
