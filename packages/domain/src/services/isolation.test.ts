import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context';
import type { Principal } from '../principal';
import { anonCtx, accountCtx, insertCaptureWithAnalysis, insertItem, insertReference } from '../test-support/library';
import { closeTestDb, getTestDb } from '../testing';
import * as collections from './collections';
import { getDiscoveries } from './discovery';
import { getItem, startRelatedDiscovery } from './items';
import { getJob } from './jobs';
import * as plans from './plans';
import { listSaved, recordPreference } from './preferences';
import { getTaste } from './taste';

/**
 * Tenant isolation (spec acceptance): two accounts and two anonymous sessions
 * cannot read or mutate each other's captures (as items), collections, saved
 * items, plans, jobs or preference records. Every cross-tenant access is 404
 * (never 403, so private records' existence is not revealed); anonymous
 * sessions are asked to create an account for account-only areas.
 */

const db = getTestDb();
afterAll(closeTestDb);

interface Tenant {
  name: string;
  principal: Principal;
  ctx: ServiceContext;
  itemId: string;
  captureItemId: string;
  captureId: string;
  relatedJobId: string;
  collectionId?: string;
  membershipId?: string;
  planId?: string;
  planJobId?: string;
}

async function accountTenant(name: string): Promise<Tenant> {
  const { principal, ctx } = await accountCtx();
  const owner = { accountId: principal.accountId };
  const ref = await insertReference({ name: `${name} reference` });
  const itemId = await insertItem(owner, { kind: 'film', title: `${name} film`, qloo: `${name}-${randomUUID()}` });
  const artist = await insertItem(owner, { kind: 'artist', title: `${name} artist` });
  const cap = await insertCaptureWithAnalysis(owner, { anchorIds: [ref] });
  const col = await collections.createCollection(ctx, { name: `${name} collection` });
  const add = await collections.addCollectionItem(ctx, { id: col.id, item_id: itemId, body: {} });
  await collections.addCollectionItem(ctx, { id: col.id, item_id: artist, body: {} });
  await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
  await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: await insertItem(owner, { kind: 'brand' }) });
  const plan = await plans.createPlan(ctx, {
    collection_id: col.id,
    expected_revision: 3,
    item_ids: [itemId, artist],
    template: 'movie_night',
    exploration: 'balanced',
  });
  const related = await startRelatedDiscovery(ctx, { id: itemId, body: {} });
  return {
    name,
    principal,
    ctx,
    itemId,
    captureItemId: cap.itemId,
    captureId: cap.captureId,
    relatedJobId: related.job_id,
    collectionId: col.id,
    membershipId: add.membership_id,
    planId: plan.plan_id,
    planJobId: plan.job_id,
  };
}

async function anonTenant(name: string): Promise<Tenant> {
  const { principal, ctx } = await anonCtx();
  if (principal.kind !== 'anonymous') throw new Error('expected anonymous');
  const owner = { sessionId: principal.sessionId };
  const itemId = await insertItem(owner, { kind: 'film', title: `${name} film`, qloo: `${name}-${randomUUID()}` });
  const cap = await insertCaptureWithAnalysis(owner, { recommendItemIds: [itemId] });
  await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: await insertItem(owner, { kind: 'artist' }) });
  const related = await startRelatedDiscovery(ctx, { id: itemId, body: {} });
  return { name, principal, ctx, itemId, captureItemId: cap.itemId, captureId: cap.captureId, relatedJobId: related.job_id };
}

const notFound = { code: 'not_found', status: 404 };

describe('tenant isolation across 2 accounts and 2 anonymous sessions', () => {
  it('nobody can read or mutate another tenant’s records', async () => {
    const tenants = [await accountTenant('alice'), await accountTenant('bob'), await anonTenant('s1'), await anonTenant('s2')];

    for (const me of tenants) {
      for (const other of tenants) {
        if (me === other) continue;
        const label = `${me.name} -> ${other.name}`;
        // Items (private recommendations and capture inspirations).
        await expect(getItem(me.ctx, { id: other.itemId, query: {} }), label).rejects.toMatchObject(notFound);
        await expect(getItem(me.ctx, { id: other.captureItemId, query: {} }), label).rejects.toMatchObject(notFound);
        await expect(startRelatedDiscovery(me.ctx, { id: other.itemId, body: {} }), label).rejects.toMatchObject(notFound);
        // Jobs.
        await expect(getJob(me.ctx, { id: other.relatedJobId }), label).rejects.toMatchObject(notFound);
        if (other.planJobId) await expect(getJob(me.ctx, { id: other.planJobId }), label).rejects.toMatchObject(notFound);
        // Preference writes against someone else's items or captures.
        await expect(
          recordPreference(me.ctx, { action: 'hide', target_type: 'discovery_item', target_id: other.itemId }),
          label,
        ).rejects.toMatchObject(notFound);
        await expect(
          recordPreference(me.ctx, { action: 'remove', target_type: 'capture', target_id: other.captureId }),
          label,
        ).rejects.toMatchObject(notFound);

        if (me.principal.kind === 'anonymous') {
          // Account-only areas ask anonymous visitors to create an account.
          if (other.collectionId) {
            await expect(collections.getCollection(me.ctx, { id: other.collectionId, query: {} }), label).rejects.toMatchObject({
              code: 'account_required',
            });
            await expect(plans.getPlan(me.ctx, { id: other.planId! }), label).rejects.toMatchObject({ code: 'account_required' });
          }
          continue;
        }
        if (other.collectionId) {
          const cid = other.collectionId;
          await expect(collections.getCollection(me.ctx, { id: cid, query: {} }), label).rejects.toMatchObject(notFound);
          await expect(collections.updateCollection(me.ctx, { id: cid, body: { expected_revision: 3, name: 'x' } }), label).rejects.toMatchObject(notFound);
          await expect(collections.addCollectionItem(me.ctx, { id: cid, item_id: me.itemId, body: {} }), label).rejects.toMatchObject(notFound);
          await expect(collections.removeCollectionItem(me.ctx, { id: cid, item_id: other.itemId }), label).rejects.toMatchObject(notFound);
          await expect(
            collections.reorderCollection(me.ctx, { id: cid, body: { expected_revision: 3, membership_ids: [other.membershipId!] } }),
            label,
          ).rejects.toMatchObject(notFound);
          await expect(collections.deleteCollection(me.ctx, { id: cid }), label).rejects.toMatchObject(notFound);
          await expect(plans.getPlan(me.ctx, { id: other.planId! }), label).rejects.toMatchObject(notFound);
          await expect(plans.replacePlanSection(me.ctx, { id: other.planId!, body: { section: 'film' } }), label).rejects.toMatchObject(notFound);
          await expect(plans.deletePlan(me.ctx, { id: other.planId! }), label).rejects.toMatchObject(notFound);
          await expect(
            plans.createPlan(me.ctx, { collection_id: cid, expected_revision: 3, item_ids: [other.itemId, me.itemId], template: 'movie_night', exploration: 'balanced' }),
            label,
          ).rejects.toMatchObject(notFound);
        }
        // Someone else's item cannot be pulled into my collection.
        if (me.collectionId) {
          await expect(collections.addCollectionItem(me.ctx, { id: me.collectionId, item_id: other.itemId, body: {} }), label).rejects.toMatchObject(
            notFound,
          );
        }
      }

      // Lists only ever contain the tenant's own records.
      if (me.principal.kind !== 'anonymous') {
        const cols = await collections.listCollections(me.ctx);
        expect(cols.collections.map((c) => c.id)).toEqual([me.collectionId]);
        const saved = await listSaved(me.ctx, { filter: 'all' });
        expect(saved.items.map((s) => s.item.id).sort()).toEqual(
          [me.itemId, me.captureItemId, ...(await artistOf(me))].sort(),
        );
        expect((await plans.listPlans(me.ctx, {})).plans.map((p) => p.id)).toEqual([me.planId]);
      } else {
        await expect(collections.listCollections(me.ctx)).rejects.toMatchObject({ code: 'account_required' });
        await expect(recordPreference(me.ctx, { action: 'save', target_type: 'discovery_item', target_id: me.itemId })).rejects.toMatchObject({
          code: 'account_required',
        });
      }
      const taste = await getTaste(me.ctx, {});
      expect(taste.hidden_count).toBe(1);
      const feed = await getDiscoveries(me.ctx, { limit: 24, refresh: true });
      const foreign = new Set(tenants.filter((t) => t !== me).flatMap((t) => [t.itemId, t.captureItemId]));
      expect(feed.items.some((c) => foreign.has(c.id))).toBe(false);
    }

    // Preference records stay with their owner.
    const events = await db.query<{ owner_account_id: string | null; owner_session_id: string | null; n: number }>(
      `SELECT owner_account_id, owner_session_id, count(*)::int AS n FROM preference_events
        WHERE owner_account_id = ANY($1::uuid[]) OR owner_session_id = ANY($2::uuid[])
        GROUP BY 1, 2`,
      [
        tenants.flatMap((t) => (t.principal.kind === 'account' ? [t.principal.accountId] : [])),
        tenants.flatMap((t) => (t.principal.kind === 'anonymous' ? [t.principal.sessionId] : [])),
      ],
    );
    expect(events.rows).toHaveLength(4);
  });
});

async function artistOf(t: Tenant): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT si.discovery_item_id AS id FROM saved_items si JOIN discovery_items di ON di.id = si.discovery_item_id
      WHERE si.owner_account_id = $1 AND di.kind = 'artist'`,
    [t.principal.kind === 'account' ? t.principal.accountId : null],
  );
  return rows.map((r) => r.id);
}
