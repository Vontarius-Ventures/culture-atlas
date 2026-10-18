import {
  isProviderError,
  isUsable,
  ProviderError,
  type CapabilityEntry,
  type QlooEntity,
  type QlooInsightsRequest,
  type QlooProvider,
  type QlooResponse,
} from '@culture-atlas/providers';

/**
 * Bounded provider access for composer/related-discovery jobs:
 *  - at most `maxRequests` Qloo requests per job (spec: 12);
 *  - at most `maxRetries` retries per call for transient errors (429, timeouts,
 *    5xx) with exponential backoff + jitter, honoring Retry-After;
 *  - every attempt (success, empty or error) is recorded for provider_queries
 *    so each displayed Qloo-derived item links to a real returned query.
 * Never fabricates results: an unavailable provider throws and the caller
 * marks the section 'unavailable'.
 */

/** Longest provider-requested delay waited inline; longer ones re-queue the job. */
export const MAX_INLINE_DELAY_MS = 5_000;

export class BudgetExhaustedError extends Error {
  constructor() {
    super('provider request budget exhausted');
    this.name = 'BudgetExhaustedError';
  }
}

/** One recorded provider call (persisted to provider_queries by the caller). */
export interface RecordedQuery {
  /** Pre-generated id so recommendations can cite it before persistence. */
  id: string;
  provider: 'qloo' | 'text_model';
  operation: string;
  sanitized_request: unknown;
  results: unknown;
  status: 'ok' | 'empty' | 'error';
  http_status: number | null;
  error_code: string | null;
  duration_ms: number | null;
  is_replay: boolean;
  retrieved_at: string;
  query_context: Record<string, unknown>;
}

export interface CallBudgetOptions {
  maxRequests: number;
  maxRetries: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
  newId: () => string;
  /**
   * Retries the provider adapter may make on its own inside one counted
   * request. Unset keeps the adapter default; 0 makes every HTTP request a
   * counted session request (strict request caps such as the taste seed's 6).
   */
  clientMaxRetries?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('qloo', 'aborted', 'aborted'));
    });
  });

/** Compact, storable view of entities (no raw provider payloads). */
export function summarizeEntities(entities: readonly QlooEntity[]): unknown[] {
  return entities.map((e, idx) => ({
    rank: idx + 1,
    entity_id: e.entity_id,
    name: e.name,
    types: e.types,
    affinity: e.query?.affinity ?? null,
    explainability: e.query?.explainability ?? null,
  }));
}

export class QlooSession {
  readonly recorded: RecordedQuery[] = [];
  private used = 0;

  constructor(
    private readonly qloo: QlooProvider,
    private readonly options: CallBudgetOptions,
  ) {}

  get requestsUsed(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.options.maxRequests - this.used);
  }

  /** Whether insights can be attempted at all (capability not 'unavailable'). */
  insightsUsable(): boolean {
    return isUsable(this.qloo.capability().insights);
  }

  searchUsable(): boolean {
    return isUsable(this.qloo.capability().search);
  }

  capability(): CapabilityEntry {
    return this.qloo.capability().insights;
  }

  private async withRetries<T>(
    operation: string,
    context: Record<string, unknown>,
    fn: () => Promise<QlooResponse<T>>,
    summarize: (data: T) => { results: unknown; empty: boolean },
  ): Promise<{ response: QlooResponse<T>; queryId: string }> {
    let attempt = 0;
    for (;;) {
      if (this.used >= this.options.maxRequests) throw new BudgetExhaustedError();
      this.used++;
      const id = this.options.newId();
      const started = Date.now();
      try {
        const response = await fn();
        const s = summarize(response.data);
        this.recorded.push({
          id,
          provider: 'qloo',
          operation,
          sanitized_request: response.request,
          results: s.results,
          status: s.empty ? 'empty' : 'ok',
          http_status: response.status,
          error_code: null,
          duration_ms: response.duration_ms,
          is_replay: response.is_replay,
          retrieved_at: response.retrieved_at,
          query_context: context,
        });
        return { response, queryId: id };
      } catch (err) {
        const pe = isProviderError(err) ? err : null;
        this.recorded.push({
          id,
          provider: 'qloo',
          operation,
          sanitized_request: { operation, context },
          results: null,
          status: 'error',
          http_status: pe?.status ?? null,
          error_code: pe?.kind ?? 'internal',
          duration_ms: Date.now() - started,
          is_replay: false,
          retrieved_at: new Date().toISOString(),
          query_context: context,
        });
        if (!pe || !pe.retryable || attempt >= this.options.maxRetries) throw err;
        // A long Retry-After is honored by re-queuing the job (the worker reads retryAfterMs).
        if ((pe.retryAfterMs ?? 0) > MAX_INLINE_DELAY_MS) throw err;
        attempt++;
        const base = this.options.baseDelayMs ?? 250;
        const exp = base * 2 ** (attempt - 1);
        const delay = pe.retryAfterMs ?? Math.floor(exp / 2 + Math.random() * (exp / 2));
        await (this.options.sleep ?? ((ms: number) => defaultSleep(ms, this.options.signal)))(delay);
      }
    }
  }

  async insights(req: QlooInsightsRequest, context: Record<string, unknown>, call: { timeoutMs?: number } = {}) {
    return this.withRetries(
      'insights',
      { ...context, filter_type: req.filterType },
      () =>
        this.qloo.insights(req, {
          signal: this.options.signal,
          ...(this.options.clientMaxRetries === undefined ? {} : { maxRetries: this.options.clientMaxRetries }),
          ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
        }),
      (d) => ({ results: { entities: summarizeEntities(d.entities), tags: d.tags.slice(0, 20) }, empty: d.entities.length === 0 && d.tags.length === 0 }),
    );
  }

  async search(query: string, types: QlooInsightsRequest['filterType'][] | undefined, context: Record<string, unknown>) {
    return this.withRetries(
      'search',
      context,
      () =>
        this.qloo.searchEntities(
          { query, types: types?.filter((t): t is Exclude<typeof t, 'urn:tag' | 'urn:demographics'> => t.startsWith('urn:entity:')), take: 3 },
          { signal: this.options.signal },
        ),
      (d) => ({ results: summarizeEntities(d), empty: d.length === 0 }),
    );
  }
}

/** Retry a text-model call on transient errors (bounded), no budget accounting. */
export async function withProviderRetries<T>(
  fn: () => Promise<T>,
  options: { maxRetries: number; sleep?: (ms: number) => Promise<void>; baseDelayMs?: number },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isProviderError(err) || !err.retryable || attempt >= options.maxRetries) throw err;
      if ((err.retryAfterMs ?? 0) > MAX_INLINE_DELAY_MS) throw err;
      attempt++;
      const exp = (options.baseDelayMs ?? 250) * 2 ** (attempt - 1);
      await (options.sleep ?? ((ms: number) => defaultSleep(ms)))(err.retryAfterMs ?? Math.floor(exp / 2 + Math.random() * (exp / 2)));
    }
  }
}
