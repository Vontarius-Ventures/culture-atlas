import { describe, expect, it } from 'vitest';
import { parsePcmWav, pcmWavBytes } from './wav';

/** A WAV laid out like macOS `say`/CoreAudio writes it: JUNK, fmt, FLLR padding, data, LIST. */
function chunkyWav(opts: { durationMs: number; sampleRateHz: number; channels: 1 | 2; format?: number }): Uint8Array {
  const { durationMs, sampleRateHz, channels } = opts;
  const dataSize = Math.round((durationMs / 1000) * sampleRateHz) * channels * 2;
  const chunks: Array<[string, Uint8Array]> = [];
  chunks.push(['JUNK', new Uint8Array(28)]);
  const fmt = new Uint8Array(16);
  const f = new DataView(fmt.buffer);
  f.setUint16(0, opts.format ?? 1, true);
  f.setUint16(2, channels, true);
  f.setUint32(4, sampleRateHz, true);
  f.setUint32(8, sampleRateHz * channels * 2, true);
  f.setUint16(12, channels * 2, true);
  f.setUint16(14, 16, true);
  chunks.push(['fmt ', fmt]);
  chunks.push(['FLLR', new Uint8Array(4008)]);
  chunks.push(['data', new Uint8Array(dataSize)]);
  chunks.push(['LIST', new Uint8Array(26)]);
  const total = 12 + chunks.reduce((n, [, b]) => n + 8 + b.length + (b.length % 2), 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  const put = (o: number, t: string) => [...t].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, total - 8, true);
  put(8, 'WAVE');
  let o = 12;
  for (const [id, body] of chunks) {
    put(o, id);
    v.setUint32(o + 4, body.length, true);
    out.set(body, o + 8);
    o += 8 + body.length + (body.length % 2);
  }
  return out;
}

describe('parsePcmWav', () => {
  it('reads the canonical 44-byte header', () => {
    expect(parsePcmWav(pcmWavBytes({ durationMs: 2500 }))).toMatchObject({
      durationMs: 2500,
      sampleRateHz: 16_000,
      channels: 1,
      codec: 'pcm_s16le',
    });
  });

  it('accepts real-world WAVs with JUNK/FLLR/LIST chunks and times only the data chunk', () => {
    const parsed = parsePcmWav(chunkyWav({ durationMs: 2160, sampleRateHz: 16_000, channels: 1 }));
    expect(parsed.durationMs).toBe(2160);
    expect(parsed.channels).toBe(1);
    const stereo = parsePcmWav(chunkyWav({ durationMs: 3000, sampleRateHz: 44_100, channels: 2 }));
    expect(stereo.durationMs).toBe(3000);
  });

  it('still refuses non-PCM and non-WAV bytes', () => {
    expect(() => parsePcmWav(chunkyWav({ durationMs: 1000, sampleRateHz: 16_000, channels: 1, format: 3 }))).toThrow(
      /Use a WAV recording/,
    );
    expect(() => parsePcmWav(new TextEncoder().encode('x'.repeat(64)))).toThrow(/Use a WAV recording/);
  });
});
