import type { z } from 'zod';
import type { CapabilityEntry } from '../capabilities';
import { ModelProfileSchema, type ModelProfile } from '../concentrate/profiles';
import { ProviderError } from '../errors';
import { attemptSignal, backoffDelay, sleep, type Sleep } from '../http/resilience';
import type { FinishDetails, ModelSpendLedger, RoleCircuit } from './budget';
import { attachStructuredResponseShapeIssues, structuredResponseFailure } from './diagnostics';
import { structuredOutputContract } from './schema';
import type {
  GatewayCall,
  GatewayOptions,
  GatewayResponse,
  ModelIdentity,
  StructuredTransport,
} from './types';

/**
 * Readiness ladder (CONCENTRATE.md "Budget and readiness"). All values are
 * computed from local configuration, qualification artifacts and durable
 * ledger state. Nothing here sends a model request.
 *  configured          key + profile present, privacy assertions hold
 *  catalog-compatible  profile matches a stored catalog snapshot entry
 *  qualified           a passing qualification artifact matches this profile
 *  available           qualified and observed a validated response
 *  degraded            temporarily throttled (429 pause) or open spend pause pending expiry
 *  unavailable         missing config, open role circuit, credit/cost pause
 */
export type GatewayReadiness =
  'configured' | 'catalog-compatible' | 'qualified' | 'available' | 'degraded' | 'unavailable';
export interface ReadinessDetail {
  state: GatewayReadiness;
  reason?:
    | 'not_configured'
    | 'not_qualified'
    | 'credits'
    | 'cost_overrun'
    | 'rate_limited'
    | RoleCircuit['reason'];
  retryAfterMs?: number;
}
/** Operator alert: safe codes only, never payloads, keys or error bodies. */
export interface GatewayAlert {
  code:
    | 'auth_failed'
    | 'credits_exhausted'
    | 'unknown_model'
    | 'policy_route_unavailable'
    | 'route_mismatch'
    | 'rate_limited';
  role: ModelProfile['role'];
  status?: number;
  requestId?: string;
}

export class StructuredResponseRunner {
  readonly profile: ModelProfile;
  private observed = false;
  private disabled = false;
  constructor(
    profile: ModelProfile,
    private readonly transport: StructuredTransport,
    readonly ledger: ModelSpendLedger,
    private readonly defaults: {
      identity?: ModelIdentity;
      sleep?: Sleep;
      now?: () => number;
      allowTestStore?: boolean;
      /** Readiness below 'qualified' when no passing artifact matches the profile. */
      qualification?: 'configured' | 'catalog-compatible' | 'qualified';
      onAlert?: (alert: GatewayAlert) => void;
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
  async readinessDetail(): Promise<ReadinessDetail> {
    const circuit = await this.ledger.circuit(this.profile.role);
    if (this.disabled || circuit)
      return { state: 'unavailable', reason: circuit?.reason ?? 'auth' };
    const pause = await this.ledger.status();
    if (pause?.reason === 'rate_limited')
      return {
        state: 'degraded',
        reason: 'rate_limited',
        retryAfterMs: pause.until === null ? undefined : Math.max(0, pause.until - this.now()),
      };
    if (pause) return { state: 'unavailable', reason: pause.reason };
    const qualification = this.defaults.qualification ?? 'qualified';
    if (qualification !== 'qualified') return { state: qualification, reason: 'not_qualified' };
    return { state: this.observed ? 'available' : 'qualified' };
  }
  async readiness(): Promise<GatewayReadiness> {
    return (await this.readinessDetail()).state;
  }
  private alert(alert: Omit<GatewayAlert, 'role'>): void {
    try {
      this.defaults.onAlert?.({ ...alert, role: this.profile.role });
    } catch {
      // Alert sinks never affect inference control flow.
    }
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
    requestId: string | null;
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
    const contract = structuredOutputContract(request.schema);
    const jsonSchema = contract.jsonSchema;
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
    // Atlas is the single retry owner (gateway fallbacks are disabled): at most one retry.
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
        const dispatch = async () => {
          await options.beforeDispatch?.();
          if (options.signal?.aborted || sig.signal.aborted)
            throw new ProviderError('model-gateway', options.signal?.aborted ? 'aborted' : 'timeout', 'Model request ended');
          return this.transport(
            {
              model: profile.model, system: request.system, content: request.content,
              schemaName: request.schemaName, jsonSchema, maxOutputTokens,
              ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
            }, { signal: sig.signal },
          );
        };
        response = await Promise.race([
          dispatch(),
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
          throw structuredResponseFailure('provider_refusal');
        if (response.outcome === 'incomplete')
          throw structuredResponseFailure('provider_incomplete');
        if (response.outcome === 'error')
          throw structuredResponseFailure('provider_error');
        if (
          response.model !== profile.model ||
          (response.actualProvider !== null && response.actualProvider !== profile.provider)
        ) {
          this.disabled = true;
          throw Object.assign(
            structuredResponseFailure('route_mismatch'),
            { routeMismatch: true },
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(response.text);
        } catch {
          throw structuredResponseFailure('json_parse');
        }
        try {
          const candidate = contract.decode(parsed);
          result = request.schema.parse(candidate);
        } catch {
          const failure = structuredResponseFailure('schema_shape');
          try {
            if (request.diagnoseShape)
              attachStructuredResponseShapeIssues(failure, request.diagnoseShape(parsed));
          } catch {
            // Diagnostics must never replace the original failure or retain a cause.
          }
          throw failure;
        }
        try {
          request.validate?.(result);
        } catch {
          throw structuredResponseFailure('semantic_consistency');
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
      } finally {
        if (onAbort) sig.signal.removeEventListener('abort', onAbort);
        sig.dispose();
      }
      const details: FinishDetails = { requestId: failure?.requestId ?? null };
      if (failure) {
        if (failure.kind === 'auth') {
          details.circuit = { role: profile.role, reason: 'auth' };
          this.alert({ code: 'auth_failed', status: failure.status, requestId: failure.requestId });
        } else if (failure.kind === 'not_found') {
          details.circuit = { role: profile.role, reason: 'unknown_model' };
          this.alert({
            code: 'unknown_model',
            status: failure.status,
            requestId: failure.requestId,
          });
        } else if (failure.status === 422) {
          // No policy-eligible (ZDR) route: never downgrade privacy.
          details.circuit = { role: profile.role, reason: 'policy' };
          this.alert({
            code: 'policy_route_unavailable',
            status: 422,
            requestId: failure.requestId,
          });
        } else if ((failure as { routeMismatch?: boolean }).routeMismatch) {
          details.circuit = { role: profile.role, reason: 'route_mismatch' };
          this.alert({ code: 'route_mismatch' });
        } else if (failure.status === 402) {
          details.pause = { reason: 'credits', until: null };
          this.alert({ code: 'credits_exhausted', status: 402, requestId: failure.requestId });
        } else if (failure.kind === 'rate_limited') {
          details.pause = {
            reason: 'rate_limited',
            until: this.now() + Math.max(failure.retryAfterMs ?? 30_000, 1000),
          };
          this.alert({
            code: 'rate_limited',
            status: failure.status,
            requestId: failure.requestId,
          });
        }
        if (details.circuit) this.disabled = true;
      }
      // Persist completion/circuit BEFORE returning or retrying. Storage failure fails closed.
      await this.ledger.finish(attemptId, outcome, response, details);
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
          requestId: response!.requestId ?? null,
          actualProvider: response!.actualProvider,
        };
      }
      // No timeout retry: uncertain upstream billing and an exhausted deadline.
      // 429 is requeued by the scheduler, not retried in-process. Only a bounded
      // transient provider failure (424/5xx/network) may retry, with a NEW reservation.
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
