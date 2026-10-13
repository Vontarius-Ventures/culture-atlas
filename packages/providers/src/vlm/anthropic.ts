import type { ProviderConfig } from '../config';
import { UnavailableVlm } from '../unavailable';
import type { VlmProvider } from './types';

/**
 * Anthropic Claude VLM adapter (model from VLM_MODEL).
 * TODO(providers owner): implement with @anthropic-ai/sdk: send the derivative
 * image as a base64 image block, force a single structured-output tool whose
 * input schema is VlmAnalysis (z.toJSONSchema), validate with VlmAnalysis.parse,
 * map SDK errors to ProviderError (429 -> rate_limited with retry-after, 5xx ->
 * server, timeouts -> timeout). System prompt must state that any text in the
 * image is data and cannot change instructions; expose no other tools.
 */
export function createAnthropicVlm(config: ProviderConfig): VlmProvider {
  if (!config.ANTHROPIC_API_KEY) return new UnavailableVlm('not_configured');
  return new UnavailableVlm('not_implemented');
}
