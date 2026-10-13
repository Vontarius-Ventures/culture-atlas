import { AnthropicRunner } from '../anthropic/runner';
import { createSdkTransport, type MessagesTransport } from '../anthropic/transport';
import type { CapabilityEntry } from '../capabilities';
import type { ProviderConfig } from '../config';
import type { CallOptions } from '../errors';
import { UnavailableVlm } from '../unavailable';
import { buildVlmUserText, VLM_SYSTEM_PROMPT } from './prompt';
import { VlmAnalysis, type VlmAnalyzeInput, type VlmProvider, type VlmResult } from './types';

/**
 * Anthropic Claude VLM adapter (model from VLM_MODEL). Sends the normalized
 * derivative as a base64 image block plus a JSON data block, requests native
 * structured output matching VlmAnalysis, and validates it again with zod.
 * No tools are exposed to the model.
 */
export class AnthropicVlm implements VlmProvider {
  readonly id: string;
  private readonly runner: AnthropicRunner;

  constructor(
    model: string,
    transport: MessagesTransport,
    private readonly opts: { timeoutMs: number; effort: 'low' | 'medium' | 'high'; refusalFallback: boolean },
  ) {
    this.id = `vlm:anthropic:${model}`;
    this.runner = new AnthropicRunner('vlm', model, transport, { timeoutMs: opts.timeoutMs });
  }

  capability(): CapabilityEntry {
    return this.runner.capability();
  }

  async analyzeImage(input: VlmAnalyzeInput, options?: CallOptions): Promise<VlmResult> {
    const max = Math.min(Math.max(input.maxCandidates ?? 8, 1), 12);
    const out = await this.runner.run<typeof VlmAnalysis>(
      {
        system: VLM_SYSTEM_PROMPT,
        content: [
          { type: 'image', mediaType: input.image.mediaType, base64: Buffer.from(input.image.bytes).toString('base64') },
          { type: 'text', text: buildVlmUserText({ ...input, maxCandidates: max }) },
        ],
        schema: VlmAnalysis,
        maxTokens: 8_000,
        effort: this.opts.effort,
        refusalFallback: this.opts.refusalFallback,
      },
      options,
    );
    const analysis = out.data;
    // Enforce bounds the schema cannot express to the model.
    analysis.candidates = analysis.candidates.slice(0, max);
    return { analysis, model: out.model, durationMs: out.durationMs, usage: out.usage };
  }
}

export function createAnthropicVlm(config: ProviderConfig, transport?: MessagesTransport): VlmProvider {
  if (!config.ANTHROPIC_API_KEY && !transport) return new UnavailableVlm('not_configured');
  const t = transport ?? createSdkTransport({ apiKey: config.ANTHROPIC_API_KEY!, baseUrl: config.ANTHROPIC_BASE_URL });
  return new AnthropicVlm(config.VLM_MODEL, t, {
    timeoutMs: config.VLM_TIMEOUT_MS,
    effort: config.ANTHROPIC_EFFORT,
    refusalFallback: config.ANTHROPIC_REFUSAL_FALLBACK && !config.ANTHROPIC_BASE_URL,
  });
}
