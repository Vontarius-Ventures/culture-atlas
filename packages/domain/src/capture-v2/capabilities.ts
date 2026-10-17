import { CAPTURE_V2_CONTRACT_VERSION } from '../schemas/capture-v2';
import type { CaptureLimits } from './types';
import type { Queryable } from '../db/pool';
import { AppError } from '../errors';

/** Trusted worker heartbeat only; no HTTP endpoint accepts these claims. */
export async function heartbeatMediaWorker(
  db: Queryable,
  input: {
    workerId: string;
    qualifiedMatrixVersion: string;
    codecs: Record<string, boolean>;
  },
  now = new Date(),
): Promise<void> {
  if (
    !input.workerId ||
    input.workerId.length > 200 ||
    !input.qualifiedMatrixVersion ||
    input.qualifiedMatrixVersion.length > 200 ||
    !Object.values(input.codecs).some((v) => v === true)
  )
    throw new AppError('invalid_input');
  await db.query(
    `INSERT INTO media_worker_capabilities(worker_id,qualified_matrix_version,codecs,heartbeat_at) VALUES($1,$2,$3,$4)
     ON CONFLICT(worker_id) DO UPDATE SET qualified_matrix_version=excluded.qualified_matrix_version,
       codecs=excluded.codecs,heartbeat_at=excluded.heartbeat_at`,
    [input.workerId, input.qualifiedMatrixVersion, JSON.stringify(input.codecs), now],
  );
}
export async function hasQualifiedVideoWorker(
  db: Queryable,
  now = new Date(),
  enabled = true,
): Promise<boolean> {
  if (!enabled) return false;
  const { rows } = await db.query(
    `SELECT worker_id FROM media_worker_capabilities WHERE heartbeat_at>$1 AND heartbeat_at<=$2
     AND qualified_matrix_version<>'' AND jsonb_path_exists(codecs,'$.* ? (@ == true)') LIMIT 1`,
    [new Date(now.getTime() - 120000), now],
  );
  return !!rows.length;
}

export interface CaptureCapabilityPolicy {
  mediaCreationEnabled: boolean;
  cameraVideoEnabled: boolean;
  videoDecoderQualified: boolean;
  glasses: {
    buildSupported: boolean;
    channelEligible: boolean;
    rolloutEligible: boolean;
    deviceCompatible: boolean;
    permissionGranted: boolean;
    locallyReady: boolean;
    killed: boolean;
  };
  analysisReady: boolean;
  agentApiEnabled: boolean;
  sharingEnabled: boolean;
}
/** Inputs are evaluated server-side from qualified policy and authenticated device state. */
export function evaluateCaptureCapabilities(
  policy: CaptureCapabilityPolicy,
  limits: CaptureLimits,
) {
  const gates = policy.glasses;
  const reasons = [
    ...(!gates.buildSupported ? ['build_unsupported'] : []),
    ...(!gates.channelEligible ? ['release_channel_ineligible'] : []),
    ...(!gates.rolloutEligible ? ['rollout_unavailable'] : []),
    ...(!gates.deviceCompatible ? ['device_unsupported'] : []),
    ...(!gates.permissionGranted ? ['permission_required'] : []),
    ...(!gates.locallyReady ? ['user_action_required'] : []),
    ...(gates.killed ? ['temporarily_disabled'] : []),
  ];
  const glasses = !reasons.length;
  return {
    contract_version: CAPTURE_V2_CONTRACT_VERSION,
    flags: {
      media_library: true,
      camera_photo: policy.mediaCreationEnabled,
      camera_video:
        policy.mediaCreationEnabled && policy.cameraVideoEnabled && policy.videoDecoderQualified,
      file_photo_upload: policy.mediaCreationEnabled,
      file_video_upload: policy.mediaCreationEnabled && policy.videoDecoderQualified,
      meta_glasses_entry_visible: true,
      meta_glasses_capture_enabled: glasses,
      meta_glasses_audio_enabled: false,
      remote_glasses_capture_enabled: false,
      automatic_analysis: false,
      native_video_model_input: false,
      concentrate_analysis_enabled: policy.analysisReady,
      agent_api_enabled: policy.agentApiEnabled,
      collection_sharing_enabled: policy.sharingEnabled,
      agent_remote_capture_enabled: false,
    },
    limits: {
      photo_max_bytes: limits.photoMaxBytes,
      photo_max_pixels: limits.photoMaxPixels,
      video_max_bytes: limits.videoMaxBytes,
      video_max_duration_ms: limits.videoMaxDurationMs,
      capture_video_max_duration_ms: limits.captureVideoMaxDurationMs,
      account_quota_bytes: limits.accountQuotaBytes,
      batch_max_files: 20,
      concurrent_transfers: 2,
      analysis_daily_limit: limits.analysisDailyLimit,
      video_analysis_max_frames: 8,
    },
    availability: {
      meta_glasses: { available: glasses, reasons },
      analysis: {
        available: policy.analysisReady,
        reasons: policy.analysisReady ? [] : ['provider_unavailable'],
      },
      video: {
        available: policy.videoDecoderQualified,
        reasons: policy.videoDecoderQualified ? [] : ['decoder_unqualified'],
      },
    },
  };
}
