/**
 * Pure helpers for the v2 media UI: labels, durations, sizes, client-side file
 * checks and library grouping. The server stays authoritative for every limit;
 * these checks only reject obviously unsupported files before bytes move.
 */

/** Media kinds: 'audio' is a Music Mode recording (amendment 2.3). */
export type MediaKind = 'photo' | 'video' | 'audio';
export type MediaSource =
  | 'browser_camera'
  | 'phone_camera'
  | 'meta_glasses'
  | 'upload'
  | 'legacy_sensor'
  | 'browser_microphone'
  | 'phone_microphone';
export type MediaStatus =
  'pending_upload' | 'verifying' | 'processing' | 'ready' | 'failed' | 'deleted';

export interface ClientLimits {
  photo_max_bytes: number;
  photo_max_pixels: number;
  video_max_bytes: number;
  video_max_duration_ms: number;
  capture_video_max_duration_ms: number;
  batch_max_files: number;
  concurrent_transfers: number;
}

/**
 * Glasses reasons that are account-wide or release blockers (SCREEN-CONTRACT 09:
 * no hand-off and no fake reconnect). Other reasons are setup steps on the phone.
 */
export const GLASSES_BLOCKING_REASONS: ReadonlySet<string> = new Set([
  'release_channel_ineligible',
  'temporarily_disabled',
  'rollout_unavailable',
]);
export const glassesBlocked = (reasons: readonly string[]) =>
  reasons.some((r) => GLASSES_BLOCKING_REASONS.has(r));

/**
 * Screen 02 glasses line. SCREEN-CONTRACT: the glasses entry always explains
 * eligibility, and "not connected" is never shown as ready. Only a server
 * evaluation that says glasses capture is available may claim connected
 * glasses; a browser never captures from glasses (it hands off to the phone).
 */
export function glassesEntryLine(
  glasses: { available: boolean; reasons: readonly string[] } | null | undefined,
): string {
  if (!glasses) return 'See what glasses capture needs';
  if (glassesBlocked(glasses.reasons)) return 'See why it is not available yet';
  if (glasses.available) return 'Capture with your connected glasses';
  return 'Set up on your phone with the culture atlas app';
}

/** PRODUCT-AND-ARCHITECTURE defaults, used until GET /v2/capabilities answers. */
export const DEFAULT_LIMITS: ClientLimits = {
  photo_max_bytes: 15 * 1024 * 1024,
  photo_max_pixels: 40_000_000,
  video_max_bytes: 250 * 1024 * 1024,
  video_max_duration_ms: 120_000,
  capture_video_max_duration_ms: 60_000,
  batch_max_files: 20,
  concurrent_transfers: 2,
};

export const SOURCE_LABELS: Record<MediaSource, string> = {
  browser_camera: 'Browser camera',
  phone_camera: 'Phone camera',
  meta_glasses: 'Meta glasses',
  upload: 'Upload',
  legacy_sensor: 'World Sensor',
  browser_microphone: 'Browser microphone',
  phone_microphone: 'Phone microphone',
};

/** Preparation status in words (never color alone). Library readiness is not analysis. */
export function statusLabel(status: MediaStatus, kind: MediaKind): string {
  switch (status) {
    case 'pending_upload':
      return 'Uploading';
    case 'verifying':
      return 'Checking file';
    case 'processing':
      return kind === 'video'
        ? 'Preparing video'
        : kind === 'audio'
          ? 'Preparing recording'
          : 'Preparing photo';
    case 'ready':
      return 'Ready';
    case 'failed':
      return kind === 'video'
        ? 'Video could not be prepared'
        : kind === 'audio'
          ? 'Recording could not be prepared'
          : 'Photo could not be prepared';
    case 'deleted':
      return 'Deleted';
  }
}

/**
 * 42_000 → "0:42"; 125_000 → "2:05". Whole seconds are floored, the way
 * browser media players and running clocks count, so a 1.6 s recording reads
 * "0:01" next to its own `<audio>` player (never "0:02" beside "0:01").
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 42_000 → "42 sec"; 95_000 → "1 min 35 sec". */
export function formatDurationWords(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total} sec`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m} min ${s} sec` : `${m} min`;
}

/** Bytes in the mockup's short form: "3 MB", "850 KB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export const ACCEPT_MEDIA = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm';

export interface FileCheck {
  ok: boolean;
  /** The file chooser adds photos and videos; Music Mode keeps recordings separately. */
  kind: 'photo' | 'video' | null;
  contentType: string | null;
  /** Per-item reason when the file is rejected before upload. */
  reason: string | null;
}

/**
 * Extension and MIME must agree (an empty browser MIME falls back to the
 * extension); size is checked against the kind's limit. Duration and pixel
 * limits need decoding and are checked separately.
 */
export function checkMediaFile(
  file: { name: string; type: string; size: number },
  limits: ClientLimits = DEFAULT_LIMITS,
): FileCheck {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  const mime = file.type.toLowerCase();
  if (ext === 'heic' || ext === 'heif' || /heic|heif/.test(mime))
    return reject('HEIC photos are not supported yet. Export it as JPEG and add it again.');
  const byExt = TYPE_BY_EXTENSION[ext];
  if (!byExt)
    return reject('This file type is not supported. Use JPEG, PNG, WebP, MP4, MOV or WebM.');
  if (mime && mime !== byExt && !(byExt === 'video/quicktime' && mime === 'video/mp4'))
    return reject('The file name does not match its contents. Export it again and retry.');
  const contentType = mime && Object.values(TYPE_BY_EXTENSION).includes(mime) ? mime : byExt;
  const kind: 'photo' | 'video' = contentType.startsWith('image/') ? 'photo' : 'video';
  if (file.size <= 0) return reject('This file is empty.');
  const max = kind === 'photo' ? limits.photo_max_bytes : limits.video_max_bytes;
  if (file.size > max)
    return reject(
      `This ${kind} is larger than ${formatBytes(max)}. Choose a smaller file.`,
      kind,
      contentType,
    );
  return { ok: true, kind, contentType, reason: null };

  function reject(
    reason: string,
    k: 'photo' | 'video' | null = null,
    ct: string | null = null,
  ): FileCheck {
    return { ok: false, kind: k, contentType: ct, reason };
  }
}

export function durationReason(durationMs: number, limits: ClientLimits = DEFAULT_LIMITS) {
  return durationMs > limits.video_max_duration_ms
    ? `This video is longer than ${formatDurationWords(limits.video_max_duration_ms)}. Trim it and add it again.`
    : null;
}

export function pixelReason(width: number, height: number, limits: ClientLimits = DEFAULT_LIMITS) {
  return width * height > limits.photo_max_pixels
    ? `This photo has more than ${Math.round(limits.photo_max_pixels / 1_000_000)} megapixels. Resize it and add it again.`
    : null;
}

/** Library section headings: "Today", "Yesterday", then "October 3" / "October 3, 2025". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function groupByDay<T extends { created_at: string }>(items: T[], now = new Date()) {
  const groups: Array<{ label: string; items: T[] }> = [];
  for (const item of items) {
    const label = dayLabel(item.created_at, now);
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Display title: the owner's title, else a neutral kind + date. Never a model guess. */
export function mediaTitle(m: { title?: string | null; kind: MediaKind; created_at: string }) {
  if (m.title) return m.title;
  const date = new Date(m.created_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  const noun = m.kind === 'video' ? 'Video' : m.kind === 'audio' ? 'Recording' : 'Photo';
  return `${noun} from ${date}`;
}

/** "Meta glasses · Video · 0:42" / "Phone camera · Ready" / "Phone microphone · Recording · 0:15". */
export function mediaMeta(m: {
  kind: MediaKind;
  source: MediaSource;
  status: MediaStatus;
  duration_ms?: number;
}): string {
  const parts = [SOURCE_LABELS[m.source]];
  if ((m.kind === 'video' || m.kind === 'audio') && m.status === 'ready') {
    parts.push(m.kind === 'video' ? 'Video' : 'Recording');
    if (m.duration_ms) parts.push(formatDuration(m.duration_ms));
  } else parts.push(statusLabel(m.status, m.kind));
  return parts.join(' · ');
}

/** "Recording on this phone" on touch devices, "this device" elsewhere. */
export function deviceNoun(coarsePointer: boolean): 'phone' | 'device' {
  return coarsePointer ? 'phone' : 'device';
}
