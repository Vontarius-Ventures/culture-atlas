/**
 * Outage switch in front of the LIVE Qloo API, for the screen 14-18 design
 * fidelity run (docs/design-fidelity-v22.md). Point QLOO_API_URL at it: every
 * request is forwarded unchanged to the real Qloo host, so names, ids and
 * images are real Qloo results. Nothing is invented, cached or rewritten.
 *
 *   NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt \
 *     pnpm exec tsx scripts/e2e/qloo-gate.ts --port 4490
 *
 * Control (test only): POST /__gate/mode {"mode":"up"|"down"}. While "down"
 * every Qloo route answers HTTP 503 with Retry-After, exactly like an outage,
 * so the app's honest unavailable states can be captured from real data.
 * The API key travels in the request headers from the app and is never read,
 * stored or logged here. Listens on loopback only.
 */
import { createServer, type IncomingMessage } from 'node:http';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('port') ?? process.env.QLOO_GATE_PORT ?? 4490);
const target = (
  arg('target') ??
  process.env.QLOO_GATE_TARGET ??
  'https://hackathon.api.qloo.com'
).replace(/\/+$/, '');
const retryAfterS = Number(process.env.QLOO_GATE_RETRY_AFTER_S ?? 3);

let mode: 'up' | 'down' = 'up';
const counts = { forwarded: 0, refused: 0 };

/** Hop-by-hop and host headers are not forwarded. */
const SKIP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'accept-encoding',
]);

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://gate');
  if (url.pathname === '/__gate/mode' && req.method === 'POST') {
    try {
      const next = (JSON.parse((await body(req)).toString('utf8') || '{}') as { mode?: string })
        .mode;
      if (next !== 'up' && next !== 'down') throw new Error('mode must be up or down');
      mode = next;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode }));
    } catch (err) {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: String(err) }));
    }
    return;
  }
  if (url.pathname === '/__gate/stats') {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ mode, ...counts }));
    return;
  }
  if (mode === 'down') {
    counts.refused++;
    await body(req);
    res
      .writeHead(503, { 'content-type': 'application/json', 'retry-after': String(retryAfterS) })
      .end(JSON.stringify({ error: 'Service unavailable (qloo-gate outage switch)' }));
    return;
  }
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || SKIP.has(k.toLowerCase())) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const payload = req.method === 'GET' || req.method === 'HEAD' ? undefined : await body(req);
    counts.forwarded++;
    const upstream = await fetch(target + url.pathname + url.search, {
      method: req.method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!SKIP.has(k) && k !== 'content-encoding') out[k] = v;
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, out).end(buf);
  } catch {
    // Never echo upstream errors (they may include request details).
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'qloo-gate could not reach Qloo' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`qloo-gate on 127.0.0.1:${port} -> ${target}`);
});
