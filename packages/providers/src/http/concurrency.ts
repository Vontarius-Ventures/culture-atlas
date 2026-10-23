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

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error('ConcurrencyLimiter max must be a positive integer');
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
      return await fn();
    } finally {
      this.release();
    }
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
export function sharedLimiter(key: string, max: number): ConcurrencyLimiter {
  const id = `${key}#${max}`;
  let limiter = shared.get(id);
  if (!limiter) {
    limiter = new ConcurrencyLimiter(max);
    shared.set(id, limiter);
  }
  return limiter;
}
