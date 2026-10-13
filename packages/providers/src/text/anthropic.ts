import type { ProviderConfig } from '../config';
import { UnavailableTextModel } from '../unavailable';
import type { TextModelProvider } from './types';

/**
 * Anthropic Claude text model (RESEARCH_MODEL / COMPOSER_MODEL).
 * TODO(providers owner): implement generateStructured via a forced tool call
 * whose input_schema is z.toJSONSchema(request.schema); validate the output.
 */
export function createAnthropicTextModel(config: ProviderConfig, model?: string): TextModelProvider {
  void model;
  if (!config.ANTHROPIC_API_KEY) return new UnavailableTextModel('not_configured');
  return new UnavailableTextModel('not_implemented');
}
