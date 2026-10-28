import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { liftFeatureKill, setFeatureKill } from '../flags/feature-flags';
import { accountCtx, anonCtx, ctxFor, insertCaptureWithAnalysis, insertItem } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { claimSession, createAccount } from '../services/auth';
import { createPick, deletePick, putExclusions } from '../services/onboarding';
import { recordPreference, saveItem } from '../services/preferences';
import { loadExplicitSupport } from './explicit-support';
import type { TargetItem } from '../services/preferences';

/**
 * Transactional graph projection intent (PR 8, feature
 * explicit-intent-projection-hooks): every EFFECTIVE explicit mutation (save,
 * remove, returned-Undo save, hide, unhide, pick-group change, anonymous
 * claim) commits one durable outbox event in the same transaction, or rolls
 * back with it. No-op mutations and exposure-only paths write nothing. The
 * projection flag defaults off; these tests opt in per context exactly the way
 * an operator would (INTEREST_GRAPH_PROJECTION_ENABLED + kill switches).
 */

const db = getTestDb();
afterAll(closeTestDb);

const projectionOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

interface OutboxRow {
  id: string;
  event_type: string;
  logical_event_key: string;
  target_taste_revision: number;
  job_intent: string;
  payload: Record<string, unknown>;
  dispatch_state: string;
}

async function outbox(accountId: string): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, event_type, logical_event_key, target_taste_revision, job_intent, payload, dispatch_state
       FROM graph_outbox WHERE owner_account_id = $1
      ORDER BY target_taste_revision, created_at, id`,
    [accountId],
  );
  return rows;
}

/** A prepared anonymous save with its save event, the shape a claimed history leaves behind. */
async function sessionSave(sessionId: string, itemId: string): Promise<void> {
  const { rows } = await db.query<{ canonical_key: string }>('SELECT canonical_key FROM discovery_items WHERE id = $1', [itemId]);
  await db.query('INSERT INTO saved_items (owner_session_id, discovery_item_id) VALUES ($1, $2)', [sessionId, itemId]);
  await db.query(
    `INSERT INTO preference_events (owner_session_id, action, target_type, target_id, payload)
     VALUES ($1, 'save', 'discovery_item', $2, $3::jsonb)`,
    [sessionId, itemId, JSON.stringify({ canonical_key: rows[0]!.canonical_key })],
  );
}

describe('explicit intent hooks', () => {
  it('keeps projection off by default: effective mutations write no intent rows', async () => {
    const { principal, ctx } = await accountCtx();
    const item = await insertItem({ accountId: principal.accountId });
    const saved = await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    expect(saved.undo).toEqual({ action: 'remove', target_type: 'discovery_item', target_id: item });
    await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: item });
    await recordPreference(ctx, { action: 'unhide', target_type: 'discovery_item', target_id: item });
    await createPick(ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    expect(await outbox(principal.accountId)).toEqual([]);
  });

  it('commits one taste intent per effective save at the new revision', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    const res = await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    const rows = await outbox(principal.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'taste',
      logical_event_key: 'taste',
      job_intent: 'project_interest_graph',
      target_taste_revision: res.taste_revision,
      dispatch_state: 'pending',
      payload: { action: 'save', target_type: 'discovery_item', target_id: item },
    });
  });

  it('treats duplicate saves, duplicate hides and no-op unhides as inert', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    const save = await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    const again = await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    expect(again.undo).toBeNull();
    expect(again.taste_revision).toBe(save.taste_revision);

    const hide = await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: item });
    expect(hide.undo).toEqual({ action: 'unhide', target_type: 'discovery_item', target_id: item });
    const hideAgain = await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: item });
    expect(hideAgain.undo).toBeNull();
    expect(hideAgain.taste_revision).toBe(hide.taste_revision);

    const unhide = await recordPreference(ctx, { action: 'unhide', target_type: 'discovery_item', target_id: item });
    expect(unhide.undo).toEqual({ action: 'hide', target_type: 'discovery_item', target_id: item });
    const unhideAgain = await recordPreference(ctx, { action: 'unhide', target_type: 'discovery_item', target_id: item });
    expect(unhideAgain.undo).toBeNull();
    expect(unhideAgain.taste_revision).toBe(unhide.taste_revision);

    const rows = await outbox(principal.accountId);
    expect(rows.map((r) => r.payload.action)).toEqual(['save', 'hide', 'unhide']);
  });

  it('save -> remove -> returned Undo follows current explicit state, not event totals', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    const save = await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    const remove = await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: item });
    expect(remove.undo).toEqual({ action: 'save', target_type: 'discovery_item', target_id: item });
    expect(remove.saved_item).toBeNull();
    // The client sends back exactly the Undo payload it was given.
    const undo = await recordPreference(ctx, remove.undo!);
    expect(undo.saved_item?.discovery_item_id).toBe(item);

    const rows = await outbox(principal.accountId);
    expect(rows.map((r) => [r.payload.action, r.target_taste_revision])).toEqual([
      ['save', save.taste_revision],
      ['remove', remove.taste_revision],
      ['save', undo.taste_revision],
    ]);
    // Three events, one current endorsement; the remove is lineage, never a negative vote.
    const snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.saves.map((s) => s.itemId)).toEqual([item]);
    expect(snapshot.exclusions).toEqual([]);
  });

  it('rolls the intent back with the mutation', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    const { rows } = await db.query<TargetItem>(
      'SELECT id, canonical_key, kind, capture_id, is_sample FROM discovery_items WHERE id = $1',
      [item],
    );
    await expect(
      db.transaction(async (tx) => {
        await saveItem(ctx, tx, rows[0]!, { action: 'save', target_type: 'discovery_item', target_id: item });
        throw new Error('boom after the hook');
      }),
    ).rejects.toThrow('boom after the hook');
    const saved = await db.query('SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2', [
      principal.accountId,
      item,
    ]);
    expect(saved.rowCount).toBe(0);
    expect(await outbox(principal.accountId)).toEqual([]);
    const taste = await db.query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [
      principal.accountId,
    ]);
    expect(taste.rows[0]?.revision ?? 0).toBe(0);
  });

  it('concurrent duplicate saves converge on one save and one intent', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    const [a, b] = await Promise.all([
      recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item }),
      recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item }),
    ]);
    expect(a.undo === null || b.undo === null).toBe(true);
    expect(a.taste_revision).toBe(b.taste_revision);
    const saved = await db.query('SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2', [
      principal.accountId,
      item,
    ]);
    expect(saved.rowCount).toBe(1);
    const rows = await outbox(principal.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'taste', target_taste_revision: a.taste_revision });
  });

  it('commits pick-group intents with the member saves; an already-active re-pick adds nothing', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const pick = await createPick(ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    expect(pick.already_picked).toBe(false);
    let rows = await outbox(principal.accountId);
    // A multi-tag image saves each member (two taste intents, one per new
    // revision) and then commits one group intent at the final revision.
    expect(rows.filter((r) => r.event_type === 'taste').map((r) => r.payload.action)).toEqual(['save', 'save']);
    const created = rows.filter((r) => r.event_type === 'picks');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      job_intent: 'project_interest_graph',
      target_taste_revision: pick.taste_revision,
      payload: { action: 'pick_created', pick_id: pick.pick.id },
    });

    const again = await createPick(ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    expect(again.already_picked).toBe(true);
    expect(await outbox(principal.accountId)).toHaveLength(rows.length);

    await deletePick(ctx, pick.pick.id);
    rows = await outbox(principal.accountId);
    // Both member saves are reversed and the group removal lands as its own intent.
    expect(rows.filter((r) => r.event_type === 'taste').map((r) => r.payload.action)).toEqual(['save', 'save', 'remove', 'remove']);
    const pickRows = rows.filter((r) => r.event_type === 'picks');
    expect(pickRows.map((r) => r.payload.action)).toEqual(['pick_created', 'pick_removed']);
    expect(pickRows[1]).toMatchObject({ payload: { pick_id: pick.pick.id } });
    expect(pickRows[1]!.target_taste_revision).toBeGreaterThan(pickRows[0]!.target_taste_revision);
  });

  it('projects the canonical merged state once when an anonymous session is claimed', async () => {
    // An account that already saved canonical key K, with projection on.
    const { principal: account, ctx: actx } = await accountCtx({ config: projectionOn });
    const key = `qloo:${randomUUID()}`;
    const otherKey = `qloo:${randomUUID()}`;
    const accountFilm = await insertItem({ accountId: account.accountId }, { key, title: 'Amélie' });
    await recordPreference(actx, { action: 'save', target_type: 'discovery_item', target_id: accountFilm });
    const before = await outbox(account.accountId);
    expect(before).toHaveLength(1);

    // An anonymous session with a hide, a duplicate-K save and a fresh save.
    const { principal: anon } = await anonCtx();
    const hidden = await insertItem({ sessionId: anon.sessionId }, { kind: 'artist' });
    const hiddenKey = (await db.query<{ canonical_key: string }>('SELECT canonical_key FROM discovery_items WHERE id = $1', [hidden]))
      .rows[0]!.canonical_key;
    await recordPreference(ctxFor(anon, { config: projectionOn }), { action: 'hide', target_type: 'discovery_item', target_id: hidden });
    const dupFilm = await insertItem({ sessionId: anon.sessionId }, { key, title: 'Amélie' });
    const newFilm = await insertItem({ sessionId: anon.sessionId }, { key: otherKey, title: 'Persepolis' });
    await sessionSave(anon.sessionId, dupFilm);
    await sessionSave(anon.sessionId, newFilm);

    const claimed = await db.transaction((tx) => claimSession(tx, anon.sessionId, account.accountId, new Date(), projectionOn));
    expect(claimed.saved_items).toBe(1); // the duplicate dropped; the fresh one moved

    const rows = await outbox(account.accountId);
    const claimRows = rows.filter((r) => r.event_type === 'claim');
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({
      logical_event_key: 'claim',
      job_intent: 'project_interest_graph',
      payload: { action: 'claim', captures: 0, saved_items: 1 },
    });
    expect(claimRows[0]!.target_taste_revision).toBeGreaterThan(before[0]!.target_taste_revision);

    // Canonical merged state: one explicit save per canonical key, the hide carried over.
    const snapshot = await loadExplicitSupport(db, account.accountId);
    expect(snapshot.saves.map((s) => s.canonicalKey).sort()).toEqual([key, otherKey].sort());
    expect(snapshot.exclusions).toEqual([hiddenKey]);

    // A retried claim is a no-op and adds nothing.
    const retry = await db.transaction((tx) => claimSession(tx, anon.sessionId, account.accountId, new Date(), projectionOn));
    expect(retry).toEqual({ captures: 0, saved_items: 0 });
    expect((await outbox(account.accountId)).filter((r) => r.event_type === 'claim')).toHaveLength(1);
  });

  it('lands the pending-save pick group at account creation', async () => {
    const { principal: anon } = await anonCtx();
    const sample = await insertItem(null);
    const res = await createAccount(ctxFor(anon, { config: projectionOn }), {
      claim_session: true,
      pending_save: { target_type: 'discovery_item', target_id: sample },
    });
    const rows = await outbox(res.account_id);
    expect(rows).toHaveLength(3);
    const claim = rows.find((r) => r.event_type === 'claim')!;
    expect(claim.payload).toMatchObject({ action: 'claim' });
    const taste = rows.filter((r) => r.event_type === 'taste');
    expect(taste).toHaveLength(1);
    expect(taste[0]).toMatchObject({ payload: { action: 'save', target_id: sample } });
    const picks = rows.filter((r) => r.event_type === 'picks');
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ payload: { action: 'pick_created' } });
    expect(picks[0]!.target_taste_revision).toBe(taste[0]!.target_taste_revision);

    const snapshot = await loadExplicitSupport(db, res.account_id);
    expect(snapshot.saves.map((s) => s.itemId)).toEqual([sample]);
    expect(snapshot.pickGroups).toHaveLength(1);
    expect(snapshot.pickGroups[0]).toMatchObject({ source: 'pending_save' });
    expect(snapshot.pickGroups[0]!.members.map((m) => m.itemId)).toEqual([sample]);
  });

  it('silences the hook while the projection flag is killed for the account', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await setFeatureKill(db, {
      flag: 'interest_graph_projection_enabled',
      accountId: principal.accountId,
      reason: 'operator pause',
      actor: 'test',
    });
    const saved = await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    expect(saved.taste_revision).toBe(1); // taste still moves; only the intent is silenced
    expect(await outbox(principal.accountId)).toEqual([]);

    await liftFeatureKill(db, { flag: 'interest_graph_projection_enabled', accountId: principal.accountId });
    await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: item });
    expect((await outbox(principal.accountId)).map((r) => r.payload.action)).toEqual(['hide']);
  });

  it('keeps food exclusions constraints: no intent, no endorsement', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const before = await loadExplicitSupport(db, principal.accountId);
    const set = await putExclusions(ctx, { food_exclusions: [' peanut ', 'PEANUT', 'shellfish'] });
    expect(set.food_exclusions).toEqual(['peanut', 'shellfish']);
    expect(await outbox(principal.accountId)).toEqual([]);
    // Removing a constraint implies no liking: nothing is endorsed or projected.
    await putExclusions(ctx, { food_exclusions: [] });
    const after = await loadExplicitSupport(db, principal.accountId);
    expect(after.saves).toEqual(before.saves);
    expect(after.pickGroups).toEqual(before.pickGroups);
    expect(after.exclusions).toEqual(before.exclusions);
    expect(await outbox(principal.accountId)).toEqual([]);
  });

  it('still rejects hiding a capture and writes nothing', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await expect(
      recordPreference(ctx, { action: 'hide', target_type: 'capture', target_id: cap.captureId }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await outbox(principal.accountId)).toEqual([]);
    expect((await loadExplicitSupport(db, principal.accountId)).exclusions).toEqual([]);
  });
});
