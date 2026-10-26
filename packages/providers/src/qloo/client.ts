import { createHash } from 'node:crypto';
import { type CapabilityEntry, type CapabilityReason } from '../capabilities';
import type { ProviderConfig } from '../config';
import { ProviderError, type CallOptions, type ProviderErrorKind } from '../errors';
import { sharedLimiter, type ConcurrencyLimiter } from '../http/concurrency';
import { attemptSignal, CircuitBreaker, parseRetryAfter, retriesFor, withRetries, type Sleep } from '../http/resilience';
import { resolveFromWorkspace } from '../paths';
import { UnavailableQloo } from '../unavailable';
import { parseEntityTrends, parseInsights, parseSearch, parseTags, parseTrending, QlooShapeError } from './parse';
import { createReplayQloo } from './replay';
import type {
  QlooCapabilities,
  QlooEntity,
  QlooEntityTrendsRequest,
  QlooEntityTrendsResult,
  QlooInsightsRequest,
  QlooInsightsResult,
  QlooProvider,
  QlooResponse,
  QlooSanitizedRequest,
  QlooSearchRequest,
  QlooTag,
  QlooTagsRequest,
  QlooTrendingRequest,
  QlooTrendingResult,
} from './types';

/**
 * HTTP Qloo adapter over the documented API (https://github.com/qloo/docs-public):
 *   GET /search, GET /v2/tags, GET /v2/insights, GET /v2/trending, GET /trends/entity
 * Auth: `X-Api-Key` header; base URL: QLOO_API_URL.
 *
 * Resilience: per-attempt timeout (QLOO_TIMEOUT_MS), bounded retries with
 * exponential backoff + jitter for 429/timeouts/5xx (Retry-After honored),
 * a circuit breaker shared by all calls on this instance, and an optional
 * per-job RequestBudget charged before every attempt.
 *
 * Capabilities start 'unverified/probe_pending' (calls are attempted) and are
 * updated from observed outcomes: success -> available; 401/403 ->
 * unavailable/access_denied; open circuit -> degraded/circuit_open.
 * With no QLOO_API_KEY this factory returns UnavailableQloo (or, only when
 * explicitly enabled, a replay provider whose results are flagged is_replay).
 */

type Operation = 'search' | 'tags' | 'insights' | 'trending' | 'trendsEntity';

const OP_CAPABILITY: Record<Operation, keyof QlooCapabilities> = {
  search: 'search',
  tags: 'tags',
  insights: 'insights',
  trending: 'trending',
  trendsEntity: 'trendsEntity',
};

export interface QlooHttpOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  breaker?: CircuitBreaker;
  sleep?: Sleep;
  random?: () => number;
  now?: () => Date;
  /** Default retries for transient errors when the caller does not pass maxRetries. */
  defaultRetries?: number;
  /**
   * Requests in flight at once. Defaults to the process-wide limiter for this
   * API key (QLOO_MAX_CONCURRENCY, default 3), shared by every Qloo caller.
   */
  limiter?: ConcurrencyLimiter;
  /**
   * Cross-process admission for the shared key (style design R-11): a token
   * bucket and a daily request limit kept in Postgres. Called once per HTTP
   * attempt while holding a limiter slot; throws ProviderError
   * 'budget_exhausted' past the daily limit.
   */
  gate?: QlooRateGate;
}

/** Cross-process admission for one Qloo key (implemented over Postgres by the domain runtime). */
export interface QlooRateGate {
  acquire(signal?: AbortSignal): Promise<void>;
}

type QueryValue = string | number | boolean | readonly string[] | undefined | null;

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'bad_request';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** Default Qloo requests in flight per process and key (the hackathon key throttles bursts). */
export const DEFAULT_QLOO_CONCURRENCY = 3;

export function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

export class QlooHttpProvider implements QlooProvider {
  readonly id = 'qloo:http';
  readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  readonly limiter: ConcurrencyLimiter;
  private readonly observed = new Map<keyof QlooCapabilities, CapabilityEntry>();

  constructor(private readonly options: QlooHttpOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.breaker = options.breaker ?? new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 });
    this.limiter = options.limiter ?? sharedLimiter(`qloo:${options.baseUrl}:${keyFingerprint(options.apiKey)}`, DEFAULT_QLOO_CONCURRENCY);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  capability(): QlooCapabilities {
    const base = (name: keyof QlooCapabilities): CapabilityEntry => {
      const seen = this.observed.get(name);
      if (this.breaker.state === 'open' && seen?.status !== 'unavailable') {
        return { status: 'degraded', reason: 'circuit_open', detail: 'Qloo circuit is open after repeated failures', checked_at: this.now().toISOString(), provider: 'qloo' };
      }
      return seen ?? { status: 'unverified', reason: 'probe_pending', detail: 'Configured; run scripts/probe-qloo.ts to verify', checked_at: null, provider: 'qloo' };
    };
    const insights = base('insights');
    const explain = this.observed.get('explainability') ?? (insights.status === 'available' ? { ...insights, status: 'unverified' as const, reason: 'probe_pending' as const } : insights);
    return {
      search: base('search'),
      tags: base('tags'),
      insights,
      explainability: explain,
      trending: base('trending'),
      trendsEntity: base('trendsEntity'),
    };
  }

  private observe(op: Operation, status: CapabilityEntry['status'], reason?: CapabilityReason, detail?: string) {
    this.observed.set(OP_CAPABILITY[op], { status, reason, detail, checked_at: this.now().toISOString(), provider: 'qloo' });
  }

  private buildQuery(query: Record<string, QueryValue>): { search: URLSearchParams; sanitized: Record<string, string | string[]> } {
    const search = new URLSearchParams();
    const sanitized: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        search.set(key, value.join(','));
        sanitized[key] = [...value];
      } else {
        search.set(key, String(value));
        sanitized[key] = String(value);
      }
    }
    return { search, sanitized };
  }

  private async request<T>(
    op: Operation,
    path: string,
    query: Record<string, QueryValue>,
    parse: (body: unknown) => T,
    options: CallOptions | undefined,
    isEmpty: (data: T) => boolean,
  ): Promise<QlooResponse<T>> {
    const { search, sanitized } = this.buildQuery(query);
    const request: QlooSanitizedRequest = { method: 'GET', path, query: sanitized };
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}${path}?${search.toString()}`;
    const timeoutMs = options?.timeoutMs ?? this.options.timeoutMs;

    // Each HTTP attempt holds one slot of the shared limiter; queueing does not eat the timeout.
    const attempt = (n: number): Promise<QlooResponse<T>> =>
      this.limiter.run(
        async () => {
          await this.options.gate?.acquire(options?.signal);
          return attemptOnce(n);
        },
        { signal: options?.signal, provider: 'qloo' },
      );
    const attemptOnce = async (n: number): Promise<QlooResponse<T>> => {
      const started = Date.now();
      const sig = attemptSignal(options?.signal, timeoutMs);
      let status: number | null = null;
      try {
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method: 'GET',
            headers: { 'X-Api-Key': this.options.apiKey, Accept: 'application/json' },
            signal: sig.signal,
            redirect: 'error',
          });
        } catch (err) {
          if (sig.timedOut()) throw new ProviderError('qloo', 'timeout', `qloo ${op} timed out after ${timeoutMs}ms`, { cause: err });
          if (options?.signal?.aborted) throw new ProviderError('qloo', 'aborted', `qloo ${op} aborted`, { cause: err });
          throw new ProviderError('qloo', 'server', `qloo ${op} connection failed`, { cause: err });
        }
        status = res.status;
        let body: unknown = null;
        const text = await res.text().catch(() => '');
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
        }
        if (!res.ok) {
          const kind = kindForStatus(res.status);
          // A 429 backs off at least 1100 ms (style design R-11: the key allows 10 requests per second).
          const parsedRetry = parseRetryAfter(res.headers.get('retry-after'));
          const retryAfterMs = kind === 'rate_limited' ? Math.max(parsedRetry ?? 0, 1100) : parsedRetry;
          if (kind === 'auth') this.observe(op, 'unavailable', 'access_denied', `HTTP ${res.status}`);
          throw new ProviderError('qloo', kind, `qloo ${op} failed with HTTP ${res.status}`, { status: res.status, retryAfterMs });
        }
        let data: T;
        try {
          data = parse(body);
        } catch (err) {
          if (err instanceof QlooShapeError) throw new ProviderError('qloo', 'invalid_response', `qloo ${op}: ${err.message}`, { status: res.status, cause: err });
          throw err;
        }
        this.observe(op, 'available', undefined, isEmpty(data) ? 'last call returned no results' : undefined);
        if (op === 'insights' && query['feature.explainability'] === true) {
          const hasExplain = (data as unknown as QlooInsightsResult).entities.some((e) => e.query?.explainability?.length);
          if (hasExplain) this.observed.set('explainability', { status: 'available', checked_at: this.now().toISOString(), provider: 'qloo' });
        }
        return {
          data,
          request,
          status: res.status,
          retrieved_at: this.now().toISOString(),
          duration_ms: Date.now() - started,
          raw: body,
          is_replay: false,
          rate_limit: readRateLimit(res.headers),
        };
      } catch (err) {
        options?.onAttempt?.({
          provider: 'qloo',
          operation: op,
          attempt: n,
          status,
          durationMs: Date.now() - started,
          error: err instanceof ProviderError ? err.kind : 'server',
        });
        throw err;
      } finally {
        sig.dispose();
      }
    };

    return withRetries(
      async (n) => {
        const out = await attempt(n);
        options?.onAttempt?.({ provider: 'qloo', operation: op, attempt: n, status: out.status, durationMs: out.duration_ms });
        return out;
      },
      {
        provider: 'qloo',
        maxRetries: retriesFor(options, this.options.defaultRetries ?? 2),
        budget: options?.budget,
        breaker: this.breaker,
        signal: options?.signal,
        sleep: this.options.sleep,
        random: this.options.random,
      },
    );
  }

  async searchEntities(req: QlooSearchRequest, options?: CallOptions): Promise<QlooResponse<QlooEntity[]>> {
    if (!req.query.trim()) throw new ProviderError('qloo', 'bad_request', 'search query is empty');
    return this.request(
      'search',
      '/search',
      { query: req.query.trim(), types: req.types, take: Math.min(req.take ?? 5, 100) },
      parseSearch,
      options,
      (d) => d.length === 0,
    );
  }

  async lookupTags(req: QlooTagsRequest, options?: CallOptions): Promise<QlooResponse<QlooTag[]>> {
    return this.request(
      'tags',
      '/v2/tags',
      { 'filter.query': req.query.trim(), 'filter.tag.types': req.tagTypes, take: Math.min(req.take ?? 5, 50), page: req.page },
      parseTags,
      options,
      (d) => d.length === 0,
    );
  }

  async insights(req: QlooInsightsRequest, options?: CallOptions): Promise<QlooResponse<QlooInsightsResult>> {
    if (!req.signalEntities?.length && !req.signalTags?.length && !req.signalLocationQuery && !req.filterTags?.length && !req.filterLocationQuery) {
      throw new ProviderError('qloo', 'bad_request', 'insights requires at least one signal');
    }
    const weighted = req.signalTags?.some((t) => t.weight !== undefined);
    return this.request(
      'insights',
      '/v2/insights',
      {
        'filter.type': req.filterType,
        'signal.interests.entities': req.signalEntities,
        // GET supports comma-separated tag ids; weights are only documented for POST,
        // so weighted tags are sent unweighted (order preserved by weight).
        'signal.interests.tags': weighted
          ? [...(req.signalTags ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).map((t) => t.id)
          : req.signalTags?.map((t) => t.id),
        'signal.location.query': req.signalLocationQuery,
        'filter.location.query': req.filterLocationQuery,
        'filter.popularity.min': req.filterPopularityMin,
        'filter.results.entities': req.filterResultsEntities,
        'filter.tags': req.filterTags,
        'filter.tag.types': req.filterTagTypes,
        'bias.trends': req.biasTrends,
        'feature.explainability': req.explainability ? true : undefined,
        take: Math.min(req.take ?? 10, 50),
        page: req.page,
      },
      parseInsights,
      options,
      (d) => d.entities.length === 0 && d.tags.length === 0,
    );
  }

  async trending(req: QlooTrendingRequest, options?: CallOptions): Promise<QlooResponse<QlooTrendingResult>> {
    return this.request(
      'trending',
      '/v2/trending',
      {
        'signal.interests.entities': req.signalEntities,
        'filter.type': req.filterType,
        'filter.start_date': req.startDate,
        'filter.end_date': req.endDate,
        take: Math.min(req.take ?? 10, 50),
        page: req.page,
      },
      parseTrending,
      options,
      (d) => d.entities.length === 0,
    );
  }

  async entityTrends(req: QlooEntityTrendsRequest, options?: CallOptions): Promise<QlooResponse<QlooEntityTrendsResult>> {
    return this.request(
      'trendsEntity',
      '/trends/entity',
      { entity_id: req.entityId, start_date: req.startDate, end_date: req.endDate },
      (body) => parseEntityTrends(body, req.entityId),
      options,
      (d) => d.points.length === 0,
    );
  }
}

function readRateLimit(headers: Headers): QlooResponse<unknown>['rate_limit'] {
  const num = (name: string) => {
    const v = headers.get(name);
    return v !== null && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const limit = num('x-ratelimit-limit');
  const remaining = num('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset') ?? undefined;
  if (limit === undefined && remaining === undefined && !reset) return undefined;
  return { limit, remaining, reset_at: reset };
}

/**
 * Factory. No key -> UnavailableQloo('not_configured') (never fabricated), or,
 * only when QLOO_REPLAY_FIXTURES is enabled and recorded responses exist, a
 * replay provider whose every response has is_replay=true ("Example result").
 */
export function createQlooProvider(config: ProviderConfig, options: Partial<Omit<QlooHttpOptions, 'apiKey' | 'baseUrl' | 'timeoutMs'>> = {}): QlooProvider {
  // Every process spaces dispatches at least QLOO_MIN_SPACING_MS apart (R-11).
  if (!config.QLOO_API_KEY) {
    if (config.QLOO_REPLAY_FIXTURES) {
      const replay = createReplayQloo(config.QLOO_REPLAY_DIR ? resolveFromWorkspace(config.QLOO_REPLAY_DIR) : undefined);
      if (replay) return replay;
    }
    return new UnavailableQloo('not_configured');
  }
  const limiter = sharedLimiter(`qloo:${config.QLOO_API_URL}:${keyFingerprint(config.QLOO_API_KEY)}`, config.QLOO_MAX_CONCURRENCY, config.QLOO_MIN_SPACING_MS);
  return new QlooHttpProvider({ apiKey: config.QLOO_API_KEY, baseUrl: config.QLOO_API_URL, timeoutMs: config.QLOO_TIMEOUT_MS, limiter, ...options });
}
