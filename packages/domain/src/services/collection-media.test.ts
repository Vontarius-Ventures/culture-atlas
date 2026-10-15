import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { authorizeMedia } from '../authz/agent-resources';
import { closeTestDb, getTestDb, insertAccount, testContext } from '../testing';
import { createCollection } from './collections';
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
