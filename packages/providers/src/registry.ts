import { CAPABILITY_NAMES, type CapabilityMatrix } from './capabilities';
import { loadProviderConfig, type ProviderConfig } from './config';
import { createModelGateway, type ModelGatewayOptions } from './concentrate/gateway';
import { createElorianVlm, elorianEnabled, withModelFallback } from './fallback';
import { createTextModel, createVlm } from './llm';
import { createQlooProvider, keyFingerprint, type QlooRateGate } from './qloo/client';
import { PostgresQlooRateGate } from './qloo/rate-gate';
import type { GatewayDb } from './model-gateway/postgres';
import type { QlooProvider } from './qloo/types';
import { createWikipediaResearch } from './research/wikipedia';
import type { ResearchProvider } from './research/types';
import { createObjectStorage } from './storage';
import type { ObjectStorage } from './storage/types';
import type { TextModelProvider } from './text/types';
import type { MusicRecognitionProvider } from './music/types';
import { UnavailableMusicRecognition, UnavailableVlmEnricher, UnavailableVlmStyleReader, UnavailableVlmVerifier } from './unavailable';
import type { VlmStyleReader } from './vlm/style';
import type { VlmEnricher, VlmProvider } from './vlm/types';
import type { VlmVerifier } from './vlm/verify';

/** Every provider the domain uses, selected from environment configuration. */
export interface ProviderRegistry {
  readonly config: ProviderConfig;
  readonly vlm: VlmProvider;
  /**
   * Stage-2 photo enrichment (vision_photo_enrich, amendment 2.2). Only the
   * Concentrate gateway serves it; there is no Elorian or rollback fallback.
   */
  readonly vlmEnrich: VlmEnricher;
  /**
   * Independent verifier after stage 2 (vision_verify). Only the Concentrate
   * gateway serves it; the compiler also needs ANALYSIS_VERIFIER_ENABLED.
   */
  readonly vlmVerify: VlmVerifier;
  /**
   * Style reading (vision_style, style design §B). Only the Concentrate
   * gateway serves it (qualified, or experimental under
   * ANALYSIS_EXPERIMENTAL_ROLES); there is no fallback model.
   */
  readonly vlmStyle: VlmStyleReader;
  /** Claim extraction / research model (RESEARCH_MODEL). */
  readonly text: TextModelProvider;
  /** Plan composer model (COMPOSER_MODEL, defaults to RESEARCH_MODEL). */
  readonly composer: TextModelProvider;
  readonly research: ResearchProvider;
  readonly qloo: QlooProvider;
  /**
   * Licensed fingerprint/catalog music recognition. Unavailable until a
   * provider is procured; never returns invented matches.
   */
  readonly music: MusicRecognitionProvider;
  readonly storage: ObjectStorage;
  /** Present only with LLM_PROVIDER=concentrate (the default). */
  readonly modelGateway?: ReturnType<typeof createModelGateway>;
  /** Elorian vision model when MODEL_FALLBACK=elorian and ELORIAN_API_KEY are set. */
  readonly fallbackVlm?: VlmProvider;
  capabilities(): CapabilityMatrix;
}

export type ProviderOverrides = Partial<
  Omit<ProviderRegistry, 'config' | 'capabilities' | 'modelGateway'>
>;

export interface ProviderRuntimeOptions {
  /** Cross-process Qloo admission (R-11); built from the pool-level database handle. */
  qlooGate?: QlooRateGate;
}

export function createProviderRegistry(
  env: Record<string, string | undefined> = process.env,
  overrides: ProviderOverrides = {},
  gatewayOptions: ModelGatewayOptions = {},
  runtime: ProviderRuntimeOptions = {},
): ProviderRegistry {
  const config = loadProviderConfig(env);
  // No cross-gateway fallback: with Concentrate selected and a role unavailable,
  // that role is unavailable. Featherless/Anthropic are explicit rollback only.
  const modelGateway =
    config.LLM_PROVIDER === 'concentrate' ? createModelGateway(config, gatewayOptions) : undefined;
  const baseVlm = modelGateway?.vlm ?? createVlm(config);
  const baseText = modelGateway?.text ?? createTextModel(config, config.RESEARCH_MODEL);
  const baseComposer =
    modelGateway?.composer ??
    createTextModel(config, config.COMPOSER_MODEL ?? config.RESEARCH_MODEL);
  // MODEL_FALLBACK=elorian (explicit operator choice): Elorian backs up the primary models.
  const fallback = withModelFallback(config, { vlm: baseVlm, text: baseText, composer: baseComposer });
  const vlm = overrides.vlm ?? fallback.vlm;
  const vlmEnrich =
    overrides.vlmEnrich ?? modelGateway?.vlmEnrich ?? new UnavailableVlmEnricher('not_configured');
  const vlmVerify =
    overrides.vlmVerify ?? modelGateway?.vlmVerify ?? new UnavailableVlmVerifier('not_configured');
  const vlmStyle =
    overrides.vlmStyle ?? modelGateway?.vlmStyle ?? new UnavailableVlmStyleReader('not_configured');
  const text = overrides.text ?? fallback.text;
  const composer = overrides.composer ?? fallback.composer;
  const fallbackVlm = elorianEnabled(config) ? createElorianVlm(config) : undefined;
  const research = overrides.research ?? createWikipediaResearch(config, text);
  const qloo = overrides.qloo ?? createQlooProvider(config, runtime.qlooGate ? { gate: runtime.qlooGate } : {});
  const music = overrides.music ?? new UnavailableMusicRecognition('not_implemented');
  const storage = overrides.storage ?? createObjectStorage(config);

  return {
    config,
    vlm,
    vlmEnrich,
    vlmVerify,
    vlmStyle,
    text,
    composer,
    research,
    qloo,
    music,
    storage,
    modelGateway,
    fallbackVlm,
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
        'music.recognize': music.capability(),
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
let runtimeGatewayOptions: ModelGatewayOptions = {};
let runtimeQlooDb: (() => GatewayDb) | undefined;

/**
 * Process startup hook: the domain layer registers its pool-level database
 * getter (durable spend ledger) and the worker its alert sink before the
 * shared registry is built. Without it Concentrate roles stay unavailable.
 */
export function configureProviderRuntime(options: { gateway?: ModelGatewayOptions; qlooDb?: () => GatewayDb }): void {
  runtimeGatewayOptions = { ...runtimeGatewayOptions, ...options.gateway };
  if (options.qlooDb) runtimeQlooDb = options.qlooDb;
  shared = undefined;
}

/** The shared key's cross-process gate (R-11), when a pool-level database handle was registered. */
function runtimeQlooGate(env: Record<string, string | undefined>): QlooRateGate | undefined {
  if (!runtimeQlooDb) return undefined;
  const config = loadProviderConfig(env);
  if (!config.QLOO_API_KEY) return undefined;
  return new PostgresQlooRateGate(runtimeQlooDb, {
    keyId: `qloo:${keyFingerprint(config.QLOO_API_KEY)}`,
    ratePerSecond: config.QLOO_RATE_PER_SECOND,
    dailyLimit: config.QLOO_DAILY_REQUEST_LIMIT,
    onError: () => console.warn('[qloo] rate gate unavailable (migration 190?); in-process spacing only for a minute'),
  });
}

export function getProviders(): ProviderRegistry {
  shared ??= createProviderRegistry(process.env, {}, runtimeGatewayOptions, { qlooGate: runtimeQlooGate(process.env) });
  return shared;
}

export function setProvidersForTesting(registry: ProviderRegistry | undefined): void {
  shared = registry;
}
