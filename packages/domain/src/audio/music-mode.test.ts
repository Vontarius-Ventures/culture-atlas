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
import { artistSeedsFromQlooEntities, queriesFromTranscript } from './qloo-seeds';
import {
  ELEVENLABS_TRANSCRIPTION,
  ElevenLabsScribeTranscription,
  audioUploadFile,
  elevenLabsFromConfig,
  sniffAudioType,
} from './transcription';
import { testConfig } from '../testing';

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
    expect(elevenLabsFromConfig(testConfig()).enabled).toBe(false);
    expect(elevenLabsFromConfig(testConfig({ ELEVENLABS_API_KEY: 'test-key' })).enabled).toBe(true);
  });

  it('extracts artist queries from a transcript and never invents names', () => {
    expect(queriesFromTranscript('That was Feeling Good by Nina Simone.')).toEqual(['Nina Simone', 'Feeling Good']);
    expect(queriesFromTranscript('"Redbone" by Childish Gambino')).toEqual(['Childish Gambino', 'Redbone']);
    expect(queriesFromTranscript('')).toEqual([]);
    expect(queriesFromTranscript('   ')).toEqual([]);
    // DJ patterns, no sentence-crossing, apostrophes are not quotes.
    expect(
      queriesFromTranscript(
        "You're listening to Fleetwood Mac. That was Dreams from the album Rumors. Up next, more Fleetwood Mac",
      )[0],
    ).toBe('Fleetwood Mac');
    expect(queriesFromTranscript('This one is Dreams by Fleetwood Mac, a classic from 1977')[0]).toBe('Fleetwood Mac');
    expect(queriesFromTranscript('Daft Punk - Get Lucky')).toEqual(['Daft Punk', 'Get Lucky']);
    // Ordinary speech is never sent to Qloo as an "artist".
    expect(queriesFromTranscript('Okay, so I think we should pick up groceries later and then go to the park.')).toEqual([]);
  });

  it('resolves only an artist whose full name was heard; fuzzy neighbours never win', () => {
    const artist = (name: string, popularity: number) => ({
      entity_id: `id-${name}`, name, types: ['urn:entity:artist'], properties: {}, tags: [], popularity,
    });
    const search = [artist('Fleetwood Mac', 0.9995), artist('G Tom Mac', 0.5), artist('TobyMac', 0.8), artist('Tokyo Machine', 0.4)];
    expect(artistSeedsFromQlooEntities(search, "You're listening to Fleetwood Mac.")).toMatchObject({
      status: 'resolved', seeds: [{ entity_id: 'id-Fleetwood Mac', name: 'Fleetwood Mac' }],
    });
    // A short name inside the longer heard name does not compete.
    expect(artistSeedsFromQlooEntities([artist('Mac', 0.3), ...search], 'more Fleetwood Mac').seeds[0]?.name).toBe('Fleetwood Mac');
    // "The" and punctuation are ignored; same-named artists resolve to the most popular.
    expect(artistSeedsFromQlooEntities([artist('The Beatles', 0.99), { ...artist('Beatles', 0.2), entity_id: 'tribute' }], 'that was beatles').seeds[0]?.entity_id)
      .toBe('id-The Beatles');
    // Two different heard names stay ambiguous; nothing heard is unresolved.
    expect(artistSeedsFromQlooEntities([artist('Daft Punk', 0.9), artist('Pharrell Williams', 0.9)], 'Daft Punk with Pharrell Williams').status).toBe('ambiguous');
    expect(artistSeedsFromQlooEntities(search, 'pick up groceries later').status).toBe('unresolved');
  });

  it('parses Scribe v2 JSON without sending live audio', async () => {
    const adapter = new ElevenLabsScribeTranscription({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(
          JSON.stringify({
            text: 'Nina Simone',
            words: [
              { text: 'Nina', start: 0.1, end: 0.4, type: 'word' },
              { text: ' ', start: 0.4, end: 0.45, type: 'spacing' },
              { text: 'Simone', start: 0.45, end: 0.9, type: 'word' },
            ],
          }),
          { status: 200 },
        ),
    });
    const got = await adapter.transcribe({
      bytes: new Uint8Array([1, 2, 3]),
      signal: new AbortController().signal,
      mediaType: 'audio/wav',
    });
    expect(got.text).toBe('Nina Simone');
    expect(got.words).toEqual([
      { text: 'Nina', start_ms: 100, end_ms: 400 },
      { text: 'Simone', start_ms: 450, end_ms: 900 },
    ]);
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

describe('ElevenLabs upload MIME', () => {
  it('keeps iPhone AAC as audio/mp4 instead of relabeling it WAV', () => {
    const ftyp = new Uint8Array(32);
    ftyp.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    expect(sniffAudioType(ftyp)).toBe('audio/mp4');
    expect(audioUploadFile({ bytes: ftyp, mediaType: 'audio/mp4' })).toEqual({
      type: 'audio/mp4',
      filename: 'clip.m4a',
    });
    expect(audioUploadFile({ bytes: ftyp })).toEqual({ type: 'audio/mp4', filename: 'clip.m4a' });
  });

  it('sends Scribe the stored MIME, not a hardcoded WAV container', async () => {
    let uploaded: { name: string; type: string } | null = null;
    const adapter = new ElevenLabsScribeTranscription({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        const file = (init?.body as FormData).get('file') as File;
        uploaded = { name: file.name, type: file.type };
        return new Response(JSON.stringify({ text: 'Nina Simone', words: [] }), { status: 200 });
      },
    });
    await adapter.transcribe({
      bytes: new Uint8Array([1, 2, 3, 4]),
      signal: new AbortController().signal,
      mediaType: 'audio/mp4',
    });
    expect(uploaded).toEqual({ name: 'clip.m4a', type: 'audio/mp4' });
  });
});
