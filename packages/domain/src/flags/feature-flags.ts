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
} as const;

export type FeatureFlagName = Exclude<keyof typeof FEATURE_FLAG_DEFAULTS, 'meta_glasses_label'>;
/** Must match the CHECK constraint in db/migrations/085_feature_kills_and_push.sql. */
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
    privacyVerified: boolean;
    budgetAvailable: boolean;
    providerReady: boolean;
  };
  agentApiConfigured: boolean;
  sharingConfigured: boolean;
  /** Explicit operator opt-ins for default-off flags without a written activation rule. */
  optIn: {
    automaticAnalysis: boolean;
    nativeVideoModelInput: boolean;
    agentRemoteCapture: boolean;
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
    agent_remote_capture_enabled: gate('agent_remote_capture_enabled', [
      [i.optIn.agentRemoteCapture, 'not_enabled'],
      [i.agentApiConfigured, 'agent_api_disabled'],
    ]),
  };
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
  return {
    ...base,
    flags: { ...base.flags, ...evaluation.flags },
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
  const killed = new Set<string>(list(env.FEATURE_KILL_SWITCHES).filter(isKillableFlag));
  const kills = await db.query<{ flag: string }>(
    `SELECT flag FROM feature_flag_kills WHERE lifted_at IS NULL AND (account_id IS NULL OR account_id=$1)`,
    [input.accountId],
  );
  for (const row of kills.rows) killed.add(row.flag);

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
  const wearableCaps = device?.wearable_capabilities ?? {};
  const analysisReadiness = input.analysisReadiness ?? {
    budgetAvailable: false,
    providerReady: false,
  };
  return evaluateFeatureFlags({
    killed,
    mediaCreationEnabled: notOff(env.CAPTURE_MEDIA_CREATION_ENABLED),
    cameraVideoEnabled: notOff(env.CAPTURE_VIDEO_UPLOAD_ENABLED),
    videoDecoderQualified: input.videoDecoderQualified,
    glasses: {
      // Operator-qualified builds that contain the real SDK, e.g. "ios@1.4.0".
      buildSupported:
        !!device &&
        deviceCaps.meta_wearables_sdk === true &&
        list(env.META_GLASSES_QUALIFIED_BUILDS).includes(
          `${device.platform}@${device.app_version}`,
        ),
      // Platform/release-channel entitlement verified by the operator.
      channelEligible:
        !!device && list(env.META_GLASSES_ENTITLED_PLATFORMS).includes(device.platform),
      rolloutEligible:
        rollout === 'all' ||
        (rollout === 'allowlist' &&
          list(env.META_GLASSES_ROLLOUT_ACCOUNT_IDS).includes(input.accountId)),
      deviceCompatible:
        deviceCaps.meta_wearables_supported_os === true &&
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
      keyConfigured:
        (env.LLM_PROVIDER === undefined || env.LLM_PROVIDER === 'concentrate') &&
        !!env.CONCENTRATE_API_KEY,
      profileQualified:
        !!env.CONCENTRATE_PROFILES_JSON || (!!env.VLM_MODEL && !!env.CONCENTRATE_PROFILE_FILE),
      // Spec defaults are the safe values (require ZDR, no content logging).
      privacyVerified:
        env.CONCENTRATE_REQUIRE_ZDR !== 'false' && env.CONCENTRATE_ALLOW_CONTENT_LOGGING !== 'true',
      budgetAvailable:
        Number(env.MODEL_DAILY_SPEND_LIMIT_USD) > 0 && analysisReadiness.budgetAvailable,
      providerReady: analysisReadiness.providerReady,
    },
    agentApiConfigured: notOff(env.AGENT_API_ENABLED),
    sharingConfigured: notOff(env.COLLECTION_SHARING_ENABLED),
    optIn: {
      automaticAnalysis: on(env.AUTOMATIC_ANALYSIS_ENABLED),
      nativeVideoModelInput: on(env.NATIVE_VIDEO_MODEL_INPUT_ENABLED),
      agentRemoteCapture: on(env.AGENT_REMOTE_CAPTURE_ENABLED),
    },
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
