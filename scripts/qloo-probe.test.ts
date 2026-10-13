import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROBE_BEGIN, PROBE_END, runQlooProbes, summarizeCapabilities, updateCapabilityMatrix } from './qloo-probe-lib';

/**
 * The probes run against a local server that answers with the recorded-shape
 * contract fixtures (fixtures/qloo/contract). This tests the probe logic and
 * the matrix writer; it says nothing about the live API, which is what the
 * script itself is for once a key exists.
 */
const FIX = path.join(import.meta.dirname, '../fixtures/qloo/contract');
const fixture = (name: string) => readFileSync(path.join(FIX, `${name}.json`), 'utf8');
const KEY = 'test-key-never-printed';

let server: Server | null = null;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = null;
});

async function mockQloo(handler: (url: URL, req: IncomingMessage) => { status: number; body: string; headers?: Record<string, string> }) {
  const seen: { url: URL; key: string | undefined }[] = [];
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://qloo.local');
    seen.push({ url, key: req.headers['x-api-key'] as string | undefined });
    if (req.headers['x-api-key'] !== KEY) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(fixture('error.401'));
    }
    const r = handler(url, req);
    res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
    res.end(r.body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
}

const happy = (url: URL) => {
  const rl = { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '97', 'x-ratelimit-reset': '60' };
  switch (url.pathname) {
    case '/search':
      return { status: 200, body: fixture('search.brand'), headers: rl };
    case '/v2/tags':
      return { status: 200, body: fixture('tags.style'), headers: rl };
    case '/v2/insights':
      return { status: 200, body: url.searchParams.get('filter.type') === 'urn:entity:place' ? fixture('insights.empty') : fixture('insights.movie.explainability'), headers: rl };
    case '/v2/trending':
      return { status: 200, body: fixture('trending.movie'), headers: rl };
    case '/trends/entity':
      return { status: 200, body: fixture('trends.entity'), headers: rl };
    default:
      return { status: 404, body: '{}' };
  }
};

describe('qloo contract probes', () => {
  it('runs every spec probe with the documented parameters and X-Api-Key', async () => {
    const q = await mockQloo(happy);
    const run = await runQlooProbes({ baseUrl: q.url, apiKey: KEY, brand: 'Fixture Denim', tag: 'mid century', pauseMs: 0, now: () => new Date('2026-10-13T00:00:00Z') });

    const byId = Object.fromEntries(run.results.map((r) => [r.id, r]));
    expect(byId['search.brand']).toMatchObject({ status: 'available', http_status: 200 });
    expect(byId['search.brand']!.detail).toContain('FIXTURE-BRAND-0001');
    expect(byId['tags.lookup']).toMatchObject({ status: 'available' });
    expect(byId['insights.artist']).toMatchObject({ status: 'available' });
    expect(byId['insights.place']).toMatchObject({ status: 'degraded', detail: 'no place results' });
    expect(byId['insights.explainability']).toMatchObject({ status: 'available', detail: 'contributing inputs present on 3 of 6 result(s)' });
    expect(byId['insights.tag_signal']).toMatchObject({ status: 'available' });
    expect(byId['trending']).toMatchObject({ status: 'available' });
    expect(byId['trends.entity']).toMatchObject({ status: 'available', detail: '3 trend point(s)' });
    expect(byId['auth.invalid_key']).toMatchObject({ status: 'available', http_status: 401 });
    expect(byId['search.brand']!.rate_limit).toEqual({ limit: '100', remaining: '97', reset: '60' });

    const insights = q.seen.filter((s) => s.url.pathname === '/v2/insights' && s.url.searchParams.has('signal.interests.entities'));
    expect(insights.map((s) => s.url.searchParams.get('filter.type'))).toEqual(['urn:entity:artist', 'urn:entity:movie', 'urn:entity:brand', 'urn:entity:place']);
    for (const s of insights) {
      expect(s.url.searchParams.get('signal.interests.entities')).toBe('FIXTURE-BRAND-0001');
      expect(s.url.searchParams.get('feature.explainability')).toBe('true');
    }
    const trending = q.seen.find((s) => s.url.pathname === '/v2/trending')!.url.searchParams;
    expect(Object.fromEntries(trending)).toMatchObject({ 'filter.start_date': '2026-09-15', 'filter.end_date': '2026-10-13', 'filter.type': 'urn:entity:brand' });
    expect(q.seen.filter((s) => s.key === KEY).length).toBe(q.seen.length - 1);

    const caps = summarizeCapabilities(run);
    expect(caps.get('qloo.insights')!.status).toBe('available');
    expect(JSON.stringify(run)).not.toContain(KEY);
  });

  it('reports access problems and rate limits honestly, and skips what depends on them', async () => {
    const q = await mockQloo((url) =>
      url.pathname === '/search'
        ? { status: 403, body: '{"error":{"message":"Key not enabled for search"}}' }
        : { status: 429, body: fixture('error.429'), headers: { 'retry-after': '30' } },
    );
    const run = await runQlooProbes({ baseUrl: q.url, apiKey: KEY, pauseMs: 0 });
    const byId = Object.fromEntries(run.results.map((r) => [r.id, r]));
    expect(byId['search.brand']).toMatchObject({ status: 'unavailable', detail: 'access denied (HTTP 403)' });
    expect(byId['tags.lookup']).toMatchObject({ status: 'degraded', detail: 'rate limited (HTTP 429, retry after 30s)' });
    expect(byId['insights.movie']).toMatchObject({ status: 'skipped', detail: 'brand did not resolve' });
    expect(run.results.some((r) => r.id === 'trending')).toBe(false);
  });

  it('marks an unreachable API unavailable', async () => {
    const run = await runQlooProbes({ baseUrl: 'http://127.0.0.1:9', apiKey: KEY, pauseMs: 0, timeoutMs: 1000 });
    expect(run.results[0]).toMatchObject({ id: 'search.brand', status: 'unavailable', http_status: null });
  });

  it('writes results into the capability matrix idempotently', async () => {
    const q = await mockQloo(happy);
    const run = await runQlooProbes({ baseUrl: q.url, apiKey: KEY, pauseMs: 0, now: () => new Date('2026-10-20T10:00:00Z') });
    const matrix = readFileSync(path.join(import.meta.dirname, '../docs/capability-matrix.md'), 'utf8');
    const once = updateCapabilityMatrix(matrix, run);
    expect(once).toContain(PROBE_BEGIN);
    expect(once).toContain(PROBE_END);
    expect(once).toMatch(/\| `qloo\.search` \| [^|]+ \| available \(probed 2026-10-20\) \|/);
    expect(once).toMatch(/\| `qloo\.insights\.explainability` \| [^|]+ \| available \(probed 2026-10-20\) \|/);
    expect(updateCapabilityMatrix(once, run)).toBe(once);
    expect(once.split(PROBE_BEGIN)).toHaveLength(2);
    expect(once).not.toContain(KEY);
    // Every table row keeps its five columns.
    for (const line of once.split('\n').filter((l) => l.startsWith('| `qloo.'))) expect(line.split(' | ')).toHaveLength(5);
  });
});
