import { z } from 'zod';
import { CaptureV2Uuid, Sha256 } from './capture-v2';
import { Uuid } from './common';

const DateTime = z.iso.datetime({ offset: true });
const Revision = z.number().int().positive();

/** v1 photo/video kinds. Unknown values (including audio) fail closed without throwing. */
export const LegacyMediaKind = z.enum(['photo', 'video']);
export const AudioAssetKind = z.literal('audio');
export const AUDIO_SCHEMA_VERSION = 2 as const;

export const AudioMediaSource = z.enum([
  'browser_microphone',
  'phone_microphone',
  'meta_glasses',
  'upload',
]);
export const MusicCaptureMode = z.literal('music');
export const AudioAnalysisComponent = z.enum(['music_match', 'speech_references', 'soundscape']);
export const AudioComponentState = z.enum([
  'not_requested',
  'queued',
  'running',
  'succeeded',
  'no_result',
  'unavailable',
  'failed',
  'cancelled',
]);
export const MusicResultState = z.enum([
  'matching',
  'identified',
  'possible_matches',
  'no_reliable_match',
  'provider_unavailable',
]);
export const MusicModeState = z.enum([
  'idle',
  'permission_requested',
  'route_check',
  'recording',
  'finalizing',
  'local_draft',
  'queued_upload',
  'ready',
]);
export type MusicModeState = z.infer<typeof MusicModeState>;
export const QualifiedAudioContentType = z.enum(['audio/wav', 'audio/wave', 'audio/x-wav']);
export const ProposedAudioContentType = z.enum([
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
  'audio/flac',
  'audio/webm',
  'audio/ogg',
]);

export const AUDIO_SCOPES = [
  'audio:read',
  'audio:analyze',
  'transcripts:read',
  'transcripts:write',
  'devices:microphone_record',
] as const;
export type AudioScope = (typeof AUDIO_SCOPES)[number];

export const MUSIC_MODE_PERMISSIONS = ['microphone'] as const;
export const MUSIC_MODE_FORBIDDEN_PERMISSIONS = ['camera'] as const;

export const CreateAudioUploadRequest = z
  .object({
    client_capture_id: CaptureV2Uuid,
    kind: AudioAssetKind,
    source: AudioMediaSource,
    filename: z.string().min(1).max(255),
    content_type: QualifiedAudioContentType,
    byte_size: z.number().int().positive().max(104857600),
    sha256: Sha256,
    captured_at: DateTime.optional(),
    capture_session_id: CaptureV2Uuid.optional(),
    destination_collection_id: CaptureV2Uuid.optional(),
    capture_mode: MusicCaptureMode.default('music'),
    source_route: z.string().min(1).max(100).optional(),
  })
  .strict();
export type CreateAudioUploadRequest = z.infer<typeof CreateAudioUploadRequest>;

export const KeepAudioRecordingRequest = z
  .object({
    client_capture_id: CaptureV2Uuid,
    source: AudioMediaSource.exclude(['upload']),
    filename: z.string().min(1).max(255).default('music-mode.wav'),
    content_type: QualifiedAudioContentType.default('audio/wav'),
    captured_at: DateTime.optional(),
    capture_session_id: CaptureV2Uuid.optional(),
    source_route: z.string().min(1).max(100).default('phone_microphone'),
    title: z.string().trim().max(255).nullable().optional(),
  })
  .strict();
export type KeepAudioRecordingRequest = z.infer<typeof KeepAudioRecordingRequest>;

export const MusicWindow = z
  .object({
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().positive(),
  })
  .strict()
  .refine((w) => w.end_ms - w.start_ms >= 5000 && w.end_ms - w.start_ms <= 30000, {
    message: 'Music windows must be 5–30 seconds.',
  });

export const AudioSelection = z
  .object({
    track_id: Uuid.optional(),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().positive(),
    windows: z.array(MusicWindow).max(3).optional(),
  })
  .strict()
  .refine((s) => s.start_ms < s.end_ms, { message: 'Selection start must precede end.' });

/**
 * A song the client recognized on-device before asking for analysis (iOS:
 * ShazamKit). It is a hint, never a result: the job resolves the artist only
 * through Qloo search, exactly like the fingerprint and transcript tiers.
 */
export const ClientRecognizedSong = z
  .object({
    vendor: z.literal('shazamkit'),
    artist_name: z.string().trim().min(1).max(120),
    title: z.string().trim().max(200).nullable().optional(),
    matched_at_ms: z.number().int().nonnegative().nullable().optional(),
    vendor_recording_id: z.string().trim().max(120).nullable().optional(),
  })
  .strict();
export type ClientRecognizedSong = z.infer<typeof ClientRecognizedSong>;

export const AnalyzeAudioRequest = z
  .object({
    contract_version: z.literal(2),
    expected_generation: Revision,
    requested_components: z.array(AudioAnalysisComponent).min(1).max(3),
    selection: AudioSelection,
    client_recognition: ClientRecognizedSong.optional(),
  })
  .strict();
export type AnalyzeAudioRequest = z.infer<typeof AnalyzeAudioRequest>;

export const AudioAsset = z
  .object({
    schema_version: z.literal(AUDIO_SCHEMA_VERSION),
    id: CaptureV2Uuid,
    kind: AudioAssetKind,
    source: AudioMediaSource,
    capture_mode: MusicCaptureMode,
    duration_ms: z.number().int().positive().max(600000),
    sample_rate_hz: z.number().int().min(8000).max(96000).optional(),
    channels: z.union([z.literal(1), z.literal(2)]).optional(),
    codec: z.string().min(1).max(40).optional(),
    bitrate: z.number().int().positive().optional(),
    source_route: z.string().min(1).max(100).optional(),
    audio_quality: z.string().max(40).optional(),
    status: z.enum(['pending_upload', 'verifying', 'processing', 'ready', 'failed', 'deleted']),
    analysis_status: z.enum(['not_requested', 'queued', 'running', 'complete', 'failed']),
    camera_active: z.literal(false),
    speech_analysis: z.literal('off'),
    created_at: DateTime,
    title: z.string().nullable().optional(),
  })
  .strict();
export type AudioAsset = z.infer<typeof AudioAsset>;

export const AudioDetailResponse = z.object({
  media: AudioAsset,
  generation: Revision,
  revision: Revision,
  track_id: CaptureV2Uuid.nullable(),
  links: z.object({
    original: z.string().nullable(),
    playback: z.string().nullable(),
    analysis: z.string().nullable(),
  }),
  error_code: z.string().nullable(),
});
export type AudioDetailResponse = z.infer<typeof AudioDetailResponse>;

export const AnalyzeAudioResponse = z.object({
  analysis_id: CaptureV2Uuid,
  job_id: CaptureV2Uuid,
  state: z.enum(['queued', 'running', 'partial', 'complete', 'failed', 'cancelled']),
  reused: z.boolean(),
  result_url: z.string().nullable(),
  error_code: z.string().nullable().optional(),
});
export type AnalyzeAudioResponse = z.infer<typeof AnalyzeAudioResponse>;

export const AudioEvidence = z
  .object({
    id: CaptureV2Uuid,
    modality: z.literal('audio'),
    track_id: CaptureV2Uuid.nullable(),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().positive(),
    method: z.string(),
    status: z.enum(['matched', 'ambiguous', 'no_match', 'unavailable', 'partial']),
    recognition_id: CaptureV2Uuid.nullable(),
    qloo_entity_id: z.string().nullable(),
    relationship: z.enum(['heard', 'spoken', 'seen', 'written', 'user_confirmed', 'related']),
  })
  .strict();
export type AudioEvidence = z.infer<typeof AudioEvidence>;

export const QlooAudioSeed = z
  .object({
    entity_id: z.string().min(1),
    entity_type: z.literal('urn:entity:artist'),
    name: z.string().min(1),
    insights_eligible: z.literal(true),
    /** Affinity is Qloo relationship strength and is never stored here. */
    affinity: z.undefined().optional(),
  })
  .strict();
export type QlooAudioSeed = z.infer<typeof QlooAudioSeed>;

export const CreateMusicCaptureSessionRequest = z
  .object({
    source: z.enum(['phone_microphone', 'meta_glasses', 'browser_microphone']),
    mode: AudioAssetKind,
    capture_mode: MusicCaptureMode.default('music'),
    connection_id: CaptureV2Uuid.optional(),
    local_session_id: CaptureV2Uuid.optional(),
  })
  .strict();
export type CreateMusicCaptureSessionRequest = z.infer<typeof CreateMusicCaptureSessionRequest>;

export const RecordAudioCommandRequest = z
  .object({
    session_id: Uuid,
    generation: Revision,
    action: z.enum(['record_audio', 'stop_audio']),
    capture_client_id: Uuid,
    duration_seconds: z.number().int().min(1).max(120).optional(),
    expires_in_seconds: z.number().int().min(1).max(30).default(30),
  })
  .strict();

export const AUDIO_V2_ROUTES = {
  createAudioUpload: 'POST /v2/uploads',
  keepAudioRecording: 'POST /v2/media/audio',
  audioMedia: 'GET /v2/media/{id}',
  analyzeAudio: 'POST /v2/media/{id}/analysis',
  audioAnalysis: 'GET /v2/media/{id}/analysis/{analysisId}',
  audioTracks: 'GET /v2/media/{id}/tracks',
  audioEvidence: 'GET /v2/media/{id}/evidence',
  audioTranscript: 'GET /v2/media/{id}/transcript',
  saveMoment: 'POST /v2/media/{id}/moments',
  deleteMoment: 'DELETE /v2/media/{id}/moments/{momentId}',
} as const;

export function parseLegacyMediaKind(value: unknown): 'photo' | 'video' | null {
  const parsed = LegacyMediaKind.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function filterLegacyLibraryItems<T extends { kind?: unknown }>(items: readonly T[]): T[] {
  return items.filter((item) => parseLegacyMediaKind(item.kind) !== null);
}
