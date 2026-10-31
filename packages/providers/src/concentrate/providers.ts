import sharp, { type Metadata } from 'sharp';
import type { z } from 'zod';
import type { CapabilityEntry } from '../capabilities';
import { ProviderError, type CallOptions } from '../errors';
import type { StructuredResponseRunner } from '../model-gateway/runner';
import type { StructuredRequest, StructuredResult, TextModelProvider } from '../text/types';
import {
  ENRICH_MAX_DIMENSION,
  QUICK_READ_MAX_CANDIDATES,
  QUICK_READ_MAX_DIMENSION,
  VLM_ENRICH_SYSTEM_PROMPT,
  VLM_ENRICH_SYSTEM_PROMPT_V2,
  VLM_QUICK_SYSTEM_PROMPT,
  VLM_QUICK_SYSTEM_PROMPT_V2,
  VLM_READING_VERSIONS,
  VLM_SYSTEM_PROMPT,
  buildVlmEnrichUserText,
  buildVlmQuickUserText,
  buildVlmUserText,
} from '../vlm/prompt';
import {
  VlmAnalysis,
  VlmEnrichmentV1,
  VlmEnrichmentV2,
  VlmFullReading,
  VlmQuickReadV1,
  VlmQuickReadV2,
  candidateNameKey,
  normalizeEnrichment,
  normalizeQuickRead,
  toVlmAnalysis,
  type VlmAnalyzeInput,
  type VlmEnricher,
  type VlmEnrichInput,
  type VlmEnrichResult,
  type VlmProvider,
  type VlmQuickRead,
  type VlmResult,
} from '../vlm/types';
import {
  VERIFY_MAX_DIMENSION,
  VERIFY_READING_VERSION,
  VLM_VERIFY_SYSTEM_PROMPT,
  VlmVerification,
  buildVlmVerifyUserText,
  type VlmVerifier,
  type VlmVerifyInput,
  type VlmVerifyResult,
} from '../vlm/verify';
import { boundJpegForProfile } from './image';
import type { ModelProfile } from './profiles';

export type VlmReading = 'full' | 'quick' | 'enrich' | 'verify';

/**
 * Which reading a profile was qualified for. Its schemaVersion names it (and
 * is part of profileHash): the stage-2 role always enriches and the verifier
 * role always verifies; a vision profile pinned to the legacy full schema
 * keeps the single full reading; every other vision profile uses the
 * two-stage quick read (amendment 2.2).
 */
export function readingForProfile(profile: Pick<ModelProfile, 'role' | 'schemaVersion'>): VlmReading {
  if (profile.role === 'vision_photo_enrich') return 'enrich';
  if (profile.role === 'vision_verify') return 'verify';
  return profile.schemaVersion === VLM_READING_VERSIONS.full.schema ? 'full' : 'quick';
}

/**
 * Which version of the two-stage reading a profile was qualified for. A
 * profile pinned to a v1 schema (phase-4 qualified) keeps the v1 prompt and
 * schema byte-identical; every other quick or enrich profile gets reading v2
 * (docs/quality-plan.md §3). Both pass through the same guardrails.
 */
export function readingVersionForProfile(profile: Pick<ModelProfile, 'role' | 'schemaVersion'>): 'v1' | 'v2' {
  return profile.schemaVersion === VLM_READING_VERSIONS.quick.schema ||
    profile.schemaVersion === VLM_READING_VERSIONS.enrich.schema
    ? 'v1'
    : 'v2';
}

/**
 * Round 4 (docs/quality-plan.md §19): a reading-v2 photo profile must name the
 * prompt version the code sends for its schema (VLM_READING_VERSIONS). The v2
 * prompts are edited in place under a new promptVersion, so a profile naming an
 * older one would be evaluated or qualified on a prompt production no longer
 * sends. Returns the reason, or null when the profile names the current prompt
 * (or is a v1, full-reading, verifier or text profile).
 */
export function stalePhotoPromptVersion(profile: Pick<ModelProfile, 'role' | 'schemaVersion' | 'promptVersion'>): string | null {
  const current =
    profile.schemaVersion === VLM_READING_VERSIONS.quickV2.schema
      ? VLM_READING_VERSIONS.quickV2.prompt
      : profile.schemaVersion === VLM_READING_VERSIONS.enrichV2.schema
        ? VLM_READING_VERSIONS.enrichV2.prompt
        : null;
  if (!current || (profile.role !== 'vision_photo' && profile.role !== 'vision_photo_enrich')) return null;
  return profile.promptVersion === current
    ? null
    : `The ${profile.role} profile names promptVersion ${profile.promptVersion}; schema ${profile.schemaVersion} is sent with ${current}.`;
}

/** Largest derivative accepted for re-bounding to a stage's qualified size. */
const MAX_STAGE_INPUT_BYTES = 16 * 1024 * 1024;

/**
 * Bounds a normalized JPEG to the profile's qualified image limits, further
 * capped at the stage's measured size (512 px stage 1, 768 px stage 2).
 * A derivative that already fits is sent unchanged.
 */
async function stageImage(
  input: VlmAnalyzeInput['image'],
  limits: ModelProfile['image'],
  stageMaxDimension: number,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  if (input.mediaType !== 'image/jpeg' || input.bytes.length > MAX_STAGE_INPUT_BYTES)
    throw new ProviderError(
      'concentrate',
      'bad_request',
      'Vision requires a bounded normalized JPEG derivative',
    );
  const bounds = { ...limits, maxDimension: Math.min(limits.maxDimension, stageMaxDimension) };
  let metadata: Metadata;
  try {
    metadata = await sharp(input.bytes, { limitInputPixels: 100_000_000 }).metadata();
  } catch {
    throw new ProviderError('concentrate', 'bad_request', 'Invalid normalized image');
  }
  if (
    metadata.format !== 'jpeg' ||
    !metadata.width ||
    !metadata.height ||
    (metadata.pages ?? 1) > 1
  )
    throw new ProviderError('concentrate', 'bad_request', 'Invalid normalized JPEG');
  const swapped = (metadata.orientation ?? 1) >= 5;
  if (
    !swapped &&
    input.bytes.length <= bounds.maxBytes &&
    metadata.width * metadata.height <= bounds.maxPixels &&
    Math.max(metadata.width, metadata.height) <= bounds.maxDimension
  )
    return { bytes: input.bytes, width: metadata.width, height: metadata.height };
  return boundJpegForProfile(input.bytes, bounds);
}

/** Stage-1 output checks beyond the schema: requested count, names, ids after merge. */
function validateQuickRead(quick: VlmQuickRead, maxCandidates: number): void {
  const names = quick.candidates.map((c) => candidateNameKey(c.name));
  if (names.some((n) => !n) || new Set(names).size !== names.length)
    throw new Error('Empty or duplicate candidate names');
  validateVision(toVlmAnalysis(quick), maxCandidates);
}

/** Additional reference/geometry checks run before output is eligible for publication. */
export function validateVision(analysis: VlmAnalysis, maxCandidates: number): void {
  for (const records of [
    analysis.regions,
    analysis.observations,
    analysis.candidates,
    analysis.competing_subjects,
  ]) {
    if (records.some((r) => !r.id) || new Set(records.map((r) => r.id)).size !== records.length)
      throw new Error('Duplicate or empty IDs');
  }
  const ids = new Set(analysis.regions.map((r) => r.id));
  const refs = [
    ...analysis.observations.flatMap((o) => o.region_ids),
    ...analysis.candidates.flatMap((o) => o.region_ids),
    ...analysis.competing_subjects.flatMap((o) => o.region_ids),
    ...analysis.visible_text.flatMap((o) => (o.region_id === null ? [] : [o.region_id])),
  ];
  if (refs.some((id) => !ids.has(id)) || analysis.candidates.length > maxCandidates)
    throw new Error('Invalid reference');
  if (
    analysis.regions.some(
      ({ box }) => box.w <= 0 || box.h <= 0 || box.x + box.w > 1 || box.y + box.h > 1,
    )
  )
    throw new Error('Invalid geometry');
}

export class ConcentrateVlm implements VlmProvider {
  readonly id: string;
  /** 'quick' (stage 1 of the two-stage reading) or the legacy single 'full' reading. */
  readonly reading: 'full' | 'quick';
  constructor(
    readonly runner: StructuredResponseRunner,
    options: { reading?: 'full' | 'quick' } = {},
  ) {
    if (runner.profile.role === 'vision_similarity')
      throw new Error('The visual similarity role is served by ConcentrateVisualSimilarity');
    if (runner.profile.role === 'vision_connection_asset')
      throw new Error('The connection asset role is served only by ConcentrateConnectionAsset');
    this.id = `vlm:concentrate:${runner.profile.model}`;
    const fromProfile = readingForProfile(runner.profile);
    if (fromProfile === 'enrich')
      throw new Error('The enrichment role is served by ConcentrateVlmEnricher');
    if (fromProfile === 'verify')
      throw new Error('The verifier role is served by ConcentrateVlmVerifier');
    this.reading = options.reading ?? fromProfile;
  }
  capability(): CapabilityEntry {
    return this.runner.capability();
  }
  async analyzeImage(input: VlmAnalyzeInput, options?: CallOptions): Promise<VlmResult> {
    if (this.reading === 'quick') return this.quickRead(input, options);
    if (
      input.image.mediaType !== 'image/jpeg' ||
      input.image.bytes.length > this.runner.profile.image.maxBytes
    ) {
      throw new ProviderError(
        'concentrate',
        'bad_request',
        'Vision requires a bounded normalized JPEG derivative',
      );
    }
    let metadata: Metadata;
    try {
      metadata = await sharp(input.image.bytes, {
        limitInputPixels: this.runner.profile.image.maxPixels,
      }).metadata();
    } catch {
      throw new ProviderError('concentrate', 'bad_request', 'Invalid normalized image');
    }
    if (
      metadata.format !== 'jpeg' ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) > 1
    ) {
      throw new ProviderError('concentrate', 'bad_request', 'Invalid normalized JPEG');
    }
    const max = Math.min(Math.max(input.maxCandidates ?? 8, 1), 12);
    const result = await this.runner.run(
      {
        system: VLM_SYSTEM_PROMPT,
        content: [
          { type: 'text', text: buildVlmUserText({ ...input, maxCandidates: max }) },
          {
            type: 'image',
            mediaType: 'image/jpeg',
            base64: Buffer.from(input.image.bytes).toString('base64'),
            width: metadata.width,
            height: metadata.height,
          },
        ],
        schema: VlmFullReading,
        schemaName: 'atlas_observations_v2',
        validate: (analysis) => validateVision(VlmAnalysis.parse(analysis), max),
      },
      options,
    );
    return {
      analysis: VlmAnalysis.parse(result.data),
      model: result.model,
      durationMs: result.durationMs,
      usage: result.usage,
    };
  }

  /**
   * Stage 1 (amendment 2.2): the slim VlmQuickRead at <= 512 px with at most
   * five candidates, merged into the VlmAnalysis shape the compiler expects.
   */
  private async quickRead(input: VlmAnalyzeInput, options?: CallOptions): Promise<VlmResult> {
    const image = await stageImage(input.image, this.runner.profile.image, QUICK_READ_MAX_DIMENSION);
    const max = Math.min(
      Math.max(input.maxCandidates ?? QUICK_READ_MAX_CANDIDATES, 1),
      QUICK_READ_MAX_CANDIDATES,
    );
    const v2 = readingVersionForProfile(this.runner.profile) === 'v2';
    const content = [
      { type: 'text' as const, text: buildVlmQuickUserText({ ...input, maxCandidates: max }) },
      {
        type: 'image' as const,
        mediaType: 'image/jpeg' as const,
        base64: Buffer.from(image.bytes).toString('base64'),
        width: image.width,
        height: image.height,
      },
    ];
    const result: { data: VlmQuickRead; model: string; durationMs: number; usage?: VlmResult['usage'] } = v2
      ? await this.runner.run(
          {
            system: VLM_QUICK_SYSTEM_PROMPT_V2,
            content,
            schema: VlmQuickReadV2,
            schemaName: VLM_READING_VERSIONS.quickV2.schema,
            // Reading v2 is cut back to its limits before the checks (a cap overflow never fails it).
            validate: (quick) => validateQuickRead(normalizeQuickRead(quick, max), max),
          },
          options,
        )
      : await this.runner.run(
          {
            system: VLM_QUICK_SYSTEM_PROMPT,
            content,
            schema: VlmQuickReadV1,
            schemaName: VLM_READING_VERSIONS.quick.schema,
            validate: (quick) => validateQuickRead(quick, max),
          },
          options,
        );
    const quick = v2 ? normalizeQuickRead(result.data, max) : result.data;
    return {
      analysis: toVlmAnalysis(quick),
      quick,
      model: result.model,
      durationMs: result.durationMs,
      usage: result.usage,
    };
  }
}

/**
 * Stage 2 (role vision_photo_enrich): observations, visible text, short
 * rationales, a verdict (v1: keep) per stage-1 candidate, up to four more
 * candidates and regions, read from the same photo at <= 768 px.
 */
export class ConcentrateVlmEnricher implements VlmEnricher {
  readonly id: string;
  constructor(readonly runner: StructuredResponseRunner) {
    if (readingForProfile(runner.profile) !== 'enrich')
      throw new Error('ConcentrateVlmEnricher requires the vision_photo_enrich role');
    this.id = `vlm-enrich:concentrate:${runner.profile.model}`;
  }
  capability(): CapabilityEntry {
    return this.runner.capability();
  }
  async enrichImage(input: VlmEnrichInput, options?: CallOptions): Promise<VlmEnrichResult> {
    const image = await stageImage(input.image, this.runner.profile.image, ENRICH_MAX_DIMENSION);
    const content = [
      { type: 'text' as const, text: buildVlmEnrichUserText(input) },
      {
        type: 'image' as const,
        mediaType: 'image/jpeg' as const,
        base64: Buffer.from(image.bytes).toString('base64'),
        width: image.width,
        height: image.height,
      },
    ];
    const validate = (enrichment: { additional_candidates: readonly { name: string }[] }) => {
      const names = enrichment.additional_candidates.map((c) => candidateNameKey(c.name));
      if (names.some((n) => !n)) throw new Error('Empty candidate name');
    };
    const result =
      readingVersionForProfile(this.runner.profile) === 'v2'
        ? await this.runner.run(
            {
              system: VLM_ENRICH_SYSTEM_PROMPT_V2,
              content,
              schema: VlmEnrichmentV2,
              schemaName: VLM_READING_VERSIONS.enrichV2.schema,
              validate: (e) => validate(normalizeEnrichment(e)),
            },
            options,
          )
        : await this.runner.run(
            {
              system: VLM_ENRICH_SYSTEM_PROMPT,
              content,
              schema: VlmEnrichmentV1,
              schemaName: VLM_READING_VERSIONS.enrich.schema,
              validate,
            },
            options,
          );
    return {
      enrichment: normalizeEnrichment(result.data),
      model: result.model,
      durationMs: result.durationMs,
      usage: result.usage,
    };
  }
}

/**
 * The independent verifier (role vision_verify, docs/requalification-plan.md):
 * one batched yes/no/unsure check of the selected claims against the photo at
 * <= 768 px. Claims and transcribed text are passed as DATA inside the
 * escaped user_data block; the prompt keeps the security rules word for word.
 */
export class ConcentrateVlmVerifier implements VlmVerifier {
  readonly id: string;
  constructor(readonly runner: StructuredResponseRunner) {
    if (readingForProfile(runner.profile) !== 'verify')
      throw new Error('ConcentrateVlmVerifier requires the vision_verify role');
    this.id = `vlm-verify:concentrate:${runner.profile.model}`;
  }
  capability(): CapabilityEntry {
    return this.runner.capability();
  }
  async verifyImage(input: VlmVerifyInput, options?: CallOptions): Promise<VlmVerifyResult> {
    if (!input.claims.length) throw new ProviderError('concentrate', 'bad_request', 'Nothing to verify');
    const image = await stageImage(input.image, this.runner.profile.image, VERIFY_MAX_DIMENSION);
    const result = await this.runner.run(
      {
        system: VLM_VERIFY_SYSTEM_PROMPT,
        content: [
          { type: 'text', text: buildVlmVerifyUserText(input) },
          {
            type: 'image',
            mediaType: 'image/jpeg',
            base64: Buffer.from(image.bytes).toString('base64'),
            width: image.width,
            height: image.height,
          },
        ],
        schema: VlmVerification,
        schemaName: VERIFY_READING_VERSION.schema,
      },
      options,
    );
    return { verification: result.data, model: result.model, durationMs: result.durationMs, usage: result.usage };
  }
}

export class ConcentrateTextModel implements TextModelProvider {
  readonly id: string;
  constructor(readonly runner: StructuredResponseRunner) {
    if (runner.profile.role === 'vision_similarity')
      throw new Error('The visual similarity role is served by ConcentrateVisualSimilarity');
    if (runner.profile.role === 'vision_connection_asset')
      throw new Error('The connection asset role is served only by ConcentrateConnectionAsset');
    this.id = `text:concentrate:${runner.profile.model}`;
  }
  capability(): CapabilityEntry {
    return this.runner.capability();
  }
  async generateStructured<T extends z.ZodType>(
    request: StructuredRequest<T>,
    options?: CallOptions,
  ): Promise<StructuredResult<z.infer<T>>> {
    return this.runner.run(
      {
        system: request.system,
        content: [{ type: 'text', text: request.prompt }],
        schemaName: request.schemaName,
        schema: request.schema,
        maxOutputTokens: request.maxTokens,
      },
      options,
    );
  }
}

export interface TimestampedFrame {
  derivativeId: string;
  timestampMs: number;
  image: VlmAnalyzeInput['image'];
}
/** Already prepared/owned frame derivatives, never original video or model-invented timestamps. */
export async function analyzeVideoFrames(
  provider: VlmProvider,
  frames: readonly TimestampedFrame[],
  durationMs: number,
  options: CallOptions,
): Promise<{
  status: 'complete' | 'partial' | 'failed';
  frames: Array<{
    derivativeId: string;
    timestampMs: number;
    result?: VlmResult;
    error?: string;
  }>;
}> {
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    frames.length === 0 ||
    frames.length > 8 ||
    new Set(frames.map((f) => f.derivativeId)).size !== frames.length ||
    frames.some(
      (f, i) =>
        !f.derivativeId ||
        !Number.isSafeInteger(f.timestampMs) ||
        f.timestampMs < 0 ||
        f.timestampMs > durationMs ||
        (i > 0 && f.timestampMs <= frames[i - 1]!.timestampMs),
    )
  ) {
    throw new ProviderError(
      'model-gateway',
      'bad_request',
      'Video requires up to eight ordered timestamped frames',
    );
  }
  if (!options.modelIdentity)
    throw new ProviderError(
      'model-gateway',
      'bad_request',
      'Verified video analysis identity required',
    );
  const results: Array<{
    derivativeId: string;
    timestampMs: number;
    result?: VlmResult;
    error?: string;
  }> = [];
  const deadline = Date.now() + Math.min(options.timeoutMs ?? 180_000, 180_000);
  for (const frame of frames) {
    if (options.signal?.aborted)
      throw new ProviderError('model-gateway', 'aborted', 'Video analysis cancelled');
    if (Date.now() >= deadline) {
      results.push({
        derivativeId: frame.derivativeId,
        timestampMs: frame.timestampMs,
        error: 'timeout',
      });
      continue;
    }
    try {
      const result = await provider.analyzeImage(
        { image: frame.image },
        {
          ...options,
          timeoutMs: Math.min(30_000, deadline - Date.now()),
          modelIdentity: {
            ...options.modelIdentity,
            attemptKey: `${options.modelIdentity.attemptKey}:frame:${frame.derivativeId}`,
          },
        },
      );
      results.push({ derivativeId: frame.derivativeId, timestampMs: frame.timestampMs, result });
    } catch (error) {
      if (options.signal?.aborted || (error instanceof ProviderError && error.kind === 'aborted'))
        throw new ProviderError('model-gateway', 'aborted', 'Video analysis cancelled');
      results.push({
        derivativeId: frame.derivativeId,
        timestampMs: frame.timestampMs,
        error: error instanceof ProviderError ? error.kind : 'unavailable',
      });
    }
  }
  const succeeded = results.filter((f) => f.result).length;
  return {
    status: succeeded === frames.length ? 'complete' : succeeded ? 'partial' : 'failed',
    frames: results,
  };
}
