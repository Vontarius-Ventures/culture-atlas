import { ProviderError, type CallOptions, type RequestBudget } from '../errors';

/**
 * Shared resilience primitives for provider adapters:
 *  - exponential backoff with jitter,
 *  - Retry-After parsing (429/503),
 *  - a circuit breaker per provider instance,
 *  - withRetries(): bounded retries that consult the per-job RequestBudget
 *    before every attempt and honor provider rate limits.
 */

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** base * 2^attempt capped, with "equal jitter" (50-100% of the exponential value). */
export function backoffDelay(attempt: number, baseMs = 250, capMs = 8_000, random: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(exp / 2 + random() * (exp / 2));
}

/** Retry-After as delta-seconds or an HTTP date. Returns ms, or undefined. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive transient failures that open the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial request. */
  cooldownMs?: number;
  now?: () => number;
}

/**
 * Classic three-state breaker. Only transient upstream failures (timeouts,
 * 5xx, connection errors) count; 4xx and rate limits do not open it.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  /** Whether a request may be sent now. In half-open state only one trial is allowed. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  onFailure(): void {
    this.trialInFlight = false;
    if (this.openedAt !== null) {
      // Failed trial: stay open for another cooldown.
      this.openedAt = this.now();
      return;
    }
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }

  /** A non-transient outcome (e.g. 404) releases a half-open trial without changing state. */
  onNeutral(): void {
    this.trialInFlight = false;
    if (this.openedAt !== null && this.state === 'half_open') this.onSuccess();
  }
}

export interface RetryOptions {
  provider: string;
  maxRetries: number;
  budget?: RequestBudget;
  breaker?: CircuitBreaker;
  signal?: AbortSignal;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A Retry-After longer than this is not waited for in-process: the error propagates (the job re-queues later). */
  maxRetryAfterMs?: number;
  sleep?: Sleep;
  random?: () => number;
}

function isTransient(err: ProviderError): boolean {
  return err.kind === 'timeout' || err.kind === 'server';
}

/**
 * Run `fn` with bounded retries for transient provider errors. Every attempt
 * (first and retries) is charged to the budget first; an exhausted budget
 * stops with ProviderError('budget_exhausted') and never calls the provider.
 */
export async function withRetries<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const doSleep = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new ProviderError(options.provider, 'aborted', 'request aborted');
    if (options.breaker && !options.breaker.tryAcquire()) {
      throw new ProviderError(options.provider, 'unavailable', `${options.provider} circuit is open`);
    }
    if (options.budget && !options.budget.take(options.provider, attempt === 0 ? 'request' : 'retry')) {
      options.breaker?.onNeutral();
      throw new ProviderError(options.provider, 'budget_exhausted', `${options.provider} request budget exhausted`);
    }
    try {
      const out = await fn(attempt);
      options.breaker?.onSuccess();
      return out;
    } catch (err) {
      if (!(err instanceof ProviderError)) {
        options.breaker?.onNeutral();
        throw err;
      }
      if (isTransient(err)) options.breaker?.onFailure();
      else options.breaker?.onNeutral();
      if (!err.retryable || attempt >= options.maxRetries) throw err;
      const backoff = backoffDelay(attempt, options.baseDelayMs ?? 250, options.maxDelayMs ?? 8_000, options.random);
      const wait = Math.max(backoff, err.retryAfterMs ?? 0);
      if (wait > (options.maxRetryAfterMs ?? 15_000)) throw err;
      try {
        await doSleep(wait, options.signal);
      } catch {
        throw new ProviderError(options.provider, 'aborted', 'request aborted during backoff');
      }
    }
  }
}

/** Combines a caller signal with a per-attempt timeout. `timedOut()` tells which fired. */
export function attemptSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('timeout'));
  }, timeoutMs);
  const onAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) controller.abort(callerSignal.reason);
  else callerSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Default retry count when the caller does not say. */
export function retriesFor(options: CallOptions | undefined, fallback = 2): number {
  return Math.max(0, options?.maxRetries ?? fallback);
}
