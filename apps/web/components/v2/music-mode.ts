/**
 * Browser Music Mode client (amendment 2.3).
 *
 * Keep and Explore call the audio domain over HTTP. This slice is WAV/PCM
 * only. AUD01: getUserMedia is `{ audio: true }` with no `video` key.
 * Missing recognizer stays honest unavailable/partial; never invent Qloo ids.
 * Do not send recordings to ElevenLabs.
 */
import { cameraProblem, type CameraProblem } from './camera-logic';
import { formatDuration } from './media-format';

/** Matches domain `musicModeGetUserMediaConstraints()`. No `video` key. */
export const MUSIC_GET_USER_MEDIA_CONSTRAINTS = { audio: true } as const;

export const MUSIC_CAPTURE_LIMIT_MS = 120_000;
export const MUSIC_SAMPLE_RATE_HZ = 16_000;

export const ACCEPT_AUDIO = 'audio/wav,audio/wave,audio/x-wav,.wav';

export type MicProblem = CameraProblem;

export const MIC_PROBLEM_TEXT: Record<MicProblem, { title: string; body: string }> = {
  denied: {
    title: 'Microphone access is off',
    body: 'Allow microphone access for this site in your browser settings, then try again. You can also choose a WAV file instead.',
  },
  insecure: {
    title: 'Microphone needs a secure page',
    body: 'Open culture atlas over https to record, or choose a WAV file instead.',
  },
  unavailable: {
    title: 'No microphone found',
    body: 'This device has no microphone we can use. Choose a WAV file instead.',
  },
  busy: {
    title: 'The microphone is busy',
    body: 'Another app may be using the microphone. Close it and try again, or choose a WAV file instead.',
  },
  error: {
    title: 'The microphone did not start',
    body: 'Try again, or choose a WAV file instead.',
  },
};

export function micProblem(err: unknown): MicProblem {
  return cameraProblem(err);
}

/**
 * True only when the call is audio-only and never names a video track.
 * A `video: false` key still fails AUD01 (domain constraints omit `video`).
 */
export function isAudioOnlyGetUserMedia(
  constraints: MediaStreamConstraints | undefined | null,
): boolean {
  if (!constraints) return false;
  if ('video' in constraints) return false;
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

export function isQualifiedWavFile(file: { name: string; type: string }): boolean {
  return /^audio\/(wav|wave|x-wav)$/i.test(file.type) || /\.wav$/i.test(file.name);
}

/** 16-bit PCM WAV. Domain parsePcmWav accepts this container only. */
export function encodePcmWav(samples: Float32Array, sampleRateHz: number): Blob {
  const dataSize = samples.length * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export function concatPcm(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

export function musicFileName(_extension: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `music-${stamp}.wav`;
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

export const MUSIC_SERVER = {
  transcription: 'off',
  elevenlabs: 'disabled',
  reason:
    'Audio identification is not configured on this server yet. Recordings stay in your library without a match.',
} as const;

export function exploreNotice(analysis: {
  state: string;
  error_code?: string | null;
  result?: unknown;
}): string {
  const result = analysis.result as
    | {
        components?: { music_match?: { state?: string; reason?: string | null } };
        qloo_seeds?: Array<{ entity_id?: string | null }>;
        recognition_id?: string | null;
      }
    | null
    | undefined;
  const match = result?.components?.music_match;
  if (analysis.state === 'queued' || analysis.state === 'running') {
    return 'Looking up the music. This stays in your library either way.';
  }
  if (match?.state === 'unavailable' || analysis.state === 'partial') {
    return (
      match?.reason === 'not_configured'
        ? MUSIC_SERVER.reason
        : 'Music identification is unavailable. Nothing was invented.'
    );
  }
  if (match?.state === 'no_result' || analysis.state === 'complete') {
    const seeds = result?.qloo_seeds ?? [];
    if (!seeds.length || !result?.recognition_id) {
      return 'No reliable match. Culture atlas did not invent a catalog id.';
    }
    return 'Match found.';
  }
  if (analysis.state === 'failed') {
    return 'Explore could not finish. The recording is still in your library.';
  }
  return MUSIC_SERVER.reason;
}

export function glassesMicrophoneAvailability(): { available: false; label: string } {
  return { available: false, label: 'Glasses microphone unavailable' };
}

export const BROWSER_MICROPHONE_LABEL = 'This browser';
