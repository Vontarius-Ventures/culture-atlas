import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { SAMPLE_ITEMS } from '../feed/samples';
import { accountCtx, anonCtx, ctxFor, insertCaptureWithAnalysis, insertItem, saveDirect } from '../test-support/library';
import { closeTestDb, getTestDb, insertAgentConnection } from '../testing';
import { FEED_TOP_UP_MIN, getDiscoveries, interleaveFeed, longestCategoryRun, weaveRecentIntoFront } from './discovery';
import { getItem, startRelatedDiscovery } from './items';
import { recordPreference } from './preferences';

const db = getTestDb();
afterAll(closeTestDb);

const cand = (id: string, category: string | null, key = id) => ({ id, canonical_key: key, category });

describe('interleaveFeed (pure)', () => {
  it('interleaves categories, dedupes canonical items and drops hidden keys', () => {
    const out = interleaveFeed(
      [cand('w1', 'watch'), cand('w2', 'watch'), cand('w3', 'watch'), cand('p1', 'play'), cand('dup', 'play', 'w1'), cand('e1', 'eat'), cand('h', 'eat')],
      new Set(['h']),
    );
    expect(out.map((c) => c.id)).toEqual(['w1', 'p1', 'e1', 'w2', 'w3']);
  });

  it('never puts more than two of one category in a row while alternatives exist', () => {
    const many = [
      ...Array.from({ length: 8 }, (_, i) => cand(`w${i}`, 'watch')),
      ...Array.from({ length: 3 }, (_, i) => cand(`p${i}`, 'play')),
      ...Array.from({ length: 3 }, (_, i) => cand(`e${i}`, 'eat')),
    ];
    const out = interleaveFeed(many, new Set());
    const withAlternatives = out.slice(0, out.findIndex((c, idx) => out.slice(idx).every((x) => x.category === 'watch')));
    expect(longestCategoryRun(withAlternatives)).toBeLessThanOrEqual(2);
    expect(out).toHaveLength(14);
  });

  it('keeps priority order within each category', () => {
    const out = interleaveFeed([cand('a', 'wear'), cand('b', 'play'), cand('c', 'wear'), cand('d', 'play')], new Set());
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('weaveRecentIntoFront (pure)', () => {
  it('places newest cards every third slot so expand results reach the first page', () => {
    const fused = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));
    expect(weaveRecentIntoFront(fused, ['f', 'e']).map((x) => x.id)).toEqual(['a', 'b', 'f', 'c', 'd', 'e']);
  });

  it('leaves the fused order alone when nothing recent matches', () => {
    const fused = [{ id: 'a' }, { id: 'b' }];
    expect(weaveRecentIntoFront(fused, ['missing'])).toEqual(fused);
    expect(weaveRecentIntoFront(fused, [])).toEqual(fused);
  });
});

describe('discovery feed', () => {
  it('serves reviewed samples to new users, labeled as examples, with a stable cursor', async () => {
    const { ctx, principal } = await anonCtx();
    const page1 = await getDiscoveries(ctx, { limit: 6, refresh: false });
    expect(page1.is_example_feed).toBe(true);
    expect(page1.items).toHaveLength(6);
    expect(page1.items.every((c) => c.is_example)).toBe(true);
    expect(page1.available_categories).toEqual(['wear', 'play', 'watch', 'eat']);
    expect(longestCategoryRun(page1.items)).toBeLessThanOrEqual(2);

    const jobsBefore = await db.query('SELECT count(*)::int AS n FROM jobs WHERE owner_session_id = $1', [principal.sessionId]);
    const page2 = await getDiscoveries(ctx, { limit: 6, cursor: page1.next_cursor!, refresh: false });
    const again = await getDiscoveries(ctx, { limit: 6, cursor: page1.next_cursor!, refresh: false });
    expect(page2.items.map((c) => c.id)).toEqual(again.items.map((c) => c.id));
    expect(page2.feed_id).toBe(page1.feed_id);
    expect(new Set([...page1.items, ...page2.items].map((c) => c.id)).size).toBe(12);
    // Load more consumes the snapshot; it never starts generation.
    const jobsAfter = await db.query('SELECT count(*)::int AS n FROM jobs WHERE owner_session_id = $1', [principal.sessionId]);
    expect(jobsAfter.rows[0]!.n).toBe(jobsBefore.rows[0]!.n);

    let cursor = page2.next_cursor;
    let total = 12;
    while (cursor) {
      const p = await getDiscoveries(ctx, { limit: 6, cursor, refresh: false });
      total += p.items.length;
      cursor = p.next_cursor;
    }
    expect(total).toBe(SAMPLE_ITEMS.length);
  });

  it('filters by category and suppresses hidden items immediately, even inside a snapshot', async () => {
    const { ctx } = await anonCtx();
    const watch = await getDiscoveries(ctx, { category: 'watch', refresh: false });
    expect(watch.items.length).toBeGreaterThan(0);
    expect(watch.items.every((c) => c.category === 'watch')).toBe(true);
    const all = await getDiscoveries(ctx, { limit: 6, refresh: false });
    const peek = await getDiscoveries(ctx, { limit: 6, cursor: all.next_cursor!, refresh: false });
    const victim = peek.items[0]!;
    const hide = await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: victim.id });
    expect(hide.undo).toEqual({ action: 'unhide', target_type: 'discovery_item', target_id: victim.id });
    // The existing cursor keeps working (stable pagination) but the hidden item is gone.
    const page2 = await getDiscoveries(ctx, { limit: 6, cursor: all.next_cursor!, refresh: false });
    expect(page2.items.map((c) => c.id)).not.toContain(victim.id);
    expect(page2.items.map((c) => c.id)).toEqual(peek.items.slice(1).map((c) => c.id).concat(page2.items.slice(5).map((c) => c.id)));
    const reloaded = await getDiscoveries(ctx, { limit: 24, refresh: true });
    expect(reloaded.items.map((c) => c.id)).not.toContain(victim.id);
    await recordPreference(ctx, { action: 'unhide', target_type: 'discovery_item', target_id: victim.id });
    expect((await getDiscoveries(ctx, { limit: 24, refresh: true })).items.map((c) => c.id)).toContain(victim.id);
    await expect(getDiscoveries(ctx, { limit: 6, cursor: 'not-a-cursor', refresh: false })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('prefers the owner’s pictured Eat venues over their cuisine tags, never lets sample pictures evict real results, and still tops up', async () => {
    const pictured = (id: string) =>
      db.query(`UPDATE discovery_items SET display_metadata = display_metadata || $2::jsonb WHERE id = $1`, [
        id,
        JSON.stringify({ image: { url: 'https://images.example.test/fixture-venue.jpg', alt: 'Fixture venue' } }),
      ]);
    // Only cuisine tags (no pictures): kept, even though reviewed samples topping up the grid are pictured.
    const tagsOnly = await accountCtx();
    const tagOwner = { accountId: tagsOnly.principal.accountId };
    const tag = await insertItem(tagOwner, { kind: 'food', title: 'Fixture Sichuanese' });
    const film = await insertItem(tagOwner, { kind: 'film' });
    const tagCap = await insertCaptureWithAnalysis(tagOwner, { recommendItemIds: [tag, film] });
    await recordPreference(tagsOnly.ctx, { action: 'save', target_type: 'capture', target_id: tagCap.captureId });
    const tagFeed = await getDiscoveries(tagsOnly.ctx, { limit: 24, refresh: true });
    expect(tagFeed.items.map((c) => c.id)).toEqual(expect.arrayContaining([tag, film]));
    expect(tagFeed.items).toHaveLength(FEED_TOP_UP_MIN);

    // A pictured venue for this owner: their image-less cuisine tag gives way, samples still top up the grid.
    const withVenue = await accountCtx();
    const venueOwner = { accountId: withVenue.principal.accountId };
    const venue = await insertItem(venueOwner, { kind: 'food', title: 'Fixture Dim Sum Hall' });
    await pictured(venue);
    const cuisine = await insertItem(venueOwner, { kind: 'food', title: 'Fixture Teahouse' });
    const venueCap = await insertCaptureWithAnalysis(venueOwner, { recommendItemIds: [venue, cuisine] });
    await recordPreference(withVenue.ctx, { action: 'save', target_type: 'capture', target_id: venueCap.captureId });
    const venueFeed = await getDiscoveries(withVenue.ctx, { limit: 24, refresh: true });
    const ids = venueFeed.items.map((c) => c.id);
    expect(ids).toContain(venue);
    expect(ids).not.toContain(cuisine);
    expect(venueFeed.items.filter((c) => !c.is_example).map((c) => c.id)).toEqual([venue]);
    expect(venueFeed.items).toHaveLength(FEED_TOP_UP_MIN);
  });

  it('returning users get a bounded pool connected to their saves, owner-scoped', async () => {
    const { principal, ctx } = await accountCtx();
    const owner = { accountId: principal.accountId };
    const recs = [
      await insertItem(owner, { kind: 'film' }),
      await insertItem(owner, { kind: 'film' }),
      await insertItem(owner, { kind: 'film' }),
      await insertItem(owner, { kind: 'artist' }),
      await insertItem(owner, { kind: 'food' }),
    ];
    const cap = await insertCaptureWithAnalysis(owner, { recommendItemIds: recs });
    // Unrelated capture whose results were never endorsed stays out of the feed.
    const other = await insertItem(owner, { kind: 'brand' });
    await insertCaptureWithAnalysis(owner, { recommendItemIds: [other] });
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });

    // Another user's private items never leak in.
    const { principal: stranger } = await accountCtx();
    const theirs = await insertItem({ accountId: stranger.accountId }, { kind: 'film' });
    const theirCap = await insertCaptureWithAnalysis({ accountId: stranger.accountId }, { recommendItemIds: [theirs] });
    await saveDirect(stranger.accountId, theirCap.itemId);

    const feed = await getDiscoveries(ctx, { limit: 24, refresh: true });
    expect(feed.is_example_feed).toBe(false);
    const connected = feed.items.filter((c) => !c.is_example);
    expect(connected.map((c) => c.id).sort()).toEqual([...recs].sort());
    expect(connected.every((c) => c.recommendation_id)).toBe(true);
    // Few connected results: reviewed samples (labeled examples) fill the grid.
    const topUp = feed.items.filter((c) => c.is_example);
    expect(topUp.length).toBe(FEED_TOP_UP_MIN - recs.length);
    expect(topUp.every((c) => c.recommendation_id === null)).toBe(true);
    expect(feed.items.findIndex((c) => c.id === recs[0])).toBe(0);
    expect(longestCategoryRun(feed.items)).toBeLessThanOrEqual(2);
    expect(feed.available_categories).toEqual(['wear', 'play', 'watch', 'eat']);
    expect(feed.feed_revision).toBeGreaterThan(0);
  });

  it('does not put related-discovery results on the home feed', async () => {
    const { principal, ctx } = await accountCtx();
    const owner = { accountId: principal.accountId };
    const film = await insertItem(owner, { kind: 'film', title: 'Playtime' });
    const junk = await insertItem(owner, { kind: 'brand', title: 'Tesla' });
    const cap = await insertCaptureWithAnalysis(owner, { recommendItemIds: [film] });
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
    await saveDirect(principal.accountId, film);
    const job = await db.query<{ id: string }>(
      `INSERT INTO discovery_jobs (owner_account_id, origin_item_id) VALUES ($1, $2) RETURNING id`,
      [principal.accountId, film],
    );
    await db.query(
      `INSERT INTO recommendations (discovery_item_id, discovery_job_id, rank, title, origin, category)
       VALUES ($1, $2, 1, 'Tesla', 'vlm_creative', 'wear')`,
      [junk, job.rows[0]!.id],
    );
    const feed = await getDiscoveries(ctx, { limit: 24, refresh: true });
    expect(feed.items.map((c) => c.id)).toContain(film);
    expect(feed.items.map((c) => c.id)).not.toContain(junk);
  });

  it('selected-collection agents cannot read the global feed', async () => {
    const { principal } = await accountCtx();
    const { principal: agent } = await insertAgentConnection(principal, { scopes: ['taste:read'], libraryAccess: 'selected_collections', collectionIds: [] });
    await expect(getDiscoveries(ctxFor(agent), { refresh: false })).rejects.toMatchObject({ code: 'scope_denied' });
  });
});

describe('items', () => {
  it('opens a sample item with cached related samples and never generates', async () => {
    const { ctx, principal } = await anonCtx();
    const feed = await getDiscoveries(ctx, { limit: 1, refresh: false });
    const before = await db.query('SELECT count(*)::int AS n FROM jobs WHERE owner_session_id = $1', [principal.sessionId]);
    const detail = await getItem(ctx, { id: feed.items[0]!.id, query: {} });
    expect(detail.item.is_example).toBe(true);
    expect(detail.related.length).toBeGreaterThan(0);
    expect(detail.related.length).toBeLessThanOrEqual(6);
    expect(detail.related.every((r) => r.category !== detail.item.category)).toBe(true);
    expect(detail.related_state).toBe('cached');
    expect(detail.destination_url).toMatch(/^https:\/\/en\.wikipedia\.org\//);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs WHERE owner_session_id = $1', [principal.sessionId])).rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('returns owned items with the recommendation reason; other owners get 404', async () => {
    const { principal, ctx } = await accountCtx();
    const film = await insertItem({ accountId: principal.accountId }, { kind: 'film', title: 'In the Mood for Love' });
    await insertCaptureWithAnalysis({ accountId: principal.accountId }, { recommendItemIds: [film] });
    const detail = await getItem(ctx, { id: film, query: {} });
    expect(detail.reason).toBe('Inspired by your photo.');
    expect(detail.why_this?.text).toBe('Inspired by your photo.');
    const { ctx: other } = await accountCtx();
    await expect(getItem(other, { id: film, query: {} })).rejects.toMatchObject({ code: 'not_found' });
    await expect(getItem(other, { id: randomUUID(), query: {} })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('"Discover more" starts one bounded job and reuses it for the same input', async () => {
    const { principal, ctx } = await accountCtx();
    const film = await insertItem({ accountId: principal.accountId }, { kind: 'film', title: 'Playtime' });
    const a = await startRelatedDiscovery(ctx, { id: film, body: {} });
    const b = await startRelatedDiscovery(ctx, { id: film, body: {} });
    expect(a.reused).toBe(false);
    expect(b).toEqual({ ...a, reused: true });
    const detail = await getItem(ctx, { id: film, query: {} });
    expect(detail.related_state).toBe('pending');
    expect(detail.related_job_id).toBe(a.job_id);
    // Photos still analyzing have no anchors to explore.
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await expect(startRelatedDiscovery(ctx, { id: cap.itemId, body: {} })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
