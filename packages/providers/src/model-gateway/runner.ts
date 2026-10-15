import type { z } from 'zod';
import type { CapabilityEntry } from '../capabilities';
import { ModelProfileSchema, type ModelProfile } from '../concentrate/profiles';
import { ProviderError } from '../errors';
import { attemptSignal, backoffDelay, sleep, type Sleep } from '../http/resilience';
import type { ModelSpendLedger } from './budget';
import { strictJsonSchema, validateStrictShape } from './schema';
import type {
  GatewayCall,
  GatewayOptions,
  GatewayResponse,
  ModelIdentity,
  StructuredTransport,
} from './types';

export type GatewayReadiness =
  'configured' | 'catalog-compatible' | 'qualified' | 'available' | 'degraded' | 'unavailable';

export class StructuredResponseRunner {
  readonly profile: ModelProfile;
  private observed = false;
  private disabled = false;
  constructor(
    profile: ModelProfile,
    private readonly transport: StructuredTransport,
    private readonly ledger: ModelSpendLedger,
    private readonly defaults: {
      identity?: ModelIdentity;
      sleep?: Sleep;
      now?: () => number;
      allowTestStore?: boolean;
    } = {},
  ) {
    this.profile = ModelProfileSchema.parse(profile);
    if (!ledger.store.durable && !defaults.allowTestStore)
      throw new Error('Durable spend ledger required');
  }
  private get now() {
    return this.defaults.now ?? Date.now;
  }
  capability(): CapabilityEntry {
    return {
      status: this.disabled ? 'unavailable' : this.observed ? 'available' : 'unverified',
      reason: this.disabled ? 'access_denied' : this.observed ? undefined : 'probe_pending',
      provider: `${this.profile.gateway}:${this.profile.model}`,
      checked_at: null,
    };
  }
  /** Read-only local evidence and durable circuit state. Never sends a model probe. */
  async readiness(): Promise<GatewayReadiness> {
    if (this.disabled) return 'unavailable';
    if (await this.ledger.status()) return 'degraded';
    return this.observed ? 'available' : 'qualified';
  }
  async run<T extends z.ZodType>(
    request: GatewayCall<T>,
    options: GatewayOptions = {},
  ): Promise<{
    data: z.infer<T>;
    model: string;
    durationMs: number;
    usage?: { inputTokens?: number; outputTokens?: number };
    attemptId: string;
    responseId: string | null;
    actualProvider: string | null;
  }> {
    const profile = this.profile;
    const identity = options.modelIdentity ?? this.defaults.identity;
    if (!identity)
      throw new ProviderError(
        'model-gateway',
        'bad_request',
        'Verified analysis identity required',
      );
    if (this.disabled)
      throw new ProviderError(
        'model-gateway',
        'unavailable',
        'Model role disabled pending operator review',
      );
    const jsonSchema = strictJsonSchema(request.schema);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(request.schemaName))
      throw new ProviderError('model-gateway', 'bad_request', 'Invalid schema name');
    const textBytes =
      Buffer.byteLength(request.system) +
      request.content
        .filter((b) => b.type === 'text')
        .reduce((n, b) => n + Buffer.byteLength(b.text), 0);
    // UTF-8 bytes conservatively bound text tokens; include schema/instructions in the cap.
    const inputBytes = textBytes + Buffer.byteLength(JSON.stringify(jsonSchema));
    const images = request.content.filter((b) => b.type === 'image');
    if (
      inputBytes > profile.maxInputBytes ||
      inputBytes > profile.maxInputTokens ||
      images.length > profile.image.maxCount ||
      (profile.role.startsWith('vision_') && images.length !== 1) ||
      images.some(
        (image) =>
          image.mediaType !== 'image/jpeg' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64) ||
          Buffer.from(image.base64, 'base64').length > profile.image.maxBytes ||
          !Number.isSafeInteger(image.width) ||
          !Number.isSafeInteger(image.height) ||
          image.width <= 0 ||
          image.height <= 0 ||
          image.width * image.height > profile.image.maxPixels ||
          Math.max(image.width, image.height) > profile.image.maxDimension,
      )
    ) {
      throw new ProviderError(
        'model-gateway',
        'bad_request',
        'Model input exceeds qualified profile',
      );
    }
    const maxOutputTokens = Math.min(
      request.maxOutputTokens ?? profile.maxOutputTokens,
      profile.maxOutputTokens,
    );
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
      throw new ProviderError('model-gateway', 'bad_request', 'Invalid output cap');
    const started = this.now();
    const timeout = Math.min(options.timeoutMs ?? profile.timeoutMs, profile.timeoutMs);
    // Total role deadline, including retries. Never multiply the per-role deadline.
    const deadline = started + timeout;
    const retries = Math.min(1, Math.max(0, options.maxRetries ?? 1));
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted)
        throw new ProviderError('model-gateway', 'aborted', 'Analysis cancelled');
      const remaining = deadline - this.now();
      if (remaining <= 0)
        throw new ProviderError('model-gateway', 'timeout', 'Analysis deadline reached');
      if (
        options.budget &&
        !options.budget.take('model-gateway', attempt === 0 ? 'request' : 'retry')
      ) {
        throw new ProviderError(
          'model-gateway',
          'budget_exhausted',
          'Analysis request allowance exhausted',
        );
      }
      const attemptId = await this.ledger.reserve(
        { ...identity, attemptKey: `${identity.attemptKey}:${attempt}` },
        profile,
      );
      const sig = attemptSignal(options.signal, remaining);
      let response: GatewayResponse | undefined;
      let outcome: string;
      let failure: ProviderError | undefined;
      let result: z.infer<T> | undefined;
      const t0 = this.now();
      let onAbort: (() => void) | undefined;
      try {
        response = await Promise.race([
          this.transport(
            {
              model: profile.model,
              system: request.system,
              content: request.content,
              schemaName: request.schemaName,
              jsonSchema,
              maxOutputTokens,
            },
            { signal: sig.signal },
          ),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('Request ended'));
            if (sig.signal.aborted) onAbort();
            else sig.signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
        if (options.signal?.aborted)
          throw new ProviderError('model-gateway', 'aborted', 'Analysis cancelled');
        if (sig.timedOut())
          throw new ProviderError('model-gateway', 'timeout', 'Analysis timed out');
        if (response.outcome === 'refusal')
          throw new ProviderError('model-gateway', 'content_rejected', 'Model declined analysis');
        if (response.outcome === 'incomplete')
          throw new ProviderError(
            'model-gateway',
            'incomplete_response',
            'Model output incomplete',
          );
        if (response.outcome === 'error')
          throw new ProviderError(
            'model-gateway',
            'invalid_response',
            'Model response reported an error',
          );
        if (
          response.model !== profile.model ||
          (response.actualProvider !== null && response.actualProvider !== profile.provider)
        ) {
          this.disabled = true;
          throw new ProviderError(
            'model-gateway',
            'invalid_response',
            'Returned route does not match qualified profile',
          );
        }
        try {
          const candidate: unknown = JSON.parse(response.text);
          validateStrictShape(candidate, jsonSchema);
          result = request.schema.parse(candidate);
          request.validate?.(result);
        } catch {
          throw new ProviderError(
            'model-gateway',
            'invalid_response',
            'Model output failed validation',
          );
        }
        outcome = 'complete';
      } catch (error) {
        failure =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                'model-gateway',
                options.signal?.aborted ? 'aborted' : sig.timedOut() ? 'timeout' : 'server',
                'Model request failed',
              );
        outcome = failure.kind;
        if (failure.kind === 'auth' || failure.kind === 'not_found' || failure.status === 422)
          this.disabled = true;
      } finally {
        if (onAbort) sig.signal.removeEventListener('abort', onAbort);
        sig.dispose();
      }
      // Persist completion/circuit BEFORE returning or retrying. Storage failure fails closed.
      await this.ledger.finish(
        attemptId,
        outcome,
        response,
        failure?.status === 402
          ? { reason: 'credits', until: null }
          : failure?.kind === 'rate_limited'
            ? {
                reason: 'rate_limited',
                until: this.now() + Math.max(failure.retryAfterMs ?? 30_000, 1000),
              }
            : undefined,
      );
      options.onAttempt?.({
        provider: 'model-gateway',
        operation: profile.role,
        attempt,
        status: failure?.status ?? (failure ? null : 200),
        durationMs: this.now() - t0,
        error: failure?.kind,
      });
      if (!failure) {
        // Cancellation may arrive while completion is being persisted.
        if (options.signal?.aborted)
          throw new ProviderError('model-gateway', 'aborted', 'Analysis cancelled');
        this.observed = true;
        return {
          data: result!,
          model: response!.model!,
          durationMs: this.now() - started,
          usage: response!.usage ?? undefined,
          attemptId,
          responseId: response!.id,
          actualProvider: response!.actualProvider,
        };
      }
      // No timeout retry: uncertain upstream billing and an exhausted deadline.
      // 429 is requeued by the scheduler, not retried in-process. Only a bounded
      // transient provider failure may retry, with a NEW reservation.
      if (failure.kind !== 'server' || attempt >= retries) throw failure;
      const wait = Math.max(backoffDelay(attempt), failure.retryAfterMs ?? 0);
      if (this.now() + wait >= deadline) throw failure;
      try {
        await (this.defaults.sleep ?? sleep)(wait, options.signal);
      } catch {
        throw new ProviderError('model-gateway', 'aborted', 'Analysis cancelled');
      }
    }
  }
}
