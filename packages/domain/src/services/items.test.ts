import { randomUUID } from 'node:crypto';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { ProviderError, type QlooEntity } from '@culture-atlas/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { accountCtx, ctxFor, insertItem, runJob } from '../test-support/library';
import { closeTestDb, getTestDb, insertAgentConnection, testProviders } from '../testing';
import { addCollectionItem, createCollection, getCollection, listCollections, removeCollectionItem } from './collections';
import { getJob } from './jobs';
import { getItem, startRelatedDiscovery } from './items';
import { listSaved, recordPreference } from './preferences';

const db = getTestDb();
afterAll(closeTestDb);

const e = (id: string, name: string): QlooEntity => ({ entity_id: id, name, types: [], properties: {}, tags: [] });

function qloo(prefix: string, opts: { failArtists?: boolean; replay?: boolean } = {}) {
  return new FakeQloo(
    {
      insights: (req) => {
        if (req.filterType === 'urn:entity:artist' && opts.failArtists) return new ProviderError('qloo', 'server', 'down');
        const kind = req.filterType.split(':').pop();
        return { entities: Array.from({ length: 4 }, (_, i) => e(`${prefix}-${kind}-${i}`, `${kind} ${prefix} ${i}`)), tags: [] };
      },
    },
    { live: !opts.replay },
  );
}

describe('related discovery job', () => {
  it('stores Qloo-traceable results across categories and serves them from cache', async () => {
    const { principal, ctx } = await accountCtx();
    const prefix = randomUUID().slice(0, 6);
    const film = await insertItem({ accountId: principal.accountId }, { kind: 'film', title: 'Playtime', qloo: `${prefix}-origin` });
    const providers = testProviders({ qloo: qloo(prefix, { failArtists: true }) });
    const started = await startRelatedDiscovery(ctx, { id: film, body: {} });
    expect((await runJob(started.job_id, { providers, config: undefined })).state).toBe('partial');
    const job = await getJob(ctx, { id: started.job_id });
    expect(job.result).toEqual({ type: 'discovery_job', id: started.discovery_job_id });

    const detail = await getItem(ctx, { id: film, query: {} });
    expect(detail.related_state).toBe('cached');
    expect(detail.related.length).toBe(8);
    expect(new Set(detail.related.map((r) => r.category))).toEqual(new Set(['watch', 'wear']));
    expect(detail.related.every((r) => !r.is_example)).toBe(true);
    const recs = await db.query<{ origin: string; provider_query_ids: string[] }>(
      'SELECT origin, provider_query_ids FROM recommendations WHERE discovery_job_id = $1',
      [started.discovery_job_id],
    );
    expect(recs.rows.every((r) => r.origin === 'qloo' && r.provider_query_ids.length === 1)).toBe(true);
    const failed = await db.query(`SELECT 1 FROM provider_queries WHERE discovery_job_id = $1 AND status = 'error'`, [started.discovery_job_id]);
    expect(failed.rowCount).toBeGreaterThan(0);

    // Hidden results disappear from the cached set immediately.
    await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: detail.related[0]!.id });
    expect((await getItem(ctx, { id: film, query: {} })).related.map((r) => r.id)).not.toContain(detail.related[0]!.id);
  });

  it('with Qloo unavailable, finishes partial with nothing fabricated', async () => {
    const { principal, ctx } = await accountCtx();
    const film = await insertItem({ accountId: principal.accountId }, { kind: 'film', qloo: `x-${randomUUID()}` });
    const started = await startRelatedDiscovery(ctx, { id: film, body: { category: 'watch' } });
    expect((await runJob(started.job_id)).state).toBe('partial');
    const recs = await db.query('SELECT 1 FROM recommendations WHERE discovery_job_id = $1', [started.discovery_job_id]);
    expect(recs.rowCount).toBe(0);
    expect((await getItem(ctx, { id: film, query: {} })).related_state).toBe('none');
  });

  it('agent related discoveries stay tied to their granted origin', async () => {
    const { principal, ctx } = await accountCtx();
    const prefix = randomUUID().slice(0, 6);
    const film = await insertItem({ accountId: principal.accountId }, { kind: 'film', qloo: `${prefix}-o` });
    const col = await createCollection(ctx, { name: 'Shared' });
    await addCollectionItem(ctx, { id: col.id, item_id: film, body: {} });
    const { principal: agent } = await insertAgentConnection(principal, {
      scopes: ['collections:read'],
      libraryAccess: 'selected_collections',
      collectionIds: [col.id],
    });
    const actx = ctxFor(agent);
    await expect(startRelatedDiscovery(actx, { id: film, body: {} })).rejects.toMatchObject({ code: 'invalid_input' });
    const started = await startRelatedDiscovery(actx, { id: film, body: { collection_id: col.id, category: 'watch' } });
    await runJob(started.job_id, { providers: testProviders({ qloo: qloo(prefix) }) });
    const detail = await getItem(actx, { id: film, query: { collection_id: col.id } });
    expect(detail.related.length).toBe(4);
    const relatedId = detail.related[0]!.id;
    expect((await getItem(actx, { id: relatedId, query: {} })).item.id).toBe(relatedId);

    // Removing the origin from the granted collection removes access immediately.
    await removeCollectionItem(ctx, { id: col.id, item_id: film });
    await expect(getItem(actx, { id: relatedId, query: {} })).rejects.toMatchObject({ code: 'not_found' });
    await expect(getItem(actx, { id: film, query: {} })).rejects.toMatchObject({ code: 'not_found' });
    await expect(getJob(actx, { id: started.job_id })).rejects.toMatchObject({ code: 'not_found' });
    // The owner still sees everything.
    expect((await getItem(ctx, { id: relatedId, query: {} })).item.id).toBe(relatedId);
  });

  it('replayed results stay labeled "Example result" wherever they show up later', async () => {
    const { principal, ctx } = await accountCtx();
    const prefix = randomUUID().slice(0, 6);
    const film = await insertItem({ accountId: principal.accountId }, { kind: 'film', title: 'Playtime', qloo: `${prefix}-origin` });
    const started = await startRelatedDiscovery(ctx, { id: film, body: { category: 'watch' } });
    await runJob(started.job_id, { providers: testProviders({ qloo: qloo(prefix, { replay: true }) }) });

    const detail = await getItem(ctx, { id: film, query: {} });
    expect(detail.related.length).toBeGreaterThan(0);
    expect(detail.related.every((r) => r.is_example)).toBe(true);
    const replayed = detail.related[0]!;
    // Opened on its own (no recommendation context) it is still an example.
    expect((await getItem(ctx, { id: replayed.id, query: {} })).item.is_example).toBe(true);

    // Saved into a collection: the collection, its cover source and the saved list keep the label.
    const col = await createCollection(ctx, { name: 'Replays' });
    await addCollectionItem(ctx, { id: col.id, item_id: replayed.id, body: {} });
    const inCollection = await getCollection(ctx, { id: col.id, query: {} });
    expect(inCollection.items.find((m) => m.item.id === replayed.id)?.item.is_example).toBe(true);
    expect((await listCollections(ctx)).collections.some((c) => c.id === col.id)).toBe(true);
    const saved = await listSaved(ctx, { filter: 'all' });
    expect(saved.items.find((e) => e.item.id === replayed.id)?.item.is_example).toBe(true);

    // The original item and live results are not labeled.
    expect(detail.item.is_example).toBe(false);
    const live = await startRelatedDiscovery(ctx, { id: film, body: {} });
    await runJob(live.job_id, { providers: testProviders({ qloo: qloo(prefix) }) });
    const after = await getItem(ctx, { id: replayed.id, query: {} });
    expect(after.item.is_example).toBe(false);
  });

  it('holds Similar with interest-pool cards until the search for this card has run', async () => {
    const { principal, ctx } = await accountCtx();
    const owner = { accountId: principal.accountId };
    const film = await insertItem(owner, { kind: 'film', title: 'Playtime' });
    const similar = await insertItem(owner, { kind: 'film', title: 'Playtime adjacent' });
    await db.query(
      `UPDATE discovery_items
          SET display_metadata = display_metadata || '{"image":{"url":"https://images.example/cover.jpg","alt":"cover"}}'::jsonb
        WHERE id = $1`,
      [similar],
    );
    const run = await db.query<{ id: string }>(
      `INSERT INTO taste_seed_runs (owner_account_id, taste_revision, state)
       VALUES ($1, 1, 'complete') RETURNING id`,
      [principal.accountId],
    );
    await db.query(
      `INSERT INTO recommendations (discovery_item_id, taste_seed_run_id, rank, title, origin, category)
       VALUES ($1, $2, 1, 'Playtime adjacent', 'catalog', 'watch')`,
      [similar, run.rows[0]!.id],
    );
    const detail = await getItem(ctx, { id: film, query: {} });
    // Pool cards hold the rail, but 'none' still tells the client to run the real search.
    expect(detail.related_state).toBe('none');
    expect(detail.related.map((r) => r.id)).toContain(similar);
    expect(detail.related.every((r) => r.id !== film)).toBe(true);
  });
});
