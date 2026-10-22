import { AppError } from '../errors';
import {
  MUSIC_MODE_FORBIDDEN_PERMISSIONS,
  MUSIC_MODE_PERMISSIONS,
  type MusicModeState,
} from '../schemas/audio';
import { AUDIO_LIMITS } from './limits';

/**
 * Camera-off Music Mode (AUD01). Domain contract for web/iOS/Android:
 * request the microphone only; never initialize a camera, preview, or frame upload.
 */
export interface MusicModeCameraTrace {
  camera_initialized: boolean;
  camera_permission_requested: boolean;
  frames: number;
  network_images: number;
}

export interface MusicModeCaptureSpec {
  product: 'culture atlas';
  capture_mode: 'music';
  camera_active: false;
  speech_analysis: 'off';
  automatic_cloud_analysis: false;
  required_permissions: typeof MUSIC_MODE_PERMISSIONS;
  forbidden_permissions: typeof MUSIC_MODE_FORBIDDEN_PERMISSIONS;
  max_duration_ms: number;
  get_user_media: { audio: true };
  native_permission_request: { microphone: true; camera: false };
}

export const MUSIC_MODE_CAPTURE_SPEC: MusicModeCaptureSpec = {
  product: 'culture atlas',
  capture_mode: 'music',
  camera_active: false,
  speech_analysis: 'off',
  automatic_cloud_analysis: false,
  required_permissions: MUSIC_MODE_PERMISSIONS,
  forbidden_permissions: MUSIC_MODE_FORBIDDEN_PERMISSIONS,
  max_duration_ms: AUDIO_LIMITS.captureMaxDurationMs,
  get_user_media: { audio: true },
  native_permission_request: { microphone: true, camera: false },
};

/** Browser helper: constraints for getUserMedia in Music Mode. No `video` key. */
export function musicModeGetUserMediaConstraints(): { audio: true } {
  return { audio: true };
}

export function musicModePermissionRequest(): { microphone: true; camera: false } {
  return { microphone: true, camera: false };
}

export function emptyCameraTrace(): MusicModeCameraTrace {
  return {
    camera_initialized: false,
    camera_permission_requested: false,
    frames: 0,
    network_images: 0,
  };
}

export function assertMusicModeCameraOff(trace: MusicModeCameraTrace): void {
  if (
    trace.camera_initialized ||
    trace.camera_permission_requested ||
    trace.frames > 0 ||
    trace.network_images > 0
  ) {
    throw new AppError('invalid_input', {
      message: 'Music Mode never initializes a camera.',
    });
  }
}

const TRANSITIONS: Record<MusicModeState, readonly MusicModeState[]> = {
  idle: ['permission_requested'],
  permission_requested: ['route_check', 'idle'],
  route_check: ['recording', 'idle'],
  recording: ['finalizing', 'idle'],
  finalizing: ['local_draft', 'idle'],
  local_draft: ['queued_upload', 'idle'],
  queued_upload: ['ready', 'idle'],
  ready: ['idle'],
};

export class MusicModeSession {
  readonly capture_mode = 'music' as const;
  readonly camera_active = false as const;
  readonly speech_analysis = 'off' as const;
  readonly automatic_cloud_analysis = false as const;
  readonly camera = emptyCameraTrace();
  state: MusicModeState = 'idle';
  input_name: string | null = null;
  elapsed_ms = 0;

  advance(next: MusicModeState): void {
    if (!(TRANSITIONS[this.state] ?? []).includes(next)) {
      throw new AppError('invalid_input', {
        message: `Music Mode cannot move from ${this.state} to ${next}.`,
      });
    }
    this.state = next;
    assertMusicModeCameraOff(this.camera);
  }

  startRecording(inputName: string, nowElapsedMs = 0): void {
    if (this.state === 'idle') this.advance('permission_requested');
    if (this.state === 'permission_requested') this.advance('route_check');
    if (this.state !== 'route_check') {
      throw new AppError('invalid_input', { message: 'Music Mode is not ready to record.' });
    }
    this.input_name = inputName;
    this.elapsed_ms = nowElapsedMs;
    this.advance('recording');
  }

  stopRecording(elapsedMs: number): void {
    if (this.state !== 'recording') {
      throw new AppError('invalid_input', { message: 'Music Mode is not recording.' });
    }
    this.elapsed_ms = Math.min(Math.max(elapsedMs, 0), AUDIO_LIMITS.captureMaxDurationMs);
    this.advance('finalizing');
    this.advance('local_draft');
  }

  keepDraft(): void {
    if (this.state !== 'local_draft') {
      throw new AppError('invalid_input', { message: 'There is no Music Mode draft to keep.' });
    }
    this.advance('queued_upload');
  }

  markReady(): void {
    if (this.state !== 'queued_upload') {
      throw new AppError('invalid_input', { message: 'Music Mode upload is not queued.' });
    }
    this.advance('ready');
    assertMusicModeCameraOff(this.camera);
  }

  spec(): MusicModeCaptureSpec {
    return MUSIC_MODE_CAPTURE_SPEC;
  }
}
