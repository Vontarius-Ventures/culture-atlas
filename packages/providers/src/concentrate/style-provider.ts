import sharp from 'sharp';
import type { CapabilityEntry } from '../capabilities';
import { ProviderError, type CallOptions } from '../errors';
import type { StructuredResponseRunner } from '../model-gateway/runner';
import {
  STYLE_MAX_DIMENSION,
  STYLE_MAX_OUTPUT_TOKENS,
  VLM_STYLE_SYSTEM_PROMPT,
  VlmStyleWireSchema,
  buildVlmStyleUserText,
  normalizeStyleReading,
  STYLE_READING_SCHEMA,
  type VlmStyleInput,
  type VlmStyleReader,
  type VlmStyleResult,
} from '../vlm/style';
import { boundJpegForProfile } from './image';

/** Largest derivative accepted for re-bounding to the style image size. */
const MAX_STYLE_INPUT_BYTES = 16 * 1024 * 1024;

/**
 * The style reading (role vision_style, profile style-1): one strict
 * structured-output call on the photo bounded to 1024 px (STYLE_MAX_DIMENSION,
 * further capped by the profile), with the measured swatches and the closed
 * tag vocabulary as DATA. A `length` stop surfaces as incomplete_response
 * (a failed call); the runner settles spend and owns the single retry.
 */
export class ConcentrateVlmStyleReader implements VlmStyleReader {
  readonly id: string;
  constructor(readonly runner: StructuredResponseRunner) {
    if (runner.profile.role !== 'vision_style') throw new Error('ConcentrateVlmStyleReader requires the vision_style role');
    this.id = `vlm-style:concentrate:${runner.profile.model}`;
  }
  capability(): CapabilityEntry {
    return this.runner.capability();
  }
  async readStyle(input: VlmStyleInput, options?: CallOptions): Promise<VlmStyleResult> {
    if (input.image.mediaType !== 'image/jpeg' || input.image.bytes.length > MAX_STYLE_INPUT_BYTES)
      throw new ProviderError('concentrate', 'bad_request', 'Style reading requires a bounded normalized JPEG derivative');
    const limits = { ...this.runner.profile.image, maxDimension: Math.min(this.runner.profile.image.maxDimension, STYLE_MAX_DIMENSION) };
    let image: { bytes: Uint8Array; width: number; height: number };
    try {
      const meta = await sharp(input.image.bytes, { limitInputPixels: 100_000_000 }).metadata();
      const swapped = (meta.orientation ?? 1) >= 5;
      image =
        meta.format === 'jpeg' && meta.width && meta.height && !swapped && input.image.bytes.length <= limits.maxBytes && meta.width * meta.height <= limits.maxPixels && Math.max(meta.width, meta.height) <= limits.maxDimension
          ? { bytes: input.image.bytes, width: meta.width, height: meta.height }
          : await boundJpegForProfile(input.image.bytes, limits);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('concentrate', 'bad_request', 'Invalid normalized image');
    }
    const result = await this.runner.run(
      {
        system: VLM_STYLE_SYSTEM_PROMPT,
        content: [
          { type: 'text', text: buildVlmStyleUserText(input) },
          { type: 'image', mediaType: 'image/jpeg', base64: Buffer.from(image.bytes).toString('base64'), width: image.width, height: image.height },
        ],
        schema: VlmStyleWireSchema,
        schemaName: STYLE_READING_SCHEMA,
        maxOutputTokens: STYLE_MAX_OUTPUT_TOKENS,
      },
      options,
    );
    return {
      reading: normalizeStyleReading(result.data, input.swatches.length),
      model: result.model,
      durationMs: result.durationMs,
      usage: result.usage,
      image: { width: image.width, height: image.height },
    };
  }
}
