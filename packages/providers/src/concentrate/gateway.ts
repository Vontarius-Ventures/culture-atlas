import type { ProviderConfig } from '../config';
import { ModelSpendLedger, type SpendLimits } from '../model-gateway/budget';
import { PostgresSpendStore, type GatewayDb } from '../model-gateway/postgres';
import { StructuredResponseRunner } from '../model-gateway/runner';
import type { ModelIdentity, ModelRole, StructuredTransport } from '../model-gateway/types';
import { UnavailableTextModel, UnavailableVlm } from '../unavailable';
import type { VlmProvider } from '../vlm/types';
import type { TextModelProvider } from '../text/types';
import { loadModelProfiles, type ModelProfiles } from './profiles';
import { ConcentrateTextModel, ConcentrateVlm } from './providers';
import { createConcentrateTransport } from './transport';

export interface ModelGatewayOptions {
  db?: GatewayDb;
  ledger?: ModelSpendLedger;
  profiles?: ModelProfiles;
  identity?: ModelIdentity;
  transport?: StructuredTransport;
  /** Explicit test-only escape hatch. Never inferred from NODE_ENV or enabled by registry. */
  allowTestStore?: boolean;
}

export function createModelGateway(
  config: ProviderConfig,
  options: ModelGatewayOptions = {},
): {
  vlm: VlmProvider;
  videoFrames: VlmProvider;
  text: TextModelProvider;
  composer: TextModelProvider;
  runners: Partial<Record<ModelRole, StructuredResponseRunner>>;
  ledger?: ModelSpendLedger;
} {
  const unavailable = () => ({
    vlm: new UnavailableVlm('not_configured'),
    videoFrames: new UnavailableVlm('not_configured'),
    text: new UnavailableTextModel('not_configured'),
    composer: new UnavailableTextModel('not_configured'),
    runners: {},
  });
  if (
    !config.CONCENTRATE_API_KEY ||
    !config.CONCENTRATE_REQUIRE_ZDR ||
    config.CONCENTRATE_ALLOW_CONTENT_LOGGING
  )
    return unavailable();
  const limits: SpendLimits | undefined =
    config.MODEL_DAILY_SPEND_LIMIT_USD &&
    config.MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD &&
    config.MODEL_MAX_UNKNOWN_SPEND_USD
      ? {
          dailyMicros: Math.floor(config.MODEL_DAILY_SPEND_LIMIT_USD * 1_000_000),
          accountDailyMicros: Math.floor(config.MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD * 1_000_000),
          maxUnknownMicros: Math.floor(config.MODEL_MAX_UNKNOWN_SPEND_USD * 1_000_000),
          accountDailyAnalyses: config.ACCOUNT_DAILY_MEDIA_ANALYSES,
        }
      : undefined;
  const ledger =
    options.ledger ??
    (options.db && limits
      ? new ModelSpendLedger(new PostgresSpendStore(options.db), limits)
      : undefined);
  if (!ledger || (!ledger.store.durable && !options.allowTestStore)) return unavailable();
  const profiles =
    options.profiles ??
    (config.CONCENTRATE_PROFILE_FILE ? loadModelProfiles(config.CONCENTRATE_PROFILE_FILE) : {});
  const runners: Partial<Record<ModelRole, StructuredResponseRunner>> = {};
  const models = {
    vision_photo: config.VLM_MODEL,
    vision_video_frame: config.VLM_MODEL,
    research_text: config.RESEARCH_MODEL,
    composer: config.COMPOSER_MODEL,
  };
  const transport =
    options.transport ??
    createConcentrateTransport({
      apiKey: config.CONCENTRATE_API_KEY,
      baseUrl: config.CONCENTRATE_BASE_URL,
    });
  for (const role of ['vision_photo', 'vision_video_frame', 'research_text', 'composer'] as const) {
    const profile = profiles[role];
    // Optional environment IDs are assertions against qualified profiles, never replacements.
    if (!profile || profile.role !== role || (models[role] && models[role] !== profile.model))
      continue;
    runners[role] = new StructuredResponseRunner(profile, transport, ledger, {
      identity: options.identity,
      allowTestStore: options.allowTestStore,
    });
  }
  return {
    vlm: runners.vision_photo
      ? new ConcentrateVlm(runners.vision_photo)
      : new UnavailableVlm('not_configured'),
    videoFrames: runners.vision_video_frame
      ? new ConcentrateVlm(runners.vision_video_frame)
      : new UnavailableVlm('not_configured'),
    text: runners.research_text
      ? new ConcentrateTextModel(runners.research_text)
      : new UnavailableTextModel('not_configured'),
    composer: runners.composer
      ? new ConcentrateTextModel(runners.composer)
      : new UnavailableTextModel('not_configured'),
    runners,
    ledger,
  };
}
