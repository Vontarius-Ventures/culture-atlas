import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Principal } from '../principal';
import { clampShareRange, segmentByteLimit } from '../sharing/projection';
import { insertCaptureWithAnalysis, insertItem, saveDirect } from '../test-support/library';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, insertAnonymousSession, testConfig, testContext } from '../testing';
import { liftFeatureKill, setFeatureKill } from '../flags/feature-flags';
import { createCollection, deleteCollection, updateCollection } from './collections';
import {
  acceptInvitation,
  createInvitation,
  createShare,
  getSharedCollection,
  getSharedMedia,
  listShares,
  redeemLink,
  revokeShare,
  saveSharedItem,
  sharePolicyVersion,
  updateShare,
} from './collection-shares';

const db = getTestDb();
afterAll(closeTestDb);

const DAY = 86_400_000;

async function verifiedAccount(email: string, displayName: string | null = null) {
  const principal = await insertAccount();
  await db.query('UPDATE accounts SET display_name = $2 WHERE id = $1', [principal.accountId, displayName]);
  await db.query('INSERT INTO account_emails (account_id, email, verified_at) VALUES ($1, $2, now())', [principal.accountId, email]);
  return principal;
}

async function mediaAsset(accountId: string, input: { kind?: 'photo' | 'video'; shareSafe?: boolean; title?: string } = {}) {
  const kind = input.kind ?? 'video';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_assets (account_id, client_capture_id, kind, source, status, byte_size, content_type, title,
                               duration_ms, original_key, width, height)
     VALUES ($1, $2, $3, 'meta_glasses', 'ready', 6000000, $4, $5, $6, $7, 1280, 720) RETURNING id`,
    [accountId, randomUUID(), kind, kind === 'video' ? 'video/mp4' : 'image/jpeg', input.title ?? null,
      kind === 'video' ? 60_000 : null, `originals/${randomUUID()}`],
  );
  const id = rows[0]!.id;
  const kinds = kind === 'video' ? ['playback', 'poster'] : ['normalized'];
  for (const k of kinds) {
    await db.query(
      `INSERT INTO media_derivatives (account_id, asset_id, generation, kind, processing_version, object_key, checksum,
                                      byte_size, width, height, duration_ms, share_safe)
       VALUES ($1, $2, 1, $3, 'test', $4, $5, $6, 1280, 720, $7, $8)`,
      [accountId, id, k, `derivatives/${randomUUID()}`, 'a'.repeat(64), k === 'playback' ? 6_000_000 : 50_000,
        k === 'playback' ? 60_000 : null, input.shareSafe ?? true],
    );
  }
  return id;
}

async function fixture() {
  const owner = await verifiedAccount(`owner-${randomUUID()}@example.com`, 'Alex');
  const ctx = testContext(owner);
  const col = await createCollection(ctx, { name: 'Quiet weekends', description: 'A few things for slower days.' });
  const other = await createCollection(ctx, { name: 'Secret anniversary plans' });
  const gallery = await insertItem({ accountId: owner.accountId }, { kind: 'reference', category: null, title: 'A neighborhood gallery', qloo: `q-${randomUUID()}` });
  await db.query('UPDATE discovery_items SET display_metadata = $2 WHERE id = $1', [gallery, {
    description: 'Art, small exhibitions and an afternoon nearby.',
    image: { url: 'https://images.example.com/gallery.jpg', width: 800, height: 600, alt: 'A gallery' },
    destination_url: 'https://gallery.example.com',
  }]);
  const listening = await insertItem({ accountId: owner.accountId }, { kind: 'track', category: 'play', title: 'Sunday listening', key: `food:private|${randomUUID()}` });
  await db.query('UPDATE discovery_items SET display_metadata = $2 WHERE id = $1', [listening, {
    description: 'Records to spend a little time with.',
    image: { object_key: 'captures/private/owner-photo.jpg', alt: 'private stored photo' },
    destination_url: 'javascript:alert(1)',
  }]);
  const capture = await insertCaptureWithAnalysis({ accountId: owner.accountId }, { title: 'Kitchen at 12 Elm Street', recommendItemIds: [gallery] });
  const hidden = await insertItem({ accountId: owner.accountId }, { title: 'Only in the private collection' });
  await saveDirect(owner.accountId, gallery, [col.id]);
  await saveDirect(owner.accountId, listening, [col.id]);
  await saveDirect(owner.accountId, capture.itemId, [col.id]);
  await saveDirect(owner.accountId, hidden, [other.id]);
  const video = await mediaAsset(owner.accountId, { title: 'Home, 12 Elm Street' });
  const unsafe = await mediaAsset(owner.accountId, { kind: 'photo', shareSafe: false });
  const elsewhere = await mediaAsset(owner.accountId, { kind: 'photo' });
  for (const asset of [video, unsafe]) {
    await db.query('INSERT INTO collection_media_items (account_id, collection_id, asset_id) VALUES ($1, $2, $3)', [owner.accountId, col.id, asset]);
  }
  await db.query('INSERT INTO collection_media_items (account_id, collection_id, asset_id) VALUES ($1, $2, $3)', [owner.accountId, other.id, elsewhere]);
  await db.query('INSERT INTO collection_media_items (account_id, collection_id, asset_id) VALUES ($1, $2, $3)', [owner.accountId, other.id, video]);
  return { owner, ctx, col, other, gallery, listening, capture, hidden, video, unsafe, elsewhere };
}

const at = (principal: Principal, offsetMs: number) => testContext(principal, { now: () => new Date(Date.now() + offsetMs) });
const tokenOf = (link: string, key: 'share' | 'invite') => new URL(link).hash.replace(`#${key}=`, '');

async function linkShare(f: Awaited<ReturnType<typeof fixture>>, body: Record<string, unknown> = {}) {
  const created = await createShare(f.ctx, f.col.id, { audience: 'link', confirm_policy: true, ...body });
  const anon = testContext(await insertAnonymousSession());
  const redeemed = await redeemLink(anon, { token: tokenOf(created.link!, 'share') });
  return { created, anon, viewer: { sessionToken: redeemed.sessionToken } };
}

describe('SHR-01 restricted invitations, links, expiry, revocation and deletion', () => {
  it('admits only the exact verified recipient and answers uniformly for every address', async () => {
    const f = await fixture();
    const share = await createShare(f.ctx, f.col.id, {});
    expect(share.link).toBeNull();
    expect(share.share).toMatchObject({ audience: 'restricted', include_media: false, allow_originals: false, expires_at: null });
    const invited = `Recipient-${randomUUID()}@Example.com`;
    const existing = await createInvitation(f.ctx, share.share.id, { email: invited });
    const unknown = await createInvitation(f.ctx, share.share.id, { email: `nobody-${randomUUID()}@example.com` });
    const shape = (r: typeof existing) => ({ keys: Object.keys(r).sort(), inv: Object.keys(r.invitation).sort(), status: r.invitation.status,
      days: Math.round((Date.parse(r.invitation.expires_at) - Date.now()) / DAY), link: new URL(r.link).pathname });
    expect(shape(existing)).toEqual(shape(unknown));
    expect(existing.link).not.toContain(invited.toLowerCase());
    const token = tokenOf(existing.link, 'invite');

    const wrong = await verifiedAccount(`someone-else-${randomUUID()}@example.com`);
    const unverified = await insertAccount();
    const anon = await insertAnonymousSession();
    await expect(acceptInvitation(testContext(wrong), { token })).rejects.toMatchObject({ code: 'not_found' });
    await expect(acceptInvitation(testContext(unverified), { token })).rejects.toMatchObject({ code: 'not_found' });
    await expect(acceptInvitation(testContext(anon), { token })).rejects.toMatchObject({ code: 'account_required' });
    await expect(acceptInvitation(f.ctx, { token })).rejects.toMatchObject({ code: 'not_found' });
    // An address that merely differs by case/whitespace normalizes to the same verified email.
    const recipient = await verifiedAccount(invited.toLowerCase());
    const accepted = await acceptInvitation(testContext(recipient), { token });
    expect(accepted.share_id).toBe(share.share.id);
    expect((await acceptInvitation(testContext(recipient), { token })).share_id).toBe(share.share.id);
    const late = await verifiedAccount(`late-${randomUUID()}@example.com`);
    await expect(acceptInvitation(testContext(late), { token })).rejects.toMatchObject({ code: 'not_found' });

    const view = await getSharedCollection(testContext(recipient), { shareId: share.share.id });
    expect(view.collection.title).toBe('Quiet weekends');
    await expect(getSharedCollection(testContext(wrong), { shareId: share.share.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(getSharedCollection(testContext(anon), { shareId: share.share.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('expires invitations after 7 days and refuses acceptance on a revoked share', async () => {
    const f = await fixture();
    const share = await createShare(f.ctx, f.col.id, {});
    const email = `r-${randomUUID()}@example.com`;
    const recipient = await verifiedAccount(email);
    const first = await createInvitation(f.ctx, share.share.id, { email });
    await expect(acceptInvitation(at(recipient, 7 * DAY + 60_000), { token: tokenOf(first.link, 'invite') })).rejects.toMatchObject({ code: 'not_found' });
    const second = await createInvitation(f.ctx, share.share.id, { email });
    await revokeShare(f.ctx, share.share.id);
    await expect(acceptInvitation(testContext(recipient), { token: tokenOf(second.link, 'invite') })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('requires confirming link policy, and blocks views and ranges after expiry or revocation', async () => {
    const f = await fixture();
    await expect(createShare(f.ctx, f.col.id, { audience: 'link' })).rejects.toMatchObject({ code: 'conflict' });
    const { created, anon, viewer } = await linkShare(f, { include_media: true, expires_in_days: 1 });
    expect(created.link).toMatch(/\/shared#share=cas_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(created.share.expires_at!) - Date.now()).toBeLessThanOrEqual(DAY + 5000);
    expect((await getSharedCollection(anon, viewer)).media.map((m) => m.id)).toEqual([f.video]);
    await expect(getSharedMedia(anon, viewer, f.video, 'playback')).resolves.toMatchObject({ kind: 'video' });
    // Expiry blocks the next view and range.
    const later = at(anon.principal, DAY + 60_000);
    await expect(getSharedCollection(later, viewer)).rejects.toMatchObject({ code: 'not_found', message: 'This collection is no longer shared.' });
    await expect(getSharedMedia(later, viewer, f.video, 'playback')).rejects.toMatchObject({ code: 'not_found' });
    await expect(redeemLink(later, { token: tokenOf(created.link!, 'share') })).rejects.toMatchObject({ code: 'not_found' });
    // Revocation blocks the very next range of an active playback.
    await revokeShare(f.ctx, created.share.id);
    await expect(getSharedMedia(anon, viewer, f.video, 'playback')).rejects.toMatchObject({ code: 'not_found' });
    await expect(getSharedCollection(anon, viewer)).rejects.toMatchObject({ code: 'not_found' });
    await expect(redeemLink(anon, { token: tokenOf(created.link!, 'share') })).rejects.toMatchObject({ code: 'not_found' });
    // Garbage and wrong-prefix tokens get the same generic answer.
    await expect(redeemLink(anon, { token: 'cas_' + 'x'.repeat(43) })).rejects.toMatchObject({ code: 'not_found' });
    await expect(redeemLink(anon, { token: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('revoking one share leaves other intentional grants intact', async () => {
    const f = await fixture();
    const a = await linkShare(f);
    const b = await linkShare(f);
    await revokeShare(f.ctx, a.created.share.id);
    await expect(getSharedCollection(a.anon, a.viewer)).rejects.toMatchObject({ code: 'not_found' });
    expect((await getSharedCollection(b.anon, b.viewer)).collection.title).toBe('Quiet weekends');
    // A session for share B cannot be pointed at share A.
    await expect(getSharedCollection(b.anon, { ...b.viewer, shareId: a.created.share.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('deleting the collection revokes every share, invitation and session transactionally', async () => {
    const f = await fixture();
    const link = await linkShare(f);
    const restricted = await createShare(f.ctx, f.col.id, {});
    const email = `d-${randomUUID()}@example.com`;
    const recipient = await verifiedAccount(email);
    const invite = await createInvitation(f.ctx, restricted.share.id, { email });
    await deleteCollection(f.ctx, { id: f.col.id });
    await expect(getSharedCollection(link.anon, link.viewer)).rejects.toMatchObject({ code: 'not_found' });
    await expect(acceptInvitation(testContext(recipient), { token: tokenOf(invite.link, 'invite') })).rejects.toMatchObject({ code: 'not_found' });
    const { rows } = await db.query<{ revoked_at: Date | null; revoke_reason: string; collection_id: string | null }>(
      'SELECT revoked_at, revoke_reason, collection_id FROM collection_shares WHERE id = ANY($1::uuid[])',
      [[link.created.share.id, restricted.share.id]],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ revoke_reason: 'collection_deleted', collection_id: null });
    const audit = await db.query('SELECT action FROM audit_events WHERE account_id = $1 AND action = $2', [f.owner.accountId, 'share.revoked_collection_deleted']);
    expect(audit.rowCount).toBe(2);
    const sessions = await db.query('SELECT 1 FROM share_sessions WHERE share_id = $1 AND revoked_at IS NULL', [link.created.share.id]);
    expect(sessions.rowCount).toBe(0);
  });

  it('original download off cannot be bypassed, and broadening needs If-Match plus confirmation', async () => {
    const f = await fixture();
    const { created, anon, viewer } = await linkShare(f, { include_media: true });
    expect((await getSharedCollection(anon, viewer)).media[0]!.original_url).toBeNull();
    await expect(getSharedMedia(anon, viewer, f.video, 'original')).rejects.toMatchObject({ code: 'not_found' });
    // Not share-safe and not-in-collection media are invisible through every variant.
    for (const variant of ['poster', 'playback', 'original'] as const) {
      await expect(getSharedMedia(anon, viewer, f.unsafe, variant)).rejects.toMatchObject({ code: 'not_found' });
      await expect(getSharedMedia(anon, viewer, f.elsewhere, variant)).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(() => sharePolicyVersion(null)).toThrow();
    await expect(updateShare(f.ctx, created.share.id, { allow_originals: true }, created.share.policy_version))
      .rejects.toMatchObject({ code: 'conflict', details: { confirmation_required: true, broadening: ['allow_originals'] } });
    await expect(updateShare(f.ctx, created.share.id, { allow_originals: true, confirm_broaden: true }, created.share.policy_version + 5))
      .rejects.toMatchObject({ code: 'precondition_failed' });
    const updated = await updateShare(f.ctx, created.share.id, { allow_originals: true, confirm_broaden: true }, created.share.policy_version);
    expect(updated.share.allow_originals).toBe(true);
    await expect(getSharedMedia(anon, viewer, f.video, 'original')).resolves.toMatchObject({ variant: 'original' });
    const audit = await db.query('SELECT 1 FROM audit_events WHERE account_id = $1 AND action = $2 AND target_id = $3',
      [f.owner.accountId, 'media.original_downloaded', f.video]);
    expect(audit.rowCount).toBe(1);
    // Narrowing needs no confirmation and applies to the next request.
    const narrowed = await updateShare(f.ctx, created.share.id, { include_media: false }, updated.share.policy_version);
    expect(narrowed.share).toMatchObject({ include_media: false, allow_originals: false });
    await expect(getSharedMedia(anon, viewer, f.video, 'playback')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('previews exactly which captured items become visible before including media', async () => {
    const f = await fixture();
    const { created } = await linkShare(f);
    const err = await updateShare(f.ctx, created.share.id, { include_media: true }, created.share.policy_version).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'conflict', details: { would_include: [{ id: f.video, kind: 'video', title: 'Home, 12 Elm Street' }] } });
  });

  it('never lets agents, other accounts or anonymous sessions manage shares', async () => {
    const f = await fixture();
    const agent = await insertAgentConnection(f.owner, { libraryAccess: 'all' });
    const stranger = testContext(await insertAccount());
    await expect(createShare(testContext(agent.principal), f.col.id, {})).rejects.toMatchObject({ code: 'scope_denied' });
    await expect(listShares(testContext(agent.principal), f.col.id)).rejects.toMatchObject({ code: 'scope_denied' });
    await expect(createShare(stranger, f.col.id, {})).rejects.toMatchObject({ code: 'not_found' });
    const share = await createShare(f.ctx, f.col.id, {});
    await expect(revokeShare(stranger, share.share.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(createInvitation(stranger, share.share.id, { email: 'a@example.com' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateShare(stranger, share.share.id, { include_media: false }, 1)).rejects.toMatchObject({ code: 'not_found' });
    await expect(createShare(f.ctx, f.col.id, {})).rejects.toMatchObject({ code: 'conflict' });
    expect((await listShares(f.ctx, f.col.id)).shares).toHaveLength(1);
  });
});

describe('SHR-02 public-safe projection', () => {
  it('excludes private reasoning, provenance, coordinates, other collections and taste', async () => {
    const f = await fixture();
    await db.query('UPDATE captures SET focus = $2 WHERE id = $1', [f.capture.captureId, { lat: 40.7128, lon: -74.006 }]).catch(() => undefined);
    const { anon, viewer } = await linkShare(f, { include_media: true });
    const view = await getSharedCollection(anon, viewer);
    expect(view.collection).toEqual({ title: 'Quiet weekends', description: 'A few things for slower days.', owner_display_name: 'Alex' });
    expect(view.share.view_only).toBe(true);
    expect(view.discoveries.map((d) => d.title)).toEqual(['A neighborhood gallery', 'Sunday listening']);
    const [gallery, listening] = view.discoveries;
    expect(gallery).toMatchObject({ description: 'Art, small exhibitions and an afternoon nearby.', saveable: true,
      image: { url: 'https://images.example.com/gallery.jpg' }, destination_url: 'https://gallery.example.com' });
    expect(listening).toMatchObject({ image: null, destination_url: null, saveable: false });
    expect(view.media).toEqual([{ id: f.video, kind: 'video', width: 1280, height: 720, duration_ms: 60_000,
      poster_url: `/v2/shared/media/${f.video}/poster?share=${view.share.id}`,
      playback_url: `/v2/shared/media/${f.video}/playback?share=${view.share.id}`, original_url: null }]);
    const text = JSON.stringify(view);
    for (const secret of ['Inspired by your photo', 'Kitchen at 12 Elm Street', 'Home, 12 Elm Street', 'meta_glasses',
      'Secret anniversary plans', 'Only in the private collection', 'captures/', 'originals/', 'derivatives/', '40.7128',
      f.owner.accountId, f.col.id, f.capture.captureId, f.elsewhere, f.unsafe, 'taste']) {
      expect(text).not.toContain(secret);
    }
  });

  it('hides captured media entirely unless the owner includes it', async () => {
    const f = await fixture();
    const { anon, viewer } = await linkShare(f);
    const view = await getSharedCollection(anon, viewer);
    expect(view.media).toEqual([]);
    expect(view.share.include_media).toBe(false);
    await expect(getSharedMedia(anon, viewer, f.video, 'poster')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('follows live additions, removals, deletions and renames', async () => {
    const f = await fixture();
    const { anon, viewer } = await linkShare(f, { include_media: true });
    const added = await insertItem({ accountId: f.owner.accountId }, { title: 'A late addition', qloo: `q-${randomUUID()}` });
    await saveDirect(f.owner.accountId, added, [f.col.id]);
    expect((await getSharedCollection(anon, viewer)).discoveries.map((d) => d.title)).toContain('A late addition');
    await db.query('DELETE FROM collection_items WHERE collection_id = $1 AND saved_item_id IN (SELECT id FROM saved_items WHERE discovery_item_id = $2)', [f.col.id, added]);
    expect((await getSharedCollection(anon, viewer)).discoveries.map((d) => d.title)).not.toContain('A late addition');
    // Removing the video from this collection removes it here although another private collection still holds it.
    await db.query('DELETE FROM collection_media_items WHERE collection_id = $1 AND asset_id = $2', [f.col.id, f.video]);
    expect((await getSharedCollection(anon, viewer)).media).toEqual([]);
    await expect(getSharedMedia(anon, viewer, f.video, 'playback')).rejects.toMatchObject({ code: 'not_found' });
    await db.query('INSERT INTO collection_media_items (account_id, collection_id, asset_id) VALUES ($1, $2, $3)', [f.owner.accountId, f.col.id, f.video]);
    await db.query("UPDATE media_assets SET deleted_at = now(), status = 'deleted' WHERE id = $1", [f.video]);
    expect((await getSharedCollection(anon, viewer)).media).toEqual([]);
    const col = (await db.query<{ revision: number }>('SELECT revision FROM collections WHERE id = $1', [f.col.id])).rows[0]!;
    await updateCollection(f.ctx, { id: f.col.id, body: { name: 'Slow Sundays', expected_revision: col.revision } });
    expect((await getSharedCollection(anon, viewer)).collection.title).toBe('Slow Sundays');
  });

  it('lets a signed-in viewer copy only public catalog references into their own library', async () => {
    const f = await fixture();
    const { created } = await linkShare(f);
    const viewerAccount = await insertAccount();
    const vctx = testContext(viewerAccount);
    const redeemed = await redeemLink(vctx, { token: tokenOf(created.link!, 'share') });
    const viewer = { sessionToken: redeemed.sessionToken };
    const saved = await saveSharedItem(vctx, viewer, f.gallery);
    expect(saved.item_id).not.toBe(f.gallery);
    const copy = await db.query<{ owner_account_id: string; display_metadata: Record<string, unknown>; reference_id: string | null }>(
      'SELECT owner_account_id, display_metadata, reference_id FROM discovery_items WHERE id = $1', [saved.item_id],
    );
    expect(copy.rows[0]).toMatchObject({ owner_account_id: viewerAccount.accountId, reference_id: null });
    const own = await db.query('SELECT 1 FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2', [viewerAccount.accountId, saved.item_id]);
    expect(own.rowCount).toBe(1);
    await expect(saveSharedItem(vctx, viewer, f.listening)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(saveSharedItem(vctx, viewer, f.capture.itemId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(saveSharedItem(vctx, viewer, f.hidden)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('collection_sharing_enabled is enforced on the server', () => {
  it('an owner kill stops link viewing, redemption, invitations and broadening, but never revocation', async () => {
    const f = await fixture();
    const { created, anon, viewer } = await linkShare(f, { include_media: true });
    const restricted = await createShare(f.ctx, f.col.id, {});
    const recipient = await verifiedAccount(`kill-${randomUUID()}@example.com`);
    const email = (await db.query<{ email: string }>('SELECT email FROM account_emails WHERE account_id = $1', [recipient.accountId])).rows[0]!.email;
    const invite = await createInvitation(f.ctx, restricted.share.id, { email });
    await setFeatureKill(db, { flag: 'collection_sharing_enabled', accountId: f.owner.accountId, reason: 'incident', actor: 'test' });
    const off = { code: 'service_unavailable', message: 'Sharing is temporarily unavailable.' };
    await expect(getSharedCollection(anon, viewer)).rejects.toMatchObject(off);
    await expect(getSharedMedia(anon, viewer, f.video, 'playback')).rejects.toMatchObject(off);
    await expect(redeemLink(anon, { token: tokenOf(created.link!, 'share') })).rejects.toMatchObject(off);
    await expect(createShare(f.ctx, f.col.id, { audience: 'link', confirm_policy: true })).rejects.toMatchObject(off);
    await expect(createInvitation(f.ctx, restricted.share.id, { email: 'x@example.com' })).rejects.toMatchObject(off);
    await expect(acceptInvitation(testContext(recipient), { token: tokenOf(invite.link, 'invite') })).rejects.toMatchObject(off);
    await expect(updateShare(f.ctx, restricted.share.id, { include_media: true, confirm_broaden: true }, 1)).rejects.toMatchObject(off);
    // Owners can still see and narrow or revoke what they shared.
    expect((await listShares(f.ctx, f.col.id)).shares).toHaveLength(2);
    // Lifting the kill restores the untouched share and its session.
    await liftFeatureKill(db, { flag: 'collection_sharing_enabled', accountId: f.owner.accountId });
    expect((await getSharedCollection(anon, viewer)).media.map((m) => m.id)).toEqual([f.video]);
    await setFeatureKill(db, { flag: 'collection_sharing_enabled', accountId: f.owner.accountId, reason: 'incident', actor: 'test' });
    await revokeShare(f.ctx, created.share.id);
    await liftFeatureKill(db, { flag: 'collection_sharing_enabled', accountId: f.owner.accountId });
    await expect(getSharedCollection(anon, viewer)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('COLLECTION_SHARING_ENABLED=false turns sharing off for every owner', async () => {
    const f = await fixture();
    const { anon, viewer } = await linkShare(f);
    const disabled = testConfig({ COLLECTION_SHARING_ENABLED: 'false' });
    await expect(getSharedCollection(testContext(anon.principal, { config: disabled }), viewer))
      .rejects.toMatchObject({ code: 'service_unavailable', retryable: false });
    await expect(createShare(testContext(f.owner, { config: disabled }), f.col.id, {}))
      .rejects.toMatchObject({ code: 'service_unavailable' });
  });
});

describe('share media segments', () => {
  it('serves at most about 30 seconds per authorized range', () => {
    const video = { byteSize: 6_000_000, durationMs: 60_000 };
    expect(segmentByteLimit(video)).toBe(3_000_000);
    expect(clampShareRange(null, 6_000_000, 3_000_000)).toEqual({ start: 0, end: 2_999_999 });
    expect(clampShareRange('bytes=1000-', 6_000_000, 3_000_000)).toEqual({ start: 1000, end: 3_000_999 });
    expect(clampShareRange('bytes=-500', 6_000_000, 3_000_000)).toEqual({ start: 5_999_500, end: 5_999_999 });
    expect(clampShareRange('bytes=7000000-', 6_000_000, 3_000_000)).toBeNull();
    expect(clampShareRange('bytes=abc', 6_000_000, 3_000_000)).toBeNull();
    expect(segmentByteLimit({ byteSize: 50_000, durationMs: null })).toBe(8 * 1024 * 1024);
  });
});
