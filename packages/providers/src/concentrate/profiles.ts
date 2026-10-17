import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

export function parseModelProfiles(value: unknown): ModelProfiles {
  const profiles = z.array(ModelProfileSchema).max(4).parse(value);
  const result: ModelProfiles = {};
  for (const profile of profiles) {
    if (result[profile.role]) throw new Error('Duplicate model role');
    result[profile.role] = profile;
  }
  return result;
}

export function loadModelProfiles(path: string): ModelProfiles {
  return parseModelProfiles(JSON.parse(readFileSync(path, 'utf8')));
}

/** Stable hash binding qualification artifacts to the exact profile they qualified. */
export function profileHash(profile: ModelProfile): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(profile)))
    .digest('hex');
}

/**
 * Catalog snapshot written by scripts/qualify-concentrate.ts from paginated
 * `GET /v1/models` pages. Raw entries are kept verbatim (public catalog
 * metadata only); Atlas does not guess undocumented field semantics.
 */
export const CatalogSnapshotSchema = z
  .object({
    kind: z.literal('concentrate-catalog-snapshot'),
    fetched_at: z.iso.datetime(),
    pages: z.number().int().positive(),
    models: z.array(z.object({ id: z.string().min(1) }).loose()),
  })
  .strict();
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;

/** Safe aggregate qualification evidence. Never media, prompts, outputs or keys. */
export const QualificationArtifactSchema = z
  .object({
    kind: z.literal('concentrate-qualification'),
    artifact_id: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
    created_at: z.iso.datetime(),
    role: z.enum(['vision_photo', 'vision_video_frame', 'research_text', 'composer']),
    model: z.string().min(1),
    provider: z.string().min(1),
    profile_hash: z.string().regex(/^[0-9a-f]{64}$/),
    catalog_snapshot_at: z.iso.datetime().nullable(),
    result: z.enum(['pass', 'fail']),
    requests_sent: z.number().int().nonnegative(),
    spend_cap_micros: z.number().int().nonnegative(),
    fixtures: z
      .object({
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        outcomes: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    latency_ms: z
      .object({
        p50: z.number().nonnegative().nullable(),
        p95: z.number().nonnegative().nullable(),
      })
      .strict(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        unknown_usage_attempts: z.number().int().nonnegative(),
      })
      .strict(),
    notes: z.array(z.string().max(300)).max(20),
  })
  .strict();
export type QualificationArtifact = z.infer<typeof QualificationArtifactSchema>;

/** Minimum passing live fixtures per role (CONCENTRATE.md: >=10 photos, >=3 short videos). */
export const QUALIFICATION_MINIMUM_FIXTURES: Record<ModelRole, number> = {
  vision_photo: 10,
  vision_video_frame: 3,
  research_text: 3,
  composer: 3,
};

function findString(value: unknown, needle: string): boolean {
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some((v) => findString(v, needle));
  if (value && typeof value === 'object')
    return Object.values(value).some((v) => findString(v, needle));
  return false;
}

/** Offline check: the pinned model id and provider appear in the snapshot the profile names. */
export function catalogCompatible(profile: ModelProfile, snapshot: CatalogSnapshot): boolean {
  if (Date.parse(snapshot.fetched_at) !== Date.parse(profile.catalogSnapshotAt)) return false;
  // Profiles pin "<provider>/<model>"; catalog entries list the bare model id
  // with its providers keyed underneath.
  const modelId = profile.model.slice(profile.provider.length + 1);
  const entry = snapshot.models.find((m) => m.id === modelId || m.id === profile.model);
  if (!entry) return false;
  const providers = (entry as { providers?: unknown }).providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    return Object.prototype.hasOwnProperty.call(providers, profile.provider);
  }
  return findString(entry, profile.provider);
}

export type QualificationState = 'configured' | 'catalog-compatible' | 'qualified';

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export const CATALOG_SNAPSHOT_FILE = 'catalog-snapshot.json';

/**
 * Reads `<dir>/catalog-snapshot.json` and `<dir>/<qualificationArtifactId>.json`.
 * Qualified only with a passing artifact for this exact profile hash and enough
 * fixtures. Read-only: never contacts the gateway.
 */
export function qualificationState(
  profile: ModelProfile,
  dir: string | undefined,
): QualificationState {
  if (!dir || !/^[a-zA-Z0-9._-]{1,120}$/.test(profile.qualificationArtifactId)) return 'configured';
  const snapshot = CatalogSnapshotSchema.safeParse(readJson(join(dir, CATALOG_SNAPSHOT_FILE)));
  const compatible = snapshot.success && catalogCompatible(profile, snapshot.data);
  const artifact = QualificationArtifactSchema.safeParse(
    readJson(join(dir, `${profile.qualificationArtifactId}.json`)),
  );
  if (
    compatible &&
    artifact.success &&
    artifact.data.result === 'pass' &&
    artifact.data.artifact_id === profile.qualificationArtifactId &&
    artifact.data.profile_hash === profileHash(profile) &&
    artifact.data.role === profile.role &&
    artifact.data.model === profile.model &&
    artifact.data.provider === profile.provider &&
    artifact.data.fixtures.failed === 0 &&
    artifact.data.fixtures.passed >= QUALIFICATION_MINIMUM_FIXTURES[profile.role]
  )
    return 'qualified';
  return compatible ? 'catalog-compatible' : 'configured';
}
