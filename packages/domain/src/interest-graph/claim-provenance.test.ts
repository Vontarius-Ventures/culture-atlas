import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { claimSession } from '../services/accounts';
import { fillInterestsBoard } from '../services/collections';
import { recordPreference } from '../services/preferences';
import { accountCtx, anonCtx, ctxFor, insertItem } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { loadExplicitSupport } from './explicit-support';
import { projectAccountInterestGraph } from './projector';
import { readReconciledInterestGraph } from './read';

/**
 * Claim provenance (VAL-PROJ-002 / VAL-PROJ-003 / VAL-CROSS-001): an
 * anonymous session and an existing account are two INDEPENDENT preference
 * histories. When the claim merges them under one owner, each surviving
 * explicit save keeps its own provenance — the other history's historical
 * removal of the same canonical item withdrew ITS OWN save, never this one.
 *
 * Neither conflicting direction (account save / anonymous remove, anonymous
 * save / account remove) may relabel a still-active save exposure-only:
 * reconciled reads and the ready projection retain it as exactly one private
 * endorsement, unsaved auto-filled rows still confirm nothing, and later
 * real removes, returned Undo and a retried claim converge on the same
 * canonical state as a clean equivalent account.
 */

const db = getTestDb();
afterAll(closeTestDb);

const projectionOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

/** A prepared anonymous save with its save event: the claimed-history shape. */
async function sessionSave(sessionId: string, itemId: string): Promise<void> {
  const { rows } = await db.query<{ canonical_key: string }>('SELECT canonical_key FROM discovery_items WHERE id = $1', [itemId]);
  await db.query('INSERT INTO saved_items (owner_session_id, discovery_item_id) VALUES ($1, $2)', [sessionId, itemId]);
  await db.query(
    `INSERT INTO preference_events (owner_session_id, action, target_type, target_id, payload)
     VALUES ($1, 'save', 'discovery_item', $2, $3::jsonb)`,
    [sessionId, itemId, JSON.stringify({ canonical_key: rows[0]!.canonical_key })],
  );
}

/** An exposure-only session row: filed without a save event, like auto-fill. */
async function sessionRowOnly(sessionId: string, itemId: string): Promise<void> {
  await db.query('INSERT INTO saved_items (owner_session_id, discovery_item_id) VALUES ($1, $2)', [sessionId, itemId]);
}

async function claim(sessionId: string, accountId: string) {
  return db.transaction((tx) => claimSession(tx, sessionId, accountId, new Date(), projectionOn));
}

async function project(accountId: string) {
  return projectAccountInterestGraph(db, { accountId, config: projectionOn, source: 'mutation_intent' });
}

async function graphState(accountId: string): Promise<{ state: string; applied: number; target: number } | null> {
  const { rows } = await db.query<{ state: string; applied: number; target: number }>(
    'SELECT state, applied_taste_revision AS applied, target_taste_revision AS target FROM personal_graph_state WHERE owner_account_id = $1',
    [accountId],
  );
  return rows[0] ?? null;
}

/** The account's saved_item support rows keyed by canonical key (semantic, no event ids). */
async function savedItemSupport(accountId: string): Promise<{ canonicalKey: string }[]> {
  const { rows } = await db.query<{ canonical_key: string }>(
    `SELECT di.canonical_key
       FROM personal_interest_support s
       JOIN saved_items si ON si.id = s.saved_item_id
       JOIN discovery_items di ON di.id = si.discovery_item_id
      WHERE s.owner_account_id = $1 AND s.origin_kind = 'saved_item'
      ORDER BY di.canonical_key`,
    [accountId],
  );
  return rows.map((r) => ({ canonicalKey: r.canonical_key }));
}

/** Which event the projection recorded as each key's real save provenance. */
async function supportLineage(accountId: string): Promise<Map<string, string>> {
  const { rows } = await db.query<{ canonical_key: string; originating_event_id: string | null }>(
    `SELECT di.canonical_key, s.originating_event_id
       FROM personal_interest_support s
       JOIN saved_items si ON si.id = s.saved_item_id
       JOIN discovery_items di ON di.id = si.discovery_item_id
      WHERE s.owner_account_id = $1 AND s.origin_kind = 'saved_item'`,
    [accountId],
  );
  return new Map(rows.map((r) => [r.canonical_key, r.originating_event_id!]));
}

async function saveEventId(ownerAccountId: string, canonicalKey: string, lineage: 'account' | 'claimed'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM preference_events
      WHERE owner_account_id = $1 AND action = 'save' AND payload->>'canonical_key' = $2
        AND payload->>'claimed_session_id' ${lineage === 'claimed' ? 'IS NOT NULL' : 'IS NULL'}
      ORDER BY created_at`,
    [ownerAccountId, canonicalKey],
  );
  return rows[0]!.id;
}

/** Reconciled interests as a comparable canonical-key shape. */
async function reconciledShape(accountId: string) {
  const read = await readReconciledInterestGraph(db, accountId);
  return read.interests
    .map((i) => ({ canonicalKey: i.canonicalKey, origin: i.origin, state: i.state, edge: i.edgeId !== null }))
    .sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
}

describe('conflicting claim histories preserve each surviving explicit save (VAL-PROJ-002/003, VAL-CROSS-001)', () => {
  it('keeps the surviving account save explicit when the anonymous history removed the same canonical item', async () => {
    const { principal: account, ctx: actx } = await accountCtx({ config: projectionOn });
    const key = `test:${randomUUID()}`;
    // An ownerless shared row, so both histories save the very same discovery row.
    const shared = await insertItem(null, { key, kind: 'film', title: 'Shared sample' });
    await recordPreference(actx, { action: 'save', target_type: 'discovery_item', target_id: shared });

    // The anonymous history saves and later withdraws ITS OWN save of the row.
    const { principal: anon } = await anonCtx();
    const sctx = ctxFor(anon, { config: projectionOn });
    await sessionSave(anon.sessionId, shared);
    await recordPreference(sctx, { action: 'remove', target_type: 'discovery_item', target_id: shared });

    const claimed = await claim(anon.sessionId, account.accountId);
    expect(claimed).toEqual({ captures: 0, saved_items: 0 }); // the session row was already withdrawn

    // The account's still-active save keeps its provenance: it stays one
    // explicit endorsement, not an exposure-only row.
    const snapshot = await loadExplicitSupport(db, account.accountId);
    expect(snapshot.saves.map((s) => s.canonicalKey)).toEqual([key]);
    expect(snapshot.exposureOnlyItemIds).toEqual([]);

    // Reconciled reads retain it while the projection catches up.
    const read = await readReconciledInterestGraph(db, account.accountId);
    expect(read.interests.map((i) => i.canonicalKey)).toEqual([key]);
    expect(read.interests[0]).toMatchObject({ origin: 'explicit', state: 'confirmed' });

    // The ready projection retains exactly one private endorsement whose
    // lineage names the account's own save event.
    await project(account.accountId);
    expect(await graphState(account.accountId)).toMatchObject({ state: 'ready' });
    expect(await savedItemSupport(account.accountId)).toEqual([{ canonicalKey: key }]);
    expect((await supportLineage(account.accountId)).get(key)).toBe(await saveEventId(account.accountId, key, 'account'));
  });

  it('keeps the surviving anonymous save explicit when the account history removed the same canonical item', async () => {
    const { principal: account, ctx: actx } = await accountCtx({ config: projectionOn });
    const key = `test:${randomUUID()}`;
    const acctItem = await insertItem({ accountId: account.accountId }, { key, kind: 'film', title: 'Merged twin' });

    // The anonymous history holds the still-active save (a row of its own).
    const { principal: anon } = await anonCtx();
    const sessItem = await insertItem({ sessionId: anon.sessionId }, { key, kind: 'film', title: 'Merged twin' });
    await sessionSave(anon.sessionId, sessItem);

    // The account history saves and then removes ITS OWN save, later than the
    // anonymous save above it.
    await recordPreference(actx, { action: 'save', target_type: 'discovery_item', target_id: acctItem });
    await recordPreference(actx, { action: 'remove', target_type: 'discovery_item', target_id: acctItem });

    const claimed = await claim(anon.sessionId, account.accountId);
    expect(claimed).toEqual({ captures: 0, saved_items: 1 }); // the surviving anonymous save transfers

    // The transferred save stays explicit — the account's historical removal
    // withdrew the account's own row, never the anonymous one.
    const snapshot = await loadExplicitSupport(db, account.accountId);
    expect(snapshot.saves.map((s) => s.canonicalKey)).toEqual([key]);
    expect(snapshot.exposureOnlyItemIds).toEqual([]);
    expect(snapshot.saves[0]!.itemId).toBe(acctItem); // repointed at the merged discovery row

    await project(account.accountId);
    expect(await graphState(account.accountId)).toMatchObject({ state: 'ready' });
    expect(await savedItemSupport(account.accountId)).toEqual([{ canonicalKey: key }]);
    // Its provenance is the anonymous history's own save event, now carried
    // under the account.
    expect((await supportLineage(account.accountId)).get(key)).toBe(await saveEventId(account.accountId, key, 'claimed'));
  });

  it('the claim stamps the moved history with its lineage and leaves account events native', async () => {
    const { principal: account, ctx: actx } = await accountCtx({ config: projectionOn });
    const key = `test:${randomUUID()}`;
    const shared = await insertItem(null, { key, kind: 'film', title: 'Shared sample' });
    await recordPreference(actx, { action: 'save', target_type: 'discovery_item', target_id: shared });
    const before = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM preference_events WHERE owner_account_id = $1 AND payload->>'claimed_session_id' IS NOT NULL`,
      [account.accountId],
    );
    expect(Number(before.rows[0]!.n)).toBe(0);

    const { principal: anon } = await anonCtx();
    const sctx = ctxFor(anon, { config: projectionOn });
    await sessionSave(anon.sessionId, shared);
    await recordPreference(sctx, { action: 'remove', target_type: 'discovery_item', target_id: shared });
    await claim(anon.sessionId, account.accountId);

    // The moved save/remove events carry their anonymous lineage and the claim
    // time; the account's own save event stays native.
    const moved = await db.query<{ action: string; claimed_at: string | null }>(
      `SELECT action, payload->>'claimed_at' AS claimed_at FROM preference_events
        WHERE owner_account_id = $1 AND payload->>'claimed_session_id' = $2
        ORDER BY action`,
      [account.accountId, anon.sessionId],
    );
    expect(moved.rows.map((r) => r.action)).toEqual(['remove', 'save']);
    for (const row of moved.rows) expect(row.claimed_at).toBeTruthy();
    const native = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM preference_events
        WHERE owner_account_id = $1 AND payload->>'claimed_session_id' IS NULL AND payload->>'canonical_key' = $2`,
      [account.accountId, key],
    );
    expect(Number(native.rows[0]!.n)).toBe(1);
  });

  it('auto-filled rows confirm nothing while the surviving saves stay explicit', async () => {
    const { principal: account } = await accountCtx({ config: projectionOn });
    const autoKey = `test:${randomUUID()}`;
    const auto = await insertItem({ accountId: account.accountId }, { key: autoKey, kind: 'film', title: 'Filed only' });
    await fillInterestsBoard(db, account.accountId, [auto]); // account auto-fill: exposure-only

    // The anonymous history: an active save plus an event-less filed row.
    const key = `test:${randomUUID()}`;
    const shared = await insertItem(null, { key, kind: 'film', title: 'Shared sample' });
    const filedKey = `test:${randomUUID()}`;
    const filedOnly = await insertItem(null, { key: filedKey, kind: 'film', title: 'Filed only' });
    const { principal: anon } = await anonCtx();
    await sessionSave(anon.sessionId, shared);
    await sessionRowOnly(anon.sessionId, filedOnly);

    const claimed = await claim(anon.sessionId, account.accountId);
    expect(claimed).toEqual({ captures: 0, saved_items: 2 });

    const snapshot = await loadExplicitSupport(db, account.accountId);
    expect(snapshot.saves.map((s) => s.canonicalKey)).toEqual([key]);
    // Neither the account's auto-fill nor the transferred event-less row
    // became an endorsement by riding along with the claim.
    expect([...snapshot.exposureOnlyItemIds].sort()).toEqual([auto, filedOnly].sort());

    await project(account.accountId);
    expect(await savedItemSupport(account.accountId)).toEqual([{ canonicalKey: key }]);
    expect((await readReconciledInterestGraph(db, account.accountId)).interests).toHaveLength(1);
  });

  it('converges after the claim: real remove withdraws, returned Undo restores once, retries add nothing', async () => {
    const { principal: account, ctx: actx } = await accountCtx({ config: projectionOn });
    const key = `test:${randomUUID()}`;
    const acctItem = await insertItem({ accountId: account.accountId }, { key, kind: 'film', title: 'Merged twin' });

    // Direction B: the anonymous history holds the still-active save; the
    // account history removed its own save of the same canonical item.
    const { principal: anon } = await anonCtx();
    const sessItem = await insertItem({ sessionId: anon.sessionId }, { key, kind: 'film', title: 'Merged twin' });
    await sessionSave(anon.sessionId, sessItem);
    await recordPreference(actx, { action: 'save', target_type: 'discovery_item', target_id: acctItem });
    await recordPreference(actx, { action: 'remove', target_type: 'discovery_item', target_id: acctItem });
    const claimed = await claim(anon.sessionId, account.accountId);
    expect(claimed).toEqual({ captures: 0, saved_items: 1 });

    // The merged state is one explicit endorsement before anything else.
    expect((await loadExplicitSupport(db, account.accountId)).saves.map((s) => s.canonicalKey)).toEqual([key]);
    await project(account.accountId);
    const before = await savedItemSupport(account.accountId);
    expect(before).toEqual([{ canonicalKey: key }]);

    // A retried claim is a no-op and rebuilds to the same support.
    const retry = await claim(anon.sessionId, account.accountId);
    expect(retry).toEqual({ captures: 0, saved_items: 0 });
    await project(account.accountId);
    expect(await savedItemSupport(account.accountId)).toEqual(before);

    // An actual post-claim remove withdraws the merged endorsement — the
    // reconciled read honors it before any projection catch-up, and the
    // projection converges on zero support.
    const removed = await recordPreference(actx, { action: 'remove', target_type: 'discovery_item', target_id: acctItem });
    expect(removed.saved_item).toBeNull();
    expect((await loadExplicitSupport(db, account.accountId)).saves).toEqual([]);
    expect((await readReconciledInterestGraph(db, account.accountId)).interests).toEqual([]);
    await project(account.accountId);
    expect(await savedItemSupport(account.accountId)).toEqual([]);

    // The actual returned Undo payload restores exactly one canonical
    // endorsement (the row is gone, so the undo save is fresh, not a no-op).
    expect(removed.undo).toMatchObject({ action: 'save', target_type: 'discovery_item', target_id: acctItem });
    const undone = await recordPreference(actx, removed.undo!);
    expect(undone.saved_item).toBeTruthy();
    expect(undone.undo).toMatchObject({ action: 'remove' });
    expect((await loadExplicitSupport(db, account.accountId)).saves.map((s) => s.canonicalKey)).toEqual([key]);
    await project(account.accountId);
    expect(await savedItemSupport(account.accountId)).toEqual([{ canonicalKey: key }]);

    // Withdrawing again and letting auto-fill re-file the item keeps it
    // exposure-only: both saves (the account's own and the transferred
    // anonymous one) are superseded by post-claim removes, and a filed row
    // is never an endorsement — the projection converges on zero support.
    await recordPreference(actx, { action: 'remove', target_type: 'discovery_item', target_id: acctItem });
    await fillInterestsBoard(db, account.accountId, [acctItem]);
    expect((await loadExplicitSupport(db, account.accountId)).saves).toEqual([]);
    expect((await loadExplicitSupport(db, account.accountId)).exposureOnlyItemIds).toEqual([acctItem]);
    await project(account.accountId);
    expect(await savedItemSupport(account.accountId)).toEqual([]);
  });

  it('two separately claimed sessions never erase each other’s surviving saves', async () => {
    const { principal: account } = await accountCtx({ config: projectionOn });
    const key = `test:${randomUUID()}`;

    // Session two saves the canonical item and keeps it saved.
    const { principal: anon2 } = await anonCtx();
    const item2 = await insertItem({ sessionId: anon2.sessionId }, { key, kind: 'film', title: 'Twin' });
    await sessionSave(anon2.sessionId, item2);

    // Session one later withdraws ITS OWN save of the same canonical item.
    const { principal: anon1 } = await anonCtx();
    const item1 = await insertItem({ sessionId: anon1.sessionId }, { key, kind: 'film', title: 'Twin' });
    await sessionSave(anon1.sessionId, item1);
    const sctx1 = ctxFor(anon1, { config: projectionOn });
    await recordPreference(sctx1, { action: 'remove', target_type: 'discovery_item', target_id: item1 });

    await claim(anon1.sessionId, account.accountId);
    const claimed2 = await claim(anon2.sessionId, account.accountId);
    expect(claimed2).toEqual({ captures: 0, saved_items: 1 });

    // Session one's historical removal stayed in its own lineage: session
    // two's surviving save is one explicit endorsement under the account.
    const snapshot = await loadExplicitSupport(db, account.accountId);
    expect(snapshot.saves.map((s) => s.canonicalKey)).toEqual([key]);
    expect(snapshot.exposureOnlyItemIds).toEqual([]);
    await project(account.accountId);
    expect(await savedItemSupport(account.accountId)).toEqual([{ canonicalKey: key }]);
  });

  it('a claim, remove and auto-fill in one transaction never resurrect the withdrawn anonymous support', async () => {
    const { principal: account, ctx: actx } = await accountCtx({ config: projectionOn });
    const key = `test:${randomUUID()}`;
    const acctItem = await insertItem({ accountId: account.accountId }, { key, kind: 'film', title: 'Merged twin' });

    // The anonymous history's active save (its own row, same canonical key),
    // plus the account's own earlier save+remove in separate transactions.
    const { principal: anon } = await anonCtx();
    const sessItem = await insertItem({ sessionId: anon.sessionId }, { key, kind: 'film', title: 'Merged twin' });
    await sessionSave(anon.sessionId, sessItem);
    await recordPreference(actx, { action: 'save', target_type: 'discovery_item', target_id: acctItem });
    await recordPreference(actx, { action: 'remove', target_type: 'discovery_item', target_id: acctItem });

    // claimSession's contract is "must run in a transaction", and a caller
    // may compose the claim with a withdrawal and an auto-fill re-file in the
    // SAME outer transaction — where every statement shares one tx-start
    // now(), equal to the claim's claimed_at stamp. The claim merges the
    // session row onto the account's discovery item first, so the withdrawal
    // inside the transaction targets that item.
    let undoPayload: Awaited<ReturnType<typeof recordPreference>>['undo'] = null;
    await db.transaction(async (tx) => {
      await claimSession(tx, anon.sessionId, account.accountId, new Date(), projectionOn);
      const removed = await recordPreference({ ...actx, db: tx }, {
        action: 'remove',
        target_type: 'discovery_item',
        target_id: acctItem,
      });
      expect(removed.saved_item).toBeNull();
      undoPayload = removed.undo;
      await fillInterestsBoard(tx, account.accountId, [acctItem]);
    });
    expect(undoPayload).toMatchObject({ action: 'save', target_type: 'discovery_item', target_id: acctItem });

    // The withdrawn anonymous support stays withdrawn: the re-filed row is
    // exposure-only, and the projection converges on zero support.
    const snapshot = await loadExplicitSupport(db, account.accountId);
    expect(snapshot.saves).toEqual([]);
    expect(snapshot.exposureOnlyItemIds).toEqual([acctItem]);
    await project(account.accountId);
    expect(await graphState(account.accountId)).toMatchObject({ state: 'ready' });
    expect(await savedItemSupport(account.accountId)).toEqual([]);

    // Applying the returned Undo after the auto-fill is a no-op: the filed
    // row already exists, so no new save event endorses it.
    const undone = await recordPreference(actx, undoPayload!);
    expect(undone.saved_item).toBeTruthy();
    expect(undone.undo).toBeNull();
    const after = await loadExplicitSupport(db, account.accountId);
    expect(after.saves).toEqual([]);
    expect(after.exposureOnlyItemIds).toEqual([acctItem]);
  });

  it('the merged account projects the same canonical state as a clean equivalent account (fresh-fold parity)', async () => {
    const { principal: account, ctx: actx } = await accountCtx({ config: projectionOn });
    const keyA = `test:${randomUUID()}`;
    const keyB = `test:${randomUUID()}`;
    const sharedA = await insertItem(null, { key: keyA, kind: 'film', title: 'Shared sample' });
    const acctB = await insertItem({ accountId: account.accountId }, { key: keyB, kind: 'film', title: 'Merged twin' });

    // Direction A: the account keeps an active save the anonymous history removed.
    await recordPreference(actx, { action: 'save', target_type: 'discovery_item', target_id: sharedA });
    // Direction B: the anonymous history keeps an active save the account removed.
    const { principal: anon } = await anonCtx();
    const sessB = await insertItem({ sessionId: anon.sessionId }, { key: keyB, kind: 'film', title: 'Merged twin' });
    await sessionSave(anon.sessionId, sessB);
    await sessionSave(anon.sessionId, sharedA);
    const sctx = ctxFor(anon, { config: projectionOn });
    await recordPreference(sctx, { action: 'remove', target_type: 'discovery_item', target_id: sharedA });
    await recordPreference(actx, { action: 'save', target_type: 'discovery_item', target_id: acctB });
    await recordPreference(actx, { action: 'remove', target_type: 'discovery_item', target_id: acctB });

    await claim(anon.sessionId, account.accountId);
    await project(account.accountId);
    expect(await graphState(account.accountId)).toMatchObject({ state: 'ready' });

    // A clean account that simply saves both items today (its own row for the
    // private canonical key — accounts cannot see each other's items).
    const clean = await accountCtx({ config: projectionOn });
    const cleanB = await insertItem({ accountId: clean.principal.accountId }, { key: keyB, kind: 'film', title: 'Merged twin' });
    await recordPreference(clean.ctx, { action: 'save', target_type: 'discovery_item', target_id: sharedA });
    await recordPreference(clean.ctx, { action: 'save', target_type: 'discovery_item', target_id: cleanB });
    await project(clean.principal.accountId);
    expect(await graphState(clean.principal.accountId)).toMatchObject({ state: 'ready' });

    // Same canonical explicit state, same reconciled shape, same support.
    expect(await savedItemSupport(account.accountId)).toEqual(await savedItemSupport(clean.principal.accountId));
    expect(await reconciledShape(account.accountId)).toEqual(await reconciledShape(clean.principal.accountId));
    expect(await reconciledShape(account.accountId)).toHaveLength(2);
  });
});
