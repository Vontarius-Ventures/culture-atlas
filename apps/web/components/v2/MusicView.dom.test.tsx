import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

import { MusicView } from './MusicView';
import { MUSIC_GET_USER_MEDIA_CONSTRAINTS } from './music-mode';

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
