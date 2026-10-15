import { CAPABILITY_NAMES, type CapabilityMatrix } from './capabilities';
import { loadProviderConfig, type ProviderConfig } from './config';
import { createModelGateway, type ModelGatewayOptions } from './concentrate/gateway';
import { createTextModel, createVlm } from './llm';
import { createQlooProvider } from './qloo/client';
import type { QlooProvider } from './qloo/types';
import { createWikipediaResearch } from './research/wikipedia';
import type { ResearchProvider } from './research/types';
import { createObjectStorage } from './storage';
import type { ObjectStorage } from './storage/types';
import type { TextModelProvider } from './text/types';
import type { VlmProvider } from './vlm/types';

/** Every provider the domain uses, selected from environment configuration. */
export interface ProviderRegistry {
  readonly config: ProviderConfig;
  readonly vlm: VlmProvider;
  /** Claim extraction / research model (RESEARCH_MODEL). */
  readonly text: TextModelProvider;
  /** Plan composer model (COMPOSER_MODEL, defaults to RESEARCH_MODEL). */
  readonly composer: TextModelProvider;
  readonly research: ResearchProvider;
  readonly qloo: QlooProvider;
  readonly storage: ObjectStorage;
  readonly modelGateway?: ReturnType<typeof createModelGateway>;
  capabilities(): CapabilityMatrix;
}

export type ProviderOverrides = Partial<
  Omit<ProviderRegistry, 'config' | 'capabilities' | 'modelGateway'>
>;

export function createProviderRegistry(
  env: Record<string, string | undefined> = process.env,
  overrides: ProviderOverrides = {},
  gatewayOptions: ModelGatewayOptions = {},
): ProviderRegistry {
  const config = loadProviderConfig(env);
  const modelGateway =
    config.LLM_PROVIDER === 'concentrate' ? createModelGateway(config, gatewayOptions) : undefined;
  const vlm = overrides.vlm ?? modelGateway?.vlm ?? createVlm(config);
  const text =
    overrides.text ?? modelGateway?.text ?? createTextModel(config, config.RESEARCH_MODEL);
  const composer =
    overrides.composer ??
    modelGateway?.composer ??
    createTextModel(config, config.COMPOSER_MODEL ?? config.RESEARCH_MODEL);
  const research = overrides.research ?? createWikipediaResearch(config, text);
  const qloo = overrides.qloo ?? createQlooProvider(config);
  const storage = overrides.storage ?? createObjectStorage(config);

  return {
    config,
    vlm,
    text,
    composer,
    research,
    qloo,
    storage,
    modelGateway,
    capabilities(): CapabilityMatrix {
      const q = qloo.capability();
      const r = research.capability();
      const s = storage.capability();
      const matrix: CapabilityMatrix = {
        'vlm.analyze_image': vlm.capability(),
        'text.generate': text.capability(),
        'research.sources': r.sources,
        'research.claims': r.claims,
        'qloo.search': q.search,
        'qloo.tags': q.tags,
        'qloo.insights': q.insights,
        'qloo.insights.explainability': q.explainability,
        'qloo.trending': q.trending,
        'qloo.trends_entity': q.trendsEntity,
        // No track catalog adapter in this release: artist recommendations only.
        'catalog.tracks': { status: 'unavailable', reason: 'not_implemented' },
        'storage.objects': s.objects,
        'storage.signed_urls': s.signedUrls,
      };
      for (const name of CAPABILITY_NAMES)
        matrix[name] ??= { status: 'unavailable', reason: 'not_implemented' };
      return matrix;
    },
  };
}

let shared: ProviderRegistry | undefined;

export function getProviders(): ProviderRegistry {
  shared ??= createProviderRegistry();
  return shared;
}

export function setProvidersForTesting(registry: ProviderRegistry | undefined): void {
  shared = registry;
}
