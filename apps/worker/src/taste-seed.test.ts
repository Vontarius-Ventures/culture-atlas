import { afterEach, describe, expect, it } from 'vitest';
import {
  discovery,
  items,
  JOB_HANDLERS,
  tasteSeed,
  traces,
  type DomainConfig,
  type ServiceContext,
} from '@culture-atlas/domain';
import { getTestDb, insertAccount, testConfig, testContext, testProviders } from '@culture-atlas/domain/testing';
import { CircuitBreaker, QlooHttpProvider, type ProviderRegistry } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { Worker } from './worker';

/**
 * Taste seed job (spec amendment 2.2, package B) against the real Worker and
 * the real Qloo HTTP adapter with a scripted fetch, so every HTTP request is
 * counted (ONB-04: at most 6 requests, at most 3 in flight) and outages are
 * real 429s and timeouts (ONB-03: retry, no fabricated cards).
 */

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'timeout';

const ent = (id: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({ entity_id: id, name, types: [type], ...extra });
const ok = (results: unknown): Reply => ({ status: 200, body: { success: true, results } });

const PICK_TAGS = [
  { id: 'urn:tag:decor:qloo:fixture_japandi', name: 'Fixture Japandi' },
  { id: 'urn:tag:genre:media:fixture_film_noir', name: 'Fixture Film Noir' },
];
const PICK_ARTIST = { id: 'FIXTURE-ARTIST-PICK', name: 'Fixture Pick Artist' };

const RESULTS: Record<string, Reply> = {
  'urn:entity:brand': ok({
    entities: [
      ent('FIXTURE-BRAND-0001', 'Fixture Linen House', 'urn:entity:brand', { properties: { short_description: 'Fixture description.' } }),
      ent('FIXTURE-BRAND-0002', 'Fixture Hidden Brand', 'urn:entity:brand'),
      ent('FIXTURE-BRAND-0003', 'Fixture Oak Studio', 'urn:entity:brand'),
    ],
  }),
  'urn:entity:artist': ok({
    entities: [
      ent(PICK_ARTIST.id, PICK_ARTIST.name, 'urn:entity:artist'),
      ent('FIXTURE-ARTIST-0001', 'Fixture Night Trio', 'urn:entity:artist', { query: { affinity: 0.9, explainability: [{ entity_id: PICK_ARTIST.id, score: 0.7 }] } }),
      ent('FIXTURE-ARTIST-0002', 'Fixture Quiet Choir', 'urn:entity:artist'),
    ],
  }),
  'urn:entity:movie': ok({
    entities: [
      ent('FIXTURE-MOVIE-0001', 'Fixture Rain City', 'urn:entity:movie', { properties: { release_year: 1949 } }),
      ent('FIXTURE-MOVIE-0002', 'Fixture Long Shadow', 'urn:entity:movie', { properties: { release_year: 1955 } }),
    ],
  }),
  'urn:tag': ok({
    tags: [
      { id: 'urn:tag:cuisine:qloo:fixture_sichuanese', name: 'Fixture Sichuanese', type: 'urn:tag:cuisine:qloo' },
      { id: 'urn:tag:cuisine:qloo:fixture_shellfish_shack', name: 'Shellfish Shack', type: 'urn:tag:cuisine:qloo' },
      { id: 'urn:tag:genre:place:fixture_not_cuisine', name: 'Fixture Not A Cuisine', type: 'urn:tag:genre:place' },
      { id: 'urn:tag:cuisine:qloo:fixture_teahouse', name: 'Fixture Teahouse', type: 'urn:tag:cuisine:qloo' },
    ],
  }),
};

/** Real Qloo HTTP adapter over a scripted fetch that counts requests and concurrency. */
function scriptedQloo(reply: (filterType: string, url: URL) => Reply | Promise<Reply>, timeoutMs = 150, breaker?: CircuitBreaker) {
  const calls: URL[] = [];
  let inflight = 0;
  const state = { peak: 0 };
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    inflight++;
    state.peak = Math.max(state.peak, inflight);
    try {
      await new Promise((r) => setTimeout(r, 20)); // let concurrent requests overlap
      const r = await reply(url.searchParams.get('filter.type') ?? '', url);
      if (r === 'timeout') {
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: r.headers });
    } finally {
      inflight--;
    }
  }) as typeof fetch;
  const qloo = new QlooHttpProvider({
    apiKey: 'test-key-not-real',
    baseUrl: 'https://qloo.example.test',
    timeoutMs,
    fetch: impl,
    breaker: breaker ?? new CircuitBreaker({ failureThreshold: 10_000, cooldownMs: 1 }),
  });
  return { providers: testProviders({ qloo }), calls, state };
}

async function insertPick(accountId: string, input: { kind: string; category: string | null; title: string; qloo: string }) {
  const db = getTestDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title, external_ids)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    // Stored like real onboarding picks (onboarding/catalog.ts itemForRef): tags under qloo_tag, entities under qloo.
    [accountId, input.kind, input.category, `qloo:${input.qloo}`, input.title,
      JSON.stringify(input.qloo.startsWith('urn:tag:') ? { qloo_tag: input.qloo } : { qloo: input.qloo })],
  );
  await db.query('INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)', [accountId, rows[0]!.id]);
}

/** A new account that finished onboarding with three picks (two tags, one entity). */
async function onboardedAccount(options: { exclusions?: string[]; hide?: string[]; isDemoOwner?: boolean } = {}) {
  const db = getTestDb();
  const principal = await insertAccount(db, { isDemoOwner: options.isDemoOwner ?? false });
  const accountId = principal.accountId;
  await insertPick(accountId, { kind: 'style', category: 'wear', title: PICK_TAGS[0]!.name, qloo: PICK_TAGS[0]!.id });
  await insertPick(accountId, { kind: 'style', category: 'watch', title: PICK_TAGS[1]!.name, qloo: PICK_TAGS[1]!.id });
  await insertPick(accountId, { kind: 'artist', category: 'play', title: PICK_ARTIST.name, qloo: PICK_ARTIST.id });
  if (options.exclusions) {
    await db.query('UPDATE accounts SET preferences = preferences || $2::jsonb WHERE id = $1', [accountId, JSON.stringify({ food: { exclusions: options.exclusions } })]);
  }
  for (const key of options.hide ?? []) {
    await db.query('INSERT INTO item_exclusions (owner_account_id, canonical_key) VALUES ($1, $2)', [accountId, key]);
  }
  return principal;
}

async function enqueue(accountId: string, config: DomainConfig = testConfig()) {
  const out = await tasteSeed.enqueueTasteSeed(getTestDb(), { accountId, tasteRevision: 1, catalogVersion: 'fixture.1', config });
  expect(out.enqueued).toBe(true);
  return out.status.job_id!;
}

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
});

function worker(providers: ProviderRegistry, jobId: string, config: DomainConfig = testConfig()) {
  const w = new Worker({ db: getTestDb(), providers, config, handlers: JOB_HANDLERS, jobIds: [jobId], log: () => undefined, heartbeatMs: 1_000 });
  workers.push(w);
  return w;
}

/** Runs one attempt now (makes a backed-off retry available first). */
async function runAttempt(providers: ProviderRegistry, jobId: string, config?: DomainConfig) {
  await getTestDb().query(`UPDATE jobs SET available_at = now() WHERE id = $1 AND state = 'queued'`, [jobId]);
  await worker(providers, jobId, config).drain();
}

async function job(jobId: string) {
  const { rows } = await getTestDb().query<{ state: string; attempt: number; error_code: string | null; error_retryable: boolean | null }>(
    'SELECT state, attempt, error_code, error_retryable FROM jobs WHERE id = $1',
    [jobId],
  );
  return rows[0]!;
}

async function seededRecs(accountId: string) {
  const { rows } = await getTestDb().query<{
    title: string;
    category: string;
    origin: string;
    provider_query_ids: string[];
    external_ids: { qloo?: string };
    display_reason: string;
    canonical_key: string;
  }>(
    `SELECT r.title, r.category, r.origin, r.provider_query_ids, r.external_ids, r.display_reason, di.canonical_key
       FROM recommendations r JOIN taste_seed_runs tr ON tr.id = r.taste_seed_run_id
       JOIN discovery_items di ON di.id = r.discovery_item_id
      WHERE tr.owner_account_id = $1 ORDER BY r.category, r.rank`,
    [accountId],
  );
  return rows;
}

async function wholeFeed(ctx: ServiceContext) {
  const first = await discovery.getDiscoveries(ctx, { limit: 24, refresh: false });
  const items = [...first.items];
  let cursor = first.next_cursor;
  while (cursor) {
    const page = await discovery.getDiscoveries(ctx, { limit: 24, cursor, refresh: false });
    items.push(...page.items);
    cursor = page.next_cursor;
  }
  return { ...first, items };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - started > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('taste seed job', () => {
  it('seeds every category from the picks with at most 6 requests, 3 in flight, publishing progressively (ONB-04)', async () => {
    const principal = await onboardedAccount({ exclusions: ['shellfish'], hide: ['qloo:FIXTURE-BRAND-0002'] });
    const { accountId } = principal;
    let releaseEat!: () => void;
    const eatGate = new Promise<void>((r) => (releaseEat = r));
    const q = scriptedQloo(async (type) => {
      if (type === 'urn:tag') await eatGate;
      return RESULTS[type] ?? { status: 400 };
    });
    const ctx = testContext(principal, { providers: q.providers });
    const jobId = await enqueue(accountId);

    // Before the job runs, the feed is the labeled example feed.
    expect((await discovery.getDiscoveries(ctx, { limit: 12, refresh: false })).is_example_feed).toBe(true);

    const draining = worker(q.providers, jobId).drain();
    // The first categories publish while Eat is still being fetched.
    const mid = await until(
      () => tasteSeed.getTasteSeedStatus(getTestDb(), accountId),
      (s) => s.categories.filter((c) => c.state === 'ready').length === 3,
    );
    expect(mid.state).toBe('running');
    expect(mid.first_ready_at).not.toBeNull();
    expect(mid.categories.find((c) => c.category === 'eat')!.state).toBe('pending');
    const early = await wholeFeed(ctx);
    expect(early.is_example_feed).toBe(false);
    expect(early.items.map((i) => i.title)).toContain('Fixture Linen House');
    releaseEat();
    await draining;

    expect(await job(jobId)).toMatchObject({ state: 'complete', attempt: 1 });
    const status = await tasteSeed.getTasteSeedStatus(getTestDb(), accountId);
    expect(status.state).toBe('complete');
    expect(status.poll_after_ms).toBeNull();
    expect(Object.fromEntries(status.categories.map((c) => [c.category, [c.state, c.card_count]]))).toEqual({
      wear: ['ready', 2],
      play: ['ready', 2],
      watch: ['ready', 2],
      eat: ['ready', 2],
    });

    // ONB-04 request caps, counted at the HTTP level (adapter retries disabled).
    expect(q.calls.length).toBe(4);
    expect(q.calls.length).toBeLessThanOrEqual(6);
    expect(q.state.peak).toBeLessThanOrEqual(3);
    for (const url of q.calls) {
      expect(url.pathname).toBe('/v2/insights');
      expect(url.searchParams.get('signal.interests.tags')!.split(',').sort()).toEqual(PICK_TAGS.map((t) => t.id).sort());
      expect(url.searchParams.get('signal.interests.entities')).toBe(PICK_ARTIST.id);
    }
    const eatCall = q.calls.find((u) => u.searchParams.get('filter.type') === 'urn:tag')!;
    expect(eatCall.searchParams.get('filter.tag.types')).toBe('urn:tag:cuisine:qloo');

    // Every seeded card is a real returned Qloo result that cites its query.
    const recs = await seededRecs(accountId);
    expect(recs.map((r) => r.title).sort()).toEqual(
      ['Fixture Linen House', 'Fixture Oak Studio', 'Fixture Night Trio', 'Fixture Quiet Choir', 'Fixture Rain City', 'Fixture Long Shadow', 'Fixture Sichuanese', 'Fixture Teahouse'].sort(),
    );
    const { rows: queries } = await getTestDb().query<{ id: string; status: string; is_replay: boolean }>(
      `SELECT pq.id, pq.status, pq.is_replay FROM provider_queries pq JOIN taste_seed_runs tr ON tr.id = pq.taste_seed_run_id WHERE tr.owner_account_id = $1`,
      [accountId],
    );
    const queryIds = new Set(queries.map((x) => x.id));
    for (const r of recs) {
      expect(r.origin).toBe('qloo');
      expect(r.provider_query_ids.length).toBe(1);
      expect(queryIds.has(r.provider_query_ids[0]!)).toBe(true);
      expect(r.canonical_key).toBe(`qloo:${r.external_ids.qloo}`);
    }
    expect(queries.every((x) => x.status === 'ok' && !x.is_replay)).toBe(true);
    // Picks, hidden items, excluded food and non-cuisine tags never come back.
    const titles = recs.map((r) => r.title);
    expect(titles).not.toContain(PICK_ARTIST.name);
    expect(titles).not.toContain('Fixture Hidden Brand');
    expect(titles).not.toContain('Shellfish Shack');
    expect(titles).not.toContain('Fixture Not A Cuisine');
    expect(recs.find((r) => r.title === 'Fixture Night Trio')!.display_reason).toBe(`Because you picked ${PICK_ARTIST.name}.`);
    expect(recs.find((r) => r.title === 'Fixture Oak Studio')!.display_reason).toMatch(/^From your picks: /);

    // The personal feed follows the usual rules and labels nothing seeded as an example.
    const feed = await wholeFeed(ctx);
    expect(feed.is_example_feed).toBe(false);
    const seeded = feed.items.filter((i) => titles.includes(i.title));
    expect(seeded.length).toBe(8);
    expect(seeded.every((i) => !i.is_example)).toBe(true);
    expect(feed.items.filter((i) => !titles.includes(i.title)).every((i) => i.is_example)).toBe(true);
    expect(discovery.longestCategoryRun(feed.items.slice(0, 8))).toBeLessThanOrEqual(2);
  });

  it('with Qloo throttled, stays within the per-job cap of 6 across attempts, invents nothing and retries until Qloo is back (ONB-03, ONB-04)', async () => {
    const principal = await onboardedAccount();
    const { accountId } = principal;
    let healthy = false;
    const q = scriptedQloo((type) => (healthy ? RESULTS[type]! : { status: 429, body: { error: { code: 'rate_limited' } } }));
    const ctx = testContext(principal, { providers: q.providers });
    const jobId = await enqueue(accountId);

    await runAttempt(q.providers, jobId);
    // The first wave (3 in flight) meets the throttle; the fourth category is not asked, no inline retries.
    expect(q.calls.length).toBe(3);
    expect(q.state.peak).toBeLessThanOrEqual(3);
    expect(await job(jobId)).toMatchObject({ state: 'queued', attempt: 1, error_code: 'rate_limited', error_retryable: true });
    const waiting = await tasteSeed.getTasteSeedStatus(getTestDb(), accountId);
    expect(waiting.state).toBe('retrying');
    expect(waiting.poll_after_ms).toBeGreaterThan(0);
    expect(waiting.categories.every((c) => c.state === 'unavailable' && c.card_count === 0)).toBe(true);
    expect(waiting.first_ready_at).toBeNull();
    expect(await seededRecs(accountId)).toEqual([]);
    const { rows: errors } = await getTestDb().query<{ status: string; http_status: number }>(
      `SELECT pq.status, pq.http_status FROM provider_queries pq JOIN taste_seed_runs tr ON tr.id = pq.taste_seed_run_id WHERE tr.owner_account_id = $1`,
      [accountId],
    );
    expect(errors.length).toBe(3);
    expect(errors.every((e) => e.status === 'error' && e.http_status === 429)).toBe(true);
    // Meanwhile the feed is the labeled example feed, never invented cards.
    const meanwhile = await wholeFeed(ctx);
    expect(meanwhile.is_example_feed).toBe(true);
    expect(meanwhile.items.every((i) => i.is_example)).toBe(true);

    // Still throttled: the retry probes with ONE request and stops.
    await runAttempt(q.providers, jobId);
    expect(q.calls.length).toBe(4);
    expect(await job(jobId)).toMatchObject({ state: 'queued', attempt: 2 });

    healthy = true;
    await runAttempt(q.providers, jobId);
    // 4 of the job's 6 requests were spent while throttled; the last 2 go to the probe and one more category.
    expect(q.calls.length).toBe(6);
    expect(q.state.peak).toBeLessThanOrEqual(3);
    const { rows: used } = await getTestDb().query<{ n: number }>('SELECT qloo_requests_used AS n FROM taste_seed_runs WHERE job_id = $1', [jobId]);
    expect(used[0]!.n).toBe(6);
    expect(await job(jobId)).toMatchObject({ state: 'partial', attempt: 3 });
    const done = await tasteSeed.getTasteSeedStatus(getTestDb(), accountId);
    expect(done.state).toBe('partial');
    expect(done.poll_after_ms).toBeNull();
    // The probe and one more category; the other two stay unavailable and the feed fills them with labeled examples.
    expect(done.categories.filter((c) => c.state === 'ready')).toHaveLength(2);
    expect(done.categories.filter((c) => c.state === 'unavailable')).toHaveLength(2);
    expect(done.categories.find((c) => c.category === 'wear')!.state).toBe('ready'); // the probe
    expect((await wholeFeed(ctx)).is_example_feed).toBe(false);

    // Nothing further runs: the job is finished and its budget is spent.
    await runAttempt(q.providers, jobId);
    expect(q.calls.length).toBe(6);
  });

  it('an open Qloo circuit re-queues the seed for after the cooldown instead of giving up (ONB-03)', async () => {
    const { accountId } = await onboardedAccount();
    let clock = Date.now();
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000, now: () => clock });
    let healthy = false;
    const { providers } = scriptedQloo((t) => (healthy ? RESULTS[t] ?? ok({ entities: [] }) : { status: 503 }), 150, breaker);
    const jobId = await enqueue(accountId);
    await runAttempt(providers, jobId);
    expect(breaker.state).toBe('open');
    expect(await job(jobId)).toMatchObject({ state: 'queued', attempt: 1 });
    // Next attempt while the circuit is still open: no request is possible, so wait for the cooldown.
    await runAttempt(providers, jobId);
    const waiting = await getTestDb().query<{ state: string; attempt: number; wait_ms: number }>(
      `SELECT state, attempt, EXTRACT(EPOCH FROM (available_at - now())) * 1000 AS wait_ms FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(waiting.rows[0]).toMatchObject({ state: 'queued', attempt: 2 });
    expect(Number(waiting.rows[0]!.wait_ms)).toBeGreaterThan(30_000);
    expect(await seededRecs(accountId)).toEqual([]);
    // Qloo is back and the cooldown has passed: the half-open trial succeeds and the seed publishes.
    healthy = true;
    clock += 61_000;
    await runAttempt(providers, jobId);
    if ((await job(jobId)).state === 'queued') await runAttempt(providers, jobId);
    const status = await tasteSeed.getTasteSeedStatus(getTestDb(), accountId);
    expect(status.categories.some((c) => c.state === 'ready')).toBe(true);
    expect((await seededRecs(accountId)).length).toBeGreaterThan(0);
  });

  it('keeps categories Qloo has nothing for empty instead of filling them (no fabrication)', async () => {
    const principal = await onboardedAccount();
    const { accountId } = principal;
    const q = scriptedQloo((type) => {
      if (type === 'urn:entity:movie') return ok({ entities: [] });
      if (type === 'urn:tag') return ok({ tags: [] });
      // Only the user's own pick comes back for Play: nothing new to show.
      if (type === 'urn:entity:artist') return ok({ entities: [ent(PICK_ARTIST.id, PICK_ARTIST.name, 'urn:entity:artist')] });
      return RESULTS[type]!;
    });
    const ctx = testContext(principal, { providers: q.providers });
    const jobId = await enqueue(accountId);
    await runAttempt(q.providers, jobId);

    expect(await job(jobId)).toMatchObject({ state: 'complete' });
    const status = await tasteSeed.getTasteSeedStatus(getTestDb(), accountId);
    expect(status.state).toBe('complete');
    expect(Object.fromEntries(status.categories.map((c) => [c.category, [c.state, c.card_count, c.ready_at]]))).toMatchObject({
      wear: ['ready', 3, expect.any(String)],
      play: ['empty', 0, null],
      watch: ['empty', 0, null],
      eat: ['empty', 0, null],
    });
    const recs = await seededRecs(accountId);
    expect(new Set(recs.map((r) => r.category))).toEqual(new Set(['wear']));
    // Empty categories show only labeled examples in the feed.
    const feed = await wholeFeed(ctx);
    expect(feed.is_example_feed).toBe(false);
    for (const item of feed.items.filter((i) => i.category !== 'wear')) expect(item.is_example).toBe(true);
  });

  it('retries a timing-out category without re-requesting published ones, then ends partial within 6 requests (timeouts)', async () => {
    const principal = await onboardedAccount();
    const { accountId } = principal;
    const q = scriptedQloo((type) => (type === 'urn:entity:brand' ? 'timeout' : RESULTS[type]!), 100);
    const jobId = await enqueue(accountId);

    await runAttempt(q.providers, jobId);
    expect(q.calls.length).toBe(4); // one request per category, no inline retry
    expect(q.state.peak).toBeLessThanOrEqual(3);
    const first = await tasteSeed.getTasteSeedStatus(getTestDb(), accountId);
    expect(first.state).toBe('retrying');
    expect(first.categories.map((c) => c.state)).toEqual(['unavailable', 'ready', 'ready', 'ready']);

    for (let attempt = 2; attempt <= 4; attempt++) {
      const before = q.calls.length;
      await runAttempt(q.providers, jobId);
      const made = q.calls.slice(before);
      expect(made.every((u) => u.searchParams.get('filter.type') === 'urn:entity:brand')).toBe(true);
    }
    // 4 + 1 + 1: the per-job cap ends the retries after the third attempt.
    expect(q.calls.length).toBe(6);
    expect(await job(jobId)).toMatchObject({ state: 'partial', attempt: 3 });
    const last = await tasteSeed.getTasteSeedStatus(getTestDb(), accountId);
    expect(last.state).toBe('partial');
    expect(last.poll_after_ms).toBeNull();
    expect(last.categories.map((c) => [c.category, c.state])).toEqual([
      ['wear', 'unavailable'],
      ['play', 'ready'],
      ['watch', 'ready'],
      ['eat', 'ready'],
    ]);
    expect((await seededRecs(accountId)).some((r) => r.category === 'wear')).toBe(false);
  });

  it('fails without retry and without cards when Qloo is not configured', async () => {
    const principal = await onboardedAccount();
    const providers = testProviders(); // no Qloo key: UnavailableQloo
    const jobId = await enqueue(principal.accountId);
    await runAttempt(providers, jobId);
    expect(await job(jobId)).toMatchObject({ state: 'failed', error_code: 'provider_unavailable', error_retryable: false });
    const status = await tasteSeed.getTasteSeedStatus(getTestDb(), principal.accountId);
    expect(status.state).toBe('failed');
    expect(status.categories.every((c) => c.state === 'unavailable')).toBe(true);
    expect(await seededRecs(principal.accountId)).toEqual([]);
    expect((await wholeFeed(testContext(principal, { providers }))).is_example_feed).toBe(true);
  });

  it('labels replayed Qloo data as examples', async () => {
    const principal = await onboardedAccount();
    const replay = new FakeQloo(
      {
        insights: (req) =>
          req.filterType === 'urn:entity:brand'
            ? { entities: [{ entity_id: 'FIXTURE-BRAND-0101', name: 'Fixture Replayed Brand', types: ['urn:entity:brand'], properties: {}, tags: [] }], tags: [] }
            : { entities: [], tags: [] },
      },
      { live: false },
    );
    const providers = testProviders({ qloo: replay });
    const jobId = await enqueue(principal.accountId);
    await runAttempt(providers, jobId);
    const recs = await seededRecs(principal.accountId);
    expect(recs.map((r) => [r.title, r.origin])).toEqual([['Fixture Replayed Brand', 'replay']]);
    const feed = await wholeFeed(testContext(principal, { providers }));
    const card = feed.items.find((i) => i.title === 'Fixture Replayed Brand')!;
    expect(card.is_example).toBe(true);
  });

  it('asks Qloo nothing when there are no Qloo-backed picks', async () => {
    const principal = await insertAccount();
    const q = scriptedQloo((type) => RESULTS[type]!);
    const jobId = await enqueue(principal.accountId);
    await runAttempt(q.providers, jobId);
    expect(q.calls.length).toBe(0);
    expect(await job(jobId)).toMatchObject({ state: 'complete' });
    const status = await tasteSeed.getTasteSeedStatus(getTestDb(), principal.accountId);
    expect(status.categories.every((c) => c.state === 'empty')).toBe(true);
  });

  it('stops before any Qloo request when the seed is killed after it was queued', async () => {
    const principal = await onboardedAccount();
    const q = scriptedQloo((type) => RESULTS[type]!);
    const jobId = await enqueue(principal.accountId);
    await runAttempt(q.providers, jobId, testConfig({ FEATURE_KILL_SWITCHES: 'taste_seed_enabled' }));
    expect(q.calls.length).toBe(0);
    expect(await job(jobId)).toMatchObject({ error_code: 'service_unavailable' });
    expect(await seededRecs(principal.accountId)).toEqual([]);
  });

  it('explains a seeded card in item detail and the inspector, to its owner only', async () => {
    const owner = await onboardedAccount({ isDemoOwner: true });
    const other = await insertAccount();
    const q = scriptedQloo((type) => RESULTS[type]!);
    const jobId = await enqueue(owner.accountId);
    await runAttempt(q.providers, jobId);
    const { rows } = await getTestDb().query<{ id: string }>(
      `SELECT id FROM discovery_items WHERE owner_account_id = $1 AND canonical_key = 'qloo:FIXTURE-ARTIST-0001'`,
      [owner.accountId],
    );
    const itemId = rows[0]!.id;
    const detail = await items.getItem(testContext(owner, { providers: q.providers }), { id: itemId, query: {} });
    expect(detail.reason).toBe(`Because you picked ${PICK_ARTIST.name}.`);
    expect(detail.item.is_example).toBe(false);
    await expect(items.getItem(testContext(other, { providers: q.providers }), { id: itemId, query: {} })).rejects.toMatchObject({ code: 'not_found' });

    const trace = await traces.getTrace(testContext(owner, { providers: q.providers }), { job_id: jobId });
    expect(trace.provider_queries.length).toBe(4);
    expect(trace.recommendations.length).toBe(10); // no hides or exclusions on this account
    expect(trace.recommendations.every((r) => r.origin === 'qloo' && r.provider_query_ids.length === 1)).toBe(true);
  });

  it('keeps one account’s seed out of another account’s feed', async () => {
    const owner = await onboardedAccount();
    const other = await insertAccount();
    const q = scriptedQloo((type) => RESULTS[type]!);
    const jobId = await enqueue(owner.accountId);
    await runAttempt(q.providers, jobId);
    const otherFeed = await wholeFeed(testContext(other, { providers: q.providers }));
    expect(otherFeed.is_example_feed).toBe(true);
    expect(otherFeed.items.some((i) => i.title.startsWith('Fixture Linen'))).toBe(false);
    expect((await tasteSeed.getTasteSeedStatus(getTestDb(), other.accountId)).state).toBe('not_started');
  });
});
