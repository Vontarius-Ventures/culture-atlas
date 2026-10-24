import { ProviderError } from '../errors';

/**
 * A FIFO concurrency limiter. Qloo's hackathon key throttles bursts, so every
 * Qloo caller in one process (onboarding search, the taste seed job, capture
 * analysis resolution, related discovery) shares one limiter per API key
 * (spec amendment 2.2, build plan "Risks"). Waiting for a slot does not count
 * toward a request's own timeout, but honours the caller's abort signal.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private peakActive = 0;
  private readonly waiting: { resolve: () => void; reject: (err: unknown) => void; cleanup: () => void }[] = [];
  /** Earliest time the next slot holder may start (minimum spacing between dispatches). */
  private nextStartAt = 0;

  /**
   * @param minSpacingMs minimum gap between two slot starts (style design R-11:
   *   the Qloo key allows about 10 requests a second; a burst of 11 got a 429).
   */
  constructor(
    readonly max: number,
    readonly minSpacingMs = 0,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(max) || max < 1) throw new Error('ConcurrencyLimiter max must be a positive integer');
    if (!Number.isFinite(minSpacingMs) || minSpacingMs < 0) throw new Error('ConcurrencyLimiter spacing must be >= 0');
  }

  get inFlight(): number {
    return this.active;
  }

  /** Highest number of slots held at once since construction (for tests and metrics). */
  get peak(): number {
    return this.peakActive;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>, opts: { signal?: AbortSignal; provider?: string } = {}): Promise<T> {
    await this.acquire(opts.signal, opts.provider ?? 'qloo');
    try {
      await this.space(opts.signal, opts.provider ?? 'qloo');
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Waits until minSpacingMs has passed since the previous slot holder started. */
  private async space(signal: AbortSignal | undefined, provider: string): Promise<void> {
    if (!this.minSpacingMs) return;
    const now = this.now();
    const startAt = Math.max(now, this.nextStartAt);
    this.nextStartAt = startAt + this.minSpacingMs;
    const wait = startAt - now;
    if (wait <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, wait);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ProviderError(provider, 'aborted', `${provider} request aborted while queued`));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private acquire(signal: AbortSignal | undefined, provider: string): Promise<void> {
    if (signal?.aborted) return Promise.reject(new ProviderError(provider, 'aborted', `${provider} request aborted while queued`));
    if (this.active < this.max) {
      this.take();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new ProviderError(provider, 'aborted', `${provider} request aborted while queued`));
      };
      const entry = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  private take(): void {
    this.active += 1;
    if (this.active > this.peakActive) this.peakActive = this.active;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) {
      next.cleanup();
      this.take();
      next.resolve();
    }
  }
}

const shared = new Map<string, ConcurrencyLimiter>();

/** The process-wide limiter for one key (created on first use). */
export function sharedLimiter(key: string, max: number, minSpacingMs = 0): ConcurrencyLimiter {
  const id = `${key}#${max}#${minSpacingMs}`;
  let limiter = shared.get(id);
  if (!limiter) {
    limiter = new ConcurrencyLimiter(max, minSpacingMs);
    shared.set(id, limiter);
  }
  return limiter;
}
