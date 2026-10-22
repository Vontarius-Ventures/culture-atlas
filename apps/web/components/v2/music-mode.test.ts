import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCEPT_AUDIO,
  assertAudioOnlyStream,
  BROWSER_MICROPHONE_LABEL,
  exploreMusic,
  glassesMicrophoneAvailability,
  isAudioOnlyGetUserMedia,
  MUSIC_CAPTURE_LIMIT_MS,
  MUSIC_GET_USER_MEDIA_CONSTRAINTS,
  MUSIC_SERVER,
  musicFileName,
  musicLimitText,
  pickAudioRecorderType,
} from './music-mode';

describe('Music Mode client contract (AUD01)', () => {
  it('never requests a camera track from getUserMedia', () => {
    expect(MUSIC_GET_USER_MEDIA_CONSTRAINTS).toEqual({ audio: true, video: false });
    expect(isAudioOnlyGetUserMedia(MUSIC_GET_USER_MEDIA_CONSTRAINTS)).toBe(true);
    expect(isAudioOnlyGetUserMedia({ audio: true })).toBe(true);
    expect(isAudioOnlyGetUserMedia({ audio: true, video: true })).toBe(false);
    expect(isAudioOnlyGetUserMedia({ audio: true, video: { facingMode: 'user' } })).toBe(false);
    expect(isAudioOnlyGetUserMedia({ video: true })).toBe(false);
    expect(isAudioOnlyGetUserMedia({ audio: false, video: false })).toBe(false);
  });

  it('stops and refuses a stream that already has video tracks', () => {
    const stopped: string[] = [];
    expect(() =>
      assertAudioOnlyStream({
        getVideoTracks: () => [
          { kind: 'video', stop: () => stopped.push('video') },
        ],
      }),
    ).toThrow(/camera tracks/);
    expect(stopped).toEqual(['video']);
    expect(() => assertAudioOnlyStream({ getVideoTracks: () => [] })).not.toThrow();
  });

  it('picks an audio MediaRecorder type and never a video container', () => {
    expect(pickAudioRecorderType((t) => t.startsWith('audio/webm'))).toMatchObject({
      contentType: 'audio/webm',
      extension: 'webm',
    });
    expect(pickAudioRecorderType((t) => t === 'audio/mp4')).toMatchObject({
      contentType: 'audio/mp4',
      extension: 'm4a',
    });
    expect(pickAudioRecorderType((t) => t.startsWith('video/'))).toBeNull();
    expect(pickAudioRecorderType(() => false)).toBeNull();
  });

  it('keeps the 120s capture limit and an audio filename', () => {
    expect(MUSIC_CAPTURE_LIMIT_MS).toBe(120_000);
    expect(musicLimitText(0, MUSIC_CAPTURE_LIMIT_MS, false).text).toBe('2:00 max');
    expect(musicLimitText(112_000, MUSIC_CAPTURE_LIMIT_MS, true)).toEqual({
      text: '0:08 left',
      soon: true,
    });
    expect(musicFileName('webm', new Date(2026, 9, 21, 15, 4, 9))).toBe('music-20261021-150409.webm');
    expect(ACCEPT_AUDIO).toMatch(/audio\/mpeg/);
    expect(ACCEPT_AUDIO).not.toMatch(/video\//);
    expect(ACCEPT_AUDIO).not.toMatch(/image\//);
  });
});

describe('Music Mode honest unavailable states', () => {
  it('explore matches the spec music_match selection and invents no Qloo ids', () => {
    const examples = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            '../../../../specs/capture-platform-v2/audio-contract.examples.json',
            import.meta.url,
          ),
        ),
        'utf8',
      ),
    ) as {
      analysis_request: { requested_components: string[]; selection: { start_ms: number; end_ms: number } };
      evidence_example: { qloo_entity_id: null; recognition_id: null };
    };
    expect(examples.analysis_request.requested_components).toEqual(['music_match']);
    const result = exploreMusic(examples.analysis_request.selection);
    expect(result.requested_components).toEqual(['music_match']);
    expect(result.components.music_match).toEqual({
      status: 'unavailable',
      reason: 'no_qualified_recognizer',
      recognition_id: null,
      qloo_entity_id: null,
    });
    expect(result.components.music_match.qloo_entity_id).toBe(
      examples.evidence_example.qloo_entity_id,
    );
    expect(MUSIC_SERVER.audio_upload).toBe('unavailable');
    expect(MUSIC_SERVER.transcription).toBe('off');
    expect(glassesMicrophoneAvailability()).toEqual({
      available: false,
      label: 'Glasses microphone unavailable',
    });
    expect(BROWSER_MICROPHONE_LABEL).toBe('This browser');
  });
});
