import type { z } from 'zod';
import type { CapabilityEntry } from './capabilities';
import type { ProviderConfig } from './config';
import { isProviderError, type CallOptions, type ProviderErrorKind } from './errors';
import { createFeatherlessTransport } from './featherless/transport';
import { AnthropicTextModel } from './text/anthropic';
import type { StructuredRequest, StructuredResult, TextModelProvider } from './text/types';
import { AnthropicVlm } from './vlm/anthropic';
import type { VlmAnalyzeInput, VlmProvider, VlmResult } from './vlm/types';

/**
 * Operator-chosen fallback (MODEL_FALLBACK=elorian). The primary provider is
 * always tried first; the fallback runs once only when the primary failed for
 * a provider-side reason. Our own bad requests, refusals, cancellations and
 * the per-job budget never fall through, so a fallback cannot widen spend or
 * bypass a refusal. Results from either side go through the same zod
 * validation; nothing is fabricated when both fail (the primary error wins).
 */
const FALL_THROUGH: ReadonlySet<ProviderErrorKind> = new Set([
  'unavailable',
  'timeout',
  'incomplete_response',
  'invalid_response',
  'rate_limited',
  'server',
  'auth',
  'not_found',
]);

export function shouldFallBack(err: unknown): boolean {
  return isProviderError(err) && FALL_THROUGH.has(err.kind);
}

function eitherCapability(primary: CapabilityEntry, fallback: CapabilityEntry): CapabilityEntry {
  if (primary.status === 'available' || primary.status === 'unverified') return primary;
  if (fallback.status === 'available' || fallback.status === 'unverified')
    return { ...fallback, detail: `fallback for ${primary.provider ?? 'primary'} (${primary.status})` };
  return primary;
}

export class FallbackVlm implements VlmProvider {
  readonly id: string;
  constructor(
    private readonly primary: VlmProvider,
    private readonly fallback: VlmProvider,
  ) {
    this.id = `${primary.id}|fallback:${fallback.id}`;
  }
  capability(): CapabilityEntry {
    return eitherCapability(this.primary.capability(), this.fallback.capability());
  }
  async analyzeImage(input: VlmAnalyzeInput, options?: CallOptions): Promise<VlmResult> {
    try {
      return await this.primary.analyzeImage(input, options);
    } catch (err) {
      if (!shouldFallBack(err) || options?.signal?.aborted) throw err;
      try {
        return await this.fallback.analyzeImage(input, { ...options, maxRetries: 0 });
      } catch {
        throw err;
      }
    }
  }
}

export class FallbackTextModel implements TextModelProvider {
  readonly id: string;
  constructor(
    private readonly primary: TextModelProvider,
    private readonly fallback: TextModelProvider,
  ) {
    this.id = `${primary.id}|fallback:${fallback.id}`;
  }
  capability(): CapabilityEntry {
    return eitherCapability(this.primary.capability(), this.fallback.capability());
  }
  async generateStructured<T extends z.ZodType>(
    request: StructuredRequest<T>,
    options?: CallOptions,
  ): Promise<StructuredResult<z.infer<T>>> {
    try {
      return await this.primary.generateStructured(request, options);
    } catch (err) {
      if (!shouldFallBack(err) || options?.signal?.aborted) throw err;
      try {
        return await this.fallback.generateStructured(request, { ...options, maxRetries: 0 });
      } catch {
        throw err;
      }
    }
  }
}

function elorianTransport(config: ProviderConfig, fetchImpl?: typeof fetch) {
  return createFeatherlessTransport({
    apiKey: config.ELORIAN_API_KEY!,
    baseUrl: config.ELORIAN_BASE_URL,
    jsonMode: config.ELORIAN_JSON_MODE,
    providerName: 'elorian',
    tokenParam: 'max_completion_tokens',
    fetch: fetchImpl,
  });
}

const elorianOpts = (config: ProviderConfig) => ({
  timeoutMs: config.ELORIAN_TIMEOUT_MS,
  effort: config.ANTHROPIC_EFFORT,
  refusalFallback: false,
  vendor: 'elorian',
});

export function elorianEnabled(config: ProviderConfig): boolean {
  return config.MODEL_FALLBACK === 'elorian' && !!config.ELORIAN_API_KEY;
}

/** The Elorian vision model on its own (for the v2 media worker's fallback path). */
export function createElorianVlm(config: ProviderConfig, fetchImpl?: typeof fetch): VlmProvider {
  return new AnthropicVlm(config.ELORIAN_MODEL, elorianTransport(config, fetchImpl), elorianOpts(config));
}

/** Wraps the primary providers with Elorian when MODEL_FALLBACK=elorian and a key is set. */
export function withModelFallback(
  config: ProviderConfig,
  providers: { vlm: VlmProvider; text: TextModelProvider; composer: TextModelProvider },
  fetchImpl?: typeof fetch,
): { vlm: VlmProvider; text: TextModelProvider; composer: TextModelProvider } {
  if (!elorianEnabled(config)) return providers;
  const transport = elorianTransport(config, fetchImpl);
  const model = config.ELORIAN_MODEL;
  return {
    vlm: new FallbackVlm(providers.vlm, new AnthropicVlm(model, transport, elorianOpts(config))),
    text: new FallbackTextModel(providers.text, new AnthropicTextModel(model, transport, elorianOpts(config))),
    composer: new FallbackTextModel(
      providers.composer,
      new AnthropicTextModel(model, transport, elorianOpts(config)),
    ),
  };
}
