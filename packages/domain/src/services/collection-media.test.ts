import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { authorizeMedia } from '../authz/agent-resources';
import { insertCaptureWithAnalysis } from '../test-support/library';
import { closeTestDb, getTestDb, insertAccount, insertAnonymousSession, testContext } from '../testing';
import { addCollectionItem, createCollection } from './collections';
import { createShare, getSharedCollection, redeemLink, revokeShare } from './collection-shares';
import { addMediaToCollection, listCollectionMedia, removeMediaFromCollection } from './collection-media';
import { createConnection } from './agent-platform';
import { resolvePrincipal } from './auth';

const db = getTestDb();
afterAll(closeTestDb);
async function asset(accountId: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_assets(account_id,client_capture_id,kind,source,status,byte_size,content_type)
     VALUES($1,$2,'photo','upload','ready',123,'image/jpeg') RETURNING id`, [accountId, randomUUID()],
  );
  return rows[0]!.id;
}
async function fixture() {
  const owner = await insertAccount(), other = await insertAccount();
  const ctx = testContext(owner), col = await createCollection(ctx, { name: 'Selected' });
  const id = await asset(owner.accountId), foreign = await asset(other.accountId);
  return { owner, other, ctx, col, id, foreign };
}
describe('AGT-01 collection media membership', () => {
  it('adds idempotently, lists and removes current membership', async () => {
    const f = await fixture();
    await addMediaToCollection(f.ctx, f.col.id, f.id);
    await addMediaToCollection(f.ctx, f.col.id, f.id);
    expect((await listCollectionMedia(f.ctx, f.col.id)).map((m) => m.id)).toEqual([f.id]);
    await removeMediaFromCollection(f.ctx, f.col.id, f.id);
    expect(await listCollectionMedia(f.ctx, f.col.id)).toEqual([]);
  });
  it('enforces both owners structurally even with direct SQL mistakes', async () => {
    const f = await fixture();
    await expect(addMediaToCollection(f.ctx, f.col.id, f.foreign)).rejects.toMatchObject({ code: 'not_found' });
    await expect(db.query('INSERT INTO collection_media_items(account_id,collection_id,asset_id) VALUES($1,$2,$3)',
      [f.owner.accountId, f.col.id, f.foreign])).rejects.toMatchObject({ code: '23503' });
    await expect(db.query('INSERT INTO collection_media_items(account_id,collection_id,asset_id) VALUES($1,$2,$3)',
      [f.other.accountId, f.col.id, f.foreign])).rejects.toMatchObject({ code: '23503' });
  });
  it('immediately hides hidden and deleted assets from membership reads', async () => {
    const f = await fixture();
    await addMediaToCollection(f.ctx, f.col.id, f.id);
    await db.query('UPDATE media_assets SET hidden_at=now() WHERE id=$1', [f.id]);
    expect(await listCollectionMedia(f.ctx, f.col.id)).toEqual([]);
    await db.query('UPDATE media_assets SET hidden_at=NULL,deleted_at=now(),status=$2 WHERE id=$1', [f.id, 'deleted']);
    expect(await listCollectionMedia(f.ctx, f.col.id)).toEqual([]);
  });
  it('does not allow selected agents to move unseen assets into a grant', async () => {
    const f = await fixture(), secret = await asset(f.owner.accountId);
    await addMediaToCollection(f.ctx, f.col.id, f.id);
    const created = await createConnection(f.ctx, { client_name: 'selected', scopes: ['media:read', 'collections:write', 'collections:read'],
      library_access: 'selected_collections', collection_ids: [f.col.id] });
    const agent = testContext((await resolvePrincipal(db, { authorization: `Bearer ${created.credential}` }))!);
    expect((await listCollectionMedia(agent, f.col.id)).map((m) => m.id)).toEqual([f.id]);
    await expect(addMediaToCollection(agent, f.col.id, secret)).rejects.toMatchObject({ code: 'not_found' });
    await removeMediaFromCollection(f.ctx, f.col.id, f.id);
    await expect(authorizeMedia(agent, 'media:read', f.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('agents cannot create public access to media through a live share', () => {
  async function shared() {
    const f = await fixture();
    // A share-safe derivative, so the media WOULD be visible to link holders if added.
    await db.query(
      `INSERT INTO media_derivatives (account_id, asset_id, generation, kind, processing_version, object_key, checksum,
                                      byte_size, width, height, share_safe)
       VALUES ($1, $2, 1, 'normalized', 'test', $3, $4, 1000, 64, 64, true)`,
      [f.owner.accountId, f.id, `derivatives/${randomUUID()}`, 'a'.repeat(64)],
    );
    const share = await createShare(f.ctx, f.col.id, { audience: 'link', confirm_policy: true, include_media: true });
    const anon = testContext(await insertAnonymousSession());
    const token = new URL(share.link!).hash.replace('#share=', '');
    const viewer = { sessionToken: (await redeemLink(anon, { token })).sessionToken };
    const created = await createConnection(f.ctx, { client_name: 'organizer', library_access: 'all',
      scopes: ['media:read', 'collections:read', 'collections:write', 'taste:write'] });
    const agent = testContext((await resolvePrincipal(db, { authorization: `Bearer ${created.credential}` }))!);
    return { ...f, share, anon, viewer, agent };
  }
  const viewerMedia = async (f: Awaited<ReturnType<typeof shared>>) =>
    (await getSharedCollection(f.anon, f.viewer)).media.map((m) => m.id);

  it('refuses an agent adding media to a collection whose link share includes media', async () => {
    const f = await shared();
    expect(await viewerMedia(f)).toEqual([]);
    await expect(addMediaToCollection(f.agent, f.col.id, f.id)).rejects.toMatchObject({
      code: 'scope_denied', details: { reason: 'shared_with_media' },
    });
    expect(await viewerMedia(f)).toEqual([]);
    expect(await listCollectionMedia(f.ctx, f.col.id)).toEqual([]);
    // Once the share no longer exposes media, the agent's ordinary organizing works again.
    await revokeShare(f.ctx, f.share.share.id);
    await addMediaToCollection(f.agent, f.col.id, f.id);
    expect((await listCollectionMedia(f.ctx, f.col.id)).map((m) => m.id)).toEqual([f.id]);
  });

  it('refuses the v1 path too: a capture item that carries the media', async () => {
    const f = await shared();
    const capture = await insertCaptureWithAnalysis({ accountId: f.owner.accountId });
    await db.query('UPDATE captures SET media_asset_id = $2 WHERE id = $1', [capture.captureId, f.id]);
    await expect(addCollectionItem(f.agent, { id: f.col.id, item_id: capture.itemId, body: {} })).rejects.toMatchObject({
      code: 'scope_denied',
    });
    expect(await viewerMedia(f)).toEqual([]);
  });

  it('leaves the owner, and collections that are not shared with media, unaffected', async () => {
    const f = await shared();
    const plain = await createCollection(f.ctx, { name: 'Not shared' });
    await addMediaToCollection(f.agent, plain.id, f.id);
    await addMediaToCollection(f.ctx, f.col.id, f.id);
    expect(await viewerMedia(f)).toEqual([f.id]);
  });
});
