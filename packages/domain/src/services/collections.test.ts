import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { accountCtx, ctxFor, insertCaptureWithAnalysis, insertItem, insertReference } from '../test-support/library';
import { closeTestDb, getTestDb, insertAgentConnection } from '../testing';
import {
  addCollectionItem,
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  removeCollectionItem,
  reorderCollection,
  updateCollection,
  validateReorder,
} from './collections';
import { listSaved, recordPreference } from './preferences';
import { getTaste } from './taste';

const db = getTestDb();
afterAll(closeTestDb);

describe('validateReorder (pure)', () => {
  it('requires exactly the current members once each', () => {
    expect(validateReorder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual({ ok: true });
    expect(validateReorder(['a', 'b'], ['a', 'a'])).toEqual({ ok: false, reason: 'duplicate' });
    expect(validateReorder(['a', 'b'], ['a'])).toEqual({ ok: false, reason: 'missing' });
    expect(validateReorder(['a', 'b'], ['a', 'x'])).toEqual({ ok: false, reason: 'unknown' });
    expect(validateReorder(['a'], ['a', 'b'])).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('collections', () => {
  it('saves into multiple collections without duplicates; membership removal keeps the save', async () => {
    const { principal, ctx } = await accountCtx();
    const film = await insertItem({ accountId: principal.accountId }, { kind: 'film', title: 'Playtime' });
    const weekend = await createCollection(ctx, { name: 'Weekend', description: 'Slow evenings' });
    const rooms = await createCollection(ctx, { name: 'Rooms' });
    expect(weekend).toMatchObject({ name: 'Weekend', revision: 1, item_count: 0 });

    const first = await addCollectionItem(ctx, { id: weekend.id, item_id: film, body: {} });
    expect(first).toMatchObject({ created: true, saved: true, collection_revision: 2 });
    const again = await addCollectionItem(ctx, { id: weekend.id, item_id: film, body: {} });
    expect(again).toMatchObject({ created: false, saved: false, collection_revision: 2, membership_id: first.membership_id });
    const second = await addCollectionItem(ctx, { id: rooms.id, item_id: film, body: {} });
    expect(second.saved_item_id).toBe(first.saved_item_id);

    const saved = await listSaved(ctx, { filter: 'all' });
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]!.collection_ids.sort()).toEqual([weekend.id, rooms.id].sort());

    const removed = await removeCollectionItem(ctx, { id: weekend.id, item_id: film });
    expect(removed).toMatchObject({ removed: true, collection_revision: 3 });
    const after = await listSaved(ctx, { filter: 'all' });
    expect(after.items[0]!.collection_ids).toEqual([rooms.id]);
    // Taste still counts the item once.
    expect((await getTaste(ctx, {})).saved_count).toBe(1);
  });

  it('unsave everywhere removes the endorsement and every membership', async () => {
    const { principal, ctx } = await accountCtx();
    const item = await insertItem({ accountId: principal.accountId }, { kind: 'artist' });
    const a = await createCollection(ctx, { name: 'A' });
    const b = await createCollection(ctx, { name: 'B' });
    await addCollectionItem(ctx, { id: a.id, item_id: item, body: {} });
    await addCollectionItem(ctx, { id: b.id, item_id: item, body: {} });
    const res = await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: item });
    expect(res.saved_item).toBeNull();
    expect(res.undo).toEqual({ action: 'save', target_type: 'discovery_item', target_id: item });
    const list = await listCollections(ctx);
    expect(list.collections.map((c) => c.item_count)).toEqual([0, 0]);
    expect(list.collections.every((c) => c.revision === 3)).toBe(true);
    expect((await listSaved(ctx, { filter: 'all' })).items).toHaveLength(0);
  });

  it('deleting a collection leaves orphans as unfiled saves and keeps multi-member items filed', async () => {
    const { principal, ctx } = await accountCtx();
    const only = await insertItem({ accountId: principal.accountId });
    const shared = await insertItem({ accountId: principal.accountId });
    const doomed = await createCollection(ctx, { name: 'Doomed' });
    const keeper = await createCollection(ctx, { name: 'Keeper' });
    await addCollectionItem(ctx, { id: doomed.id, item_id: only, body: {} });
    await addCollectionItem(ctx, { id: doomed.id, item_id: shared, body: {} });
    await addCollectionItem(ctx, { id: keeper.id, item_id: shared, body: {} });
    await deleteCollection(ctx, { id: doomed.id });
    const unfiled = await listSaved(ctx, { filter: 'unfiled' });
    expect(unfiled.items.map((i) => i.item.id)).toEqual([only]);
    const list = await listCollections(ctx);
    expect(list.collections.map((c) => c.id)).toEqual([keeper.id]);
    expect(list.unfiled).toMatchObject({ item_count: 1 });
    await expect(getCollection(ctx, { id: doomed.id, query: {} })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('enforces expected_revision on rename and reorder, and validates the exact member set', async () => {
    const { principal, ctx } = await accountCtx();
    const col = await createCollection(ctx, { name: 'Order' });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await insertItem({ accountId: principal.accountId }, { title: `Item ${i}` }));
    for (const id of ids) await addCollectionItem(ctx, { id: col.id, item_id: id, body: {} });
    const detail = await getCollection(ctx, { id: col.id, query: {} });
    expect(detail.collection.revision).toBe(4);
    expect(detail.items.map((m) => m.item.id)).toEqual(ids);

    await expect(updateCollection(ctx, { id: col.id, body: { expected_revision: 1, name: 'Stale' } })).rejects.toMatchObject({
      code: 'revision_conflict',
      status: 409,
    });
    const renamed = await updateCollection(ctx, { id: col.id, body: { expected_revision: 4, name: 'Renamed', description: null } });
    expect(renamed).toMatchObject({ name: 'Renamed', revision: 5, description: null });

    const memberships = detail.items.map((m) => m.membership_id);
    await expect(reorderCollection(ctx, { id: col.id, body: { expected_revision: 4, membership_ids: memberships } })).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    await expect(
      reorderCollection(ctx, { id: col.id, body: { expected_revision: 5, membership_ids: memberships.slice(0, 2) } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      reorderCollection(ctx, { id: col.id, body: { expected_revision: 5, membership_ids: [memberships[0]!, memberships[0]!, memberships[1]!] } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const r = await reorderCollection(ctx, { id: col.id, body: { expected_revision: 5, membership_ids: [...memberships].reverse() } });
    expect(r.collection_revision).toBe(6);
    const reordered = await getCollection(ctx, { id: col.id, query: {} });
    expect(reordered.items.map((m) => m.item.id)).toEqual([...ids].reverse());
    await expect(addCollectionItem(ctx, { id: col.id, item_id: ids[0]!, body: { expected_revision: 2 } })).rejects.toMatchObject({
      code: 'revision_conflict',
    });
  });

  it('paginates members with a stable cursor and filters by type', async () => {
    const { principal, ctx } = await accountCtx();
    const col = await createCollection(ctx, { name: 'Mixed' });
    const films = [];
    for (let i = 0; i < 3; i++) films.push(await insertItem({ accountId: principal.accountId }, { kind: 'film' }));
    const artist = await insertItem({ accountId: principal.accountId }, { kind: 'artist' });
    for (const id of [...films, artist]) await addCollectionItem(ctx, { id: col.id, item_id: id, body: {} });
    const page1 = await getCollection(ctx, { id: col.id, query: { limit: 3 } });
    expect(page1.items).toHaveLength(3);
    expect(page1.available_filters).toEqual(['music', 'films']);
    const page2 = await getCollection(ctx, { id: col.id, query: { limit: 3, cursor: page1.next_cursor! } });
    expect(page2.items.map((m) => m.item.id)).toEqual([artist]);
    expect(page2.next_cursor).toBeNull();
    const onlyFilms = await getCollection(ctx, { id: col.id, query: { filter: 'films' } });
    expect(onlyFilms.items.map((m) => m.item.id)).toEqual(films);
  });

  it('dedupes identities: one card per canonical item; captures can be saved as inspirations', async () => {
    const { principal, ctx } = await accountCtx();
    const owner = { accountId: principal.accountId };
    const key = `qloo:${randomUUID()}`;
    const film = await insertItem(owner, { key, title: 'Paris, Texas' });
    await expect(insertItem(owner, { key })).rejects.toThrow();
    const ref = await insertReference({ name: 'Road movie' });
    const cap = await insertCaptureWithAnalysis(owner, { anchorIds: [ref] });
    const col = await createCollection(ctx, { name: 'Night' });
    await addCollectionItem(ctx, { id: col.id, item_id: film, body: {} });
    const inspiration = await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
    expect(inspiration.saved_item?.discovery_item_id).toBe(cap.itemId);
    await addCollectionItem(ctx, { id: col.id, item_id: cap.itemId, body: {} });
    const taste = await getTaste(ctx, {});
    expect(taste.interests.map((i) => i.label)).toEqual(expect.arrayContaining(['Paris, Texas', 'Road movie']));
    expect(taste.saved_count).toBe(2);
  });

  it('applies agent grants: selected collections only, no unfiled, no create; whole-library may create', async () => {
    const { principal, ctx } = await accountCtx();
    const granted = await createCollection(ctx, { name: 'Granted' });
    const secret = await createCollection(ctx, { name: 'Secret' });
    const inGranted = await insertItem({ accountId: principal.accountId });
    const inSecret = await insertItem({ accountId: principal.accountId });
    const unfiled = await insertItem({ accountId: principal.accountId });
    await addCollectionItem(ctx, { id: granted.id, item_id: inGranted, body: {} });
    await addCollectionItem(ctx, { id: secret.id, item_id: inSecret, body: {} });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: unfiled });

    const { principal: agent } = await insertAgentConnection(principal, {
      scopes: ['collections:read', 'collections:write', 'taste:read'],
      libraryAccess: 'selected_collections',
      collectionIds: [granted.id],
    });
    const actx = ctxFor(agent);
    const list = await listCollections(actx);
    expect(list.collections.map((c) => c.id)).toEqual([granted.id]);
    expect(list.unfiled).toBeNull();
    await expect(getCollection(actx, { id: secret.id, query: {} })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createCollection(actx, { name: 'Nope' })).rejects.toMatchObject({ code: 'scope_denied' });
    await expect(listSaved(actx, { filter: 'unfiled' })).rejects.toMatchObject({ code: 'scope_denied' });
    expect((await listSaved(actx, { filter: 'all' })).items.map((i) => i.item.id)).toEqual([inGranted]);
    // Items outside the grant cannot be added (indistinguishable from missing).
    await expect(addCollectionItem(actx, { id: granted.id, item_id: inSecret, body: {} })).rejects.toMatchObject({ code: 'not_found' });
    // Global unsave/hide need whole-library access.
    await expect(recordPreference(ctx_withScopes(agent), { action: 'remove', target_type: 'discovery_item', target_id: inGranted })).rejects.toMatchObject({
      code: 'scope_denied',
    });
    // Global taste is not available; collection-scoped taste is.
    await expect(getTaste(actx, {})).rejects.toMatchObject({ code: 'scope_denied' });
    expect((await getTaste(actx, { collection_id: granted.id })).saved_count).toBe(1);
    await expect(getTaste(actx, { collection_id: secret.id })).rejects.toMatchObject({ code: 'not_found' });

    const { principal: whole } = await insertAgentConnection(principal, { scopes: ['collections:write', 'collections:read'], libraryAccess: 'all' });
    const made = await createCollection(ctxFor(whole), { name: 'By agent' });
    expect((await listCollections(ctxFor(whole))).collections.map((c) => c.id)).toContain(made.id);
    // Adding an unsaved item additionally needs taste:write.
    const fresh = await insertItem({ accountId: principal.accountId });
    await expect(addCollectionItem(ctxFor(whole), { id: made.id, item_id: fresh, body: {} })).rejects.toMatchObject({ code: 'scope_denied' });
  });
});

function ctx_withScopes(agent: Parameters<typeof ctxFor>[0]) {
  if (agent.kind !== 'agent') return ctxFor(agent);
  return ctxFor({ ...agent, scopes: [...agent.scopes, 'taste:write'] });
}

void db;
