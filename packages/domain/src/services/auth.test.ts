import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, testConfig } from '../testing';
import { createAnonymousSession, csrfTokenFor, resolvePrincipal, verifyCsrf } from './auth';

const db = getTestDb();
afterAll(closeTestDb);

describe('resolvePrincipal', () => {
  it('returns null without credentials and resolves anonymous sessions', async () => {
    expect(await resolvePrincipal(db, {})).toBeNull();
    const s = await createAnonymousSession(db, testConfig());
    const p = await resolvePrincipal(db, { sessionToken: s.token });
    expect(p).toMatchObject({ kind: 'anonymous', sessionId: s.sessionId });
    expect(await resolvePrincipal(db, { sessionToken: 'unknown' })).toBeNull();
  });

  it('resolves agent bearer tokens with grants and rejects revoked/expired ones', async () => {
    const account = await insertAccount(db);
    const col = await db.query<{ id: string }>(`INSERT INTO collections (owner_account_id, name) VALUES ($1, 'Shared') RETURNING id`, [account.accountId]);
    const { principal, credential } = await insertAgentConnection(account, {
      scopes: ['collections:read'],
      libraryAccess: 'selected_collections',
      collectionIds: [col.rows[0]!.id],
    });
    const p = await resolvePrincipal(db, { authorization: `Bearer ${credential}` });
    expect(p).toMatchObject({ kind: 'agent', connectionId: principal.connectionId, allowedCollectionIds: [col.rows[0]!.id] });

    await db.query('UPDATE agent_connections SET revoked_at = now() WHERE id = $1', [principal.connectionId]);
    await expect(resolvePrincipal(db, { authorization: `Bearer ${credential}` })).rejects.toMatchObject({ code: 'token_revoked', status: 401 });

    const other = await insertAgentConnection(account);
    await db.query(`UPDATE agent_connections SET expires_at = now() - interval '1 minute' WHERE id = $1`, [other.principal.connectionId]);
    await expect(resolvePrincipal(db, { authorization: `Bearer ${other.credential}` })).rejects.toMatchObject({ code: 'token_expired' });
    await expect(resolvePrincipal(db, { authorization: 'Bearer nope' })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('verifies CSRF tokens bound to the session', () => {
    const t = csrfTokenFor('s-1', 'secret');
    expect(verifyCsrf('s-1', 'secret', t)).toBe(true);
    expect(verifyCsrf('s-2', 'secret', t)).toBe(false);
    expect(verifyCsrf('s-1', 'secret', null)).toBe(false);
  });
});
