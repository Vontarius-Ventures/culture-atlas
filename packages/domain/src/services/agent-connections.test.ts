import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, insertAnonymousSession, testConfig, testContext } from '../testing';
import { hashToken, resolvePrincipal } from './auth';
import { createAgentConnection, listAgentConnections, revokeAgentConnection, updateAgentConnection } from './agent-connections';
import { createCollection, deleteCollection } from './collections';

const db = getTestDb();
afterAll(closeTestDb);

async function owner() {
  const principal = await insertAccount();
  return { principal, ctx: testContext(principal) };
}

describe('agent connections', () => {
  it('shows the credential once, stores only its hash, and resolves it to a scoped agent principal', async () => {
    const { principal, ctx } = await owner();
    const col = await createCollection(ctx, { name: 'Tokyo evenings' });
    const res = await createAgentConnection(ctx, {
      client_name: 'demo agent',
      scopes: ['plans:write', 'collections:read', 'collections:read'],
      library_access: 'selected_collections',
      collection_ids: [col.id],
      expires_in_days: 7,
    });
    expect(res.credential).toMatch(/^cat_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(res.mcp_url).toBe('http://localhost:3000/mcp');
    expect(res.connection).toMatchObject({
      client_name: 'demo agent',
      scopes: ['collections:read', 'plans:write'],
      library_access: 'selected_collections',
      collection_ids: [col.id],
      status: 'active',
      revoked_at: null,
    });
    expect(res.connection.credential_prefix).toBe(`${res.credential.split('_').slice(0, 2).join('_')}_…`);
    expect(res.connection.access_summary.limits.join(' ')).toMatch(/Unfiled saves, other collections and your overall taste stay private/);
    const days = (Date.parse(res.connection.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    const { rows } = await db.query<{ credential_hash: string; credential_prefix: string }>(
      'SELECT credential_hash, credential_prefix FROM agent_connections WHERE id = $1',
      [res.connection.id],
    );
    expect(rows[0]!.credential_hash).toBe(hashToken(res.credential));
    expect(JSON.stringify(rows[0])).not.toContain(res.credential);

    const listed = await listAgentConnections(ctx);
    expect(listed.connections.map((c) => c.id)).toEqual([res.connection.id]);
    expect(JSON.stringify(listed)).not.toContain(res.credential);

    const agent = await resolvePrincipal(db, { authorization: `Bearer ${res.credential}` });
    expect(agent).toMatchObject({
      kind: 'agent',
      accountId: principal.accountId,
      scopes: ['collections:read', 'plans:write'],
      libraryAccess: 'selected_collections',
      allowedCollectionIds: [col.id],
    });
  });

  it('defaults to read-only scopes and never grants another account’s collections', async () => {
    const a = await owner();
    const b = await owner();
    const theirs = await createCollection(b.ctx, { name: 'Not yours' });
    await expect(
      createAgentConnection(a.ctx, { client_name: 'x', scopes: ['collections:read'], library_access: 'selected_collections', collection_ids: [theirs.id], expires_in_days: 30 }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
    const { rows } = await db.query('SELECT 1 FROM agent_connections WHERE owner_account_id = $1', [a.principal.accountId]);
    expect(rows).toHaveLength(0);

    const { CreateAgentConnectionRequest } = await import('../schemas/agent-connections');
    const parsed = CreateAgentConnectionRequest.parse({ client_name: 'reader', library_access: 'all' });
    expect(parsed.scopes).toEqual(['captures:read', 'collections:read', 'taste:read', 'plans:read']);
  });

  it('is only available to the account owner in the browser', async () => {
    const anon = testContext(await insertAnonymousSession());
    await expect(listAgentConnections(anon)).rejects.toMatchObject({ code: 'account_required' });
    const { principal } = await owner();
    const { principal: agent } = await insertAgentConnection(principal, { libraryAccess: 'all' });
    await expect(
      createAgentConnection(testContext(agent), { client_name: 'nested', scopes: ['collections:read'], library_access: 'all', collection_ids: [], expires_in_days: 30 }),
    ).rejects.toMatchObject({ code: 'scope_denied' });
    await expect(revokeAgentConnection(testContext(agent), { id: agent.connectionId })).rejects.toMatchObject({ code: 'scope_denied' });
  });

  it('revokes immediately and idempotently; other owners get not_found', async () => {
    const a = await owner();
    const b = await owner();
    const res = await createAgentConnection(a.ctx, { client_name: 'x', scopes: ['collections:read'], library_access: 'all', collection_ids: [], expires_in_days: 30 });
    await expect(revokeAgentConnection(b.ctx, { id: res.connection.id })).rejects.toMatchObject({ code: 'not_found' });
    await revokeAgentConnection(a.ctx, { id: res.connection.id });
    await revokeAgentConnection(a.ctx, { id: res.connection.id });
    await expect(resolvePrincipal(db, { authorization: `Bearer ${res.credential}` })).rejects.toMatchObject({ code: 'token_revoked', status: 401 });
    const listed = await listAgentConnections(a.ctx);
    expect(listed.connections[0]).toMatchObject({ status: 'revoked' });
    await expect(updateAgentConnection(a.ctx, { id: res.connection.id, body: { client_name: 'y' } })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reports expired connections and rejects their tokens', async () => {
    const a = await owner();
    const res = await createAgentConnection(a.ctx, { client_name: 'x', scopes: ['collections:read'], library_access: 'all', collection_ids: [], expires_in_days: 1 });
    const later = new Date(Date.now() + 2 * 86_400_000);
    await expect(resolvePrincipal(db, { authorization: `Bearer ${res.credential}`, now: later })).rejects.toMatchObject({ code: 'token_expired' });
    const listed = await listAgentConnections(testContext(a.principal, { now: () => later }));
    expect(listed.connections[0]!.status).toBe('expired');
  });

  it('changes the collection grant in place; new and deleted collections follow the rules', async () => {
    const a = await owner();
    const one = await createCollection(a.ctx, { name: 'One' });
    const two = await createCollection(a.ctx, { name: 'Two' });
    const res = await createAgentConnection(a.ctx, {
      client_name: 'x',
      scopes: ['collections:read'],
      library_access: 'selected_collections',
      collection_ids: [one.id, two.id],
      expires_in_days: 30,
    });
    await createCollection(a.ctx, { name: 'Three (not auto-granted)' });
    let agent = await resolvePrincipal(db, { authorization: `Bearer ${res.credential}` });
    expect(agent?.kind === 'agent' && [...agent.allowedCollectionIds].sort()).toEqual([one.id, two.id].sort());

    const updated = await updateAgentConnection(a.ctx, { id: res.connection.id, body: { collection_ids: [one.id], client_name: 'renamed' } });
    expect(updated).toMatchObject({ client_name: 'renamed', collection_ids: [one.id] });
    agent = await resolvePrincipal(db, { authorization: `Bearer ${res.credential}` });
    expect(agent?.kind === 'agent' && agent.allowedCollectionIds).toEqual([one.id]);

    await deleteCollection(a.ctx, { id: one.id });
    agent = await resolvePrincipal(db, { authorization: `Bearer ${res.credential}` });
    expect(agent?.kind === 'agent' && agent.allowedCollectionIds).toEqual([]);

    const whole = await createAgentConnection(a.ctx, { client_name: 'w', scopes: ['collections:read'], library_access: 'all', collection_ids: [], expires_in_days: 30 });
    await expect(updateAgentConnection(a.ctx, { id: whole.connection.id, body: { collection_ids: [two.id] } })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('builds the MCP url from APP_BASE_URL', async () => {
    const principal = await insertAccount();
    const ctx = testContext(principal, { config: testConfig({ APP_BASE_URL: 'https://atlas.example/' }) });
    const res = await createAgentConnection(ctx, { client_name: 'x', scopes: ['taste:read'], library_access: 'none', collection_ids: [], expires_in_days: 30 });
    expect(res.mcp_url).toBe('https://atlas.example/mcp');
    expect(res.connection.access_summary.limits).toContain('No access to your collections or saved items.');
  });
});
