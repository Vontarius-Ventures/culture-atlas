import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProviderConfig } from '../config';
import { ProviderError, type RequestBudget } from '../errors';
import { CircuitBreaker } from '../http/resilience';
import { UnavailableQloo } from '../unavailable';
import { createQlooProvider, QlooHttpProvider } from './client';
import { parseInsights, parseSearch, parseTags } from './parse';
import { ReplayQloo } from './replay';

const FIXTURES = path.resolve(import.meta.dirname, '../../../../fixtures/qloo/contract');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

type Step = { status: number; body?: string; headers?: Record<string, string> } | 'timeout' | 'network';

/** Scripted fetch: returns steps in order and records every call. */
function scriptedFetch(steps: Step[]) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const step = steps.shift() ?? { status: 500 };
    if (step === 'network') throw new TypeError('fetch failed');
    if (step === 'timeout') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return new Response(step.body ?? '', { status: step.status, headers: step.headers });
  }) as typeof fetch;
  return { impl, calls };
}

function provider(steps: Step[], extra: Partial<ConstructorParameters<typeof QlooHttpProvider>[0]> = {}) {
  const f = scriptedFetch(steps);
  const sleeps: number[] = [];
  const p = new QlooHttpProvider({
    apiKey: 'test-key-123',
    baseUrl: 'https://qloo.example.test/',
    timeoutMs: 50,
    fetch: f.impl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...extra,
  });
  return { p, calls: f.calls, sleeps };
}

function countingBudget(limit: number): RequestBudget & { used: number; retries: number } {
  return {
    used: 0,
    retries: 0,
    take(_provider, kind) {
      if (this.used >= limit) return false;
      this.used++;
      if (kind === 'retry') this.retries++;
      return true;
    },
  };
}

describe('Qloo adapter configuration', () => {
  it('is unavailable/not_configured without QLOO_API_KEY and never calls the network', async () => {
    const q = createQlooProvider(loadProviderConfig({}));
    expect(q).toBeInstanceOf(UnavailableQloo);
    expect(q.capability().insights).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
    await expect(q.searchEntities({ query: 'denim' })).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('does not replay contract fixtures: replay needs real recordings in QLOO_REPLAY_DIR', () => {
    const q = createQlooProvider(loadProviderConfig({ QLOO_REPLAY_FIXTURES: 'true', QLOO_REPLAY_DIR: FIXTURES }));
    // Contract fixtures are not recordings (no op/request envelope) -> still unavailable.
    expect(q).toBeInstanceOf(UnavailableQloo);
  });

  it('with a key starts unverified (probe pending) and uses the configured base URL + X-Api-Key', async () => {
    const q = createQlooProvider(loadProviderConfig({ QLOO_API_KEY: 'k', QLOO_API_URL: 'https://qloo.example.test' }));
    expect(q).toBeInstanceOf(QlooHttpProvider);
    expect(q.capability().search).toMatchObject({ status: 'unverified', reason: 'probe_pending' });

    const { p, calls } = provider([{ status: 200, body: fixture('search.brand.json') }]);
    const res = await p.searchEntities({ query: ' Fixture Denim ', types: ['urn:entity:brand'], take: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe('https://qloo.example.test/search');
    expect(calls[0]!.url.searchParams.get('query')).toBe('Fixture Denim');
    expect(calls[0]!.url.searchParams.get('types')).toBe('urn:entity:brand');
    expect(calls[0]!.headers['x-api-key']).toBe('test-key-123');
    // The sanitized request never contains the key.
    expect(JSON.stringify(res.request)).not.toContain('test-key-123');
    expect(res.is_replay).toBe(false);
    expect(p.capability().search.status).toBe('available');
  });
});

describe('Qloo adapter contract (recorded-shape fixtures)', () => {
  it('search: keeps real ids, drops results without ids, filters properties', async () => {
    const { p } = provider([{ status: 200, body: fixture('search.brand.json') }]);
    const res = await p.searchEntities({ query: 'denim' });
    expect(res.data.map((e) => e.entity_id)).toEqual(['FIXTURE-BRAND-0001', 'FIXTURE-BRAND-0002']);
    expect(res.data[0]!.tags).toEqual([{ id: 'urn:tag:genre:qloo:fixture_workwear', name: 'Fixture Workwear', type: 'urn:tag:genre:qloo' }]);
    expect(res.data[0]!.properties).not.toHaveProperty('internal_scoring_blob');
    expect(res.data[1]!.types).toEqual(['urn:entity:brand']);
  });

  it('tags: filter.query + exact filter.tag.types; normalizes tag_id/subtype', async () => {
    const { p, calls } = provider([{ status: 200, body: fixture('tags.style.json') }]);
    const res = await p.lookupTags({ query: 'mid-century', tagTypes: ['urn:tag:style:qloo'] });
    expect(calls[0]!.url.pathname).toBe('/v2/tags');
    expect(calls[0]!.url.searchParams.get('filter.query')).toBe('mid-century');
    expect(calls[0]!.url.searchParams.get('filter.tag.types')).toBe('urn:tag:style:qloo');
    expect(res.data).toEqual([
      { id: 'urn:tag:style:qloo:fixture_mid_century_modern', name: 'Fixture Mid-Century Modern', type: 'urn:tag:style:qloo', parents: ['urn:tag:style:qloo:fixture_modernism'] },
      { id: 'urn:tag:style:qloo:fixture_atomic_age', name: 'Fixture Atomic Age', type: 'urn:tag:style:qloo', parents: undefined },
    ]);
  });

  it('insights: sends real signal ids, keeps per-query affinity and explainability', async () => {
    const { p, calls } = provider([{ status: 200, body: fixture('insights.movie.explainability.json') }]);
    const res = await p.insights({
      filterType: 'urn:entity:movie',
      signalEntities: ['FIXTURE-BRAND-0001', 'FIXTURE-BRAND-0002'],
      signalTags: [{ id: 'urn:tag:style:qloo:fixture_mid_century_modern' }],
      explainability: true,
      take: 5,
    });
    const q = calls[0]!.url.searchParams;
    expect(calls[0]!.url.pathname).toBe('/v2/insights');
    expect(q.get('filter.type')).toBe('urn:entity:movie');
    expect(q.get('signal.interests.entities')).toBe('FIXTURE-BRAND-0001,FIXTURE-BRAND-0002');
    expect(q.get('signal.interests.tags')).toBe('urn:tag:style:qloo:fixture_mid_century_modern');
    expect(q.get('feature.explainability')).toBe('true');
    expect(res.data.entities[0]).toMatchObject({
      entity_id: 'FIXTURE-MOVIE-0001',
      properties: { release_year: 1968 },
      query: { affinity: 0.981, explainability: [{ entity_id: 'FIXTURE-BRAND-0001', score: 0.71 }, { entity_id: 'FIXTURE-BRAND-0002', score: 0.29 }] },
    });
    expect(res.data.entities[1]!.query).toEqual({ affinity: 0.944 });
    expect(p.capability().explainability.status).toBe('available');
  });

  it('insights without any signal is rejected locally (no request sent)', async () => {
    const { p, calls } = provider([]);
    await expect(p.insights({ filterType: 'urn:entity:artist' })).rejects.toMatchObject({ kind: 'bad_request' });
    expect(calls).toHaveLength(0);
  });

  it('trending and entity history parse documented shapes', async () => {
    const { p, calls } = provider([
      { status: 200, body: fixture('trending.movie.json') },
      { status: 200, body: fixture('trends.entity.json') },
    ]);
    const t = await p.trending({ signalEntities: ['FIXTURE-MOVIE-0001'], filterType: 'urn:entity:movie', startDate: '2026-09-01', endDate: '2026-09-30' });
    expect(calls[0]!.url.searchParams.get('filter.start_date')).toBe('2026-09-01');
    expect(t.data.entities[0]!.trend).toHaveLength(2);
    const h = await p.entityTrends({ entityId: 'FIXTURE-MOVIE-0001', startDate: '2026-09-01' });
    expect(calls[1]!.url.pathname).toBe('/trends/entity');
    expect(calls[1]!.url.searchParams.get('entity_id')).toBe('FIXTURE-MOVIE-0001');
    expect(h.data.points.map((x) => x.date)).toEqual(['2026-09-01', '2026-09-08']);
  });
});

describe('Qloo adapter fault injection (no fabricated results)', () => {
  it('empty results stay empty', async () => {
    const { p } = provider([
      { status: 200, body: fixture('search.empty.json') },
      { status: 200, body: fixture('insights.empty.json') },
    ]);
    expect((await p.searchEntities({ query: 'nothing' })).data).toEqual([]);
    const ins = await p.insights({ filterType: 'urn:entity:brand', signalEntities: ['X'] });
    expect(ins.data).toEqual({ entities: [], tags: [] });
  });

  it('429 honors Retry-After then succeeds; retries are charged to the budget', async () => {
    const { p, calls, sleeps } = provider([
      { status: 429, body: fixture('error.429.json'), headers: { 'retry-after': '2' } },
      { status: 200, body: fixture('insights.artist.json') },
    ]);
    const budget = countingBudget(12);
    const res = await p.insights({ filterType: 'urn:entity:artist', signalEntities: ['A'] }, { budget });
    expect(res.data.entities).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(sleeps[0]).toBe(2000);
    expect(budget.used).toBe(2);
    expect(budget.retries).toBe(1);
  });

  it('429 beyond the retry limit surfaces rate_limited with retryAfterMs', async () => {
    const { p, calls } = provider([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 429, headers: { 'retry-after': '1' } },
    ]);
    const err = await p.searchEntities({ query: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    // Style design R-11: a 429 backs off at least 1100 ms.
    expect(err).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 1100 });
    expect(calls).toHaveLength(3); // 1 + 2 retries (spec: two retries per stage)
  });

  it('a long Retry-After is not waited in-process (the job re-queues instead)', async () => {
    const { p, calls, sleeps } = provider([{ status: 429, headers: { 'retry-after': '120' } }]);
    await expect(p.searchEntities({ query: 'x' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('timeouts are retried with exponential backoff, then reported as timeout', async () => {
    const { p, calls, sleeps } = provider(['timeout', 'timeout', 'timeout']);
    await expect(p.searchEntities({ query: 'slow' }, { maxRetries: 2 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([187, 375]); // equal jitter at random=0.5: 250*2^n * 0.75
  });

  it('network errors and 5xx are retried; 4xx are not', async () => {
    const a = provider(['network', { status: 503 }, { status: 200, body: fixture('search.brand.json') }]);
    expect((await a.p.searchEntities({ query: 'x' })).data).toHaveLength(2);
    expect(a.calls).toHaveLength(3);

    const b = provider([{ status: 400 }, { status: 200, body: '{"results":[]}' }]);
    await expect(b.p.searchEntities({ query: 'x' })).rejects.toMatchObject({ kind: 'bad_request' });
    expect(b.calls).toHaveLength(1);
  });

  it('401/403 marks the capability access_denied and is not retried', async () => {
    const { p, calls } = provider([{ status: 401, body: fixture('error.401.json') }]);
    await expect(p.lookupTags({ query: 'x' })).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toHaveLength(1);
    expect(p.capability().tags).toMatchObject({ status: 'unavailable', reason: 'access_denied' });
  });

  it('malformed envelopes are invalid_response, never guessed', async () => {
    const { p } = provider([{ status: 200, body: fixture('malformed.json') }, { status: 200, body: 'not json' }]);
    await expect(p.insights({ filterType: 'urn:entity:brand', signalEntities: ['A'] })).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect(p.searchEntities({ query: 'x' })).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('an exhausted per-job budget stops before any request is sent', async () => {
    const { p, calls } = provider([{ status: 200, body: fixture('search.brand.json') }]);
    await expect(p.searchEntities({ query: 'x' }, { budget: countingBudget(0) })).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(calls).toHaveLength(0);
  });

  it('the circuit opens after repeated transient failures and fails fast', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });
    const { p, calls } = provider([{ status: 500 }, { status: 500 }, { status: 200, body: fixture('search.brand.json') }], { breaker });
    await expect(p.searchEntities({ query: 'x' }, { maxRetries: 1 })).rejects.toMatchObject({ kind: 'server' });
    expect(calls).toHaveLength(2);
    await expect(p.searchEntities({ query: 'x' })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(calls).toHaveLength(2);
    expect(p.capability().search).toMatchObject({ status: 'degraded', reason: 'circuit_open' });
    now = 1500; // half-open: one trial request allowed
    expect((await p.searchEntities({ query: 'x' })).data).toHaveLength(2);
    expect(breaker.state).toBe('closed');
  });

  it('caller cancellation aborts without retrying', async () => {
    const { p, calls } = provider(['timeout', 'timeout']);
    const ctrl = new AbortController();
    const pending = p.searchEntities({ query: 'x' }, { signal: ctrl.signal, timeoutMs: 10_000 });
    setTimeout(() => ctrl.abort(), 5);
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls).toHaveLength(1);
  });
});

describe('Qloo replay provider', () => {
  it('serves only exact recorded requests, always flagged is_replay', async () => {
    const r = new ReplayQloo([
      {
        op: 'search',
        request: { method: 'GET', path: '/search', query: { query: 'denim', take: '5' } },
        status: 200,
        body: JSON.parse(fixture('search.brand.json')),
        recorded_at: '2026-10-20T00:00:00.000Z',
      },
    ]);
    const res = await r.searchEntities({ query: 'denim' });
    expect(res.is_replay).toBe(true);
    expect(res.data).toHaveLength(2);
    await expect(r.searchEntities({ query: 'other' })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(r.capability().search.status).toBe('degraded');
  });
});

describe('Qloo grounding fields (quality plan §5, §6)', () => {
  it('keeps tag popularity and place disambiguation/geocode, and invents nothing when absent', () => {
    const tags = parseTags({
      results: {
        tags: [
          { id: 'urn:tag:cuisine:qloo:fixture_dim_sum', name: 'Fixture Dim Sum', type: 'urn:tag:cuisine:qloo', popularity: 0.71 },
          { id: 'urn:tag:cuisine:qloo:fixture_noodle', name: 'Fixture Noodle', type: 'urn:tag:cuisine:qloo' },
        ],
      },
    });
    expect(tags[0]!.popularity).toBe(0.71);
    expect('popularity' in tags[1]!).toBe(false);
    const insightTags = parseInsights({ results: { tags: [{ id: 'urn:tag:cuisine:qloo:fixture_x', name: 'Fixture X', type: 'urn:tag:cuisine:qloo', popularity: 0.2 }] } }).tags;
    expect(insightTags[0]!.popularity).toBe(0.2);
    const [place, plain] = parseSearch({
      results: [
        {
          entity_id: 'FIXTURE-PLACE-0001',
          name: 'Fixture Palais',
          types: ['urn:entity:place'],
          disambiguation: ' 1 Fixture Street, Fixtureville ',
          properties: { geocode: { city: 'Fixtureville', country_code: 'FR' }, hours: { monday: [] } },
        },
        { entity_id: 'FIXTURE-PLACE-0002', name: 'Fixture Garden', types: ['urn:entity:place'] },
      ],
    });
    expect(place).toMatchObject({ disambiguation: '1 Fixture Street, Fixtureville', properties: { geocode: { city: 'Fixtureville', country_code: 'FR' } } });
    expect(place!.properties).not.toHaveProperty('hours');
    expect(plain!.popularity).toBeUndefined();
    expect(plain!.disambiguation).toBeUndefined();
  });
});
