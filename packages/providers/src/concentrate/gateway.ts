import type { ProviderConfig } from '../config';
import { ModelSpendLedger, type SpendLimits } from '../model-gateway/budget';
import { PostgresSpendStore, type GatewayDb } from '../model-gateway/postgres';
import {
  StructuredResponseRunner,
  type GatewayAlert,
  type ReadinessDetail,
} from '../model-gateway/runner';
import type { ModelIdentity, ModelRole, StructuredTransport } from '../model-gateway/types';
import { UnavailableTextModel, UnavailableVlm, UnavailableVlmEnricher, UnavailableVlmVerifier } from '../unavailable';
import type { VlmEnricher, VlmProvider } from '../vlm/types';
import type { VlmVerifier } from '../vlm/verify';
import type { TextModelProvider } from '../text/types';
import {
  loadModelProfiles,
  parseModelProfiles,
  qualificationState,
  type ModelProfile,
  type ModelProfiles,
  type QualificationState,
} from './profiles';
import { ConcentrateTextModel, ConcentrateVlm, ConcentrateVlmEnricher, ConcentrateVlmVerifier } from './providers';
import { createConcentrateTransport } from './transport';

export const MODEL_ROLES = [
  'vision_photo',
  'vision_video_frame',
  'research_text',
  'composer',
  'vision_photo_enrich',
  'vision_verify',
] as const satisfies readonly ModelRole[];

export interface ModelGatewayOptions {
  /** Pool-level handle for the durable ledger, or a lazy getter (only called when configured). */
  db?: GatewayDb | (() => GatewayDb);
  ledger?: ModelSpendLedger;
  profiles?: ModelProfiles;
  identity?: ModelIdentity;
  transport?: StructuredTransport;
  /** Defaults to qualificationState(profile, CONCENTRATE_QUALIFICATION_DIR). */
  qualification?: (profile: ModelProfile) => QualificationState;
  onAlert?: (alert: GatewayAlert) => void;
  /** Explicit test-only escape hatch. Never inferred from NODE_ENV or enabled by registry. */
  allowTestStore?: boolean;
}

export interface RoleReadiness extends ReadinessDetail {
  role: ModelRole;
  /** Pinned provider/model for operators; omitted from consumer projections. */
  model: string | null;
}

export interface ModelGateway {
  vlm: VlmProvider;
  /** Stage-2 enrichment (vision_photo_enrich); unavailable unless that role is qualified. */
  vlmEnrich: VlmEnricher;
  /** Independent verifier (vision_verify); unavailable unless that role is qualified. */
  vlmVerify: VlmVerifier;
  videoFrames: VlmProvider;
  text: TextModelProvider;
  composer: TextModelProvider;
  /** Only qualified roles get a dispatching runner. */
  runners: Partial<Record<ModelRole, StructuredResponseRunner>>;
  ledger?: ModelSpendLedger;
  /** Read-only per-role readiness (no paid probe, no network). */
  readiness(): Promise<Record<ModelRole, RoleReadiness>>;
}

function spendLimits(config: ProviderConfig): SpendLimits | undefined {
  return config.MODEL_DAILY_SPEND_LIMIT_USD &&
    config.MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD &&
    config.MODEL_MAX_UNKNOWN_SPEND_USD
    ? {
        dailyMicros: Math.floor(config.MODEL_DAILY_SPEND_LIMIT_USD * 1_000_000),
        accountDailyMicros: Math.floor(config.MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD * 1_000_000),
        maxUnknownMicros: Math.floor(config.MODEL_MAX_UNKNOWN_SPEND_USD * 1_000_000),
        accountDailyAnalyses: config.ACCOUNT_DAILY_MEDIA_ANALYSES,
      }
    : undefined;
}

function configuredProfiles(config: ProviderConfig, options: ModelGatewayOptions): ModelProfiles {
  if (options.profiles) return options.profiles;
  if (config.CONCENTRATE_PROFILES_JSON)
    return parseModelProfiles(JSON.parse(config.CONCENTRATE_PROFILES_JSON));
  if (config.CONCENTRATE_PROFILE_FILE) return loadModelProfiles(config.CONCENTRATE_PROFILE_FILE);
  return {};
}

/**
 * Concentrate model gateway. Every role is independently unavailable when its
 * profile is missing, unqualified or circuit-open; media storage never depends
 * on it. There is no cross-gateway fallback: when Concentrate cannot serve a
 * role, that role is unavailable (Featherless/Anthropic are only reachable by
 * an operator explicitly setting LLM_PROVIDER for rollback).
 */
export function createModelGateway(
  config: ProviderConfig,
  options: ModelGatewayOptions = {},
): ModelGateway {
  const unavailableReadiness = async () =>
    Object.fromEntries(
      MODEL_ROLES.map((role) => [
        role,
        { role, model: null, state: 'unavailable', reason: 'not_configured' } as RoleReadiness,
      ]),
    ) as Record<ModelRole, RoleReadiness>;
  const unavailable = (): ModelGateway => ({
    vlm: new UnavailableVlm('not_configured'),
    vlmEnrich: new UnavailableVlmEnricher('not_configured'),
    vlmVerify: new UnavailableVlmVerifier('not_configured'),
    videoFrames: new UnavailableVlm('not_configured'),
    text: new UnavailableTextModel('not_configured'),
    composer: new UnavailableTextModel('not_configured'),
    runners: {},
    readiness: unavailableReadiness,
  });
  if (
    !config.CONCENTRATE_API_KEY ||
    !config.CONCENTRATE_REQUIRE_ZDR ||
    config.CONCENTRATE_ALLOW_CONTENT_LOGGING
  )
    return unavailable();
  const limits = spendLimits(config);
  const db = typeof options.db === 'function' ? options.db() : options.db;
  const ledger =
    options.ledger ??
    (db && limits ? new ModelSpendLedger(new PostgresSpendStore(db), limits) : undefined);
  if (!ledger || (!ledger.store.durable && !options.allowTestStore)) return unavailable();
  const profiles = configuredProfiles(config, options);
  const qualify =
    options.qualification ??
    ((profile: ModelProfile) => qualificationState(profile, config.CONCENTRATE_QUALIFICATION_DIR));
  const runners: Partial<Record<ModelRole, StructuredResponseRunner>> = {};
  const states: Partial<Record<ModelRole, QualificationState>> = {};
  const models = {
    vision_photo: config.VLM_MODEL,
    vision_video_frame: config.VLM_MODEL,
    research_text: config.RESEARCH_MODEL,
    composer: config.COMPOSER_MODEL,
    // Stage-2 enrichment may pin a different route than stage 1 (e.g. a richer
    // model); its profile is the only source of truth until a dedicated
    // environment assertion exists.
    vision_photo_enrich: undefined,
    // The verifier should be a different model family from the reader (quality plan §7.6); its profile pins it.
    vision_verify: undefined,
  } satisfies Record<ModelRole, string | undefined>;
  const transport =
    options.transport ??
    createConcentrateTransport({
      apiKey: config.CONCENTRATE_API_KEY,
      baseUrl: config.CONCENTRATE_BASE_URL,
    });
  for (const role of MODEL_ROLES) {
    const profile = profiles[role];
    // Optional environment IDs are assertions against qualified profiles, never replacements.
    if (!profile || profile.role !== role || (models[role] && models[role] !== profile.model))
      continue;
    states[role] = qualify(profile);
    // Only a qualified profile may dispatch. Lower states are reported, not used.
    if (states[role] !== 'qualified') continue;
    runners[role] = new StructuredResponseRunner(profile, transport, ledger, {
      identity: options.identity,
      allowTestStore: options.allowTestStore,
      onAlert: options.onAlert,
    });
  }
  return {
    vlm: runners.vision_photo
      ? new ConcentrateVlm(runners.vision_photo)
      : new UnavailableVlm('not_configured'),
    vlmEnrich: runners.vision_photo_enrich
      ? new ConcentrateVlmEnricher(runners.vision_photo_enrich)
      : new UnavailableVlmEnricher('not_configured'),
    vlmVerify: runners.vision_verify
      ? new ConcentrateVlmVerifier(runners.vision_verify)
      : new UnavailableVlmVerifier('not_configured'),
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
    async readiness() {
      const out = {} as Record<ModelRole, RoleReadiness>;
      for (const role of MODEL_ROLES) {
        const runner = runners[role];
        const profile = profiles[role];
        if (runner)
          out[role] = { role, model: profile!.model, ...(await runner.readinessDetail()) };
        else if (states[role])
          out[role] = {
            role,
            model: profile!.model,
            state: states[role]!,
            reason: 'not_qualified',
          };
        else out[role] = { role, model: null, state: 'unavailable', reason: 'not_configured' };
      }
      return out;
    },
  };
}
