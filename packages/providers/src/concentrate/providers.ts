import sharp, { type Metadata } from 'sharp';
import type { z } from 'zod';
import type { CapabilityEntry } from '../capabilities';
import { ProviderError, type CallOptions } from '../errors';
import type { StructuredResponseRunner } from '../model-gateway/runner';
import type { StructuredRequest, StructuredResult, TextModelProvider } from '../text/types';
import { VLM_SYSTEM_PROMPT, buildVlmUserText } from '../vlm/prompt';
import { VlmAnalysis, type VlmAnalyzeInput, type VlmProvider, type VlmResult } from '../vlm/types';

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
  constructor(readonly runner: StructuredResponseRunner) {
    this.id = `vlm:concentrate:${runner.profile.model}`;
  }
  capability(): CapabilityEntry {
    return this.runner.capability();
  }
  async analyzeImage(input: VlmAnalyzeInput, options?: CallOptions): Promise<VlmResult> {
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
        schema: VlmAnalysis,
        schemaName: 'atlas_observations_v2',
        validate: (analysis) => validateVision(analysis, max),
      },
      options,
    );
    return {
      analysis: result.data,
      model: result.model,
      durationMs: result.durationMs,
      usage: result.usage,
    };
  }
}

export class ConcentrateTextModel implements TextModelProvider {
  readonly id: string;
  constructor(readonly runner: StructuredResponseRunner) {
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
