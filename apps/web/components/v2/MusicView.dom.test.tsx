import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

const api = vi.hoisted(() => ({
  keepAudio: vi.fn(),
  analyzeAudio: vi.fn(),
  audioAnalysis: vi.fn(),
}));
vi.mock('./media-api', async (importOriginal) => {
  const actual = await importOriginal<typeof MediaApiModule>();
  return { ...actual, mediaApi: { ...actual.mediaApi, ...api } };
});

import type * as MediaApiModule from './media-api';
import { MusicView } from './MusicView';
import { encodePcmWav, MUSIC_GET_USER_MEDIA_CONSTRAINTS } from './music-mode';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Music Mode UI (AUD01)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'MediaStream',
      class FakeMediaStream {
        constructor(public tracks: unknown[] = []) {}
        getTracks() {
          return this.tracks;
        }
        getAudioTracks() {
          return this.tracks;
        }
        getVideoTracks() {
          return [];
        }
      },
    );
  });

  it('asks getUserMedia for audio only and never names a video track', async () => {
    const calls: MediaStreamConstraints[] = [];
    const audioTrack = { kind: 'audio', stop: vi.fn(), addEventListener: vi.fn() };
    const stream = {
      getTracks: () => [audioTrack],
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [],
    };
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
          calls.push(constraints);
          return stream;
        }),
      },
    });

    render(<MusicView />);
    expect(screen.getByText('Camera off')).toBeTruthy();
    expect(screen.getByText('Music', { selector: '.music__title' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Turn on microphone' }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toEqual(MUSIC_GET_USER_MEDIA_CONSTRAINTS);
    expect('video' in calls[0]!).toBe(false);
    expect(JSON.stringify(calls)).not.toMatch(/facingMode|width|height|video/);
  });

  it('falls back to a WAV file picker when getUserMedia is missing', async () => {
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    render(<MusicView />);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on microphone' }));
    expect(screen.getByRole('alert').textContent).toMatch(/No microphone found/);
    expect(screen.getByRole('button', { name: 'Choose a WAV file' })).toBeTruthy();
    expect(screen.getByTestId('music-file-input').getAttribute('accept')).toMatch(/audio\/wav/);
    expect(screen.getByTestId('music-file-input').getAttribute('accept')).not.toMatch(/video\//);
    expect(screen.getByTestId('music-file-input').getAttribute('accept')).not.toMatch(/webm/);
  });
});

describe('Music Mode picked file and match', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:music', revokeObjectURL: () => {} }));
  });

  it('reads the picked WAV duration, then shows the Qloo artist and related artists', async () => {
    api.keepAudio.mockResolvedValue({ asset_id: 'a1', generation: 1, media: { duration_ms: 2500 } });
    api.analyzeAudio.mockResolvedValue({ analysis_id: 'an1' });
    api.audioAnalysis.mockResolvedValue({
      state: 'complete',
      result: {
        recognition_id: 'rec-1',
        qloo_seeds: [{ entity_id: 'qloo-nina', name: 'Nina Simone' }],
        match: {
          title: 'Feeling Good',
          album_title: null,
          artist: { entity_id: 'qloo-nina', name: 'Nina Simone', image: null },
          related: [{ entity_id: 'qloo-billie', name: 'Billie Holiday', image: null }],
        },
      },
    });
    render(<MusicView />);
    const wav = new File([encodePcmWav(new Float32Array(40_000), 16_000)], 'clip.wav', { type: 'audio/wav' });
    await userEvent.upload(screen.getByTestId('music-file-input'), wav);
    // 2.5 s: whole seconds floor, as the <audio> player beside the label counts them.
    await waitFor(() => expect(screen.getByTestId('music-length').textContent).toBe('0:02 recording'));
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Explore music' }));
    const card = await screen.findByTestId('music-match');
    expect(card.textContent).toMatch(/It sounds like/);
    expect(screen.getByRole('heading', { name: 'Nina Simone' })).toBeTruthy();
    expect(card.textContent).toMatch(/Feeling Good/);
    expect(screen.getByRole('list', { name: 'Artists related to Nina Simone' }).textContent).toMatch(
      /Billie Holiday/,
    );
    expect(screen.getByRole('link', { name: 'See your feed' }).getAttribute('href')).toBe('/');
    expect(api.analyzeAudio.mock.calls[0]?.[1]).toMatchObject({ selection: { start_ms: 0, end_ms: 2500 } });
  });

  it('refuses a file that is not a readable WAV', async () => {
    render(<MusicView />);
    const bogus = new File(['nope'], 'clip.wav', { type: 'audio/wav' });
    await userEvent.upload(screen.getByTestId('music-file-input'), bogus);
    expect(await screen.findByText(/not a readable WAV recording/)).toBeTruthy();
    expect(screen.queryByTestId('music-length')).toBeNull();
  });
});
