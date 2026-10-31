import type { ProviderConfig } from '../config';
import { ModelSpendLedger, type SpendLimits } from '../model-gateway/budget';
import { PostgresSpendStore, type GatewayDb } from '../model-gateway/postgres';
import {
  StructuredResponseRunner,
  type GatewayAlert,
  type ReadinessDetail,
} from '../model-gateway/runner';
import type { ModelIdentity, ModelRole, StructuredTransport } from '../model-gateway/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UnavailableTextModel,
  UnavailableVlm,
  UnavailableVlmEnricher,
  UnavailableVlmStyleReader,
  UnavailableVlmVerifier,
  UnverifiedTextModel,
  UnverifiedVlm,
} from '../unavailable';
import { PINNED_CONCENTRATE_ROUTES } from './catalog';
import type { VlmEnricher, VlmProvider } from '../vlm/types';
import { STYLE_MAX_OUTPUT_TOKENS, type VlmStyleReader } from '../vlm/style';
import { ConcentrateVlmStyleReader } from './style-provider';
import { CONNECTION_ASSET_MAX_OUTPUT_TOKENS } from '../connection-asset/schema';
import type { ConnectionAssetProvider } from '../connection-asset/types';
import { ConcentrateConnectionAsset, UnavailableConnectionAsset } from '../connection-asset/provider';
import type { VisualSimilarityProvider } from '../visual-similarity/types';
import { ConcentrateVisualSimilarity, UnavailableVisualSimilarity } from '../visual-similarity/provider';
import { VISUAL_SIMILARITY_MAX_OUTPUT_TOKENS } from '../visual-similarity/schema';
import type { VlmVerifier } from '../vlm/verify';
import type { TextModelProvider } from '../text/types';
import {
  CATALOG_SNAPSHOT_FILE,
  CatalogSnapshotSchema,
  catalogEntry,
  catalogCompatible,
  catalogZdrListed,
  evalGateFailure,
  loadModelProfiles,
  parseModelProfiles,
  qualificationState,
  type CatalogSnapshot,
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
  'vision_style',
  'vision_similarity',
  'vision_connection_asset',
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
  /** Operator notice for each role named in ANALYSIS_EXPERIMENTAL_ROLES (worker startup logs it). */
  onExperimental?: (notice: { role: ModelRole; access: RoleAccess; profileVersion?: string }) => void;
  /** Catalog snapshot for computed reservations (defaults to CONCENTRATE_QUALIFICATION_DIR's). */
  catalog?: CatalogSnapshot | null;
  /** Explicit test-only escape hatch. Never inferred from NODE_ENV or enabled by registry. */
  allowTestStore?: boolean;
}

/**
 * Why a role may (or may not) dispatch (style design §D.1). `reason` keeps
 * the runner's own readiness reasons (credits, rate limits, circuits).
 */
export type RoleAccess =
  | 'qualified'
  | 'experimental_production'
  | 'demo_override'
  | 'paused'
  | 'not_qualified'
  | 'catalog_incompatible'
  | 'spend_cap'
  | 'not_configured';

export interface RoleReadiness extends ReadinessDetail {
  role: ModelRole;
  /**
   * True when the role dispatches unqualified: under ANALYSIS_EXPERIMENTAL_ROLES
   * (any environment) or the CONCENTRATE_DEMO_ALLOW_ROLES demo override (never
   * production). Every client labels such results "Experimental".
   */
  experimental?: boolean;
  /** How the role got (or did not get) a runner. */
  access?: RoleAccess;
  /** Pinned provider/model for operators; omitted from consumer projections. */
  model: string | null;
}

export interface ModelGateway {
  vlm: VlmProvider;
  /** Stage-2 enrichment (vision_photo_enrich); unavailable unless that role is qualified. */
  vlmEnrich: VlmEnricher;
  /** Independent verifier (vision_verify); unavailable unless that role is qualified. */
  vlmVerify: VlmVerifier;
  /** Style reading (vision_style); qualified, or experimental under ANALYSIS_EXPERIMENTAL_ROLES. */
  vlmStyle: VlmStyleReader;
  visualSimilarity: VisualSimilarityProvider;
  connectionAsset: ConnectionAssetProvider;
  /** Roles whose runner dispatches unqualified (experimental production mode or the demo override). */
  experimentalRoles: ReadonlySet<ModelRole>;
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
        experimental: {
          dailyMicros: Math.floor(config.ANALYSIS_EXPERIMENTAL_DAILY_SPEND_LIMIT_USD * 1_000_000),
          accountDailyAnalyses: config.ANALYSIS_EXPERIMENTAL_ACCOUNT_DAILY,
        },
      }
    : undefined;
}

/**
 * Roles the operator explicitly allowed to dispatch while only
 * catalog-compatible (CONCENTRATE_DEMO_ALLOW_ROLES). Refused in production.
 */
export function demoAllowedRoles(config: Pick<ProviderConfig, 'CONCENTRATE_DEMO_ALLOW_ROLES' | 'NODE_ENV'>): Set<ModelRole> {
  if (!config.CONCENTRATE_DEMO_ALLOW_ROLES || config.NODE_ENV === 'production') return new Set();
  const known = new Set<string>(MODEL_ROLES);
  return new Set(
    config.CONCENTRATE_DEMO_ALLOW_ROLES.split(',')
      .map((r) => r.trim())
      .filter((r): r is ModelRole => known.has(r)),
  );
}

/**
 * Roles the operator allowed to dispatch UNQUALIFIED in any environment
 * (ANALYSIS_EXPERIMENTAL_ROLES, style design §D.1), always marked
 * experimental. Only known roles are kept; createModelGateway further
 * requires a catalog-compatible profile and reports any other role
 * (catalog_incompatible), never silently.
 */
export function experimentalRoles(config: Pick<ProviderConfig, 'ANALYSIS_EXPERIMENTAL_ROLES'>): Set<ModelRole> {
  if (!config.ANALYSIS_EXPERIMENTAL_ROLES) return new Set();
  const known = new Set<string>(MODEL_ROLES);
  return new Set(
    config.ANALYSIS_EXPERIMENTAL_ROLES.split(',')
      .map((r) => r.trim())
      .filter((r): r is ModelRole => known.has(r)),
  );
}

/** Image input tokens a provider may bill for the profile's largest image (about one token per 750 px). */
function imageTokens(profile: ModelProfile): number {
  return profile.image.maxCount ? Math.ceil(profile.image.maxPixels / 750) : 0;
}

/**
 * Worst-case cost of one call in micro-USD from the catalog's own prices
 * (R-12): (max input tokens + image tokens) x input price + max output tokens
 * x output price, on the profile's provider route, base tier. Null when the
 * catalog does not list a price for the route (never assumed).
 */
export function catalogReservationMicros(profile: ModelProfile, snapshot: CatalogSnapshot | null, maxOutputTokens = profile.maxOutputTokens): number | null {
  if (!snapshot) return null;
  const entry = catalogEntry(profile, snapshot) as { providers?: Record<string, { pricing?: unknown }> } | undefined;
  const pricing = entry?.providers?.[profile.provider]?.pricing;
  if (!Array.isArray(pricing)) return null;
  type Price = { price?: { USD?: unknown }; units?: unknown };
  const tier = (pricing as { condition?: unknown; tokens?: { input?: Price; output?: Price } }[]).find((p) => !p.condition) ?? null;
  const perToken = (p: Price | undefined) =>
    p && typeof p.price?.USD === 'number' && typeof p.units === 'number' && p.units > 0 ? p.price.USD / p.units : null;
  const input = perToken(tier?.tokens?.input);
  const output = perToken(tier?.tokens?.output);
  if (input === null || output === null) return null;
  const usd = (profile.maxInputTokens + imageTokens(profile)) * input + Math.min(maxOutputTokens, profile.maxOutputTokens) * output;
  return Math.ceil(usd * 1_000_000);
}

/** New role requires genuine local catalog/privacy/price evidence, even in experimental mode. */
function boundedVisionReservationMicros(profile: ModelProfile, snapshot: CatalogSnapshot | null, outputTokens: number): number | null {
  if (!snapshot || !catalogCompatible(profile, snapshot) || !catalogZdrListed(profile, snapshot) ||
      Date.parse(profile.privacyVerifiedAt) > Date.now() || !profile.pricingSnapshotVersion.trim()) return null;
  const entry = catalogEntry(profile, snapshot) as { providers?: Record<string, { pricing?: unknown }> } | undefined;
  const prices = entry?.providers?.[profile.provider]?.pricing;
  if (!Array.isArray(prices)) return null;
  const tier = prices.find((p) => p && typeof p === 'object' && !p.condition);
  for (const name of ['input', 'output']) {
    const token = tier?.tokens?.[name];
    if (!Number.isFinite(token?.price?.USD) || token.price.USD < 0 ||
        !Number.isFinite(token?.units) || token.units <= 0) return null;
  }
  const computed = catalogReservationMicros(profile, snapshot, outputTokens);
  if (!Number.isSafeInteger(computed) || computed === null || computed < 0) return null;
  // Conservative hard ceiling, not an increased global/account allowance.
  const reservation = Math.max(profile.reservationMicros, computed);
  return reservation <= 100_000 ? reservation : null;
}

export function visualSimilarityReservationMicros(profile: ModelProfile, snapshot: CatalogSnapshot | null): number | null {
  return boundedVisionReservationMicros(profile, snapshot, VISUAL_SIMILARITY_MAX_OUTPUT_TOKENS);
}
export function connectionAssetReservationMicros(profile: ModelProfile, snapshot: CatalogSnapshot | null): number | null {
  return boundedVisionReservationMicros(profile, snapshot, CONNECTION_ASSET_MAX_OUTPUT_TOKENS);
}

function readSnapshot(dir: string | undefined): CatalogSnapshot | null {
  if (!dir) return null;
  try {
    const parsed = CatalogSnapshotSchema.safeParse(JSON.parse(readFileSync(join(dir, CATALOG_SNAPSHOT_FILE), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
    vlmStyle: new UnavailableVlmStyleReader('not_configured'),
    visualSimilarity: new UnavailableVisualSimilarity(),
    connectionAsset: new UnavailableConnectionAsset(),
    experimentalRoles: new Set(),
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
  const canDispatch = !!(ledger && (ledger.store.durable || options.allowTestStore));
  const profiles = configuredProfiles(config, options);
  const qualify =
    options.qualification ??
    ((profile: ModelProfile) => qualificationState(profile, config.CONCENTRATE_QUALIFICATION_DIR));
  const runners: Partial<Record<ModelRole, StructuredResponseRunner>> = {};
  const states: Partial<Record<ModelRole, QualificationState>> = {};
  const demoRoles = demoAllowedRoles(config);
  const productionExperimental = experimentalRoles(config);
  const experimentalOn = config.ANALYSIS_EXPERIMENTAL_ENABLED !== false;
  const experimental = new Set<ModelRole>();
  const access: Partial<Record<ModelRole, RoleAccess>> = {};
  let snapshot: CatalogSnapshot | null | undefined;
  const catalog = () => (snapshot === undefined ? (snapshot = options.catalog ?? readSnapshot(config.CONCENTRATE_QUALIFICATION_DIR)) : snapshot);
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
    // The style reading pins its own (most accurate in-budget) model in its profile (style design §B.2).
    vision_style: undefined,
    vision_similarity: undefined,
    vision_connection_asset: undefined,
  } satisfies Record<ModelRole, string | undefined>;
  const transport = canDispatch
    ? (options.transport ??
      createConcentrateTransport({
        apiKey: config.CONCENTRATE_API_KEY,
        baseUrl: config.CONCENTRATE_BASE_URL,
      }))
    : undefined;
  for (const role of MODEL_ROLES) {
    let profile = profiles[role];
    // Optional environment IDs are assertions against qualified profiles, never replacements.
    if (!profile || profile.role !== role || (models[role] && models[role] !== profile.model)) {
      if (productionExperimental.has(role)) {
        access[role] = 'not_configured';
        options.onExperimental?.({ role, access: 'not_configured' });
      }
      continue;
    }
    states[role] = qualify(profile);
    // This task has no bound independent evaluation yet. Neither a synthetic
    // artifact nor an injected generic qualification callback can qualify it.
    if (role === 'vision_connection_asset' && states[role] === 'qualified' && evalGateFailure(role, undefined) !== null)
      states[role] = catalog() && catalogCompatible(profile, catalog()!) ? 'catalog-compatible' : 'configured';
    // Only a qualified profile may dispatch. Lower states are reported, not used,
    // except a catalog-compatible role the operator named in the demo override
    // (never production) or in ANALYSIS_EXPERIMENTAL_ROLES (any environment).
    const demo = states[role] === 'catalog-compatible' && demoRoles.has(role);
    const named = productionExperimental.has(role) && states[role] !== 'qualified';
    if (named && states[role] !== 'catalog-compatible') {
      // Never dropped silently: reported in readiness and to the operator.
      access[role] = 'catalog_incompatible';
      options.onExperimental?.({ role, access: 'catalog_incompatible' });
    }
    const prod = named && states[role] === 'catalog-compatible';
    if (prod && !experimentalOn) {
      access[role] = 'paused';
      options.onExperimental?.({ role, access: 'paused' });
    }
    const runsExperimental = (prod && experimentalOn) || demo;
    if (role === 'vision_connection_asset' && config.CONNECTION_MAX_ASSET_CHECKS_PER_CAPTURE === 0) continue;
    if ((role === 'vision_similarity' || role === 'vision_connection_asset') && (states[role] === 'qualified' || runsExperimental)) {
      const micros = role === 'vision_connection_asset'
        ? connectionAssetReservationMicros(profile, catalog()) : visualSimilarityReservationMicros(profile, catalog());
      if (micros === null) {
        access[role] = 'spend_cap';
        options.onExperimental?.({ role, access: 'spend_cap' });
        continue;
      }
      profile = { ...profile, reservationMicros: micros };
    }
    if (role === 'vision_style' && (states[role] === 'qualified' || runsExperimental)) {
      // R-12: the reservation is computed from catalog prices, never hardcoded; capped per call.
      const micros = catalogReservationMicros(profile, catalog(), STYLE_MAX_OUTPUT_TOKENS);
      if (micros === null || micros > Math.floor(config.STYLE_MAX_CALL_USD * 1_000_000)) {
        access[role] = 'spend_cap';
        options.onExperimental?.({ role, access: 'spend_cap' });
        continue;
      }
      profile = { ...profile, reservationMicros: Math.max(profile.reservationMicros, micros) };
    }
    if ((states[role] !== 'qualified' && !runsExperimental) || !canDispatch || !transport || !ledger) {
      access[role] ??= states[role] === 'qualified' ? 'not_configured' : 'not_qualified';
      continue;
    }
    if (runsExperimental) {
      experimental.add(role);
      access[role] = prod ? 'experimental_production' : 'demo_override';
      if (prod) options.onExperimental?.({ role, access: 'experimental_production', profileVersion: profile.version });
    } else access[role] = 'qualified';
    runners[role] = new StructuredResponseRunner(profile, transport, ledger, {
      identity: options.identity,
      allowTestStore: options.allowTestStore,
      onAlert: options.onAlert,
    });
  }
  // Experimental runners are charged to their own daily bucket (style design §D.1).
  if (ledger) ledger.experimentalRoles = experimental;
  const vlmModel =
    (states.vision_photo && profiles.vision_photo?.model) ||
    models.vision_photo ||
    PINNED_CONCENTRATE_ROUTES.vision.model;
  const textModel =
    (states.research_text && profiles.research_text?.model) ||
    models.research_text ||
    PINNED_CONCENTRATE_ROUTES.text.model;
  return {
    vlm: runners.vision_photo ? new ConcentrateVlm(runners.vision_photo) : new UnverifiedVlm(vlmModel),
    vlmEnrich: runners.vision_photo_enrich
      ? new ConcentrateVlmEnricher(runners.vision_photo_enrich)
      : new UnavailableVlmEnricher('not_configured'),
    vlmVerify: runners.vision_verify
      ? new ConcentrateVlmVerifier(runners.vision_verify)
      : new UnavailableVlmVerifier('not_configured'),
    vlmStyle: runners.vision_style
      ? new ConcentrateVlmStyleReader(runners.vision_style)
      : new UnavailableVlmStyleReader('not_configured'),
    visualSimilarity: runners.vision_similarity
      ? new ConcentrateVisualSimilarity(runners.vision_similarity, experimental.has('vision_similarity'))
      : new UnavailableVisualSimilarity(),
    connectionAsset: runners.vision_connection_asset
      ? new ConcentrateConnectionAsset(runners.vision_connection_asset, config.CONNECTION_MAX_ASSET_CHECKS_PER_CAPTURE)
      : new UnavailableConnectionAsset(),
    experimentalRoles: experimental,
    videoFrames: runners.vision_video_frame
      ? new ConcentrateVlm(runners.vision_video_frame)
      : new UnavailableVlm('not_configured'),
    text: runners.research_text
      ? new ConcentrateTextModel(runners.research_text)
      : new UnverifiedTextModel(textModel),
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
          out[role] = {
            role,
            model: profile!.model,
            ...(await runner.readinessDetail()),
            ...(experimental.has(role) ? { experimental: true } : {}),
            access: access[role] ?? 'qualified',
          };
        else if (access[role] === 'paused' || access[role] === 'spend_cap')
          out[role] = { role, model: profile!.model, state: 'unavailable', experimental: true, access: access[role] };
        else if (states[role])
          out[role] = {
            role,
            model: profile!.model,
            state: states[role]!,
            reason: 'not_qualified',
            access: access[role] ?? 'not_qualified',
          };
        else out[role] = { role, model: null, state: 'unavailable', reason: 'not_configured', access: access[role] ?? 'not_configured' };
      }
      return out;
    },
  };
}
