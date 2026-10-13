/**
 * Qloo contract probes (build spec, "Qloo integration contract"): resolve one
 * brand, look up one relevant tag, request artist/film/brand/place results,
 * inspect explainability, record rate-limit headers, and check the optional
 * trend routes. Raw HTTP on purpose: this verifies the documented API itself,
 * independently of how packages/providers/src/qloo interprets it.
 *
 * Nothing is simulated. Every result row comes from a real HTTP response, and
 * the API key is never written anywhere. Used by scripts/qloo-probe.ts.
 */

export type ProbeStatus = 'available' | 'degraded' | 'unavailable' | 'skipped';

export interface RateLimitObservation {
  limit?: string;
  remaining?: string;
  reset?: string;
  retry_after?: string;
}

export interface ProbeResult {
  id: string;
  capability: string;
  request: string;
  status: ProbeStatus;
  http_status: number | null;
  detail: string;
  duration_ms: number;
  rate_limit?: RateLimitObservation;
}

export interface ProbeOptions {
  baseUrl: string;
  apiKey: string;
  brand?: string;
  tag?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  /** Pause between calls (default 250 ms) to stay well inside rate limits. */
  pauseMs?: number;
}

export interface ProbeRun {
  base_url: string;
  started_at: string;
  results: ProbeResult[];
}

type Json = Record<string, unknown>;

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

/** Entities from /search ({results: [...]}) or /v2/insights ({results: {entities: [...]}}). */
function entitiesOf(body: unknown): Json[] {
  const results = obj(body).results;
  const list = Array.isArray(results) ? results : arr(obj(results).entities);
  return list.map(obj).filter((e) => typeof e.entity_id === 'string');
}

function tagsOf(body: unknown): Json[] {
  const results = obj(body).results;
  const list = Array.isArray(results) ? results : arr(obj(results).tags);
  return list.map(obj).filter((t) => typeof (t.id ?? t.tag_id) === 'string');
}

function hasExplainability(e: Json): boolean {
  const ex = obj(obj(e.query).explainability);
  return Object.keys(ex).length > 0;
}

function rateLimitOf(h: Headers): RateLimitObservation | undefined {
  const r: RateLimitObservation = {};
  const pick = (k: keyof RateLimitObservation, ...names: string[]) => {
    for (const n of names) {
      const v = h.get(n);
      if (v) {
        r[k] = v;
        return;
      }
    }
  };
  pick('limit', 'x-ratelimit-limit', 'ratelimit-limit');
  pick('remaining', 'x-ratelimit-remaining', 'ratelimit-remaining');
  pick('reset', 'x-ratelimit-reset', 'ratelimit-reset');
  pick('retry_after', 'retry-after');
  return Object.keys(r).length ? r : undefined;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function runQlooProbes(opts: ProbeOptions): Promise<ProbeRun> {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const base = opts.baseUrl.replace(/\/+$/, '');
  const results: ProbeResult[] = [];
  const run: ProbeRun = { base_url: base, started_at: now().toISOString(), results };
  const pause = () => new Promise((r) => setTimeout(r, opts.pauseMs ?? 250));

  async function call(path: string, params: Record<string, string>, key = opts.apiKey): Promise<{ status: number | null; body: unknown; ms: number; rl?: RateLimitObservation; error?: string }> {
    const qs = new URLSearchParams(params).toString();
    const started = Date.now();
    try {
      const res = await fetchImpl(`${base}${path}${qs ? `?${qs}` : ''}`, {
        headers: { 'X-Api-Key': key, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body, ms: Date.now() - started, rl: rateLimitOf(res.headers) };
    } catch (err) {
      return { status: null, body: null, ms: Date.now() - started, error: (err as Error).name === 'TimeoutError' ? 'timeout' : 'network error' };
    }
  }

  function record(id: string, capability: string, request: string, r: Awaited<ReturnType<typeof call>>, ok: (body: unknown) => { status: ProbeStatus; detail: string }): ProbeStatus {
    let status: ProbeStatus;
    let detail: string;
    if (r.status === null) {
      status = 'unavailable';
      detail = r.error ?? 'no response';
    } else if (r.status === 401 || r.status === 403) {
      status = 'unavailable';
      detail = `access denied (HTTP ${r.status})`;
    } else if (r.status === 429) {
      status = 'degraded';
      detail = `rate limited (HTTP 429${r.rl?.retry_after ? `, retry after ${r.rl.retry_after}s` : ''})`;
    } else if (r.status >= 400) {
      status = 'unavailable';
      const msg = obj(obj(r.body).error).message ?? obj(r.body).message;
      detail = `HTTP ${r.status}${typeof msg === 'string' ? `: ${msg.slice(0, 120)}` : ''}`;
    } else {
      ({ status, detail } = ok(r.body));
    }
    results.push({ id, capability, request, status, http_status: r.status, detail, duration_ms: r.ms, ...(r.rl ? { rate_limit: r.rl } : {}) });
    return status;
  }

  const brand = opts.brand ?? "Levi's";
  const tag = opts.tag ?? 'streetwear';

  // 1. Resolve one brand.
  const search = await call('/search', { query: brand, types: 'urn:entity:brand', take: '5' });
  const found: { brandId: string | null; tagId: string | null } = { brandId: null, tagId: null };
  record('search.brand', 'qloo.search', `GET /search?query=${brand}&types=urn:entity:brand`, search, (body) => {
    const es = entitiesOf(body);
    found.brandId = (es[0]?.entity_id as string | undefined) ?? null;
    return es.length > 0
      ? { status: 'available', detail: `${es.length} result(s); top "${String(es[0]!.name ?? '?')}" (${found.brandId})` }
      : { status: 'degraded', detail: 'no results for this brand' };
  });
  await pause();

  // 2. Look up one relevant tag.
  const tags = await call('/v2/tags', { 'filter.query': tag, take: '5' });
  record('tags.lookup', 'qloo.tags', `GET /v2/tags?filter.query=${tag}`, tags, (body) => {
    const ts = tagsOf(body);
    found.tagId = (ts[0]?.id ?? ts[0]?.tag_id ?? null) as string | null;
    return ts.length > 0
      ? { status: 'available', detail: `${ts.length} tag(s); top "${String(ts[0]!.name ?? '?')}" (${found.tagId})` }
      : { status: 'degraded', detail: 'no tags for this query' };
  });
  await pause();

  // 3 + 4. Insights per category from the resolved brand, with explainability.
  let explained = 0;
  let insightRows = 0;
  const brandId = found.brandId;
  const tagId = found.tagId;
  if (brandId) {
    for (const type of ['artist', 'movie', 'brand', 'place']) {
      const r = await call('/v2/insights', {
        'filter.type': `urn:entity:${type}`,
        'signal.interests.entities': brandId,
        'feature.explainability': 'true',
        take: '5',
      });
      record(`insights.${type}`, 'qloo.insights', `GET /v2/insights?filter.type=urn:entity:${type}&signal.interests.entities=<brand>&feature.explainability=true`, r, (body) => {
        const es = entitiesOf(body);
        const ex = es.filter(hasExplainability).length;
        explained += ex;
        insightRows += es.length;
        return es.length > 0
          ? { status: 'available', detail: `${es.length} ${type} result(s); explainability on ${ex}` }
          : { status: 'degraded', detail: `no ${type} results` };
      });
      await pause();
    }
    results.push({
      id: 'insights.explainability',
      capability: 'qloo.insights.explainability',
      request: 'feature.explainability=true on the insights probes above',
      status: insightRows === 0 ? 'skipped' : explained > 0 ? 'available' : 'unavailable',
      http_status: null,
      detail: insightRows === 0 ? 'no insight results to inspect' : `contributing inputs present on ${explained} of ${insightRows} result(s)`,
      duration_ms: 0,
    });
  } else {
    for (const id of ['insights.artist', 'insights.movie', 'insights.brand', 'insights.place', 'insights.explainability']) {
      results.push({ id, capability: id === 'insights.explainability' ? 'qloo.insights.explainability' : 'qloo.insights', request: '-', status: 'skipped', http_status: null, detail: 'brand did not resolve', duration_ms: 0 });
    }
  }

  // Tag signal (style anchors use tags rather than entities).
  if (tagId) {
    const r = await call('/v2/insights', { 'filter.type': 'urn:entity:brand', 'signal.interests.tags': tagId, take: '5' });
    record('insights.tag_signal', 'qloo.insights', 'GET /v2/insights?filter.type=urn:entity:brand&signal.interests.tags=<tag>', r, (body) => {
      const es = entitiesOf(body);
      return es.length > 0 ? { status: 'available', detail: `${es.length} brand result(s) from a tag signal` } : { status: 'degraded', detail: 'no results from a tag signal' };
    });
    await pause();
  }

  // Optional trend routes (inspector only).
  const end = now();
  const start = new Date(end.getTime() - 28 * 86_400_000);
  if (brandId) {
    const tr = await call('/v2/trending', {
      'signal.interests.entities': brandId,
      'filter.type': 'urn:entity:brand',
      'filter.start_date': isoDate(start),
      'filter.end_date': isoDate(end),
      take: '5',
    });
    record('trending', 'qloo.trending', 'GET /v2/trending?filter.type=urn:entity:brand&signal.interests.entities=<brand>&filter.start_date&filter.end_date', tr, (body) => {
      const es = entitiesOf(body);
      return es.length > 0 ? { status: 'available', detail: `${es.length} trending result(s)` } : { status: 'degraded', detail: 'no trending results' };
    });
    await pause();
    const te = await call('/trends/entity', { entity_id: brandId, start_date: isoDate(start), end_date: isoDate(end) });
    record('trends.entity', 'qloo.trends_entity', 'GET /trends/entity?entity_id=<brand>&start_date&end_date', te, (body) => {
      const points = arr(obj(obj(body).results).trends).length || arr(obj(body).results).length;
      return points > 0 ? { status: 'available', detail: `${points} trend point(s)` } : { status: 'degraded', detail: 'no trend points' };
    });
    await pause();
  }

  // Auth scheme check: a wrong key must be rejected (confirms X-Api-Key is enforced).
  const bad = await call('/search', { query: brand, take: '1' }, 'invalid-probe-key');
  results.push({
    id: 'auth.invalid_key',
    capability: 'qloo.auth',
    request: 'GET /search with an invalid X-Api-Key',
    status: bad.status === 401 || bad.status === 403 ? 'available' : 'degraded',
    http_status: bad.status,
    detail: bad.status === 401 || bad.status === 403 ? `rejected as expected (HTTP ${bad.status})` : `unexpected: HTTP ${bad.status ?? 'none'}`,
    duration_ms: bad.ms,
  });

  return run;
}

/** Best status per capability: available > degraded > unavailable > skipped. */
export function summarizeCapabilities(run: ProbeRun): Map<string, { status: ProbeStatus; detail: string }> {
  const rank: Record<ProbeStatus, number> = { available: 3, degraded: 2, unavailable: 1, skipped: 0 };
  const out = new Map<string, { status: ProbeStatus; detail: string }>();
  for (const r of run.results) {
    const prev = out.get(r.capability);
    if (!prev || rank[r.status] > rank[prev.status]) out.set(r.capability, { status: r.status, detail: r.detail });
  }
  return out;
}

export function rateLimitSummary(run: ProbeRun): string {
  const seen = run.results.map((r) => r.rate_limit).filter((x): x is RateLimitObservation => !!x);
  const limited = run.results.filter((r) => r.http_status === 429).length;
  if (seen.length === 0) return `no rate-limit headers observed; ${limited} request(s) answered 429`;
  const last = seen.at(-1)!;
  return `headers observed: limit ${last.limit ?? '?'}, remaining ${last.remaining ?? '?'}, reset ${last.reset ?? '?'}; ${limited} request(s) answered 429`;
}

export const PROBE_BEGIN = '<!-- qloo-probe:begin (generated by scripts/qloo-probe.ts; do not edit by hand) -->';
export const PROBE_END = '<!-- qloo-probe:end -->';

export function renderProbeSection(run: ProbeRun): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    PROBE_BEGIN,
    '## Qloo probe results',
    '',
    `Last run ${run.started_at} against \`${run.base_url}\`. Rate limits: ${rateLimitSummary(run)}.`,
    '',
    '| Probe | Capability | Status | HTTP | Detail | ms |',
    '| --- | --- | --- | --- | --- | --- |',
    ...run.results.map((r) => `| \`${r.id}\` | \`${r.capability}\` | ${r.status} | ${r.http_status ?? '-'} | ${esc(r.detail)} | ${r.duration_ms} |`),
    '',
    'Not answerable by probes (confirm with Qloo and record in the access table above): permitted storage of responses, public display of provider images and metadata.',
    PROBE_END,
  ];
  return lines.join('\n');
}

/**
 * Write the probe results into the capability matrix: replaces the generated
 * section (or appends it) and updates the Status and Result columns of the
 * Qloo capability rows. Idempotent.
 */
export function updateCapabilityMatrix(markdown: string, run: ProbeRun): string {
  const caps = summarizeCapabilities(run);
  const date = run.started_at.slice(0, 10);
  const rows = markdown.split('\n').map((line) => {
    const m = /^\| `(qloo\.[a-z_.]+)` \|/.exec(line);
    if (!m) return line;
    const cap = caps.get(m[1]!);
    if (!cap) return line;
    const cells = line.split(' | ');
    if (cells.length < 5) return line;
    cells[2] = cap.status === 'skipped' ? 'unverified (probe skipped)' : `${cap.status} (probed ${date})`;
    cells[4] = `${cap.detail.replace(/\|/g, '\\|')} |`;
    return cells.slice(0, 5).join(' | ');
  });
  let out = rows.join('\n');
  const section = renderProbeSection(run);
  const b = out.indexOf(PROBE_BEGIN);
  const e = out.indexOf(PROBE_END);
  if (b >= 0 && e > b) out = `${out.slice(0, b)}${section}${out.slice(e + PROBE_END.length)}`;
  else out = `${out.replace(/\s*$/, '')}\n\n${section}\n`;
  return out;
}
