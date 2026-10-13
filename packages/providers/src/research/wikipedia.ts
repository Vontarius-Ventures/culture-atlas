import type { ProviderConfig } from '../config';
import type { TextModelProvider } from '../text/types';
import { UnavailableResearch } from '../unavailable';
import type { ResearchProvider } from './types';

/**
 * Wikipedia/Wikimedia REST research provider.
 * TODO(research owner): findSources via the Action API search + REST
 * /page/summary/{title} (real canonical URLs, license metadata, descriptive
 * WIKIMEDIA_USER_AGENT); extractClaims via the text model with source URLs
 * attached to every factual claim. findSources works without an LLM key;
 * extractClaims reports unavailable when the text model is unavailable.
 */
export function createWikipediaResearch(config: ProviderConfig, textModel: TextModelProvider): ResearchProvider {
  void config;
  void textModel;
  return new UnavailableResearch('not_implemented');
}
