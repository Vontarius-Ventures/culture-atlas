import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { authorizeAgent } from '../authz/agent-authorization';
import { CreateAgentConnectionRequest } from '../schemas/agent-connections';
import { CreateAgentV2 } from '../schemas/agent-platform';
import { closeTestDb, getTestDb, insertAccount, testContext } from '../testing';
import { createAgentConnection, revokeAgentConnection } from './agent-connections';
import { createConnection, getPreferences, narrowConnection, preferenceVersion, rotateConnection, updatePreferences } from './agent-platform';
import { consent, exchange } from './agent-oauth';
import { hashToken, resolvePrincipal } from './auth';

const db = getTestDb();
afterAll(closeTestDb);

async function fixture(scopes = ['setup:read', 'preferences:read', 'preferences:write']) {
  const owner = await insertAccount();
  const ctx = testContext(owner);
  const created = await createConnection(ctx, { client_name: 'Research agent', scopes });
  const principal = await resolvePrincipal(db, { authorization: `Bearer ${created.credential}` });
  if (!principal) throw new Error('missing principal');
  return { owner, ctx, created, agent: testContext(principal) };
}

describe('AGT-01 explicit v2 grants', () => {
  it('preserves v1 defaults and denies every new scope to existing tokens', async () => {
    const owner = await insertAccount();
    const ctx = testContext(owner);
    const body = CreateAgentConnectionRequest.parse({ client_name: 'legacy', library_access: 'all' });
    const created = await createAgentConnection(ctx, body);
    const principal = (await resolvePrincipal(db, { authorization: `Bearer ${created.credential}` }))!;
    expect(principal.kind === 'agent' && principal.scopes).toEqual(['captures:read', 'collections:read', 'taste:read', 'plans:read']);
    for (const scope of ['setup:read', 'preferences:read', 'preferences:write', 'media:read', 'media:download', 'media:write', 'media:analyze', 'devices:command'] as const) {
      await expect(authorizeAgent(testContext(principal), scope)).rejects.toMatchObject({ code: 'scope_denied' });
    }
  });
  it('defaults new v2 connections to setup and preferences only', () => {
    const grant = CreateAgentV2.parse({ client_name: 'new' });
    expect(grant.scopes).toEqual(['setup:read', 'preferences:read']);
    expect(grant.library_access).toBe('none');
    expect(grant.installation_ids).toEqual([]);
  });
  it('requires selected devices for device-command consent', () => {
    expect(CreateAgentV2.safeParse({ client_name: 'camera', scopes: ['devices:command'] }).success).toBe(false);
  });
  it('rejects agents managing connections and rejects widening', async () => {
    const f = await fixture();
    await expect(createConnection(f.agent, { client_name: 'nested' })).rejects.toMatchObject({ code: 'scope_denied' });
    await expect(narrowConnection(f.ctx, f.created.connection.id, { scopes: ['media:read'] })).rejects.toMatchObject({ code: 'scope_denied' });
    const other = testContext(await insertAccount());
    await expect(rotateConnection(other, f.created.connection.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rechecks revocation on a previously resolved principal and queued checkpoint', async () => {
    const f = await fixture();
    await revokeAgentConnection(f.ctx, { id: f.created.connection.id });
    await expect(authorizeAgent(f.agent, 'setup:read')).rejects.toMatchObject({ code: 'token_revoked' });
  });
  it('narrowing fences previously queued authorization versions', async () => {
    const f = await fixture();
    await narrowConnection(f.ctx, f.created.connection.id, { scopes: ['setup:read'] });
    await expect(authorizeAgent(f.agent, 'setup:read')).rejects.toMatchObject({ code: 'token_revoked' });
    const fresh = (await resolvePrincipal(db, { authorization: `Bearer ${f.created.credential}` }))!;
    await expect(authorizeAgent(testContext(fresh), 'preferences:read')).rejects.toMatchObject({ code: 'scope_denied' });
  });
});

describe('AGT-02 ordinary preferences and token lifecycle', () => {
  it('returns explicit and effective ordinary preferences without private account configuration', async () => {
    const f = await fixture();
    await db.query('UPDATE accounts SET preferences=$2 WHERE id=$1', [f.owner.accountId,
      { theme: 'dark', hardware_serial: 'private', taste: 'private', automatic_analysis: true, token: 'private' }]);
    const result = await getPreferences(f.agent);
    expect(result.user_set).toEqual({ theme: 'dark' });
    expect(result.effective).toMatchObject({ theme: 'dark', video_muted: true, default_capture_mode: 'photo' });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('allows exactly one concurrent preference writer and preserves the winner', async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      updatePreferences(f.agent, { theme: 'dark' }, 1), updatePreferences(f.agent, { theme: 'light' }, 1),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'precondition_failed', status: 412 } });
    expect((await getPreferences(f.agent)).version).toBe(2);
    expect((await db.query('SELECT action FROM agent_activity WHERE connection_id=$1 AND action=$2',
      [f.created.connection.id, 'preferences.update'])).rows).toHaveLength(1);
  });
  it('rejects every security and consent field atomically', async () => {
    const f = await fixture();
    for (const field of ['microphone', 'remote_arming', 'sharing', 'automatic_analysis', 'grants', 'taste']) {
      await expect(updatePreferences(f.agent, { theme: 'dark', [field]: true }, 1)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect((await getPreferences(f.agent)).version).toBe(1);
  });
  it('requires a strong quoted If-Match version', () => {
    expect(preferenceVersion('"2"')).toBe(2);
    expect(() => preferenceVersion(null)).toThrow('If-Match');
    for (const value of ['2', '*', 'W/"2"', '"0"']) expect(() => preferenceVersion(value)).toThrow();
  });
  it('rotates atomically with no old-credential overlap or plaintext storage', async () => {
    const f = await fixture();
    const rotated = await rotateConnection(f.ctx, f.created.connection.id);
    await expect(resolvePrincipal(db, { authorization: `Bearer ${f.created.credential}` })).rejects.toMatchObject({ code: 'unauthenticated' });
    const fresh = await resolvePrincipal(db, { authorization: `Bearer ${rotated.credential}` });
    expect(fresh).toMatchObject({ kind: 'agent', connectionId: f.created.connection.id });
    const record = (await db.query('SELECT credential_hash,credential_prefix FROM agent_connections WHERE id=$1', [f.created.connection.id])).rows[0];
    expect(record!.credential_hash).toBe(hashToken(rotated.credential));
    expect(JSON.stringify(record)).not.toContain(rotated.credential);
  });
});

async function oauthFixture() {
  const owner = await insertAccount();
  const ctx = testContext(owner);
  const client = `client-${randomUUID()}`, redirect = 'https://client.example/callback', verifier = 'v'.repeat(43);
  await db.query('INSERT INTO agent_oauth_clients(id,name,redirect_uris) VALUES($1,$2,$3)', [client, 'Registered client', [redirect]]);
  const request = { client_id: client, redirect_uri: redirect, code_verifier: verifier, resource: 'http://localhost:3000/mcp' };
  const consentBody = { client_id: client, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state: 'client-state-at-least-16', resource: request.resource, grant: { client_name: 'ignored', expires_in_days: 90 } };
  const approved = await consent(ctx, consentBody);
  const url = new URL(approved.redirect_uri);
  return { ctx, request, consentBody, code: url.searchParams.get('code')!, state: url.searchParams.get('state') };
}

describe('AGT-02 OAuth consent and replay defenses', () => {
  it('uses exact registered redirects and returns the unchanged client state', async () => {
    const f = await oauthFixture();
    expect(f.state).toBe('client-state-at-least-16');
    await expect(consent(f.ctx, { ...f.consentBody, redirect_uri: 'https://client.example/callback/extra' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('enforces S256, resource audience and single-use short codes', async () => {
    const f = await oauthFixture();
    const input = { grant_type: 'authorization_code', ...f.request, code: f.code };
    await expect(exchange(db, { ...input, code_verifier: 'z'.repeat(43) }, new Date())).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(exchange(db, { ...input, resource: 'https://elsewhere.example/mcp' }, new Date())).rejects.toMatchObject({ code: 'unauthenticated' });
    const tokens = await exchange(db, input, new Date());
    expect(tokens.expires_in).toBe(600);
    await expect(exchange(db, input, new Date())).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await resolvePrincipal(db, { authorization: `Bearer ${tokens.access_token}` })).toMatchObject({ kind: 'agent' });
  });
  it('refresh reuse revokes the entire family, including new access and refresh tokens', async () => {
    const f = await oauthFixture();
    const first = await exchange(db, { grant_type: 'authorization_code', ...f.request, code: f.code }, new Date());
    const input = { grant_type: 'refresh_token', client_id: f.request.client_id, refresh_token: first.refresh_token, resource: f.request.resource };
    const second = await exchange(db, input, new Date());
    await expect(exchange(db, input, new Date())).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(resolvePrincipal(db, { authorization: `Bearer ${second.access_token}` })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(exchange(db, { ...input, refresh_token: second.refresh_token }, new Date())).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('connection rotation and revocation block OAuth access and refresh', async () => {
    const f = await oauthFixture();
    const tokens = await exchange(db, { grant_type: 'authorization_code', ...f.request, code: f.code }, new Date());
    const principal = (await resolvePrincipal(db, { authorization: `Bearer ${tokens.access_token}` }))!;
    if (principal.kind !== 'agent') throw new Error('not agent');
    await rotateConnection(f.ctx, principal.connectionId);
    await expect(resolvePrincipal(db, { authorization: `Bearer ${tokens.access_token}` })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(exchange(db, { grant_type: 'refresh_token', client_id: f.request.client_id, resource: f.request.resource, refresh_token: tokens.refresh_token }, new Date())).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
