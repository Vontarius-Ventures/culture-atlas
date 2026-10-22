import { AppError } from '../errors';
import { AUDIO_LIMITS } from './limits';

export interface PcmWav {
  durationMs: number;
  sampleRateHz: number;
  channels: 1 | 2;
  byteSize: number;
  codec: 'pcm_s16le';
}

/** Silent PCM WAV for tests. Never used as a recognition fixture. */
export function pcmWavBytes(input: {
  durationMs: number;
  sampleRateHz?: number;
  channels?: 1 | 2;
}): Uint8Array {
  const sampleRateHz = input.sampleRateHz ?? 16_000;
  const channels = input.channels ?? 1;
  const samples = Math.max(1, Math.round((input.durationMs / 1000) * sampleRateHz));
  const dataSize = samples * channels * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataSize, true);
  return bytes;
}

export function parsePcmWav(bytes: Uint8Array): PcmWav {
  if (bytes.byteLength < 44) throw unsupported();
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') throw unsupported();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 12, 4) !== 'fmt ') throw unsupported();
  const audioFormat = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRateHz = view.getUint32(24, true);
  const bitDepth = view.getUint16(34, true);
  if (audioFormat !== 1 || bitDepth !== 16) throw unsupported();
  if (channels !== 1 && channels !== 2) {
    throw new AppError('unsupported_media', { message: 'Use mono or stereo audio.' });
  }
  if (sampleRateHz < AUDIO_LIMITS.sampleRateMinHz || sampleRateHz > AUDIO_LIMITS.sampleRateMaxHz) {
    throw new AppError('unsupported_media', { message: 'This sample rate is not supported.' });
  }
  const dataSize = Math.max(0, bytes.byteLength - 44);
  const durationMs = Math.round((dataSize / (sampleRateHz * channels * 2)) * 1000);
  if (durationMs < 1) throw unsupported();
  return {
    durationMs,
    sampleRateHz,
    channels,
    byteSize: bytes.byteLength,
    codec: 'pcm_s16le',
  };
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function unsupported(): AppError {
  return new AppError('unsupported_media', {
    message: 'Use a WAV recording. Other audio containers are not qualified yet.',
  });
}
