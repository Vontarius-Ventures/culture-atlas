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

/**
 * 16-bit PCM WAV (mono/stereo). Walks the RIFF chunks, so real-world files
 * with JUNK/FLLR/LIST/bext chunks before or after `data` (macOS, iOS, DAWs)
 * are accepted and their duration comes from the `data` chunk alone.
 * WAVE_FORMAT_EXTENSIBLE is accepted only with the PCM sub-format.
 */
export function parsePcmWav(bytes: Uint8Array): PcmWav {
  if (bytes.byteLength < 44) throw unsupported();
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') throw unsupported();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: { audioFormat: number; channels: number; sampleRateHz: number; bitDepth: number } | null = null;
  let dataSize: number | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.byteLength) throw unsupported();
      let audioFormat = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first 2 bytes of the sub-format GUID.
      if (audioFormat === 0xfffe && size >= 40 && body + 26 <= bytes.byteLength) {
        audioFormat = view.getUint16(body + 24, true);
      }
      fmt = {
        audioFormat,
        channels: view.getUint16(body + 2, true),
        sampleRateHz: view.getUint32(body + 4, true),
        bitDepth: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      const present = bytes.byteLength - body;
      // Streaming writers may leave 0 / 0xFFFFFFFF; never read past the bytes present.
      dataSize = size === 0 || size === 0xffffffff || size > present ? present : size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataSize === null) throw unsupported();
  const { audioFormat, channels, sampleRateHz, bitDepth } = fmt;
  if (audioFormat !== 1 || bitDepth !== 16) throw unsupported();
  if (channels !== 1 && channels !== 2) {
    throw new AppError('unsupported_media', { message: 'Use mono or stereo audio.' });
  }
  if (sampleRateHz < AUDIO_LIMITS.sampleRateMinHz || sampleRateHz > AUDIO_LIMITS.sampleRateMaxHz) {
    throw new AppError('unsupported_media', { message: 'This sample rate is not supported.' });
  }
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
