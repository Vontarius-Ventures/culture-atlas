import { createModelGateway, type ModelGatewayOptions } from './concentrate/gateway';
import type { ProviderConfig } from './config';
import { createFeatherlessTransport } from './featherless/transport';
import { AnthropicTextModel, createAnthropicTextModel } from './text/anthropic';
import type { TextModelProvider } from './text/types';
import { UnavailableTextModel, UnavailableVlm } from './unavailable';
import { AnthropicVlm, createAnthropicVlm } from './vlm/anthropic';
import type { VlmProvider } from './vlm/types';

/**
 * Selects the LLM service for the VLM and text models from LLM_PROVIDER
 * (default concentrate). Concentrate roles come from the model gateway:
 * a key, ZDR assertions, a qualified profile and a spend ledger must all
 * exist before a role dispatches. With a key the capability is `unverified`
 * until then; without a key it is `unavailable`. Featherless/Anthropic remain
 * explicit operational rollbacks only; nothing falls back to them.
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

export function createVlm(
  config: ProviderConfig,
  gatewayOptions: ModelGatewayOptions = {},
): VlmProvider {
  if (config.LLM_PROVIDER === 'concentrate') {
    return createModelGateway(config, gatewayOptions).vlm;
  }
  if (config.LLM_PROVIDER === 'anthropic') return createAnthropicVlm(config);
  if (!config.FEATHERLESS_API_KEY) return new UnavailableVlm('not_configured');
  return new AnthropicVlm(config.VLM_MODEL, featherlessTransport(config), featherlessOpts(config));
}

export function createTextModel(
  config: ProviderConfig,
  model?: string,
  gatewayOptions: ModelGatewayOptions = {},
): TextModelProvider {
  if (config.LLM_PROVIDER === 'concentrate') {
    const gateway = createModelGateway(config, gatewayOptions);
    const requested = model?.trim() || undefined;
    const composerModel = config.COMPOSER_MODEL?.trim() || undefined;
    const researchModel = config.RESEARCH_MODEL?.trim() || undefined;
    // When research and composer pin the same catalog id, the research role is
    // the default; the registry uses the gateway's composer handle directly.
    if (requested && composerModel && requested === composerModel && requested !== researchModel) {
      return gateway.composer;
    }
    return gateway.text;
  }
  if (config.LLM_PROVIDER === 'anthropic') return createAnthropicTextModel(config, model);
  if (!config.FEATHERLESS_API_KEY) return new UnavailableTextModel('not_configured');
  return new AnthropicTextModel(
    model ?? config.RESEARCH_MODEL,
    featherlessTransport(config),
    featherlessOpts(config),
  );
}
