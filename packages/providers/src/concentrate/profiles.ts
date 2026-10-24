import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ModelRole } from '../model-gateway/types';
import { GUARDRAIL_VERSION } from '../vlm/guardrails';
import { EVAL_BINDING } from './eval-binding';

/** Every model role a profile can qualify (ModelRole). */
export const MODEL_ROLE_VALUES = [
  'vision_photo',
  'vision_video_frame',
  'research_text',
  'composer',
  /** Stage-2 background enrichment of a photo (spec amendment 2.2). */
  'vision_photo_enrich',
  /**
   * Independent verifier from a different model family (docs/requalification-plan.md, round 3):
   * binding checks before publication at stage 1 and stage 2; off by default.
   */
  'vision_verify',
  /** Style reading (style design §B.2): parallel to stage 1, its own prompt, schema and image size. */
  'vision_style',
] as const satisfies readonly ModelRole[];

/**
 * Reasoning effort a profile was qualified with. Sent as `reasoning.effort`
 * only when the profile sets it; never sent otherwise (FAST-03).
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const ModelProfileSchema = z
  .object({
    gateway: z.literal('concentrate'),
    role: z.enum(MODEL_ROLE_VALUES),
    version: z.string().min(1),
    // Exact provider/model, never "auto", a bare model, or a marketing default.
    model: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
    provider: z.string().min(1),
    allowedFallbackProviders: z.array(z.string()).length(0),
    maxOutputTokens: z.number().int().positive().max(16_000),
    /**
     * Optional qualified reasoning effort. Part of the profile, so it is part
     * of profileHash and a qualification artifact binds the exact effort.
     */
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
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
  const profiles = z.array(ModelProfileSchema).max(MODEL_ROLE_VALUES.length).parse(value);
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

/**
 * Golden set a role must be evaluated on before it can be qualified
 * (docs/quality-plan.md §7.5). Roles not listed (vision_video_frame) keep the
 * transport-only qualification until a golden set exists for them.
 */
export const REQUIRED_GOLDEN_SET: Partial<Record<ModelRole, string>> = {
  // golden-v5 (docs/quality-plan.md §19, round 4): tune = every golden-v4 photo (p01-p15, h01-h79), no held-out
  // split yet. A photo-role artifact needs at least 10 blind held-out photos (holdout_blind), so nothing qualifies a
  // photo role until the fresh blind split (h80+) is added to golden-v5 and frozen. golden-v1 to golden-v4 no longer
  // qualify a photo role (golden-v2 to golden-v4: their blind splits were consumed by failed blind runs).
  vision_photo: 'golden-v5',
  vision_photo_enrich: 'golden-v5',
  // The verifier is a photo role: it qualifies only on the same golden set, the same binding and a blind held-out split.
  vision_verify: 'golden-v5',
  research_text: 'text-v1',
  composer: 'text-v1',
};

/**
 * Guardrail version a photo role's evaluation must have run with: the
 * runtime GUARDRAIL_VERSION of vlm/guardrails.ts. Changing a guard rule bumps
 * that version and un-qualifies both photo roles until they are re-evaluated.
 */
export const REQUIRED_GUARDRAIL_VERSION: string = GUARDRAIL_VERSION;

const PHOTO_EVAL_ROLES: readonly ModelRole[] = ['vision_photo', 'vision_photo_enrich', 'vision_verify'];

/**
 * Aggregate evaluation evidence bound into an artifact: versions, hashes and
 * metric values only (no media, prompts or outputs), so the artifact rule holds.
 */
export const EvalBlockSchema = z
  .object({
    golden_set: z.string().regex(/^(golden|text)-v\d+$/),
    golden_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    thresholds_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    guardrail_version: z.string().min(1).nullable(),
    /**
     * Grounding is not exercised by a role's qualification (no Qloo calls), so
     * photo and text artifacts record null; the grounding gate is applied to
     * the live grounding run instead (scripts/eval/grounding-score.ts).
     */
    grounding_version: z.string().min(1).nullable(),
    scorer_version: z.string().min(1),
    /** Digest of the code the evaluation measured (EVAL_BINDING.sets[golden_set].code_sha256 when it was scored). */
    code_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /**
     * Photo sets: at least 10 held-out photos were scored and none had been
     * used for tuning (manifest `blind`). Null for text sets.
     */
    holdout_blind: z.boolean().nullable(),
    metrics: z.record(z.string().regex(/^[A-Za-z0-9_]{1,40}$/), z.number().finite()),
    pass: z.boolean(),
  })
  .strict();
export type EvalBlock = z.infer<typeof EvalBlockSchema>;

/**
 * Why an artifact's eval block does not qualify its role, or null when it
 * does (or none is required). Every input the evaluation depended on must
 * still be the committed one (EVAL_BINDING): the golden set's digest, the
 * thresholds file, the scorer version and the measured code. A changed label,
 * threshold, scorer, prompt builder or guard rule therefore un-qualifies the
 * role by itself, with no version to remember to bump. Photo roles also need
 * the current guardrail version and a blind held-out split, on a set whose
 * blind split no failed blind run has consumed (`blind_set_consumed`).
 */
export function evalGateFailure(role: ModelRole, block: EvalBlock | undefined, binding: EvalBindingLike = EVAL_BINDING): string | null {
  const required = REQUIRED_GOLDEN_SET[role];
  if (!required) return null;
  if (!block) return 'missing_eval';
  if (block.golden_set !== required) return 'wrong_golden_set';
  const bound = (binding.sets as Record<string, EvalBindingLike['sets'][string] | undefined>)[required];
  if (!bound) return 'unbound_golden_set';
  // A failed blind run consumed the set's held-out split (fixtures/eval/<set>/freeze.json):
  // no artifact on it qualifies a photo role, however it scores (docs/requalification-plan.md).
  if (PHOTO_EVAL_ROLES.includes(role) && bound.blind_consumed === true) return 'blind_set_consumed';
  if (block.golden_sha256 !== bound.golden_sha256) return 'stale_golden_set';
  if (block.thresholds_sha256 !== binding.thresholds_sha256) return 'stale_thresholds';
  if (block.scorer_version !== bound.scorer_version) return 'stale_scorer';
  if (block.code_sha256 !== bound.code_sha256) return 'stale_code';
  if (PHOTO_EVAL_ROLES.includes(role)) {
    if (block.guardrail_version !== REQUIRED_GUARDRAIL_VERSION) return 'stale_guardrail_version';
    if (block.holdout_blind !== true) return 'holdout_not_blind';
  }
  if (role === 'vision_verify') {
    // Round 3: the verifier qualifies only as a model of another family than the photo
    // roles (checked against the catalog author before any request) that was actually
    // exercised on enough golden photos (VERIFIER_EVAL_METRICS).
    if (block.metrics[VERIFIER_EVAL_METRICS.independentFamily] !== 1) return 'verifier_same_family';
    if ((block.metrics[VERIFIER_EVAL_METRICS.checkedPhotos] ?? 0) < QUALIFICATION_MINIMUM_FIXTURES.vision_verify) return 'verifier_unexercised';
  }
  if (!block.pass) return 'eval_failed';
  return null;
}

/** Eval-block metrics a vision_verify artifact must carry (scripts/qualify-concentrate-lib.ts writes them). */
export const VERIFIER_EVAL_METRICS = {
  /** 1 when the verifier's catalog author differs from both photo roles' (0 otherwise; the script refuses first). */
  independentFamily: 'verifier_independent_family',
  /** Golden photos on which the verifier answered at least one check. */
  checkedPhotos: 'verifier_checked_photos',
  /** Verifier calls made and claims blocked (report only). */
  calls: 'verifier_calls',
  blocked: 'verifier_blocked_claims',
} as const;

/** The catalog entry a profile pins (model id, bare or provider-prefixed), or undefined. */
export function catalogEntry(profile: Pick<ModelProfile, 'model' | 'provider'>, snapshot: CatalogSnapshot): CatalogSnapshot['models'][number] | undefined {
  const modelId = profile.model.slice(profile.provider.length + 1);
  return snapshot.models.find((m) => m.id === modelId || m.id === profile.model);
}

/**
 * The model family of a profile: the catalog entry's author (`author.slug`,
 * else `owned_by`), lower-cased; null when the catalog does not say. A model
 * family is who trained the model, not who serves it (Claude on Vertex is
 * still Anthropic's).
 */
export function catalogFamily(profile: Pick<ModelProfile, 'model' | 'provider'>, snapshot: CatalogSnapshot): string | null {
  const entry = catalogEntry(profile, snapshot) as { author?: { slug?: unknown }; owned_by?: unknown } | undefined;
  const author = typeof entry?.author?.slug === 'string' ? entry.author.slug : typeof entry?.owned_by === 'string' ? entry.owned_by : null;
  return author ? author.trim().toLowerCase() || null : null;
}

/**
 * The catalog lists a zero-data-retention policy for the profile's own
 * provider route (`providers[<provider>].zdr`). Catalog metadata only: the
 * operator's dashboard confirmation is still recorded in privacyVerifiedAt.
 */
export function catalogZdrListed(profile: Pick<ModelProfile, 'model' | 'provider'>, snapshot: CatalogSnapshot): boolean {
  const providers = (catalogEntry(profile, snapshot) as { providers?: unknown } | undefined)?.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return false;
  const route = (providers as Record<string, { zdr?: unknown } | undefined>)[profile.provider];
  return !!route && !!route.zdr && typeof route.zdr === 'object';
}

/** The shape of EVAL_BINDING (tests pass their own). */
export interface EvalBindingLike {
  thresholds_sha256: string;
  sets: Readonly<Record<string, { golden_sha256: string; scorer_version: string; code_sha256: string; blind_consumed?: boolean }>>;
}

/** Safe aggregate qualification evidence. Never media, prompts, outputs or keys. */
export const QualificationArtifactSchema = z
  .object({
    kind: z.literal('concentrate-qualification'),
    artifact_id: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
    created_at: z.iso.datetime(),
    role: z.enum(MODEL_ROLE_VALUES),
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
    /** Golden-set evaluation of the outputs (scored in memory, never stored). Required for REQUIRED_GOLDEN_SET roles. */
    eval: EvalBlockSchema.optional(),
  })
  .strict();
export type QualificationArtifact = z.infer<typeof QualificationArtifactSchema>;

/** Minimum passing live fixtures per role (CONCENTRATE.md: >=10 photos, >=3 short videos). */
export const QUALIFICATION_MINIMUM_FIXTURES: Record<ModelRole, number> = {
  vision_photo: 10,
  vision_video_frame: 3,
  research_text: 3,
  composer: 3,
  // Amendment 2.2: both photo stages qualify on >=10 real, owned photos.
  vision_photo_enrich: 10,
  // The verifier is held to the photo roles' bar.
  vision_verify: 10,
  // Style design §B.2: the style reading qualifies on >= 10 photos (eval set style-v1).
  vision_style: 10,
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
  const entry = catalogEntry(profile, snapshot);
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
 * fixtures, and, for roles with a REQUIRED_GOLDEN_SET, a passing eval block on
 * that golden set (photo roles: with the current guardrail version). Missing or
 * stale eval data leaves the role catalog-compatible. Read-only: never
 * contacts the gateway.
 */
export function qualificationState(
  profile: ModelProfile,
  dir: string | undefined,
  binding: EvalBindingLike = EVAL_BINDING,
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
    artifact.data.fixtures.passed >= QUALIFICATION_MINIMUM_FIXTURES[profile.role] &&
    evalGateFailure(profile.role, artifact.data.eval, binding) === null
  )
    return 'qualified';
  return compatible ? 'catalog-compatible' : 'configured';
}
