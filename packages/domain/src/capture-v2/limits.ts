import { AppError } from '../errors';
import { DEFAULT_CAPTURE_LIMITS, type CaptureLimits } from './types';

/**
 * Operator configuration can only lower the contract ceilings (schema byte limit,
 * database duration check). Limits are never raised silently because credits exist.
 */
const CEILINGS: Partial<Record<keyof CaptureLimits, number>> = {
  videoMaxBytes: 262144000,
  videoMaxDurationMs: 120000,
  captureVideoMaxDurationMs: 120000,
};
const ENV: Array<[keyof CaptureLimits, string, number]> = [
  ['photoMaxBytes', 'MEDIA_PHOTO_MAX_BYTES', 1],
  ['photoMaxPixels', 'MEDIA_PHOTO_MAX_PIXELS', 1],
  ['videoMaxBytes', 'MEDIA_VIDEO_MAX_BYTES', 1],
  ['videoMaxDurationMs', 'MEDIA_VIDEO_MAX_DURATION_SECONDS', 1000],
  ['captureVideoMaxDurationMs', 'CAPTURE_VIDEO_MAX_DURATION_SECONDS', 1000],
  ['accountQuotaBytes', 'ACCOUNT_MEDIA_QUOTA_BYTES', 1],
  ['analysisDailyLimit', 'ACCOUNT_DAILY_MEDIA_ANALYSES', 1],
];

export function captureLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
  base: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): CaptureLimits {
  const limits = { ...base };
  for (const [field, name, scale] of ENV) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const value = Number(raw) * scale;
    const ceiling = CEILINGS[field];
    if (!Number.isSafeInteger(value) || value <= 0 || (ceiling !== undefined && value > ceiling))
      throw new AppError('service_unavailable', {
        message: `Media limit ${name} is invalid or exceeds the contract maximum.`,
      });
    limits[field] = value;
  }
  return limits;
}
