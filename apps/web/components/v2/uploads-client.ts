'use client';

/**
 * Browser wiring for the upload engine: XHR part transfers (progress events),
 * WebCrypto SHA-256, local previews/durations, IndexedDB persistence, a
 * cross-tab Web Lock and online/offline events. One engine per tab.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { ApiError, newIdempotencyKey } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { mediaApi, type Capabilities, type PartInstruction } from './media-api';
import { DEFAULT_LIMITS, type ClientLimits } from './media-format';
import { UploadEngine, type EngineSnapshot, type FileFacts } from './upload-engine';
import { defaultUploadStore } from './upload-store';

function putPart(
  instruction: PartInstruction,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', instruction.url);
    for (const [k, v] of Object.entries(instruction.headers)) {
      if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'host') continue;
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('etag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else if (xhr.status === 403)
        reject(
          new ApiError(403, {
            code: 'upload_url_expired',
            message: 'The upload link expired. Retry to continue.',
            retryable: true,
            request_id: 'client',
          }),
        );
      else
        reject(
          new ApiError(xhr.status, {
            code: xhr.status >= 500 || xhr.status === 0 ? 'service_unavailable' : 'part_rejected',
            message: 'Part of the file did not upload. Retry to continue.',
            retryable: true,
            request_id: 'client',
          }),
        );
    };
    xhr.onerror = () =>
      reject(
        new ApiError(0, {
          code: 'offline',
          message: 'Connection lost. Your file is still selected.',
          retryable: true,
          request_id: 'client',
        }),
      );
    const abort = () => {
      xhr.abort();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(body);
  });
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function canvasThumb(source: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  const scale = Math.min(1, 480 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8));
}

/** Local-only facts for the queue row; decoding failures leave them unknown (server decides). */
export async function describeFile(file: Blob, kind: 'photo' | 'video'): Promise<FileFacts> {
  const none: FileFacts = { duration_ms: null, width: null, height: null, thumb: null };
  if (kind === 'photo') {
    if (typeof createImageBitmap !== 'function') return none;
    const bitmap = await createImageBitmap(file);
    try {
      return {
        duration_ms: null,
        width: bitmap.width,
        height: bitmap.height,
        thumb: await canvasThumb(bitmap, bitmap.width, bitmap.height),
      };
    } finally {
      bitmap.close();
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = url;
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('decode'));
      }),
      8000,
    );
    // WebM from MediaRecorder reports Infinity until the end is probed.
    if (!Number.isFinite(video.duration)) {
      video.currentTime = 1e7;
      await withTimeout(new Promise((r) => (video.ondurationchange = r)), 4000).catch(
        () => undefined,
      );
    }
    const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null;
    video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
    await withTimeout(new Promise((r) => (video.onseeked = r)), 4000).catch(() => undefined);
    const thumb = video.videoWidth
      ? await canvasThumb(video, video.videoWidth, video.videoHeight)
      : null;
    return {
      duration_ms: duration,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      thumb,
    };
  } catch {
    return none;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

let engine: UploadEngine | null = null;

export function uploadEngine(): UploadEngine {
  if (!engine) {
    engine = new UploadEngine({
      store: defaultUploadStore(),
      api: mediaApi,
      putPart,
      sha256,
      describe: describeFile,
      uuid: newIdempotencyKey,
      now: () => new Date(),
      online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          const t = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        }),
      withLock:
        typeof navigator !== 'undefined' && navigator.locks
          ? <T>(name: string, fn: () => Promise<T>) =>
              navigator.locks.request(
                name,
                { ifAvailable: true },
                async (lock): Promise<T | undefined> => (lock ? await fn() : undefined),
              ) as Promise<T | undefined>
          : undefined,
    });
    window.addEventListener('offline', () => engine?.onOffline());
    window.addEventListener('online', () => engine?.onOnline());
  }
  return engine;
}

const EMPTY: EngineSnapshot = {
  ready: false,
  accountId: null,
  items: [],
  lockedCount: 0,
  storageError: null,
};
const noop = () => () => undefined;

/** Upload queue for the signed-in account; starts the engine once a session is known. */
export function useUploads(
  limits?: ClientLimits,
): EngineSnapshot & { engine: UploadEngine | null } {
  const { session } = useSession();
  const accountId = session?.principal.kind === 'account' ? session.principal.account_id : null;
  const e = typeof window === 'undefined' ? null : uploadEngine();
  const snapshot = useSyncExternalStore(
    e ? e.subscribe : noop,
    e ? e.getSnapshot : () => EMPTY,
    () => EMPTY,
  );
  useEffect(() => {
    if (e && limits) e.setLimits(limits);
  }, [e, limits]);
  useEffect(() => {
    if (e && session) void e.start(accountId);
  }, [e, session, accountId]);
  return { ...snapshot, engine: e };
}

let capabilitiesCache: Promise<Capabilities> | null = null;

/** GET /v2/capabilities once per tab (server evaluation is authoritative). */
export function loadCapabilities(): Promise<Capabilities> {
  if (!capabilitiesCache) {
    capabilitiesCache = mediaApi.capabilities();
    capabilitiesCache.catch(() => {
      capabilitiesCache = null;
    });
  }
  return capabilitiesCache;
}

export function limitsFrom(c: Capabilities | null | undefined): ClientLimits {
  if (!c) return DEFAULT_LIMITS;
  return {
    photo_max_bytes: c.limits.photo_max_bytes,
    photo_max_pixels: c.limits.photo_max_pixels,
    video_max_bytes: c.limits.video_max_bytes,
    video_max_duration_ms: c.limits.video_max_duration_ms,
    capture_video_max_duration_ms: c.limits.capture_video_max_duration_ms,
    batch_max_files: c.limits.batch_max_files,
    concurrent_transfers: Math.max(1, c.limits.concurrent_transfers),
  };
}
