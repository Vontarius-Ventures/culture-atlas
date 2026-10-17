/** Pure camera decisions, kept separate from MediaStream plumbing so they are unit-tested. */
import { formatDuration } from './media-format';

export type CameraProblem = 'denied' | 'unavailable' | 'busy' | 'insecure' | 'error';

/** Maps getUserMedia failures to what the person can do about them. */
export function cameraProblem(err: unknown): CameraProblem {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'SecurityError') return 'insecure';
  if (
    name === 'NotFoundError' ||
    name === 'OverconstrainedError' ||
    name === 'DevicesNotFoundError'
  )
    return 'unavailable';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError')
    return 'busy';
  return 'error';
}

export const CAMERA_PROBLEM_TEXT: Record<CameraProblem, { title: string; body: string }> = {
  denied: {
    title: 'Camera access is off',
    body: 'Allow camera access for this site in your browser settings, then try again. You can also upload files instead.',
  },
  insecure: {
    title: 'Camera needs a secure page',
    body: 'Open culture atlas over https to use the camera, or upload files instead.',
  },
  unavailable: {
    title: 'No camera found',
    body: 'This device has no camera we can use. Choose a photo or video file instead.',
  },
  busy: {
    title: 'The camera is busy',
    body: 'Another app may be using the camera. Close it and try again, or upload files instead.',
  },
  error: {
    title: 'The camera did not start',
    body: 'Try again, or upload files instead.',
  },
};

/**
 * MediaRecorder container in preference order. The server accepts MP4 and
 * WebM; Safari records MP4, Chromium and Firefox record WebM.
 */
export function pickRecorderType(isTypeSupported: (t: string) => boolean): {
  mimeType: string;
  contentType: 'video/mp4' | 'video/webm';
  extension: 'mp4' | 'webm';
} | null {
  const candidates: Array<[string, 'video/mp4' | 'video/webm', 'mp4' | 'webm']> = [
    ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'mp4'],
    ['video/mp4', 'video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'video/webm', 'webm'],
    ['video/webm;codecs=vp8,opus', 'video/webm', 'webm'],
    ['video/webm', 'video/webm', 'webm'],
  ];
  for (const [mimeType, contentType, extension] of candidates)
    if (isTypeSupported(mimeType)) return { mimeType, contentType, extension };
  return null;
}

/** "60 sec max" until the last 10 seconds, then a visible countdown. */
export function limitText(
  elapsedMs: number,
  limitMs: number,
  recording: boolean,
): {
  text: string;
  soon: boolean;
} {
  const left = Math.max(0, limitMs - elapsedMs);
  if (recording && left <= 10_000)
    return { text: `${formatDuration(Math.ceil(left / 1000) * 1000)} left`, soon: true };
  return { text: `${Math.round(limitMs / 1000)} sec max`, soon: false };
}

/** File name for a browser capture, e.g. photo-20261017-142355.jpg. */
export function captureFileName(kind: 'photo' | 'video', extension: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${kind}-${stamp}.${extension}`;
}
