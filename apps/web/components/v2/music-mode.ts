/**
 * Browser Music Mode client (amendment 2.3).
 *
 * Domain audio APIs are not merged on this server: uploads still accept
 * photo/video only, and there is no qualified recognizer. This module is the
 * named web seam against `specs/capture-platform-v2/audio-contract.examples.json`.
 * Honest unavailable states; never invent Qloo or recognition ids.
 *
 * AUD01: getUserMedia is audio-only. No video tracks, no camera preview.
 */
import { cameraProblem, type CameraProblem } from './camera-logic';
import { formatDuration } from './media-format';

/** Constraints passed to getUserMedia in Music Mode. `video` is always false. */
export const MUSIC_GET_USER_MEDIA_CONSTRAINTS = { audio: true, video: false } as const;

/** Spec default: browser audio capture up to 120 seconds. */
export const MUSIC_CAPTURE_LIMIT_MS = 120_000;

export const ACCEPT_AUDIO =
  'audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/x-wav,audio/flac,audio/webm,audio/ogg,audio/opus,.mp3,.m4a,.aac,.wav,.flac,.webm,.ogg';

export type MicProblem = CameraProblem;

export const MIC_PROBLEM_TEXT: Record<MicProblem, { title: string; body: string }> = {
  denied: {
    title: 'Microphone access is off',
    body: 'Allow microphone access for this site in your browser settings, then try again. You can also choose an audio file instead.',
  },
  insecure: {
    title: 'Microphone needs a secure page',
    body: 'Open culture atlas over https to record, or choose an audio file instead.',
  },
  unavailable: {
    title: 'No microphone found',
    body: 'This device has no microphone we can use. Choose an audio file instead.',
  },
  busy: {
    title: 'The microphone is busy',
    body: 'Another app may be using the microphone. Close it and try again, or choose an audio file instead.',
  },
  error: {
    title: 'The microphone did not start',
    body: 'Try again, or choose an audio file instead.',
  },
};

export function micProblem(err: unknown): MicProblem {
  return cameraProblem(err);
}

/**
 * True only when the call is audio-only. Any truthy `video` constraint
 * (boolean true or a MediaTrackConstraints object) fails AUD01.
 */
export function isAudioOnlyGetUserMedia(
  constraints: MediaStreamConstraints | undefined | null,
): boolean {
  if (!constraints) return false;
  if (constraints.video) return false;
  return constraints.audio === true || typeof constraints.audio === 'object';
}

export function assertAudioOnlyStream(stream: {
  getVideoTracks(): Array<{ kind: string; stop(): void }>;
}): void {
  const video = stream.getVideoTracks();
  if (video.length > 0) {
    for (const track of video) track.stop();
    throw new Error('Music Mode must not open camera tracks.');
  }
}

export function pickAudioRecorderType(isTypeSupported: (t: string) => boolean): {
  mimeType: string;
  contentType: 'audio/webm' | 'audio/mp4' | 'audio/ogg';
  extension: 'webm' | 'm4a' | 'ogg';
} | null {
  const candidates: Array<
    [string, 'audio/webm' | 'audio/mp4' | 'audio/ogg', 'webm' | 'm4a' | 'ogg']
  > = [
    ['audio/webm;codecs=opus', 'audio/webm', 'webm'],
    ['audio/webm', 'audio/webm', 'webm'],
    ['audio/mp4', 'audio/mp4', 'm4a'],
    ['audio/ogg;codecs=opus', 'audio/ogg', 'ogg'],
    ['audio/ogg', 'audio/ogg', 'ogg'],
  ];
  for (const [mimeType, contentType, extension] of candidates)
    if (isTypeSupported(mimeType)) return { mimeType, contentType, extension };
  return null;
}

export function musicFileName(extension: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `music-${stamp}.${extension}`;
}

export function musicLimitText(
  elapsedMs: number,
  limitMs: number = MUSIC_CAPTURE_LIMIT_MS,
  recording = false,
): { text: string; soon: boolean } {
  const left = Math.max(0, limitMs - elapsedMs);
  if (recording && left <= 10_000)
    return { text: `${formatDuration(Math.ceil(left / 1000) * 1000)} left`, soon: true };
  return { text: `${formatDuration(limitMs)} max`, soon: false };
}

/** Server-side audio pipeline is not on this tree. Keep recordings local. */
export const MUSIC_SERVER = {
  audio_upload: 'unavailable',
  music_match: 'unavailable',
  transcription: 'off',
  reason:
    'Audio library upload and music identification are not on this server yet. Recordings stay on this device.',
} as const;

/**
 * Explore action for a kept clip. Matches the spec contract's music_match
 * component selection; returns unavailable with null catalog ids.
 */
export function exploreMusic(selection?: { start_ms: number; end_ms: number }) {
  return {
    contract_version: 2 as const,
    requested_components: ['music_match'] as const,
    selection: selection ?? { start_ms: 0, end_ms: 15_000 },
    components: {
      music_match: {
        status: 'unavailable' as const,
        reason: 'no_qualified_recognizer',
        recognition_id: null,
        qloo_entity_id: null,
      },
    },
    notice: MUSIC_SERVER.reason,
  };
}

/** Glasses microphone is a separate native qualification; the browser cannot verify it. */
export function glassesMicrophoneAvailability(): { available: false; label: string } {
  return { available: false, label: 'Glasses microphone unavailable' };
}

export const BROWSER_MICROPHONE_LABEL = 'This browser';
