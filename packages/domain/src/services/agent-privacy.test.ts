import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { describeConnectionAccess } from '../authz/connection-access';
import { accountCtx, ctxFor, insertCaptureWithAnalysis, insertItem, saveDirect } from '../test-support/library';
import { closeTestDb, getTestDb, insertAgentConnection, testProviders } from '../testing';
import * as captures from './captures';
import { createCollection, getCollection, listCollections } from './collections';
import { getItem } from './items';

/**
 * Regression tests: a selected-collection agent sees compiled results inside
 * its grant only. No private context from outside the grant (capture reasons,
 * the existence of other photos) and never the photo itself.
 */

const db = getTestDb();
afterAll(closeTestDb);

const SAMPLE_PHOTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../apps/web/public/samples/cafe.jpg');

describe('item detail under a selected-collection grant', () => {
  async function setup() {
    const { principal, ctx } = await accountCtx();
    const owner = { accountId: principal.accountId };
    const film = await insertItem(owner, { kind: 'film', title: 'Le Mans' });
    // A private capture OUTSIDE the grant whose analysis recommended the film.
    const secret = await insertCaptureWithAnalysis(owner, { recommendItemIds: [film] });
    await db.query(`UPDATE recommendations SET display_reason = 'Connected to SECRET-BRAND in your photo.' WHERE analysis_id = $1`, [
      secret.analysisId,
    ]);
    const granted = await createCollection(ctx, { name: 'Shared' });
    await saveDirect(principal.accountId, film, [granted.id]);
    const { principal: agent } = await insertAgentConnection(owner, {
      scopes: ['collections:read'],
      libraryAccess: 'selected_collections',
      collectionIds: [granted.id],
    });
    return { principal, ctx, owner, film, secret, granted, agent };
  }

  it('never shows the reason or sources of a recommendation from an ungranted capture', async () => {
    const s = await setup();
    const asAgent = await getItem(ctxFor(s.agent), { id: s.film, query: {} });
    expect(JSON.stringify(asAgent)).not.toContain('SECRET-BRAND');
    expect(asAgent.item.recommendation_id).toBeNull();

    // Asking for that recommendation by id does not help either.
    const recId = (await db.query<{ id: string }>('SELECT id FROM recommendations WHERE analysis_id = $1', [s.secret.analysisId])).rows[0]!.id;
    const byId = await getItem(ctxFor(s.agent), { id: s.film, query: { recommendation_id: recId } });
    expect(JSON.stringify(byId)).not.toContain('SECRET-BRAND');

    // The owner still sees their own context.
    expect((await getItem(s.ctx, { id: s.film, query: {} })).reason).toContain('SECRET-BRAND');
  });

  it('shows the reason once the capture itself is in a granted collection', async () => {
    const s = await setup();
    await saveDirect(s.principal.accountId, s.secret.itemId, [s.granted.id]);
    const asAgent = await getItem(ctxFor(s.agent), { id: s.film, query: {} });
    expect(asAgent.reason).toContain('SECRET-BRAND');
  });
});

describe('agent access to photos', () => {
  it('a read-only agent gets compiled results without the photo, in capture and collection reads', async () => {
    const { principal, ctx } = await accountCtx();
    const owner = { accountId: principal.accountId };
    const cap = await insertCaptureWithAnalysis(owner, {});
    // Like a real capture item: its card image is the stored derivative.
    await db.query(
      `UPDATE discovery_items di SET display_metadata = jsonb_build_object('image', jsonb_build_object('object_key', c.private_object_key, 'alt', 'Your photo'))
         FROM captures c WHERE di.id = $1 AND c.id = $2`,
      [cap.itemId, cap.captureId],
    );
    const col = await createCollection(ctx, { name: 'Shared' });
    await saveDirect(principal.accountId, cap.itemId, [col.id]);
    const { principal: agent } = await insertAgentConnection(owner, {
      scopes: ['captures:read', 'collections:read', 'taste:read', 'plans:read'],
      libraryAccess: 'selected_collections',
      collectionIds: [col.id],
    });
    const actx = ctxFor(agent);

    const capture = await captures.getCapture(actx, { id: cap.captureId });
    expect(capture.image).toBeNull();
    expect(capture.analysis?.title).toBeTruthy();
    const detail = await getCollection(actx, { id: col.id, query: {} });
    const member = detail.items.find((i) => i.item.id === cap.itemId);
    expect(member?.item.kind).toBe('capture');
    expect(member?.item.image).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('/v1/media');
    expect(JSON.stringify(await listCollections(actx))).not.toContain('/v1/media');
    expect(JSON.stringify(await getItem(actx, { id: cap.itemId, query: {} }))).not.toContain('/v1/media');

    // What the owner is told matches: compiled results only.
    expect(describeConnectionAccess(agent.scopes, 'selected_collections', ['Shared']).limits.join(' ')).toContain('Original photos');

    // The owner still sees the photo, in both places.
    expect((await captures.getCapture(ctx, { id: cap.captureId })).image?.url).toContain('/v1/media');
    const own = await getCollection(ctx, { id: col.id, query: {} });
    expect(own.items.find((i) => i.item.id === cap.itemId)?.item.image?.url).toContain('/v1/media');
  });
});

describe('duplicate-photo reuse under a selected-collection grant', () => {
  it('an agent upload of a photo the owner analyzed outside the grant is a new, readable capture', async () => {
    const providers = testProviders();
    const { principal, ctx: base } = await accountCtx({ providers });
    const ctx = { ...base, providers };
    const bytes = new Uint8Array(readFileSync(SAMPLE_PHOTO));
    const up = await captures.createUpload(ctx, { bytes });
    const mine = await captures.createCapture(ctx, { kind: 'json', body: { upload_id: up.upload_id, source: 'upload' } });

    const col = await createCollection(ctx, { name: 'Shared' });
    const { principal: agent } = await insertAgentConnection(
      { accountId: principal.accountId },
      { scopes: ['captures:read', 'captures:write', 'collections:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
    );
    const actx = ctxFor(agent, { providers });
    const aup = await captures.createUpload(actx, { bytes });
    const theirs = await captures.createCapture(actx, { kind: 'json', body: { upload_id: aup.upload_id, source: 'upload' } });
    expect(theirs.reused).toBe(false);
    expect(theirs.capture_id).not.toBe(mine.capture_id);
    expect(theirs.job_id).not.toBe(mine.job_id);
    expect((await captures.getCapture(actx, { id: theirs.capture_id })).id).toBe(theirs.capture_id);

    // The agent's own retry still reuses its own analysis.
    const again = await captures.createCapture(actx, { kind: 'json', body: { upload_id: aup.upload_id, source: 'upload' } });
    expect(again).toMatchObject({ capture_id: theirs.capture_id, reused: true });
    // The owner's own retry reuses the owner's analysis, as before.
    const ownerAgain = await captures.createCapture(ctx, { kind: 'json', body: { upload_id: up.upload_id, source: 'upload' } });
    expect(ownerAgain).toMatchObject({ capture_id: mine.capture_id, reused: true });
  });
});
