import { describe, expect, it } from 'vitest';
import {
  ACCEPT_AUDIO,
  assertAudioOnlyStream,
  concatPcm,
  encodePcmWav,
  exploreMatch,
  exploreNotice,
  glassesMicrophoneAvailability,
  isAudioOnlyGetUserMedia,
  isQualifiedWavFile,
  MUSIC_CAPTURE_LIMIT_MS,
  MUSIC_GET_USER_MEDIA_CONSTRAINTS,
  MUSIC_SERVER,
  musicFileName,
  wavDurationMs,
} from './music-mode';

describe('Music Mode client contract (AUD01)', () => {
  it('never names a camera track in getUserMedia constraints', () => {
    expect(MUSIC_GET_USER_MEDIA_CONSTRAINTS).toEqual({ audio: true });
    expect('video' in MUSIC_GET_USER_MEDIA_CONSTRAINTS).toBe(false);
    expect(isAudioOnlyGetUserMedia(MUSIC_GET_USER_MEDIA_CONSTRAINTS)).toBe(true);
    expect(isAudioOnlyGetUserMedia({ audio: true, video: false })).toBe(false);
    expect(isAudioOnlyGetUserMedia({ audio: true, video: true })).toBe(false);
    expect(isAudioOnlyGetUserMedia({ audio: true, video: { facingMode: 'user' } })).toBe(false);
    expect(isAudioOnlyGetUserMedia({ video: true })).toBe(false);
  });

  it('stops and refuses a stream that already has video tracks', () => {
    const stopped: string[] = [];
    expect(() =>
      assertAudioOnlyStream({
        getVideoTracks: () => [{ kind: 'video', stop: () => stopped.push('video') }],
      }),
    ).toThrow(/camera tracks/);
    expect(stopped).toEqual(['video']);
    expect(() => assertAudioOnlyStream({ getVideoTracks: () => [] })).not.toThrow();
  });

  it('encodes PCM WAV and accepts only wav files', () => {
    expect(MUSIC_CAPTURE_LIMIT_MS).toBe(120_000);
    const blob = encodePcmWav(concatPcm([new Float32Array(16), new Float32Array(16)]), 16_000);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 64);
    expect(isQualifiedWavFile({ name: 'clip.wav', type: 'audio/wav' })).toBe(true);
    expect(isQualifiedWavFile({ name: 'clip.webm', type: 'audio/webm' })).toBe(false);
    expect(ACCEPT_AUDIO).toMatch(/audio\/wav/);
    expect(ACCEPT_AUDIO).not.toMatch(/video\//);
    expect(ACCEPT_AUDIO).not.toMatch(/webm/);
    expect(musicFileName('ignored', new Date(2026, 9, 21, 15, 4, 9))).toBe(
      'music-20261021-150409.wav',
    );
  });
});

describe('Music Mode honest unavailable states', () => {
  it('explore never invents Qloo ids when the recognizer is missing', () => {
    expect(
      exploreNotice({
        state: 'partial',
        result: {
          components: { music_match: { state: 'unavailable', reason: 'not_configured' } },
          recognition_id: null,
          qloo_seeds: [],
        },
      }),
    ).toBe(MUSIC_SERVER.reason);
    expect(MUSIC_SERVER.elevenlabs).toBe('disabled');
    expect(glassesMicrophoneAvailability()).toEqual({
      available: false,
      label: 'Glasses microphone unavailable',
    });
  });
});

describe('Music Mode picked WAV duration', () => {
  it('reads the real duration from the WAV header', async () => {
    // 2.5 s of 16 kHz mono 16-bit PCM.
    const blob = encodePcmWav(new Float32Array(40_000), 16_000);
    expect(wavDurationMs(await blob.arrayBuffer())).toBe(2500);
  });

  it('skips non-data chunks and handles stereo 44.1 kHz', () => {
    const rate = 44_100;
    const byteRate = rate * 2 * 2;
    const dataBytes = byteRate * 3; // 3 s
    const list = 'LIST';
    const buf = new ArrayBuffer(12 + 24 + 8 + 4 + 8 + dataBytes);
    const v = new DataView(buf);
    const put = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    put(0, 'RIFF');
    put(8, 'WAVE');
    put(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 2, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, byteRate, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 16, true);
    put(36, list);
    v.setUint32(40, 4, true);
    put(48, 'data');
    v.setUint32(52, dataBytes, true);
    expect(wavDurationMs(buf)).toBe(3000);
  });

  it('returns null for bytes that are not a WAV', () => {
    expect(wavDurationMs(new TextEncoder().encode('not a wave file at all').buffer)).toBeNull();
    expect(wavDurationMs(new ArrayBuffer(4))).toBeNull();
  });
});

describe('Music Mode match display', () => {
  const matched = {
    state: 'complete',
    result: {
      recognition_id: 'rec-1',
      qloo_seeds: [{ entity_id: 'qloo-nina', name: 'Nina Simone' }],
      match: {
        title: 'Feeling Good',
        album_title: null,
        artist: {
          entity_id: 'qloo-nina',
          name: 'Nina Simone',
          image: { url: 'https://images.qloo.com/nina.jpg', alt: 'Nina Simone' },
        },
        related: [
          { entity_id: 'qloo-billie', name: 'Billie Holiday', image: null },
          { entity_id: 'qloo-etta', name: 'Etta James', image: { url: 'http://insecure/etta.jpg' } },
          { entity_id: 'qloo-nina', name: 'Nina Simone', image: null },
          { name: 'No id' },
        ],
      },
    },
  };

  it('shows the artist, the Qloo image and related artists from the result', () => {
    const m = exploreMatch(matched);
    expect(m?.artist).toEqual({
      entity_id: 'qloo-nina',
      name: 'Nina Simone',
      image: { url: 'https://images.qloo.com/nina.jpg', alt: 'Nina Simone' },
    });
    expect(m?.title).toBe('Feeling Good');
    // Only https images; the seed itself and id-less entries are dropped.
    expect(m?.related).toEqual([
      { entity_id: 'qloo-billie', name: 'Billie Holiday', image: null },
      { entity_id: 'qloo-etta', name: 'Etta James', image: null },
    ]);
    expect(exploreNotice(matched)).toBe('It sounds like Nina Simone.');
  });

  it('falls back to the Qloo seed name when the server sends no display block', () => {
    const m = exploreMatch({
      state: 'complete',
      result: { recognition_id: 'rec-1', qloo_seeds: [{ entity_id: 'qloo-nina', name: 'Nina Simone' }] },
    });
    expect(m).toEqual({
      title: null,
      album_title: null,
      artist: { entity_id: 'qloo-nina', name: 'Nina Simone', image: null },
      related: [],
    });
  });

  it('never shows a match without a Qloo id and a recognition', () => {
    const none = { state: 'complete', result: { recognition_id: null, qloo_seeds: [] } };
    expect(exploreMatch(none)).toBeNull();
    expect(exploreNotice(none)).toMatch(/culture atlas only shows catalog ids Qloo returned/);
    expect(exploreNotice(none)).not.toMatch(/Culture atlas/);
  });
});
