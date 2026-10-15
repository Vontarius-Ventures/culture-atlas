import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ModelRole } from '../model-gateway/types';

export const ModelProfileSchema = z
  .object({
    gateway: z.literal('concentrate'),
    role: z.enum(['vision_photo', 'vision_video_frame', 'research_text', 'composer']),
    version: z.string().min(1),
    // Exact provider/model, never "auto", a bare model, or a marketing default.
    model: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
    provider: z.string().min(1),
    allowedFallbackProviders: z.array(z.string()).length(0),
    maxOutputTokens: z.number().int().positive().max(16_000),
    maxInputTokens: z.number().int().positive(),
    maxInputBytes: z.number().int().positive().max(1_000_000),
    image: z
      .object({
        maxBytes: z.number().int().nonnegative(),
        maxPixels: z.number().int().nonnegative(),
        maxDimension: z.number().int().nonnegative(),
        maxCount: z.number().int().min(0).max(1),
      })
      .strict(),
    timeoutMs: z.number().int().positive().max(30_000),
    structuredOutput: z.literal(true),
    requireZdr: z.literal(true),
    providerZdrEligible: z.literal(true),
    contentLoggingEnabled: z.literal(false),
    privacyVerifiedAt: z.iso.datetime(),
    promptVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
    catalogSnapshotAt: z.iso.datetime(),
    qualificationArtifactId: z.string().min(1),
    pricingSnapshotVersion: z.string().min(1),
    /** Qualified worst-case reservation, including capped input/output and image tokens. */
    reservationMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (!p.model.startsWith(`${p.provider}/`) || p.model.split('/').includes('auto')) {
      ctx.addIssue({ code: 'custom', message: 'Profile must pin one exact provider/model' });
    }
    const vision = p.role.startsWith('vision_');
    if (
      vision &&
      (p.image.maxCount !== 1 || !p.image.maxBytes || !p.image.maxPixels || !p.image.maxDimension)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Vision profile must qualify bounded images' });
    }
    if (!vision && (p.image.maxCount !== 0 || p.timeoutMs > 15_000)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Text profile must be image-free with <=15s deadline',
      });
    }
  });
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type ModelProfiles = Partial<Record<ModelRole, ModelProfile>>;

export function loadModelProfiles(path: string): ModelProfiles {
  const profiles = z
    .array(ModelProfileSchema)
    .max(4)
    .parse(JSON.parse(readFileSync(path, 'utf8')));
  const result: ModelProfiles = {};
  for (const profile of profiles) {
    if (result[profile.role]) throw new Error('Duplicate model role');
    result[profile.role] = profile;
  }
  return result;
}
