import { describe, expect, it } from 'vitest';
import { musicMatchAvailability } from './music-readiness';

describe('musicMatchAvailability', () => {
  it('is available only when transcript and Qloo keys are present (fingerprint still unnamed)', () => {
    expect(musicMatchAvailability({ ELEVENLABS_API_KEY: 'k', QLOO_API_KEY: 'q' })).toEqual({
      available: true,
      reasons: [],
    });
  });

  it('fails closed without inventing a match when transcript or Qloo is missing', () => {
    expect(musicMatchAvailability({}).available).toBe(false);
    expect(musicMatchAvailability({}).reasons).toEqual([
      'fingerprint_unavailable',
      'transcript_unconfigured',
      'qloo_unconfigured',
    ]);
    expect(musicMatchAvailability({ ELEVENLABS_API_KEY: 'k' }).reasons).toContain('qloo_unconfigured');
    expect(musicMatchAvailability({ QLOO_API_KEY: 'q' }).reasons).toContain('transcript_unconfigured');
  });
});
