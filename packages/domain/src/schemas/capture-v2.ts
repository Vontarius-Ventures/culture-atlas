import { z } from 'zod';

/** Shared wire contract. No client-supplied account IDs or storage keys are accepted. */
export const CaptureV2Uuid = z.uuid();
export const MediaKind = z.enum(['photo', 'video']);
export const MediaSource = z.enum(['browser_camera', 'phone_camera', 'meta_glasses', 'upload', 'legacy_sensor']);
export const MediaStatus = z.enum(['pending_upload', 'verifying', 'processing', 'ready', 'failed', 'deleted']);
export const UploadState = z.enum(['created', 'uploading', 'verifying', 'committed', 'aborted', 'expired', 'rejected']);
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const DateTime = z.iso.datetime({ offset: true });
const Revision = z.number().int().positive();

export const CreateMediaUploadRequest = z.object({
  client_capture_id: CaptureV2Uuid,
  kind: MediaKind,
  source: MediaSource.exclude(['legacy_sensor']),
  filename: z.string().min(1).max(255),
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']),
  byte_size: z.number().int().positive().max(262144000),
  sha256: Sha256,
  captured_at: DateTime.optional(),
  capture_session_id: CaptureV2Uuid.optional(),
}).strict();
export type CreateMediaUploadRequest = z.infer<typeof CreateMediaUploadRequest>;

export const PartReceipt = z.object({ part_number: z.number().int().min(1).max(10000), etag: z.string().min(1).max(1024) }).strict();
export const UploadPartsRequest = z.object({
  part_numbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100),
}).strict();
export const CompleteMediaUploadRequest = z.object({ parts: z.array(PartReceipt).min(1).max(10000) }).strict();
export const UploadPartInstruction = z.object({
  part_number: z.number().int().positive(),
  method: z.literal('PUT'),
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  expires_at: DateTime,
});
export const MediaUploadResponse = z.object({
  asset_id: CaptureV2Uuid,
  upload_id: CaptureV2Uuid,
  state: UploadState,
  expires_at: DateTime,
  part_size: z.number().int().positive(),
  part_count: z.number().int().positive(),
  parts: z.array(UploadPartInstruction),
  verified_parts: z.array(PartReceipt),
  error_code: z.string().nullable(),
});
export type MediaUploadResponse = z.infer<typeof MediaUploadResponse>;

/** Matches specs/capture-platform-v2/media-contract.schema.json. */
export const MediaAsset = z.object({
  schema_version: z.literal(1),
  id: CaptureV2Uuid,
  kind: MediaKind,
  source: MediaSource,
  status: MediaStatus,
  analysis_status: z.enum(['not_requested', 'queued', 'running', 'complete', 'failed']),
  created_at: DateTime,
  title: z.string().nullable().optional(),
  duration_ms: z.number().int().positive().max(120000).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  audio_present: z.boolean().optional(),
}).strict();
export const MediaDetailResponse = z.object({
  media: MediaAsset,
  generation: Revision,
  revision: Revision,
  links: z.object({
    original: z.string().nullable(),
    playback: z.string().nullable(),
    poster: z.string().nullable(),
    analysis: z.string().nullable(),
  }),
  error_code: z.string().nullable(),
});
export const MediaLibraryQuery = z.object({
  kind: MediaKind.optional(),
  status: MediaStatus.exclude(['deleted']).optional(),
  source: MediaSource.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const MediaLibraryResponse = z.object({ items: z.array(MediaDetailResponse), next_cursor: z.string().nullable() });
export const UpdateMediaRequest = z.object({ title: z.string().trim().max(255).nullable(), expected_revision: Revision }).strict();
export const DeleteMediaRequest = z.object({ expected_generation: Revision }).strict();
export const BatchDeleteMediaRequest = z.object({
  items: z.array(z.object({ id: CaptureV2Uuid, expected_generation: Revision }).strict()).min(1).max(100),
}).strict();
export const BatchDeleteMediaResponse = z.object({
  items: z.array(z.object({ id: CaptureV2Uuid, deleted: z.boolean(), error_code: z.string().nullable() })),
});

export const EnrollCaptureDeviceRequest = z.object({
  platform: z.enum(['ios', 'android']),
  app_version: z.string().min(1).max(100),
  installation_public_id: CaptureV2Uuid,
  proof: z.string().min(32).max(256),
  enrollment_grant: z.string().min(32).max(512).optional(),
  capabilities: z.record(z.string(), z.boolean()).default({}),
}).strict();
export const CaptureDeviceResponse = z.object({
  id: CaptureV2Uuid,
  platform: z.enum(['ios', 'android']),
  app_version: z.string(),
  revision: Revision,
  last_seen_at: DateTime,
  revoked_at: DateTime.nullable(),
  capabilities: z.record(z.string(), z.boolean()),
  readiness: z.enum(['unavailable', 'user_action_required', 'ready']),
  app_state: z.enum(['foreground', 'background', 'terminated']),
});
export const EnrolledCaptureDeviceResponse = z.object({
  installation: CaptureDeviceResponse,
  native_session: z.object({
    session_id: CaptureV2Uuid,
    installation_id: CaptureV2Uuid,
    account_id: CaptureV2Uuid,
    access_token: z.string(),
    refresh_token: z.string(),
    access_expires_at: DateTime,
    refresh_expires_at: DateTime,
  }),
});
export const SafeCaptureDeviceSetup = z.object({
  alias: z.string(),
  app_version: z.string(),
  last_seen_at: DateTime,
  stale: z.boolean(),
  capabilities: z.record(z.string(), z.boolean()),
  unavailable_reasons: z.array(z.string()),
});
export const DeviceStatusRequest = z.object({
  sequence: z.number().int().nonnegative(),
  capabilities: z.record(z.string(), z.boolean()),
  readiness: z.enum(['unavailable', 'user_action_required', 'ready']),
  app_state: z.enum(['foreground', 'background', 'terminated']),
}).strict();
export const RevokeCaptureDeviceRequest = z.object({ expected_revision: Revision }).strict();
export const CreateWearableRequest = z.object({
  sdk_reference: z.string().min(1).max(2048),
  display_name: z.string().trim().min(1).max(100),
  capabilities: z.record(z.string(), z.boolean()),
  permission_state: z.enum(['unknown', 'denied', 'granted']),
}).strict();
export const CreateCaptureSessionRequest = z.object({
  source: z.enum(['phone_camera', 'meta_glasses']),
  mode: MediaKind,
  connection_id: CaptureV2Uuid.optional(),
  local_session_id: CaptureV2Uuid.optional(),
}).strict();
export const ArmCaptureSessionRequest = z.object({
  enabled: z.boolean(),
  duration_seconds: z.number().int().min(1).max(600).default(600),
  allowed_agent_connection_ids: z.array(CaptureV2Uuid).max(100).default([]),
}).strict();
export const EndCaptureSessionRequest = z.object({ reason: z.string().max(100) }).strict();
export const CaptureSessionResponse = z.object({
  session_id: CaptureV2Uuid,
  generation: Revision,
  state: z.enum(['active', 'ended']),
  remote_arm_expires_at: DateTime.nullable(),
});
export const CaptureV2Error = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    request_id: z.string(),
    retry_after_ms: z.number().nonnegative().optional(),
  }),
});

/** Contract publication is separate from route implementation. See docs/capture-v2-contract.md. */
export const CAPTURE_V2_CONTRACT_VERSION = '2026-10-15.1';
export const CAPTURE_V2_ROUTES = {
  capabilities: 'GET /v2/capabilities',
  createUpload: 'POST /v2/uploads',
  getUpload: 'GET /v2/uploads/{id}',
  uploadParts: 'POST /v2/uploads/{id}/parts',
  completeUpload: 'POST /v2/uploads/{id}/complete',
  abortUpload: 'DELETE /v2/uploads/{id}',
  library: 'GET /v2/library',
  media: 'GET /v2/media/{id}',
  updateMedia: 'PATCH /v2/media/{id}',
  deleteMedia: 'DELETE /v2/media/{id}',
  batchDeleteMedia: 'POST /v2/media/batch-delete',
  enrollmentChallenge: 'POST /v2/devices/enrollment/challenge',
  enrollDevice: 'POST /v2/devices/enroll',
  devices: 'GET /v2/devices',
  revokeDevice: 'DELETE /v2/devices/{id}',
  deviceStatus: 'PUT /v2/device/status',
  createWearable: 'POST /v2/device/wearables',
  deleteWearable: 'DELETE /v2/device/wearables/{id}',
  captureSession: 'POST /v2/device/capture-sessions',
  armCaptureSession: 'POST /v2/device/capture-sessions/{id}/arm',
  endCaptureSession: 'POST /v2/device/capture-sessions/{id}/end',
} as const;
