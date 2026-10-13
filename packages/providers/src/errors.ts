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
  | 'content_rejected' // model refused / unsupported content
  | 'aborted';

export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    provider: string,
    kind: ProviderErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** Transient errors are retried with backoff (bounded per stage). */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'timeout' || this.kind === 'server';
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/** Common per-call options. */
export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Correlates provider_queries / trace_events. */
  traceId?: string;
}
