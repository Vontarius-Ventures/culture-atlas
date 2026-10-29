import { CAPABILITY_NAMES, type CapabilityMatrix } from './capabilities';
import { loadProviderConfig, type ProviderConfig } from './config';
import { createModelGateway, type ModelGatewayOptions } from './concentrate/gateway';
import { createElorianVlm, elorianEnabled, withModelFallback } from './fallback';
import { createTextModel, createVlm } from './llm';
import { createQlooProvider } from './qloo/client';
import type { QlooProvider } from './qloo/types';
import { createWikipediaResearch } from './research/wikipedia';
import type { ResearchProvider } from './research/types';
import { createObjectStorage } from './storage';
import type { ObjectStorage } from './storage/types';
import type { TextModelProvider } from './text/types';
import type { MusicRecognitionProvider } from './music/types';
import { UnavailableMusicRecognition, UnavailableVlmEnricher, UnavailableVlmVerifier } from './unavailable';
import type { VlmEnricher, VlmProvider } from './vlm/types';
import type { VlmVerifier } from './vlm/verify';

/** One paid leg of the effective research claims chain (primary first). */
export interface ResearchClaimsLeg {
  /** Operator-safe provider identity, e.g. "text:concentrate:<model>" — never a secret. */
  readonly provider: string;
  /** True when every paid attempt on this leg reserves and settles through the model gateway's durable account/global ledger. */
  readonly reservationBound: boolean;
}

/**
 * The effective claims chain the registry constructed for relation research
 * (DISC-SCR-010, VAL-DISC-005/006). Optional paid graph research must bind to
 * an ACTUALLY QUALIFIED adapter whose every primary/fallback paid call is
 * account/global reservation-bound, or fail closed — a generic capability plus
 * the presence of a gateway ledger does not bind anything.
 */
export interface ResearchClaimsPath {
  /**
   * True when the model gateway hands the primary claims leg a dispatching
   * runner (only a qualified — or operator demo-allowed — role gets one).
   */
  readonly primaryRunner: boolean;
  /**
   * True when the primary dispatches only under the CONCENTRATE_DEMO_ALLOW_ROLES
   * demo override: an observed capability of a demo role is not independent
   * role qualification.
   */
  readonly demo: boolean;
  /** Paid legs, primary first. Empty when the chain is an explicit constructor override the registry cannot analyze. */
  readonly legs: readonly ResearchClaimsLeg[];
  /**
   * True when research/text was replaced by explicit constructor injection
   * (deterministic test adapters). The registry cannot analyze such a chain;
   * the deployment invariants (qualified non-demo role + durable ledger) still
   * bind it.
   */
  readonly explicitOverride: boolean;
}

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
  /** The effective research claims chain paid research must bind to (DISC-SCR-010). */
  readonly researchClaimsPath: ResearchClaimsPath;
  capabilities(): CapabilityMatrix;
}

export type ProviderOverrides = Partial<
  Omit<ProviderRegistry, 'config' | 'capabilities' | 'modelGateway' | 'researchClaimsPath'>
>;

export function createProviderRegistry(
  env: Record<string, string | undefined> = process.env,
  overrides: ProviderOverrides = {},
  gatewayOptions: ModelGatewayOptions = {},
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
  const text = overrides.text ?? fallback.text;
  const composer = overrides.composer ?? fallback.composer;
  const fallbackVlm = elorianEnabled(config) ? createElorianVlm(config) : undefined;
  const research = overrides.research ?? createWikipediaResearch(config, text);
  const qloo = overrides.qloo ?? createQlooProvider(config);
  const music = overrides.music ?? new UnavailableMusicRecognition('not_implemented');
  const storage = overrides.storage ?? createObjectStorage(config);

  // DISC-SCR-010: describe the effective research claims chain the registry
  // constructed, so the paid research gate can bind to an actually qualified,
  // fully reservation-bound path. The primary leg is reservation-bound only
  // when the gateway hands it a dispatching runner (every runner attempt
  // reserves and settles on the durable account/global ledger). The
  // operator-chosen Elorian fallback (MODEL_FALLBACK=elorian) is a PAID leg
  // outside that ledger: a chain containing it could spend unreserved, so the
  // gate must fail closed rather than let research escape the budget. An
  // explicit constructor override replaces the chain with code the registry
  // cannot analyze; the deployment invariants still bind it.
  const claimsOverride = !!overrides.research || !!overrides.text;
  const researchClaimsPath: ResearchClaimsPath = {
    primaryRunner: !!modelGateway?.runners.research_text,
    demo: !!modelGateway?.experimentalRoles.has('research_text'),
    explicitOverride: claimsOverride,
    legs: claimsOverride
      ? []
      : [
          { provider: baseText.id, reservationBound: !!modelGateway?.runners.research_text },
          ...(elorianEnabled(config)
            ? [
                {
                  provider: `text:elorian:${config.ELORIAN_MODEL}`,
                  reservationBound: false,
                },
              ]
            : []),
        ],
  };

  return {
    config,
    vlm,
    vlmEnrich,
    vlmVerify,
    text,
    composer,
    research,
    qloo,
    music,
    storage,
    modelGateway,
    fallbackVlm,
    researchClaimsPath,
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

/**
 * Process startup hook: the domain layer registers its pool-level database
 * getter (durable spend ledger) and the worker its alert sink before the
 * shared registry is built. Without it Concentrate roles stay unavailable.
 */
export function configureProviderRuntime(options: { gateway?: ModelGatewayOptions }): void {
  runtimeGatewayOptions = { ...runtimeGatewayOptions, ...options.gateway };
  shared = undefined;
}

export function getProviders(): ProviderRegistry {
  shared ??= createProviderRegistry(process.env, {}, runtimeGatewayOptions);
  return shared;
}

export function setProvidersForTesting(registry: ProviderRegistry | undefined): void {
  shared = registry;
}
