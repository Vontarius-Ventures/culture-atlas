import { describe, expect, it } from 'vitest';
import { MediaRangeNotSatisfiable, parseByteRange, resolveByteRange } from './intake';
import { captureLimitsFromEnv } from './limits';
import { DEFAULT_CAPTURE_LIMITS } from './types';

describe('byte range parsing', () => {
  it('parses the three single-range forms and rejects others', () => {
    expect(parseByteRange(null)).toBeUndefined();
    expect(parseByteRange('bytes=0-99')).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=100-')).toEqual({ start: 100 });
    expect(parseByteRange('bytes=-10')).toEqual({ suffix: 10 });
    for (const bad of [
      'bytes=-',
      'bytes=1-2,4-5',
      'items=0-1',
      'bytes=a-b',
      'bytes=9999999999999999-',
    ])
      expect(parseByteRange(bad)).toBe('invalid');
  });
  it('clamps ends to the object and refuses unsatisfiable ranges', () => {
    expect(resolveByteRange({ start: 0, end: 10_000 }, 100)).toEqual({ start: 0, end: 99 });
    expect(resolveByteRange({ suffix: 500 }, 100)).toEqual({ start: 0, end: 99 });
    expect(resolveByteRange({ start: 50 }, 100)).toEqual({ start: 50, end: 99 });
    expect(() => resolveByteRange({ start: 100 }, 100)).toThrow(MediaRangeNotSatisfiable);
    expect(() => resolveByteRange({ start: 9, end: 3 }, 100)).toThrow(MediaRangeNotSatisfiable);
    expect(() => resolveByteRange({ suffix: 0 }, 100)).toThrow(MediaRangeNotSatisfiable);
  });
});

describe('operator media limits', () => {
  it('reads the documented variables and converts seconds', () => {
    expect(
      captureLimitsFromEnv({
        MEDIA_VIDEO_MAX_DURATION_SECONDS: '90',
        CAPTURE_VIDEO_MAX_DURATION_SECONDS: '30',
        ACCOUNT_MEDIA_QUOTA_BYTES: '1073741824',
        ACCOUNT_DAILY_MEDIA_ANALYSES: '10',
        MEDIA_PHOTO_MAX_BYTES: '',
      }),
    ).toEqual({
      ...DEFAULT_CAPTURE_LIMITS,
      videoMaxDurationMs: 90000,
      captureVideoMaxDurationMs: 30000,
      accountQuotaBytes: 1073741824,
      analysisDailyLimit: 10,
    });
  });
  it('cannot raise limits beyond the contract ceilings or accept junk', () => {
    for (const env of [
      { MEDIA_VIDEO_MAX_BYTES: '262144001' },
      { MEDIA_VIDEO_MAX_DURATION_SECONDS: '121' },
      { ACCOUNT_DAILY_MEDIA_ANALYSES: '0' },
      { MEDIA_PHOTO_MAX_BYTES: 'lots' },
    ])
      expect(() => captureLimitsFromEnv(env)).toThrow();
  });
});
