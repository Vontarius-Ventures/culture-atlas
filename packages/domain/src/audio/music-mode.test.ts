import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CreateMediaUploadRequest, MediaKind } from '../schemas/capture-v2';
import {
  AnalyzeAudioRequest,
  AudioAsset,
  filterLegacyLibraryItems,
  parseLegacyMediaKind,
} from '../schemas/audio';
import {
  MUSIC_MODE_CAPTURE_SPEC,
  MusicModeSession,
  assertMusicModeCameraOff,
  emptyCameraTrace,
  musicModeGetUserMediaConstraints,
  musicModePermissionRequest,
} from './music-mode';
import { AUDIO_CAPABILITIES } from './limits';
import { ELEVENLABS_TRANSCRIPTION } from './transcription';

describe('AUD01 camera-off Music Mode', () => {
  it('never requests a camera permission or getUserMedia video track', () => {
    expect(MUSIC_MODE_CAPTURE_SPEC.camera_active).toBe(false);
    expect(MUSIC_MODE_CAPTURE_SPEC.required_permissions).toEqual(['microphone']);
    expect(MUSIC_MODE_CAPTURE_SPEC.forbidden_permissions).toEqual(['camera']);
    expect(musicModePermissionRequest()).toEqual({ microphone: true, camera: false });
    const constraints = musicModeGetUserMediaConstraints();
    expect(constraints).toEqual({ audio: true });
    expect('video' in constraints).toBe(false);
    expect(MUSIC_MODE_CAPTURE_SPEC.speech_analysis).toBe('off');
    expect(MUSIC_MODE_CAPTURE_SPEC.automatic_cloud_analysis).toBe(false);
    expect(AUDIO_CAPABILITIES.camera_required_for_music_mode).toBe(false);
    expect(AUDIO_CAPABILITIES.elevenlabs_transcription.enabled).toBe(false);
    expect(ELEVENLABS_TRANSCRIPTION.enabled).toBe(false);
  });

  it('records a session without initializing a camera', () => {
    const session = new MusicModeSession();
    session.startRecording('iPhone Microphone');
    session.stopRecording(12_000);
    session.keepDraft();
    session.markReady();
    expect(session.state).toBe('ready');
    expect(session.camera_active).toBe(false);
    expect(session.speech_analysis).toBe('off');
    expect(session.automatic_cloud_analysis).toBe(false);
    assertMusicModeCameraOff(session.camera);
    expect(session.camera).toEqual(emptyCameraTrace());
  });

  it('refuses a camera trace in Music Mode', () => {
    expect(() =>
      assertMusicModeCameraOff({
        camera_initialized: true,
        camera_permission_requested: false,
        frames: 0,
        network_images: 0,
      }),
    ).toThrow(/never initializes a camera/);
  });
});

describe('AUD13 legacy photo/video clients', () => {
  it('keep MediaKind photo/video-only so existing upload requests still parse', () => {
    expect(MediaKind.options).toEqual(['photo', 'video']);
    expect(CreateMediaUploadRequest.safeParse({
      client_capture_id: '11111111-1111-4111-8111-111111111111',
      kind: 'audio',
      source: 'upload',
      filename: 'clip.wav',
      content_type: 'audio/wav',
      byte_size: 100,
      sha256: 'a'.repeat(64),
    }).success).toBe(false);
    expect(parseLegacyMediaKind('audio')).toBeNull();
    expect(parseLegacyMediaKind('photo')).toBe('photo');
    expect(
      filterLegacyLibraryItems([{ kind: 'photo' }, { kind: 'audio' }, { kind: 'video' }]).map((i) => i.kind),
    ).toEqual(['photo', 'video']);
  });

  it('does not throw when a legacy parser sees an unknown audio enum', () => {
    expect(() => MediaKind.safeParse('audio')).not.toThrow();
    expect(MediaKind.safeParse('audio').success).toBe(false);
    expect(AudioAsset.safeParse({ kind: 'photo' }).success).toBe(false);
  });
});

describe('audio analysis contract', () => {
  it('matches the committed audio contract fixture', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../../../../fixtures/audio/contract.json', import.meta.url), 'utf8'),
    ) as { analysis_request: unknown; audio_asset: { camera_active: boolean; speech_analysis: string } };
    expect(fixture.audio_asset.camera_active).toBe(false);
    expect(fixture.audio_asset.speech_analysis).toBe('off');
    expect(AnalyzeAudioRequest.parse(fixture.analysis_request).requested_components).toEqual(['music_match']);
  });

  it('accepts the schema_version 2 music_match example and rejects speech in Music Mode', () => {
    const parsed = AnalyzeAudioRequest.parse({
      contract_version: 2,
      expected_generation: 1,
      requested_components: ['music_match'],
      selection: { start_ms: 0, end_ms: 15000 },
    });
    expect(parsed.requested_components).toEqual(['music_match']);
    expect(
      AnalyzeAudioRequest.safeParse({
        contract_version: 1,
        expected_generation: 1,
        requested_components: ['music_match'],
        selection: { start_ms: 0, end_ms: 15000 },
      }).success,
    ).toBe(false);
  });
});
