import type { z } from 'zod';
import type { CapabilityEntry } from '../capabilities';
import { ProviderError, type CallOptions } from '../errors';
import { attemptSignal, CircuitBreaker, retriesFor, withRetries, type Sleep } from '../http/resilience';
import { mapAnthropicError, readStructured, type MessagesTransport, type TransportRequest } from './transport';

/**
 * Shared call loop for the LLM adapters (Anthropic SDK or Featherless transport): per-attempt timeout, bounded
 * budgeted retries, circuit breaker, structured-output validation, and an
 * observed capability (unverified until the first success).
 */
export class AnthropicRunner {
  readonly breaker = new CircuitBreaker({ failureThreshold: 4, cooldownMs: 30_000 });
  private observed: CapabilityEntry | null = null;

  constructor(
    readonly provider: 'vlm' | 'text',
    readonly model: string,
    private readonly transport: MessagesTransport,
    private readonly defaults: { timeoutMs: number; sleep?: Sleep; vendor?: string },
  ) {}

  private get providerId(): string {
    return `${this.defaults.vendor ?? 'anthropic'}:${this.model}`;
  }

  capability(): CapabilityEntry {
    const providerId = this.providerId;
    if (this.breaker.state === 'open') return { status: 'degraded', reason: 'circuit_open', provider: providerId, checked_at: new Date().toISOString() };
    return this.observed ?? { status: 'unverified', reason: 'probe_pending', detail: 'Configured; not yet called', provider: providerId, checked_at: null };
  }

  async run<T extends z.ZodType>(
    request: Omit<TransportRequest, 'model'>,
    options: CallOptions | undefined,
  ): Promise<{ data: z.infer<T>; model: string; durationMs: number; usage?: { inputTokens?: number; outputTokens?: number } }> {
    const started = Date.now();
    const timeoutMs = options?.timeoutMs ?? this.defaults.timeoutMs;
    return withRetries(
      async (attempt) => {
        const sig = attemptSignal(options?.signal, timeoutMs);
        const t0 = Date.now();
        try {
          const result = await this.transport({ ...request, model: this.model }, { signal: sig.signal, timeoutMs });
          const data = readStructured(this.provider, request.schema as T, result);
          this.observed = { status: 'available', provider: this.providerId, checked_at: new Date().toISOString() };
          options?.onAttempt?.({ provider: this.provider, operation: 'structured', attempt, status: 200, durationMs: Date.now() - t0 });
          return { data, model: result.model || this.model, durationMs: Date.now() - started, usage: result.usage };
        } catch (err) {
          const mapped = mapAnthropicError(this.provider, err, sig.timedOut(), !!options?.signal?.aborted);
          if (mapped.kind === 'auth') {
            this.observed = { status: 'unavailable', reason: 'access_denied', provider: this.providerId, checked_at: new Date().toISOString() };
          }
          options?.onAttempt?.({ provider: this.provider, operation: 'structured', attempt, status: mapped.status ?? null, durationMs: Date.now() - t0, error: mapped.kind });
          throw mapped;
        } finally {
          sig.dispose();
        }
      },
      {
        provider: this.provider,
        maxRetries: retriesFor(options, 2),
        budget: options?.budget,
        breaker: this.breaker,
        signal: options?.signal,
        sleep: this.defaults.sleep,
      },
    );
  }
}

export { ProviderError };
