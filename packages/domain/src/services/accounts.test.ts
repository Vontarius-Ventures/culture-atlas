import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { AccountPrincipal } from '../principal';
import { anonCtx, ctxFor, insertCaptureWithAnalysis, insertItem, insertReference } from '../test-support/library';
import { closeTestDb, getTestDb } from '../testing';
import { claimSession, createAccount, resolvePrincipal, signIn, signOut } from './auth';
import { listCollections } from './collections';
import { hashPassword, verifyPassword } from './passwords';
import { listSaved, recordPreference } from './preferences';
import { getTaste } from './taste';

const db = getTestDb();
afterAll(closeTestDb);

const email = () => `demo-${randomUUID().slice(0, 8)}@example.com`;

async function asAccount(token: string): Promise<AccountPrincipal> {
  const p = await resolvePrincipal(db, { sessionToken: token });
  if (p?.kind !== 'account') throw new Error('expected account principal');
  return p;
}

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('accounts and session claim', () => {
  it('anonymous visitors are asked to create an account to save', async () => {
    const { ctx } = await anonCtx();
    const item = await insertItem(null, { kind: 'film' });
    await expect(recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item })).rejects.toMatchObject({
      code: 'account_required',
      status: 403,
    });
  });

  it('creates an account, claims the session (captures, hides, items) and performs the pending save', async () => {
    const { principal: anon, ctx } = await anonCtx();
    const ref = await insertReference({ name: 'Mid-century modern' });
    const cap = await insertCaptureWithAnalysis({ sessionId: anon.sessionId }, { anchorIds: [ref] });
    const hiddenItem = await insertItem({ sessionId: anon.sessionId }, { kind: 'artist' });
    await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: hiddenItem });

    const res = await createAccount(ctx, {
      email: email(),
      password: 'a long demo password',
      claim_session: true,
      pending_save: { target_type: 'capture', target_id: cap.captureId, new_collection_name: 'Rooms' },
    });
    expect(res.claimed.captures).toBe(1);
    expect(res.pending_save).toMatchObject({ discovery_item_id: cap.itemId });
    expect(res.csrf_token).toBeTruthy();

    // The anonymous token no longer works; the new one is an account session.
    const old = await db.query('SELECT revoked_at, claimed_at FROM sessions WHERE id = $1', [anon.sessionId]);
    expect(old.rows[0]!.revoked_at).not.toBeNull();
    const acct = await asAccount(res.sessionToken);
    expect(acct.accountId).toBe(res.account_id);

    const actx = ctxFor(acct);
    const cols = await listCollections(actx);
    expect(cols.collections.map((c) => c.name)).toEqual(['Rooms']);
    expect(cols.collections[0]!.item_count).toBe(1);
    const saved = await listSaved(actx, { filter: 'all' });
    expect(saved.items.map((s) => s.item.id)).toEqual([cap.itemId]);
    const taste = await getTaste(actx, {});
    expect(taste.hidden_count).toBe(1);
    expect(taste.interests.map((i) => i.label)).toContain('Mid-century modern');
    const owned = await db.query('SELECT owner_account_id, expires_at FROM captures WHERE id = $1', [cap.captureId]);
    expect(owned.rows[0]).toMatchObject({ owner_account_id: res.account_id, expires_at: null });
  });

  it('rejects duplicate emails and creation from a signed-in session', async () => {
    const e = email();
    const first = await anonCtx();
    const created = await createAccount(first.ctx, { email: e, password: 'password one', claim_session: true });
    const second = await anonCtx();
    await expect(createAccount(second.ctx, { email: e.toUpperCase(), password: 'password two', claim_session: true })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(createAccount(ctxFor(await asAccount(created.sessionToken)), { claim_session: true })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('device accounts (no email) work without credentials', async () => {
    const { ctx } = await anonCtx();
    const res = await createAccount(ctx, { display_name: 'Ana', claim_session: true });
    expect((await asAccount(res.sessionToken)).accountId).toBe(res.account_id);
  });

  it('signs in returning users, merging a new anonymous session by canonical identity', async () => {
    const e = email();
    const pw = 'returning user password';
    const first = await anonCtx();
    const created = await createAccount(first.ctx, { email: e, password: pw, claim_session: true });
    const accountId = created.account_id;
    const key = `qloo:${randomUUID()}`;
    const accountFilm = await insertItem({ accountId }, { key, title: 'Amélie' });
    await recordPreference(ctxFor(await asAccount(created.sessionToken)), { action: 'save', target_type: 'discovery_item', target_id: accountFilm });

    // Later, on another device: anonymous session with the same canonical film and a new capture.
    const later = await anonCtx();
    const dupFilm = await insertItem({ sessionId: later.principal.sessionId }, { key, title: 'Amélie' });
    const dj = await db.query<{ id: string }>('INSERT INTO discovery_jobs (owner_session_id, origin_item_id) VALUES ($1, $2) RETURNING id', [
      later.principal.sessionId,
      dupFilm,
    ]);
    await db.query(
      `INSERT INTO recommendations (discovery_item_id, discovery_job_id, rank, title, origin) VALUES ($1, $2, 1, 'Amélie', 'vlm_creative')`,
      [dupFilm, dj.rows[0]!.id],
    );
    const cap = await insertCaptureWithAnalysis({ sessionId: later.principal.sessionId });

    await expect(signIn(later.ctx, { email: e, password: 'nope nope', claim_session: true })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(signIn(later.ctx, { email: 'nobody@example.com', password: pw, claim_session: true })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    const res = await signIn(later.ctx, { email: e.toUpperCase(), password: pw, claim_session: true });
    expect(res.principal).toMatchObject({ kind: 'account', account_id: accountId });
    expect(res.claimed.captures).toBe(1);
    // The duplicate film merged into the account's existing item; references were remapped.
    const items = await db.query('SELECT id FROM discovery_items WHERE canonical_key = $1', [key]);
    expect(items.rows.map((r) => r.id)).toEqual([accountFilm]);
    const rec = await db.query('SELECT discovery_item_id FROM recommendations r JOIN discovery_jobs dj ON dj.id = r.discovery_job_id WHERE dj.origin_item_id = $1', [accountFilm]);
    expect(rec.rows.every((r) => r.discovery_item_id === accountFilm)).toBe(true);
    const capOwner = await db.query('SELECT owner_account_id FROM captures WHERE id = $1', [cap.captureId]);
    expect(capOwner.rows[0]!.owner_account_id).toBe(accountId);

    const out = await signOut(ctxFor(await asAccount(res.sessionToken)));
    expect(out.principal.kind).toBe('anonymous');
    expect(await resolvePrincipal(db, { sessionToken: res.sessionToken })).toBeNull();
  });

  it('limits repeated failed sign-ins per email', async () => {
    const e = email();
    const { ctx } = await anonCtx();
    await createAccount(ctx, { email: e, password: 'the right password', claim_session: false });
    const attacker = await anonCtx();
    for (let i = 0; i < 10; i++) {
      await expect(signIn(attacker.ctx, { email: e, password: `wrong ${i}`, claim_session: true })).rejects.toMatchObject({ code: 'unauthenticated' });
    }
    await expect(signIn(attacker.ctx, { email: e, password: 'the right password', claim_session: true })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('claimSession is idempotent for an already claimed session', async () => {
    const { principal } = await anonCtx();
    const { rows } = await db.query<{ id: string }>(`INSERT INTO accounts (auth_subject) VALUES ($1) RETURNING id`, [`test:${randomUUID()}`]);
    const first = await db.transaction((tx) => claimSession(tx, principal.sessionId, rows[0]!.id, new Date()));
    const second = await db.transaction((tx) => claimSession(tx, principal.sessionId, rows[0]!.id, new Date()));
    expect(first).toEqual({ captures: 0, saved_items: 0 });
    expect(second).toEqual({ captures: 0, saved_items: 0 });
  });
});
