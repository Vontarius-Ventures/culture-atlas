import { describe, expect, it } from 'vitest';
import { musicMatchAvailability } from './music-readiness';

describe('musicMatchAvailability', () => {
  it('needs only Qloo: Shazam runs on the phone and Qloo grounds its answer', () => {
    expect(musicMatchAvailability({ QLOO_API_KEY: 'q' })).toEqual({ available: true, reasons: [] });
  });

  it('fails closed without Qloo, whatever else is configured', () => {
    expect(musicMatchAvailability({})).toEqual({ available: false, reasons: ['qloo_unconfigured'] });
    expect(musicMatchAvailability({ ELEVENLABS_API_KEY: 'k' }).available).toBe(false);
  });
});
