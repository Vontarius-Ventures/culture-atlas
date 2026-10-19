/**
 * Fake Qloo HTTP server for the real-stack browser journeys (spec amendment
 * 2.2, docs/v22-real-stack.md). The web app and the worker talk to it through
 * the real Qloo adapter (QLOO_API_URL), so request shaping, parsing,
 * throttling, retries and the seed job's limits are all exercised; only the
 * upstream is replaced. Every id starts with FIXTURE- and every name with
 * "Fixture": nothing here is real Qloo data, and it is never used outside
 * tests (search and tag lookups echo the queried name with a FIXTURE- id).
 * No live key is needed or read.
 *
 *   pnpm exec tsx scripts/e2e/fake-qloo.ts --port 4410
 *
 * Control (test only): POST /__fake/mode {"mode":"up"|"down"} switches every
 * Qloo route to HTTP 503 and back; GET /__fake/stats reports request counts
 * and the peak number of requests in flight; POST /__fake/reset clears them.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || process.env.FAKE_QLOO_PORT || 4410);
const latencyMs = Number(process.env.FAKE_QLOO_LATENCY_MS ?? 120);
/** Retry-After (seconds) sent with the outage 503s, so the seed job's backoff is observable. */
const retryAfterS = Number(process.env.FAKE_QLOO_RETRY_AFTER_S ?? 3);

let mode: 'up' | 'down' = 'up';
let inFlight = 0;
let peak = 0;
const counts: Record<string, number> = {};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'x';
const title = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Insights results per filter type: fictional fixtures, labeled as such. */
const INSIGHTS: Record<string, Array<{ name: string; year?: number; description: string }>> = {
  'urn:entity:brand': [
    { name: 'Fixture Linen Atelier', description: 'Fixture brand for browser tests' },
    { name: 'Fixture Racing Outfitters', description: 'Fixture brand for browser tests' },
    { name: 'Fixture Quiet Tailors', description: 'Fixture brand for browser tests' },
    { name: 'Fixture Oak & Clay', description: 'Fixture brand for browser tests' },
  ],
  'urn:entity:artist': [
    { name: 'Fixture Bossa Trio', description: 'Fixture artist for browser tests' },
    { name: 'Fixture Late Set Quartet', description: 'Fixture artist for browser tests' },
    { name: 'Fixture Ambient Rooms', description: 'Fixture artist for browser tests' },
    { name: 'Fixture Sunday Records', description: 'Fixture artist for browser tests' },
  ],
  'urn:entity:movie': [
    { name: 'Fixture Night Street', year: 1958, description: 'Fixture film for browser tests' },
    { name: 'Fixture Marquee', year: 1949, description: 'Fixture film for browser tests' },
    { name: 'Fixture Rain on Glass', year: 1997, description: 'Fixture film for browser tests' },
    { name: 'Fixture Last Tram', year: 1964, description: 'Fixture film for browser tests' },
  ],
  'urn:entity:place': [
    { name: 'Fixture Noodle Bar', description: 'Fixture place for browser tests' },
    { name: 'Fixture Tea House', description: 'Fixture place for browser tests' },
    { name: 'Fixture Mezze Room', description: 'Fixture place for browser tests' },
  ],
  'urn:entity:book': [{ name: 'Fixture Field Notes', description: 'Fixture book for browser tests' }],
  'urn:entity:tv_show': [{ name: 'Fixture Late Show', description: 'Fixture show for browser tests' }],
};
const CUISINE_TAGS = ['Fixture Sichuan', 'Fixture Izakaya', 'Fixture Mezze', 'Fixture Tea Snacks'];

function entity(type: string, e: { name: string; year?: number; description: string }, i: number) {
  return {
    entity_id: `FIXTURE-${type.split(':').pop()!.toUpperCase()}-${String(i + 1).padStart(4, '0')}`,
    name: e.name,
    types: [type],
    popularity: 0.9 - i * 0.05,
    properties: { short_description: e.description, ...(e.year ? { release_year: e.year } : {}) },
    query: { affinity: 0.9 - i * 0.1 },
    tags: [],
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function route(url: URL): { status: number; body: unknown } {
  const q = url.searchParams;
  if (url.pathname === '/search') {
    const query = (q.get('query') ?? '').trim();
    if (!query) return { status: 400, body: { error: 'query required' } };
    const name = title(query);
    const types = (q.get('types') ?? 'urn:entity:artist,urn:entity:movie,urn:entity:brand').split(',');
    // The first result echoes the query (so name checks can accept it); the others are labeled fixtures.
    const results = types.slice(0, 3).map((type, i) =>
      entity(type, { name: i === 0 ? name : `Fixture ${name} ${['', 'Film', 'Label'][i]}`, description: 'Fixture search result' }, i),
    );
    return { status: 200, body: { results } };
  }
  if (url.pathname === '/v2/tags') {
    const query = (q.get('filter.query') ?? '').trim();
    const type = (q.get('filter.tag.types') ?? 'urn:tag:style:qloo').split(',')[0]!;
    if (!query) return { status: 200, body: { success: true, results: { tags: [] } } };
    return {
      status: 200,
      body: { success: true, results: { tags: [{ id: `${type}:fixture_${slug(query)}`, name: title(query), type }] } },
    };
  }
  if (url.pathname === '/v2/insights') {
    const type = q.get('filter.type') ?? '';
    const take = Math.min(Number(q.get('take') ?? 10), 50);
    if (type === 'urn:tag') {
      const tagType = (q.get('filter.tag.types') ?? 'urn:tag:cuisine:qloo').split(',')[0]!;
      const tags = CUISINE_TAGS.slice(0, take).map((name, i) => ({ id: `${tagType}:fixture_${slug(name)}`, name, type: tagType, query: { affinity: 0.9 - i * 0.1 } }));
      return { status: 200, body: { success: true, results: { tags } } };
    }
    const list = INSIGHTS[type] ?? [];
    return { status: 200, body: { success: true, results: { entities: list.slice(0, take).map((e, i) => entity(type, e, i)) } } };
  }
  return { status: 404, body: { error: 'not found' } };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/__fake/mode' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as { mode?: string };
    mode = body.mode === 'down' ? 'down' : 'up';
    return send(res, 200, { mode });
  }
  if (url.pathname === '/__fake/stats') return send(res, 200, { mode, counts, peak_in_flight: peak, in_flight: inFlight });
  if (url.pathname === '/__fake/reset' && req.method === 'POST') {
    for (const k of Object.keys(counts)) delete counts[k];
    peak = inFlight;
    return send(res, 200, { ok: true });
  }
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  counts[url.pathname] = (counts[url.pathname] ?? 0) + 1;
  try {
    await new Promise((r) => setTimeout(r, latencyMs));
    if (mode === 'down') return send(res, 503, { error: 'fixture outage' }, { 'retry-after': String(retryAfterS) });
    const out = route(url);
    send(res, out.status, out.body);
  } finally {
    inFlight -= 1;
  }
}).listen(port, '127.0.0.1', () => console.log(`[fake-qloo] listening on http://127.0.0.1:${port}`));
