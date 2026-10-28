import { afterAll, describe, expect, it } from 'vitest';
import { accountCtx, insertItem } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { createPick, deletePick } from '../services/onboarding';
import { addCollectionItem, createCollection, fillInterestsBoard, removeCollectionItem } from '../services/collections';
import { recordPreference } from '../services/preferences';
import { loadExplicitSupport, type ExplicitSupportSnapshot } from './explicit-support';

/**
 * The authoritative explicit-support reader (PR 8, feature
 * explicit-intent-projection-hooks): what a graph projection of an account may
 * treat as confirmed personal intent. Grouped picks count once per choice
 * group, current saves only, and exposure-only rows (Interests-board auto-fill
 * from recommendations) never self-endorse. Exclusions are constraints, never
 * endorsements.
 */

const db = getTestDb();
afterAll(closeTestDb);

const projectionOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });
const izakaya = 'qloo:urn:tag:cuisine:qloo:izakaya';
const ramen = 'qloo:urn:tag:cuisine:qloo:ramen';

/** Structural state (no ids, no history): clean-state comparisons. */
const shape = (s: ExplicitSupportSnapshot) => ({
  saves: s.saves.map((x) => x.canonicalKey).sort(),
  groups: s.pickGroups.map((g) => g.members.map((m) => m.canonicalKey).sort()).sort(),
  exclusions: [...s.exclusions].sort(),
  exposureOnly: s.exposureOnlyItemIds.slice().sort(),
});

describe('grouped picks count once (VAL-PROJ-002)', () => {
  it('a multi-tag image is one choice group over its member saves; unpicked alternatives contribute nothing', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const pick = await createPick(ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    const snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.pickGroups).toHaveLength(1);
    expect(snapshot.pickGroups[0]!.members).toHaveLength(2);
    expect(snapshot.saves.map((s) => s.canonicalKey).sort()).toEqual([izakaya, ramen].sort());
    // Every member save is explicit, and the group covers exactly those saves.
    expect(snapshot.pickGroups[0]!.members.map((m) => m.itemId).sort()).toEqual(snapshot.saves.map((s) => s.itemId).sort());
    // Nothing else from the catalog leaked in.
    const all = await db.query<{ n: string }>('SELECT count(*) AS n FROM saved_items WHERE owner_account_id = $1', [
      principal.accountId,
    ]);
    expect(Number(all.rows[0]!.n)).toBe(2);
    // The minimum-pick accounting still counts the image as ONE pick.
    expect(pick.state.picks_count).toBe(1);
  });

  it('overlapping picks keep only active support, in both removal orders', async () => {
    // Order 1: remove the image first; the shared save survives on the chip.
    const a = await accountCtx({ config: projectionOn });
    const image = await createPick(a.ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    const chip = await createPick(a.ctx, { source: 'catalog', catalog_item_id: 'chip-eat-ramen' });
    let snapshot = await loadExplicitSupport(db, a.principal.accountId);
    expect(snapshot.pickGroups).toHaveLength(2);
    expect(snapshot.saves.map((s) => s.canonicalKey).sort()).toEqual([izakaya, ramen].sort());

    await deletePick(a.ctx, image.pick.id);
    snapshot = await loadExplicitSupport(db, a.principal.accountId);
    expect(snapshot.saves.map((s) => s.canonicalKey)).toEqual([ramen]);
    expect(snapshot.pickGroups).toHaveLength(1);
    expect(snapshot.pickGroups[0]!.members.map((m) => m.canonicalKey)).toEqual([ramen]);

    await deletePick(a.ctx, chip.pick.id);
    snapshot = await loadExplicitSupport(db, a.principal.accountId);
    expect(snapshot.saves).toEqual([]);
    expect(snapshot.pickGroups).toEqual([]);

    // Order 2: remove the chip first; the shared save survives on the image.
    const b = await accountCtx({ config: projectionOn });
    const image2 = await createPick(b.ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    const chip2 = await createPick(b.ctx, { source: 'catalog', catalog_item_id: 'chip-eat-ramen' });
    await deletePick(b.ctx, chip2.pick.id);
    let s2 = await loadExplicitSupport(db, b.principal.accountId);
    expect(s2.saves.map((s) => s.canonicalKey).sort()).toEqual([izakaya, ramen].sort());
    expect(s2.pickGroups).toHaveLength(1);
    await deletePick(b.ctx, image2.pick.id);
    s2 = await loadExplicitSupport(db, b.principal.accountId);
    expect(s2.saves).toEqual([]);
    expect(s2.pickGroups).toEqual([]);
  });

  it('a pre-existing independent save survives pick removal', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const ramenItem = await insertItem({ accountId: principal.accountId }, { key: ramen, kind: 'food', category: 'eat' });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: ramenItem });
    const pick = await createPick(ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    let snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.saves.map((s) => s.canonicalKey).sort()).toEqual([izakaya, ramen].sort());
    expect(snapshot.pickGroups[0]!.members).toHaveLength(2);

    await deletePick(ctx, pick.pick.id);
    snapshot = await loadExplicitSupport(db, principal.accountId);
    // The pick created only the izakaya save; the account's own ramen save survives.
    expect(snapshot.saves.map((s) => s.canonicalKey)).toEqual([ramen]);
    expect(snapshot.pickGroups).toEqual([]);
  });

  it('partial member unsave and fresh re-selection match a clean equivalent account', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const pick = await createPick(ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    const members = (await loadExplicitSupport(db, principal.accountId)).pickGroups[0]!.members;
    const izakayaItem = members.find((m) => m.canonicalKey === izakaya)!.itemId;

    // Partial member unsave: the group keeps only its still-saved member.
    await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: izakayaItem });
    const snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.pickGroups[0]!.members.map((m) => m.canonicalKey)).toEqual([ramen]);
    expect(snapshot.saves.map((s) => s.canonicalKey)).toEqual([ramen]);

    // Full removal, then fresh re-selection.
    await deletePick(ctx, pick.pick.id);
    expect((await loadExplicitSupport(db, principal.accountId)).saves).toEqual([]);
    await createPick(ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    const final = await loadExplicitSupport(db, principal.accountId);
    expect(final.saves).toHaveLength(2);
    expect(final.pickGroups).toHaveLength(1);

    const clean = await accountCtx({ config: projectionOn });
    await createPick(clean.ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    const cleanSnapshot = await loadExplicitSupport(db, clean.principal.accountId);
    expect(shape(final)).toEqual(shape(cleanSnapshot));
  });
});

describe('collections do not multiply endorsement (VAL-PROJ-004)', () => {
  it('one save in many collections contributes once; membership removal changes scope only', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    const c1 = await createCollection(ctx, { name: 'One' });
    const c2 = await createCollection(ctx, { name: 'Two' });

    const add1 = await addCollectionItem(ctx, { id: c1.id, item_id: item, body: {} });
    const add2 = await addCollectionItem(ctx, { id: c2.id, item_id: item, body: {} });
    expect(add1.saved).toBe(false);
    expect(add2.saved).toBe(false);
    expect(add1.created).toBe(true);
    expect(add2.created).toBe(true);
    // Membership-only adds: no new projection intent beyond the original save.
    const { rows: outbox } = await db.query('SELECT id FROM graph_outbox WHERE owner_account_id = $1', [principal.accountId]);
    expect(outbox).toHaveLength(1);
    let snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.saves).toHaveLength(1);

    const removed = await removeCollectionItem(ctx, { id: c1.id, item_id: item });
    expect(removed.removed).toBe(true);
    expect(removed.collection_revision).toBeGreaterThan(add1.collection_revision);
    snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.saves).toHaveLength(1); // the independent save remains
    const { rows: intents } = await db.query('SELECT id FROM graph_outbox WHERE owner_account_id = $1', [principal.accountId]);
    expect(intents).toHaveLength(1);

    // Global unsave follows membership semantics: the memberships cascade away with the save.
    const unsave = await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: item });
    expect(unsave.saved_item).toBeNull();
    snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.saves).toEqual([]);
    const memberships = await db.query('SELECT id FROM collection_items WHERE owner_account_id = $1', [principal.accountId]);
    expect(memberships.rowCount).toBe(0);
  });

  it('unsaved collection auto-fill items supply no confirmed interests', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const one = await insertItem({ accountId: principal.accountId }, { kind: 'film' });
    const two = await insertItem({ accountId: principal.accountId }, { kind: 'film' });
    const board = await fillInterestsBoard(db, principal.accountId, [one, two]);
    expect(board).toBeTruthy();
    const filed = await db.query('SELECT discovery_item_id FROM saved_items WHERE owner_account_id = $1', [principal.accountId]);
    expect(filed.rowCount).toBe(2);
    let snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.saves).toEqual([]); // filing a recommendation is not an endorsement
    expect(shape(snapshot).exposureOnly).toEqual([one, two].sort());
    const { rows: outbox } = await db.query('SELECT id FROM graph_outbox WHERE owner_account_id = $1', [principal.accountId]);
    expect(outbox).toHaveLength(0); // and it projects nothing

    // The same canonical item, once the user explicitly picks it, is confirmed
    // by that pick (the earlier auto-fill save does not double it).
    const ramenItem = await insertItem({ accountId: principal.accountId }, { key: ramen, kind: 'food', category: 'eat' });
    await fillInterestsBoard(db, principal.accountId, [ramenItem]);
    const pick = await createPick(ctx, { source: 'catalog', catalog_item_id: 'img-lanterns' });
    snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.saves.map((s) => s.canonicalKey).sort()).toEqual([izakaya, ramen].sort());
    expect(snapshot.pickGroups[0]!.members).toHaveLength(2);
    expect(shape(snapshot).exposureOnly).toEqual([one, two].sort());
    // One member save was new; the auto-filled one created no second intent.
    const { rows: tasteRows } = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM graph_outbox WHERE owner_account_id = $1 AND event_type = 'taste'`,
      [principal.accountId],
    );
    expect(tasteRows).toHaveLength(1);
    expect(tasteRows[0]!.payload).toMatchObject({ action: 'save' });
    expect(pick.pick.saved_item_ids).toHaveLength(2);
  });
});

describe('exclusions constrain rather than endorse (VAL-PROJ-005)', () => {
  it('hides exactly the canonical item while keeping its save; unhide restores without endorsing', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    const before = await loadExplicitSupport(db, principal.accountId);

    await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: item });
    let snapshot = await loadExplicitSupport(db, principal.accountId);
    // The exclusion is read from current rows, so it applies immediately even
    // while any projection lags; it never deletes the save and stays scoped to
    // the one canonical key (no creator, category or culture exclusion).
    expect(snapshot.exclusions).toEqual([before.saves[0]!.canonicalKey]);
    expect(snapshot.saves.map((s) => s.itemId)).toEqual(before.saves.map((s) => s.itemId));

    const unhide = await recordPreference(ctx, { action: 'unhide', target_type: 'discovery_item', target_id: item });
    expect(unhide.undo).toEqual({ action: 'hide', target_type: 'discovery_item', target_id: item });
    snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.exclusions).toEqual([]);
    // Unhide added no endorsement: the save set is byte-for-byte unchanged.
    expect(snapshot.saves).toEqual(before.saves);
  });

  it('an effective save lifts a hide under the existing rules', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId });
    await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: item });
    expect((await loadExplicitSupport(db, principal.accountId)).exclusions).toHaveLength(1);
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    const snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.exclusions).toEqual([]);
    expect(snapshot.saves.map((s) => s.itemId)).toEqual([item]);
  });
});
