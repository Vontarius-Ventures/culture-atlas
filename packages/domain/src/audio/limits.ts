/** Release defaults from specs/capture-platform-v2/AUDIO-AND-MULTIMODAL.md. */
export const AUDIO_LIMITS = {
  captureMaxDurationMs: 120_000,
  uploadMaxDurationMs: 600_000,
  uploadMaxBytes: 104_857_600,
  musicWindowDefaultMs: 15_000,
  musicWindowMinMs: 5_000,
  musicWindowMaxMs: 30_000,
  musicWindowsMax: 3,
  sampleRateMinHz: 8_000,
  sampleRateMaxHz: 96_000,
  maxChannels: 2,
  modelWorkMaxMs: 120_000,
  qualifiedContentTypes: ['audio/wav', 'audio/wave', 'audio/x-wav'] as const,
  pendingQualificationContentTypes: [
    'audio/mpeg',
    'audio/mp4',
    'audio/aac',
    'audio/x-m4a',
    'audio/flac',
    'audio/webm',
    'audio/ogg',
  ] as const,
} as const;

export const AUDIO_CAPABILITIES = {
  supported_media_kinds: ['photo', 'video', 'audio'] as const,
  analysis_components: ['music_match'] as const,
  speech_analysis_default: 'off' as const,
  automatic_cloud_analysis: false,
  camera_required_for_music_mode: false,
  qualified_audio_content_types: AUDIO_LIMITS.qualifiedContentTypes,
  pending_qualification_content_types: AUDIO_LIMITS.pendingQualificationContentTypes,
  elevenlabs_transcription: {
    preferred: true,
    enabled: false,
    reason: 'api_key_missing',
  },
  music_recognition: {
    adapter: 'unavailable',
    reason: 'not_configured',
  },
  limits: {
    capture_max_duration_ms: AUDIO_LIMITS.captureMaxDurationMs,
    upload_max_duration_ms: AUDIO_LIMITS.uploadMaxDurationMs,
    upload_max_bytes: AUDIO_LIMITS.uploadMaxBytes,
    music_window_default_ms: AUDIO_LIMITS.musicWindowDefaultMs,
    music_window_min_ms: AUDIO_LIMITS.musicWindowMinMs,
    music_window_max_ms: AUDIO_LIMITS.musicWindowMaxMs,
    music_windows_max: AUDIO_LIMITS.musicWindowsMax,
  },
} as const;
