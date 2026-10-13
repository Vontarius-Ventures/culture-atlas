import type { z } from 'zod';
import { AnthropicRunner } from '../anthropic/runner';
import { createSdkTransport, type MessagesTransport } from '../anthropic/transport';
import type { CapabilityEntry } from '../capabilities';
import type { ProviderConfig } from '../config';
import type { CallOptions } from '../errors';
import { UnavailableTextModel } from '../unavailable';
import type { StructuredRequest, StructuredResult, TextModelProvider } from './types';

/**
 * Anthropic Claude text model (RESEARCH_MODEL / COMPOSER_MODEL) returning
 * structured output validated against the request's zod schema. Callers pass
 * user-supplied strings as quoted data inside `prompt`; the model has no tools.
 */
export class AnthropicTextModel implements TextModelProvider {
  readonly id: string;
  private readonly runner: AnthropicRunner;

  constructor(
    model: string,
    transport: MessagesTransport,
    private readonly opts: { timeoutMs: number; effort: 'low' | 'medium' | 'high'; refusalFallback: boolean },
  ) {
    this.id = `text:anthropic:${model}`;
    this.runner = new AnthropicRunner('text', model, transport, { timeoutMs: opts.timeoutMs });
  }

  capability(): CapabilityEntry {
    return this.runner.capability();
  }

  async generateStructured<T extends z.ZodType>(request: StructuredRequest<T>, options?: CallOptions): Promise<StructuredResult<z.infer<T>>> {
    const out = await this.runner.run<T>(
      {
        system: request.system,
        content: [{ type: 'text', text: request.prompt }],
        schema: request.schema,
        maxTokens: request.maxTokens ?? 8_000,
        effort: this.opts.effort,
        refusalFallback: this.opts.refusalFallback,
      },
      options,
    );
    return { data: out.data, model: out.model, durationMs: out.durationMs, usage: out.usage };
  }
}

export function createAnthropicTextModel(config: ProviderConfig, model?: string, transport?: MessagesTransport): TextModelProvider {
  if (!config.ANTHROPIC_API_KEY && !transport) return new UnavailableTextModel('not_configured');
  const t = transport ?? createSdkTransport({ apiKey: config.ANTHROPIC_API_KEY!, baseUrl: config.ANTHROPIC_BASE_URL });
  return new AnthropicTextModel(model ?? config.RESEARCH_MODEL, t, {
    timeoutMs: config.VLM_TIMEOUT_MS,
    effort: config.ANTHROPIC_EFFORT,
    refusalFallback: config.ANTHROPIC_REFUSAL_FALLBACK && !config.ANTHROPIC_BASE_URL,
  });
}
