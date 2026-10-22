import { describe, expect, it } from 'vitest';
import {
  ACCEPT_AUDIO,
  assertAudioOnlyStream,
  concatPcm,
  encodePcmWav,
  exploreNotice,
  glassesMicrophoneAvailability,
  isAudioOnlyGetUserMedia,
  isQualifiedWavFile,
  MUSIC_CAPTURE_LIMIT_MS,
  MUSIC_GET_USER_MEDIA_CONSTRAINTS,
  MUSIC_SERVER,
  musicFileName,
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
