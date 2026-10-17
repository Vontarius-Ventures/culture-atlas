import { describe, expect, it } from 'vitest';
import { cameraProblem, captureFileName, limitText, pickRecorderType } from './camera-logic';
import {
  checkMediaFile,
  dayLabel,
  durationReason,
  formatBytes,
  formatDuration,
  groupByDay,
  mediaMeta,
  mediaTitle,
  pixelReason,
  statusLabel,
} from './media-format';
import { deviceState } from './DevicesView';

describe('media format', () => {
  it('formats durations and sizes like the mockups', () => {
    expect(formatDuration(42_000)).toBe('0:42');
    expect(formatDuration(125_400)).toBe('2:05');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3 MB');
    expect(formatBytes(5_242_880)).toBe('5 MB');
    expect(formatBytes(1_288_490_189)).toBe('1.2 GB');
  });

  it('checks extension/MIME agreement, HEIC and size per kind', () => {
    expect(checkMediaFile({ name: 'a.JPG', type: 'image/jpeg', size: 10 })).toMatchObject({
      ok: true,
      kind: 'photo',
    });
    expect(checkMediaFile({ name: 'clip.mov', type: '', size: 10 })).toMatchObject({
      ok: true,
      contentType: 'video/quicktime',
    });
    expect(checkMediaFile({ name: 'x.heic', type: 'image/heic', size: 10 }).reason).toMatch(/HEIC/);
    expect(checkMediaFile({ name: 'x.png', type: 'image/jpeg', size: 10 }).reason).toMatch(
      /does not match/,
    );
    expect(checkMediaFile({ name: 'x.gif', type: 'image/gif', size: 10 }).reason).toMatch(
      /not supported/,
    );
    expect(
      checkMediaFile({ name: 'big.jpg', type: 'image/jpeg', size: 16 * 1024 * 1024 }).reason,
    ).toMatch(/larger than 15 MB/);
    expect(checkMediaFile({ name: 'v.mp4', type: 'video/mp4', size: 16 * 1024 * 1024 }).ok).toBe(
      true,
    );
    expect(durationReason(121_000)).toMatch(/longer than 2 min/);
    expect(durationReason(60_000)).toBeNull();
    expect(pixelReason(8000, 6000)).toMatch(/40 megapixels/);
  });

  it('describes preparation in words and never claims analysis', () => {
    expect(statusLabel('processing', 'video')).toBe('Preparing video');
    expect(statusLabel('failed', 'video')).toBe('Video could not be prepared');
    expect(
      mediaMeta({ kind: 'video', source: 'meta_glasses', status: 'ready', duration_ms: 42_000 }),
    ).toBe('Meta glasses · Video · 0:42');
    expect(mediaMeta({ kind: 'photo', source: 'upload', status: 'ready' })).toBe('Upload · Ready');
    expect(mediaTitle({ title: null, kind: 'video', created_at: '2026-10-17T12:00:00Z' })).toMatch(
      /^Video from Oct 1[67]$/,
    );
  });

  it('groups by day with Today/Yesterday labels', () => {
    const now = new Date(2026, 9, 17, 12);
    expect(dayLabel(new Date(2026, 9, 17, 8).toISOString(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 16, 8).toISOString(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2025, 2, 3).toISOString(), now)).toBe('March 3, 2025');
    const groups = groupByDay(
      [
        { created_at: new Date(2026, 9, 17, 9).toISOString() },
        { created_at: new Date(2026, 9, 17, 8).toISOString() },
        { created_at: new Date(2026, 9, 15, 8).toISOString() },
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Today', 2],
      ['October 15', 1],
    ]);
  });
});

describe('camera logic', () => {
  it('maps getUserMedia failures to what people can do', () => {
    expect(cameraProblem({ name: 'NotAllowedError' })).toBe('denied');
    expect(cameraProblem({ name: 'NotFoundError' })).toBe('unavailable');
    expect(cameraProblem({ name: 'NotReadableError' })).toBe('busy');
    expect(cameraProblem({ name: 'SecurityError' })).toBe('insecure');
    expect(cameraProblem(new Error('x'))).toBe('error');
  });

  it('picks a recorder container the server accepts', () => {
    expect(pickRecorderType((t) => t.startsWith('video/webm'))).toMatchObject({
      contentType: 'video/webm',
      extension: 'webm',
    });
    expect(pickRecorderType((t) => t === 'video/mp4')).toMatchObject({
      contentType: 'video/mp4',
      mimeType: 'video/mp4',
    });
    expect(pickRecorderType(() => false)).toBeNull();
  });

  it('shows the limit, then a countdown in the last 10 seconds', () => {
    expect(limitText(12_000, 60_000, true)).toEqual({ text: '60 sec max', soon: false });
    expect(limitText(52_100, 60_000, true)).toEqual({ text: '0:08 left', soon: true });
    expect(limitText(52_100, 60_000, false).soon).toBe(false);
    expect(captureFileName('video', 'webm', new Date(2026, 9, 17, 14, 3, 5))).toBe(
      'video-20261017-140305.webm',
    );
  });
});

describe('device state', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000001',
    platform: 'ios' as const,
    app_version: '2.0',
    revision: 1,
    revoked_at: null,
    capabilities: {},
    readiness: 'ready' as const,
    app_state: 'foreground' as const,
  };
  it('never labels stale status Ready', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    expect(deviceState({ ...base, last_seen_at: '2026-10-17T11:59:50Z' }, now)).toEqual({
      label: 'Ready to capture',
      ready: true,
    });
    expect(deviceState({ ...base, last_seen_at: '2026-10-17T11:58:00Z' }, now).ready).toBe(false);
    expect(
      deviceState({ ...base, last_seen_at: '2026-10-17T11:59:50Z', app_state: 'background' }, now)
        .label,
    ).toBe('App in background');
  });
});
