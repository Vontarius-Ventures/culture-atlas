/**
 * Error thrown by every adapter. Domain code maps these to AppError codes
 * (provider_unavailable / rate_limited) and decides retries; adapters do not
 * retry beyond a single transport-level attempt unless documented.
 */
export type ProviderErrorKind =
  | 'unavailable' // not configured, circuit open, or capability not accessible
  | 'auth' // 401/403 from provider
  | 'rate_limited' // 429
  | 'timeout'
  | 'bad_request' // 400/422: our request was wrong
  | 'not_found' // 404
  | 'server' // 5xx
  | 'invalid_response' // response failed schema validation
  | 'incomplete_response' // structured model response truncated or otherwise incomplete
  | 'content_rejected' // model refused / unsupported content
  | 'aborted'
  | 'budget_exhausted'; // per-job request/retry budget reached (never retried)

export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** Gateway request id for operator correlation (never a secret). */
  readonly requestId?: string;

  constructor(
    provider: string,
    kind: ProviderErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown; requestId?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }

  /** Transient errors are retried with backoff (bounded per stage). */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'timeout' || this.kind === 'server';
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/**
 * Per-job request budget (build spec: at most 12 Qloo requests per job and two
 * retries per provider stage). Adapters call `take` before EVERY HTTP attempt;
 * `kind` is 'retry' for attempts after the first. Returning false stops the
 * call with ProviderError('budget_exhausted').
 */
export interface RequestBudget {
  take(provider: string, kind: 'request' | 'retry'): boolean;
}

/** Observes each HTTP attempt (for provider_queries / traces). Never receives secrets. */
export interface AttemptObserver {
  (event: {
    provider: string;
    operation: string;
    attempt: number;
    status: number | null;
    durationMs: number;
    error?: ProviderErrorKind;
  }): void;
}

/** Common per-call options. */
export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Correlates provider_queries / trace_events. */
  traceId?: string;
  /** Retries for transient errors (429/timeout/5xx). Default: adapter-specific (2). */
  maxRetries?: number;
  budget?: RequestBudget;
  onAttempt?: AttemptObserver;
  /** Verified server-owned context required by budgeted model gateways. */
  modelIdentity?: {
    accountId: string;
    jobId: string;
    attemptKey: string;
    assetId?: string;
    queueAttemptId?: string;
  };
}
