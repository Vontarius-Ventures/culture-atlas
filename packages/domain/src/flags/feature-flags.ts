import type { Queryable } from '../db/pool';
import { AppError } from '../errors';

/**
 * Server-side feature flag evaluation for capture platform v2.
 *
 * Source of truth for defaults and activation rules:
 * specs/capture-platform-v2/feature-flags.json (a test keeps this copy equal).
 *
 * Principles (from that file and BUILD-AND-ACCEPTANCE "Operational targets"):
 * - server evaluation is authoritative; client flags never grant anything;
 * - a flag whose default is `false` stays off until every activation input is
 *   proven server-side (or, for flags without a written rule, until the
 *   operator explicitly opts in);
 * - kill switches (global or per account, from env or the database) can only
 *   turn a feature off. `media_library` and the glasses entry cannot be killed:
 *   reads, deletion and already captured media keep working.
 */
export const FEATURE_FLAG_DEFAULTS = {
  media_library: true,
  camera_photo: true,
  camera_video: true,
  file_photo_upload: true,
  file_video_upload: true,
  meta_glasses_entry_visible: true,
  meta_glasses_label: 'Experimental',
  meta_glasses_capture_enabled: false,
  meta_glasses_audio_enabled: false,
  remote_glasses_capture_enabled: false,
  concentrate_analysis_enabled: true,
  automatic_analysis: false,
  native_video_model_input: false,
  agent_api_enabled: true,
  collection_sharing_enabled: true,
  agent_remote_capture_enabled: false,
  // Spec amendment 2.2 (specs/onboarding-and-fast-analysis.md).
  onboarding_required: true,
  taste_seed_enabled: true,
  fast_analysis_two_stage: false,
  while_we_look_enabled: true,
  // Photo-role requalification (docs/requalification-plan.md): the independent
  // verifier is off by default. The tune-split evaluation (docs/quality-plan.md
  // §15) kept it off: it lowered no forbidden-label count on the tune split.
  analysis_verifier_enabled: false,
  // Interest graph (PR 8): all four flags ship off and need an explicit
  // operator opt-in; kills (global or per account) can only turn them off.
  // Projection alone never changes live ranking or buys research; reads,
  // removals, retractions and deletion cleanup never depend on these flags.
  interest_graph_projection_enabled: false,
  interest_graph_discovery_enabled: false,
  interest_graph_research_enabled: false,
  interest_graph_framework_shadow_enabled: false,
} as const;

export type FeatureFlagName = Exclude<keyof typeof FEATURE_FLAG_DEFAULTS, 'meta_glasses_label'>;
/**
 * Must match the feature_flag_kills CHECK constraint (latest definition:
 * db/migrations/100_onboarding_contracts.sql, originally 085).
 */
export const KILLABLE_FLAGS = [
  'camera_photo',
  'camera_video',
  'file_photo_upload',
  'file_video_upload',
  'meta_glasses_capture_enabled',
  'meta_glasses_audio_enabled',
  'remote_glasses_capture_enabled',
  'concentrate_analysis_enabled',
  'automatic_analysis',
  'native_video_model_input',
  'agent_api_enabled',
  'collection_sharing_enabled',
  'agent_remote_capture_enabled',
  'onboarding_required',
  'taste_seed_enabled',
  'fast_analysis_two_stage',
  'while_we_look_enabled',
  'analysis_verifier_enabled',
  'interest_graph_projection_enabled',
  'interest_graph_discovery_enabled',
  'interest_graph_research_enabled',
  'interest_graph_framework_shadow_enabled',
] as const satisfies readonly FeatureFlagName[];
export type KillableFlag = (typeof KILLABLE_FLAGS)[number];
export const isKillableFlag = (value: string): value is KillableFlag =>
  (KILLABLE_FLAGS as readonly string[]).includes(value);

export interface FeatureFlagInputs {
  killed: ReadonlySet<string>;
  /** CAPTURE_MEDIA_CREATION_ENABLED (global pause of new captures). */
  mediaCreationEnabled: boolean;
  /** CAPTURE_VIDEO_UPLOAD_ENABLED. */
  cameraVideoEnabled: boolean;
  /** Fresh qualified media-worker heartbeat. */
  videoDecoderQualified: boolean;
  glasses: {
    buildSupported: boolean;
    channelEligible: boolean;
    rolloutEligible: boolean;
    deviceCompatible: boolean;
    permissionGranted: boolean;
    locallyReady: boolean;
  };
  remote: { armedLocally: boolean; sameAccount: boolean; freshDeviceState: boolean };
  audio: { qualifiedAudio: boolean; microphonePermission: boolean; sourceSelected: boolean };
  analysis: {
    keyConfigured: boolean;
    profileQualified: boolean;
    /** False when the vision_photo role is catalog-compatible but not quality-qualified. */
    qualityQualified: boolean;
    privacyVerified: boolean;
    budgetAvailable: boolean;
    providerReady: boolean;
    /** A qualified, ready vision_photo_enrich profile (stage-2 enrichment). */
    enrichReady: boolean;
    /** A qualified, ready vision_verify profile (the independent verifier). */
    verifyReady: boolean;
  };
  agentApiConfigured: boolean;
  sharingConfigured: boolean;
  /** Amendment 2.2 operator switches (env, default on; "false"/"0" turns them off). */
  onboarding: {
    /** ONBOARDING_REQUIRED */
    requiredConfigured: boolean;
    /** TASTE_SEED_ENABLED */
    seedConfigured: boolean;
    /** WHILE_WE_LOOK_ENABLED */
    whileWeLookConfigured: boolean;
  };
  /** Explicit operator opt-ins for default-off flags without a written activation rule. */
  optIn: {
    automaticAnalysis: boolean;
    nativeVideoModelInput: boolean;
    agentRemoteCapture: boolean;
    /** ANALYSIS_VERIFIER_ENABLED: set by the operator only after the tune-split evaluation enables the verifier. */
    analysisVerifier: boolean;
    /** Interest graph opt-ins (PR 8); each flag has its own independent gate. */
    interestGraph: {
      projection: boolean;
      discovery: boolean;
      research: boolean;
      frameworkShadow: boolean;
    };
  };
}

export type FeatureFlags = Record<FeatureFlagName, boolean> & {
  meta_glasses_label: 'Experimental';
};
export interface FeatureFlagEvaluation {
  flags: FeatureFlags;
  /** Safe, user-presentable reasons for gated features that are off. */
  reasons: Partial<Record<FeatureFlagName, string[]>>;
  /** Active kill switches (global and account) that applied to this evaluation. */
  killed: KillableFlag[];
}

/** Pure evaluation of the activation rules. No I/O, no client input. */
export function evaluateFeatureFlags(i: FeatureFlagInputs): FeatureFlagEvaluation {
  const reasons: FeatureFlagEvaluation['reasons'] = {};
  const gate = (flag: FeatureFlagName, checks: [boolean, string][]): boolean => {
    const failed = checks.filter(([ok]) => !ok).map(([, reason]) => reason);
    if (isKillableFlag(flag) && i.killed.has(flag)) failed.push('temporarily_disabled');
    if (failed.length) reasons[flag] = [...new Set(failed)];
    return failed.length === 0;
  };
  const creating: [boolean, string] = [i.mediaCreationEnabled, 'creation_paused'];
  const decoder: [boolean, string] = [i.videoDecoderQualified, 'decoder_unqualified'];
  const g = i.glasses;
  const glasses = gate('meta_glasses_capture_enabled', [
    creating,
    [g.buildSupported, 'build_unsupported'],
    [g.channelEligible, 'release_channel_ineligible'],
    [g.rolloutEligible, 'rollout_unavailable'],
    [g.deviceCompatible, 'device_unsupported'],
    [g.permissionGranted, 'permission_required'],
    [g.locallyReady, 'user_action_required'],
  ]);
  const analysis = gate('concentrate_analysis_enabled', [
    [i.analysis.keyConfigured, 'provider_unconfigured'],
    [i.analysis.profileQualified, 'model_unqualified'],
    [i.analysis.qualityQualified, 'model_unqualified'],
    [i.analysis.privacyVerified, 'privacy_unverified'],
    [i.analysis.budgetAvailable, 'budget_exhausted'],
    [i.analysis.providerReady, 'provider_unavailable'],
  ]);
  const flags: FeatureFlags = {
    media_library: true,
    meta_glasses_entry_visible: true,
    meta_glasses_label: 'Experimental',
    camera_photo: gate('camera_photo', [creating]),
    camera_video: gate('camera_video', [creating, [i.cameraVideoEnabled, 'video_paused'], decoder]),
    file_photo_upload: gate('file_photo_upload', [creating]),
    file_video_upload: gate('file_video_upload', [creating, decoder]),
    meta_glasses_capture_enabled: glasses,
    remote_glasses_capture_enabled: gate('remote_glasses_capture_enabled', [
      [glasses, 'glasses_unavailable'],
      [i.remote.armedLocally, 'arm_on_phone_required'],
      [i.remote.sameAccount, 'account_mismatch'],
      [i.remote.freshDeviceState, 'device_stale'],
    ]),
    meta_glasses_audio_enabled: gate('meta_glasses_audio_enabled', [
      [glasses, 'glasses_unavailable'],
      [i.audio.qualifiedAudio, 'audio_unqualified'],
      [i.audio.microphonePermission, 'microphone_permission_required'],
      [i.audio.sourceSelected, 'microphone_not_selected'],
    ]),
    concentrate_analysis_enabled: analysis,
    automatic_analysis: gate('automatic_analysis', [
      [i.optIn.automaticAnalysis, 'not_enabled'],
      [analysis, 'analysis_unavailable'],
    ]),
    native_video_model_input: gate('native_video_model_input', [
      [i.optIn.nativeVideoModelInput, 'not_enabled'],
      [analysis, 'analysis_unavailable'],
    ]),
    agent_api_enabled: gate('agent_api_enabled', [[i.agentApiConfigured, 'not_enabled']]),
    collection_sharing_enabled: gate('collection_sharing_enabled', [
      [i.sharingConfigured, 'not_enabled'],
    ]),
    agent_remote_capture_enabled: false,
    // Amendment 2.2. A kill (or env off) on onboarding_required lets new
    // accounts reach the feed without picks; the questionnaire itself stays
    // available in Settings -> Taste.
    onboarding_required: gate('onboarding_required', [
      [i.onboarding.requiredConfigured, 'not_enabled'],
    ]),
    taste_seed_enabled: gate('taste_seed_enabled', [[i.onboarding.seedConfigured, 'not_enabled']]),
    // Two-stage reading needs the stage-1 analysis path AND a qualified, ready
    // stage-2 (vision_photo_enrich) profile. Off: the single-call reading runs.
    fast_analysis_two_stage: gate('fast_analysis_two_stage', [
      [analysis, 'analysis_unavailable'],
      [i.analysis.enrichReady, 'model_unqualified'],
    ]),
    while_we_look_enabled: gate('while_we_look_enabled', [
      [i.onboarding.whileWeLookConfigured, 'not_enabled'],
    ]),
    analysis_verifier_enabled: false,
    // Interest graph flags are gated after the literal (PR 8): each stays off
    // until its operator opt-in holds and it is not killed.
    interest_graph_projection_enabled: false,
    interest_graph_discovery_enabled: false,
    interest_graph_research_enabled: false,
    interest_graph_framework_shadow_enabled: false,
  };
  // The verifier runs only after a stage 2, so it needs the two-stage reading,
  // a qualified, ready vision_verify profile and the operator's opt-in.
  flags.analysis_verifier_enabled = gate('analysis_verifier_enabled', [
    [i.optIn.analysisVerifier, 'not_enabled'],
    [flags.fast_analysis_two_stage, 'two_stage_unavailable'],
    [i.analysis.verifyReady, 'model_unqualified'],
  ]);
  // Remote capture is an agent API operation: a killed or unconfigured agent
  // API turns it off too (the phone then cancels queued commands on claim).
  flags.agent_remote_capture_enabled = gate('agent_remote_capture_enabled', [
    [i.optIn.agentRemoteCapture, 'not_enabled'],
    [flags.agent_api_enabled, 'agent_api_disabled'],
  ]);
  // Interest graph (PR 8): default-off operator opt-ins with independent
  // gates. Projection alone never switches live ranking/reasons or buys
  // research; discovery, research and the framework shadow each stay off
  // until their own opt-in AND none of their inputs is killed.
  flags.interest_graph_projection_enabled = gate('interest_graph_projection_enabled', [
    [i.optIn.interestGraph.projection, 'not_enabled'],
  ]);
  flags.interest_graph_discovery_enabled = gate('interest_graph_discovery_enabled', [
    [i.optIn.interestGraph.discovery, 'not_enabled'],
    [flags.interest_graph_projection_enabled, 'projection_disabled'],
  ]);
  flags.interest_graph_research_enabled = gate('interest_graph_research_enabled', [
    [i.optIn.interestGraph.research, 'not_enabled'],
  ]);
  flags.interest_graph_framework_shadow_enabled = gate('interest_graph_framework_shadow_enabled', [
    [i.optIn.interestGraph.frameworkShadow, 'not_enabled'],
  ]);
  return { flags, reasons, killed: KILLABLE_FLAGS.filter((flag) => i.killed.has(flag)) };
}

/**
 * Overlays the evaluated flags on the /v2/capabilities body built by
 * evaluateCaptureCapabilities, so the response contract keeps its shape while
 * flags and availability reasons come from one authoritative evaluation.
 */
export function applyFeatureFlagsToCapabilities<
  T extends { flags: Record<string, unknown>; availability: Record<string, unknown> },
>(base: T, evaluation: FeatureFlagEvaluation): T {
  const reasons = (flag: FeatureFlagName) => evaluation.reasons[flag] ?? [];
  // The wire `flags` map is boolean-only (CaptureCapabilitiesResponse). The
  // constant `meta_glasses_label` is presentation copy (design/copy.json
  // "capture.experimental"), so it stays server-side instead of breaking
  // clients that validate the response.
  const { meta_glasses_label: _label, ...booleanFlags } = evaluation.flags;
  void _label;
  return {
    ...base,
    flags: { ...base.flags, ...booleanFlags },
    availability: {
      ...base.availability,
      meta_glasses: {
        available: evaluation.flags.meta_glasses_capture_enabled,
        reasons: reasons('meta_glasses_capture_enabled'),
      },
      remote_glasses: {
        available: evaluation.flags.remote_glasses_capture_enabled,
        reasons: reasons('remote_glasses_capture_enabled'),
      },
      analysis: {
        available: evaluation.flags.concentrate_analysis_enabled,
        reasons: reasons('concentrate_analysis_enabled'),
      },
      video: {
        available: evaluation.flags.file_video_upload,
        reasons: reasons('file_video_upload'),
      },
    },
  };
}

type Env = Record<string, string | undefined>;
const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const on = (value: string | undefined) => value === 'true' || value === '1';
const notOff = (value: string | undefined) => value !== 'false' && value !== '0';

interface DeviceFlagState {
  platform: string;
  app_version: string;
  capabilities: Record<string, unknown>;
  readiness: string;
  app_state: string;
  last_seen_at: Date;
  permission_granted: boolean;
  wearable_capabilities: Record<string, unknown> | null;
  armed: boolean;
}

/** Analysis readiness is owned by the model gateway; it can be injected. */
export interface AnalysisReadiness {
  budgetAvailable: boolean;
  providerReady: boolean;
  /** False when vision_photo is catalog-compatible but not quality-qualified. */
  qualityQualified?: boolean;
  /** Stage-2 enrichment role is qualified and ready (absent: not ready). */
  enrichReady?: boolean;
  /** Verifier role (vision_verify) is qualified and ready (absent: not ready). */
  verifyReady?: boolean;
  /** vision_photo dispatches under the non-production demo override (unqualified). */
  experimental?: boolean;
}

/**
 * Collects inputs from server configuration and the authenticated
 * installation's persisted state, then evaluates. Never sends a paid probe.
 */
export async function resolveFeatureFlags(
  db: Queryable,
  input: {
    accountId: string;
    installationId: string | null;
    env: Env;
    now: Date;
    videoDecoderQualified: boolean;
    analysisReadiness?: AnalysisReadiness;
  },
): Promise<FeatureFlagEvaluation> {
  const { env, now } = input;
  const killed = await activeKills(db, input.accountId, env);

  let device = null as DeviceFlagState | null;
  if (input.installationId) {
    const { rows } = await db.query<DeviceFlagState>(
      `SELECT i.platform,i.app_version,i.capabilities,i.readiness,i.app_state,i.last_seen_at,
         (w.id IS NOT NULL) AS permission_granted, w.capabilities AS wearable_capabilities,
         EXISTS(SELECT 1 FROM capture_sessions s WHERE s.account_id=i.account_id AND s.installation_id=i.id
           AND s.state='active' AND s.source='meta_glasses' AND s.remote_arm_expires_at>$3) AS armed
       FROM mobile_installations i
       LEFT JOIN LATERAL (
         SELECT id,capabilities FROM wearable_connections
         WHERE account_id=i.account_id AND installation_id=i.id AND disconnected_at IS NULL
           AND permission_state='granted' ORDER BY created_at DESC LIMIT 1) w ON true
       WHERE i.account_id=$1 AND i.id=$2 AND i.revoked_at IS NULL AND i.authority_ended_at IS NULL`,
      [input.accountId, input.installationId, now],
    );
    device = rows[0] ?? null;
  }
  const fresh =
    !!device &&
    device.readiness === 'ready' &&
    device.app_state === 'foreground' &&
    now.getTime() - device.last_seen_at.getTime() <= 30_000;
  const rollout = env.META_GLASSES_ROLLOUT ?? 'none';
  const deviceCaps = device?.capabilities ?? {};
  // Native apps enroll with `meta_glasses_sdk` (true only in the experimental
  // DAT build); `meta_wearables_sdk` is the spec name. Either proves the SDK.
  // The DAT SDK only loads on an OS it supports, so an SDK build implies a
  // supported OS unless the app explicitly reports meta_wearables_supported_os=false
  // (fixtures/native-contract/capability-gate.json "device_capability_keys").
  const sdkPresent = deviceCaps.meta_wearables_sdk === true || deviceCaps.meta_glasses_sdk === true;
  const supportedOs =
    deviceCaps.meta_wearables_supported_os === true ||
    (sdkPresent && deviceCaps.meta_wearables_supported_os !== false);
  const wearableCaps = device?.wearable_capabilities ?? {};
  const analysisReadiness = input.analysisReadiness ?? {
    budgetAvailable: false,
    providerReady: false,
  };
  const elorianFallback = env.MODEL_FALLBACK === 'elorian' && !!env.ELORIAN_API_KEY;
  return evaluateFeatureFlags({
    killed,
    mediaCreationEnabled: notOff(env.CAPTURE_MEDIA_CREATION_ENABLED),
    cameraVideoEnabled: notOff(env.CAPTURE_VIDEO_UPLOAD_ENABLED),
    videoDecoderQualified: input.videoDecoderQualified,
    glasses: {
      // Operator-qualified builds that contain the real SDK, e.g. "ios@1.4.0".
      buildSupported:
        !!device &&
        sdkPresent &&
        list(env.META_GLASSES_QUALIFIED_BUILDS).includes(
          `${device.platform}@${device.app_version}`,
        ),
      // Platform/release-channel entitlement verified by the operator. A browser
      // has no app release of its own: it is eligible to explain setup and hand
      // off to the phone when some native release is entitled. It still never
      // captures (build_unsupported and the device checks stay false).
      channelEligible: device
        ? list(env.META_GLASSES_ENTITLED_PLATFORMS).includes(device.platform)
        : !input.installationId && list(env.META_GLASSES_ENTITLED_PLATFORMS).length > 0,
      rolloutEligible:
        rollout === 'all' ||
        (rollout === 'allowlist' &&
          list(env.META_GLASSES_ROLLOUT_ACCOUNT_IDS).includes(input.accountId)),
      deviceCompatible:
        supportedOs &&
        (wearableCaps.photo === true || wearableCaps.video === true),
      permissionGranted: !!device?.permission_granted,
      locallyReady: fresh,
    },
    remote: { armedLocally: !!device?.armed, sameAccount: true, freshDeviceState: fresh },
    audio: {
      qualifiedAudio: on(env.META_GLASSES_AUDIO_QUALIFIED) && wearableCaps.audio === true,
      microphonePermission: deviceCaps.microphone_permission === true,
      sourceSelected: deviceCaps.glasses_microphone_selected === true,
    },
    analysis: {
      // Accepts both the spec's env names and the gateway implementation's
      // (LLM_PROVIDER unset means Concentrate there). These are configuration
      // presence checks only; providerReady (injected readiness) is the real gate.
      // MODEL_FALLBACK=elorian with a key is an operator-chosen alternative route.
      keyConfigured:
        ((env.LLM_PROVIDER === undefined || env.LLM_PROVIDER === 'concentrate') &&
          !!env.CONCENTRATE_API_KEY) ||
        elorianFallback,
      // VLM_MODEL is an optional assertion against the profile, never required:
      // the profile file alone pins the route (gateway.ts).
      profileQualified:
        !!env.CONCENTRATE_PROFILES_JSON || !!env.CONCENTRATE_PROFILE_FILE || elorianFallback,
      qualityQualified: analysisReadiness.qualityQualified !== false,
      // Spec defaults are the safe values (require ZDR, no content logging).
      privacyVerified:
        env.CONCENTRATE_REQUIRE_ZDR !== 'false' && env.CONCENTRATE_ALLOW_CONTENT_LOGGING !== 'true',
      budgetAvailable:
        (Number(env.MODEL_DAILY_SPEND_LIMIT_USD) > 0 || elorianFallback) &&
        analysisReadiness.budgetAvailable,
      providerReady: analysisReadiness.providerReady,
      // Elorian is never used for analysis stages (amendment 2.2), so only a
      // ready Concentrate enrichment profile counts here.
      enrichReady: analysisReadiness.enrichReady === true,
      verifyReady: analysisReadiness.verifyReady === true,
    },
    agentApiConfigured: notOff(env.AGENT_API_ENABLED),
    sharingConfigured: notOff(env.COLLECTION_SHARING_ENABLED),
    onboarding: {
      requiredConfigured: notOff(env.ONBOARDING_REQUIRED),
      seedConfigured: notOff(env.TASTE_SEED_ENABLED),
      whileWeLookConfigured: notOff(env.WHILE_WE_LOOK_ENABLED),
    },
    optIn: {
      automaticAnalysis: on(env.AUTOMATIC_ANALYSIS_ENABLED),
      nativeVideoModelInput: on(env.NATIVE_VIDEO_MODEL_INPUT_ENABLED),
      agentRemoteCapture: on(env.AGENT_REMOTE_CAPTURE_ENABLED),
      analysisVerifier: on(env.ANALYSIS_VERIFIER_ENABLED),
      interestGraph: {
        projection: on(env.INTEREST_GRAPH_PROJECTION_ENABLED),
        discovery: on(env.INTEREST_GRAPH_DISCOVERY_ENABLED),
        research: on(env.INTEREST_GRAPH_RESEARCH_ENABLED),
        frameworkShadow: on(env.INTEREST_GRAPH_FRAMEWORK_SHADOW_ENABLED),
      },
    },
  });
}

/**
 * Flags that services enforce themselves on every request (not only reported
 * through GET /v2/capabilities): agent REST/MCP/media/events access, collection
 * sharing (owner broadening, redemption, viewing) and agent remote capture
 * (request, phone claim and the phone's pre-execution check).
 * Amendment 2.2 adds the onboarding gate (whether the questionnaire blocks the
 * personal feed), the taste seed job and the "While we look" strip.
 * fast_analysis_two_stage depends on model readiness, so it is evaluated with
 * resolveFeatureFlags (analysisReadiness.enrichReady), not here.
 */
export const SERVICE_FEATURES = [
  'agent_api_enabled',
  'collection_sharing_enabled',
  'agent_remote_capture_enabled',
  'onboarding_required',
  'taste_seed_enabled',
  'while_we_look_enabled',
] as const;
export type ServiceFeature = (typeof SERVICE_FEATURES)[number];

export interface ServiceFeatureEnv {
  AGENT_API_ENABLED?: string;
  COLLECTION_SHARING_ENABLED?: string;
  AGENT_REMOTE_CAPTURE_ENABLED?: string;
  ONBOARDING_REQUIRED?: string;
  TASTE_SEED_ENABLED?: string;
  WHILE_WE_LOOK_ENABLED?: string;
  FEATURE_KILL_SWITCHES?: string;
}

/**
 * Pure evaluation of the service-enforced flags. Uses the same rules as
 * evaluateFeatureFlags (a test keeps them equal).
 */
export function evaluateServiceFeature(
  flag: ServiceFeature,
  input: { killed: ReadonlySet<string>; env: ServiceFeatureEnv },
): { enabled: boolean; reasons: string[] } {
  const { killed, env } = input;
  const reasons: string[] = [];
  const agentApi = notOff(env.AGENT_API_ENABLED) && !killed.has('agent_api_enabled');
  if (flag === 'agent_api_enabled') {
    if (!notOff(env.AGENT_API_ENABLED)) reasons.push('not_enabled');
  } else if (flag === 'collection_sharing_enabled') {
    if (!notOff(env.COLLECTION_SHARING_ENABLED)) reasons.push('not_enabled');
  } else if (flag === 'onboarding_required') {
    if (!notOff(env.ONBOARDING_REQUIRED)) reasons.push('not_enabled');
  } else if (flag === 'taste_seed_enabled') {
    if (!notOff(env.TASTE_SEED_ENABLED)) reasons.push('not_enabled');
  } else if (flag === 'while_we_look_enabled') {
    if (!notOff(env.WHILE_WE_LOOK_ENABLED)) reasons.push('not_enabled');
  } else {
    if (!on(env.AGENT_REMOTE_CAPTURE_ENABLED)) reasons.push('not_enabled');
    if (!agentApi) reasons.push('agent_api_disabled');
  }
  if (killed.has(flag)) reasons.push('temporarily_disabled');
  return { enabled: reasons.length === 0, reasons };
}

/** Reads the active kill switches (environment and database) that apply to one account. */
export async function activeKills(
  db: Queryable,
  accountId: string,
  env: Pick<ServiceFeatureEnv, 'FEATURE_KILL_SWITCHES'>,
): Promise<Set<string>> {
  const killed = new Set<string>(list(env.FEATURE_KILL_SWITCHES).filter(isKillableFlag));
  const { rows } = await db.query<{ flag: string }>(
    `SELECT flag FROM feature_flag_kills WHERE lifted_at IS NULL AND (account_id IS NULL OR account_id=$1)`,
    [accountId],
  );
  for (const row of rows) killed.add(row.flag);
  return killed;
}

export async function serviceFeatureState(
  db: Queryable,
  input: { accountId: string; env: ServiceFeatureEnv },
  flag: ServiceFeature,
): Promise<{ enabled: boolean; reasons: string[] }> {
  return evaluateServiceFeature(flag, {
    killed: await activeKills(db, input.accountId, input.env),
    env: input.env,
  });
}

const SERVICE_FEATURE_MESSAGES: Record<ServiceFeature, string> = {
  agent_api_enabled: 'Agent access is temporarily unavailable.',
  collection_sharing_enabled: 'Sharing is temporarily unavailable.',
  agent_remote_capture_enabled: 'Agent capture is not available.',
  onboarding_required: 'The taste questionnaire is temporarily unavailable.',
  taste_seed_enabled: 'Building your feed is temporarily unavailable.',
  while_we_look_enabled: 'Suggestions are temporarily unavailable.',
};

/**
 * Server-side enforcement point. Throws service_unavailable (503) when the flag
 * is off for this account; `retryable` only when an operator kill is the sole
 * reason (it will be lifted), never for a feature that is not enabled at all.
 */
export async function requireServiceFeature(
  ctx: { db: Queryable; config: ServiceFeatureEnv },
  accountId: string,
  flag: ServiceFeature,
): Promise<void> {
  const state = await serviceFeatureState(ctx.db, { accountId, env: ctx.config }, flag);
  if (state.enabled) return;
  throw new AppError('service_unavailable', {
    message: SERVICE_FEATURE_MESSAGES[flag],
    retryable: state.reasons.every((reason) => reason === 'temporarily_disabled'),
    details: { feature: flag, reasons: state.reasons },
  });
}

/** Operator action (runbooks). A kill is idempotent; it never deletes media or grants. */
export async function setFeatureKill(
  db: Queryable,
  input: { flag: string; accountId: string | null; reason: string; actor: string },
): Promise<{ created: boolean }> {
  if (!isKillableFlag(input.flag))
    throw new AppError('invalid_input', { message: 'That feature cannot be switched off.' });
  const { rowCount } = await db.query(
    `INSERT INTO feature_flag_kills(account_id,flag,reason,created_by) VALUES($1,$2,$3,$4)
     ON CONFLICT ((COALESCE(account_id,'00000000-0000-0000-0000-000000000000'::uuid)), flag) WHERE lifted_at IS NULL
     DO NOTHING`,
    [input.accountId, input.flag, input.reason, input.actor],
  );
  return { created: rowCount === 1 };
}

export async function liftFeatureKill(
  db: Queryable,
  input: { flag: string; accountId: string | null; now?: Date },
): Promise<{ lifted: boolean }> {
  const { rowCount } = await db.query(
    `UPDATE feature_flag_kills SET lifted_at=$3 WHERE lifted_at IS NULL AND flag=$1
       AND account_id IS NOT DISTINCT FROM $2::uuid`,
    [input.flag, input.accountId, input.now ?? new Date()],
  );
  return { lifted: (rowCount ?? 0) > 0 };
}
