import type { ProviderConfig } from './config';
import { createFeatherlessTransport } from './featherless/transport';
import { createAnthropicTextModel, AnthropicTextModel } from './text/anthropic';
import type { TextModelProvider } from './text/types';
import { UnavailableTextModel, UnavailableVlm } from './unavailable';
import { AnthropicVlm, createAnthropicVlm } from './vlm/anthropic';
import type { VlmProvider } from './vlm/types';

/**
 * Selects the LLM service for the VLM and text models from LLM_PROVIDER
 * (default featherless). Both services share one runner (retries, budgets,
 * circuit breaker, zod validation); only the transport differs.
 */

function featherlessTransport(config: ProviderConfig) {
  return createFeatherlessTransport({
    apiKey: config.FEATHERLESS_API_KEY!,
    baseUrl: config.FEATHERLESS_BASE_URL,
    jsonMode: config.FEATHERLESS_JSON_MODE,
  });
}

const featherlessOpts = (config: ProviderConfig) => ({
  timeoutMs: config.VLM_TIMEOUT_MS,
  effort: config.ANTHROPIC_EFFORT,
  refusalFallback: false,
  vendor: 'featherless',
});

export function createVlm(config: ProviderConfig): VlmProvider {
  if (config.LLM_PROVIDER === 'concentrate') return new UnavailableVlm('not_configured');
  if (config.LLM_PROVIDER === 'anthropic') return createAnthropicVlm(config);
  if (!config.FEATHERLESS_API_KEY) return new UnavailableVlm('not_configured');
  return new AnthropicVlm(config.VLM_MODEL, featherlessTransport(config), featherlessOpts(config));
}

export function createTextModel(config: ProviderConfig, model?: string): TextModelProvider {
  if (config.LLM_PROVIDER === 'concentrate') return new UnavailableTextModel('not_configured');
  if (config.LLM_PROVIDER === 'anthropic') return createAnthropicTextModel(config, model);
  if (!config.FEATHERLESS_API_KEY) return new UnavailableTextModel('not_configured');
  return new AnthropicTextModel(
    model ?? config.RESEARCH_MODEL,
    featherlessTransport(config),
    featherlessOpts(config),
  );
}
