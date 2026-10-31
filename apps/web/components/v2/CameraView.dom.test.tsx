import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

vi.mock('next/link', () => ({
  default: (props: ComponentProps<'a'>) => <a {...props} />,
}));

const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/client/session', () => ({
  useSession: () => ({ session: null, isAccount: false }),
}));
vi.mock('./uploads-client', () => ({
  useUploads: () => ({ engine: null, items: [] }),
  loadCapabilities: vi.fn(),
  limitsFrom: vi.fn(),
}));

import { CameraView } from './CameraView';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mediaStream() {
  const stop = vi.fn();
  const track = { stop, addEventListener: vi.fn() };
  return {
    stop,
    stream: {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
  };
}

function askForMicrophone() {
  fireEvent.click(screen.getByRole('button', { name: 'Video' }));
  fireEvent.click(screen.getByRole('button', { name: 'Microphone off' }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  mocks.push.mockReset();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('camera microphone permissions', () => {
  it('bounds an unanswered permission prompt without claiming it was denied, and allows retry', async () => {
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    const getUserMedia = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    render(<CameraView />);
    askForMicrophone();
    expect(
      screen.getByRole('button', { name: 'Asking for microphone…' }).hasAttribute('disabled'),
    ).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(8000));
    expect(screen.getByRole('button', { name: 'Microphone off' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(screen.getByRole('status').textContent).toMatch(/taking longer/);
    expect(screen.queryByText('Microphone blocked')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Microphone off' }));
    const late = mediaStream();
    await act(async () => first.resolve(late.stream));
    expect(late.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Asking for microphone…' })).toBeTruthy();
    const current = mediaStream();
    await act(async () => second.resolve(current.stream));
    expect(screen.getByRole('button', { name: 'Microphone on' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(current.stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Microphone on' }));
    expect(current.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['NotAllowedError', 'Microphone blocked'],
    ['NotFoundError', 'No microphone'],
    ['NotReadableError', 'No microphone'],
  ])('reports %s accurately and clears its deadline', async (name, label) => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('Media error', name));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    render(<CameraView />);
    askForMicrophone();
    await act(async () => {});
    expect(screen.getByRole('button', { name: label }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('Videos record without sound.')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['unmount', 'close', 'photo'] as const)(
    'disposes a late stream after %s',
    async (action) => {
      const pending = deferred<MediaStream>();
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => pending.promise } });
      const view = render(<CameraView />);
      askForMicrophone();
      if (action === 'unmount') view.unmount();
      if (action === 'close') fireEvent.click(screen.getByRole('link', { name: 'Close' }));
      if (action === 'photo') fireEvent.click(screen.getByRole('button', { name: 'Photo' }));
      const late = mediaStream();
      await act(async () => pending.resolve(late.stream));
      expect(late.stop).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      if (action === 'close') expect(mocks.push).toHaveBeenCalledWith('/capture');
      if (action === 'photo') {
        fireEvent.click(screen.getByRole('button', { name: 'Video' }));
        expect(screen.getByRole('button', { name: 'Microphone off' })).toBeTruthy();
      }
    },
  );

  it('ignores a rejection after the deadline rather than turning timeout into denial', async () => {
    const pending = deferred<MediaStream>();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => pending.promise } });
    render(<CameraView />);
    askForMicrophone();
    await act(() => vi.advanceTimersByTimeAsync(8000));
    await act(async () => pending.reject(new DOMException('Permission denied', 'NotAllowedError')));
    expect(screen.getByRole('button', { name: 'Microphone off' })).toBeTruthy();
    expect(screen.queryByText('Microphone blocked')).toBeNull();
  });

  it('stops an enabled microphone on unmount', async () => {
    const current = mediaStream();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(current.stream) },
    });
    const view = render(<CameraView />);
    askForMicrophone();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Microphone on' })).toBeTruthy();
    view.unmount();
    expect(current.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['unmount', 'close'] as const)(
    'also disposes a camera granted after %s',
    async (action) => {
      const pending = deferred<MediaStream>();
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => pending.promise } });
      const view = render(<CameraView />);
      fireEvent.click(screen.getByRole('button', { name: 'Turn on camera' }));
      if (action === 'unmount') view.unmount();
      else fireEvent.click(screen.getByRole('link', { name: 'Close' }));
      const late = mediaStream();
      await act(async () => pending.resolve(late.stream));
      expect(late.stop).toHaveBeenCalledOnce();
    },
  );

  it('can record silently while permission is pending, and never adds a late audio track', async () => {
    const camera = mediaStream();
    const pending = deferred<MediaStream>();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(camera.stream)
          .mockReturnValueOnce(pending.promise),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const mixedTracks = vi.fn();
    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(tracks: MediaStreamTrack[]) {
          mixedTracks(tracks);
        }
      },
    );
    vi.stubGlobal(
      'MediaRecorder',
      class {
        static isTypeSupported = () => true;
        state = 'recording';
        start = vi.fn();
        stop = vi.fn();
      },
    );
    const view = render(<CameraView />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Turn on camera' })));
    askForMicrophone();
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeTruthy();
    expect(mixedTracks).toHaveBeenCalledWith(camera.stream.getVideoTracks());
    const late = mediaStream();
    await act(async () => pending.resolve(late.stream));
    expect(late.stop).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Microphone on' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
