import { ProviderError } from '../errors';
import type { StructuredResponseRunner } from '../model-gateway/runner';
import type { GatewayOptions } from '../model-gateway/types';
import { profileHash } from '../concentrate/profiles';
import { buildVisualContactSheet, visualImageSha256 } from './contact-sheet';
import {
  VISUAL_SIMILARITY_MAX_OUTPUT_TOKENS, VISUAL_SIMILARITY_PROMPT_VERSION,
  VISUAL_SIMILARITY_SCHEMA_VERSION, VISUAL_SIMILARITY_SYSTEM_PROMPT,
  VisualSimilarityWireSchema, validateVisualSimilarity,
} from './schema';
import type { VisualSimilarityProvider, VisualSimilarityRequest, VisualSimilarityResult } from './types';
import { diagnoseVisualSimilarityShape } from './shape-diagnostics';

export class UnavailableVisualSimilarity implements VisualSimilarityProvider {
  isConfigured(): boolean { return false; }
  async compare(): Promise<never> {
    throw new ProviderError('visual-similarity', 'unavailable', 'Visual comparison is not configured');
  }
}

export class ConcentrateVisualSimilarity implements VisualSimilarityProvider {
  constructor(readonly runner: StructuredResponseRunner, readonly experimental = false) {
    if (runner.profile.role !== 'vision_similarity' ||
        runner.profile.promptVersion !== VISUAL_SIMILARITY_PROMPT_VERSION ||
        runner.profile.schemaVersion !== VISUAL_SIMILARITY_SCHEMA_VERSION)
      throw new Error('Visual comparison requires its own current role, prompt and schema');
  }
  isConfigured(): boolean { return true; }
  async compare(input: VisualSimilarityRequest, options: GatewayOptions): Promise<VisualSimilarityResult> {
    const started = Date.now();
    const check = () => {
      if (options.signal?.aborted) throw new ProviderError('visual-similarity', 'aborted', 'Visual comparison cancelled');
      if (Date.now() - started >= timeout) throw new ProviderError('visual-similarity', 'timeout', 'Visual comparison deadline reached');
    };
    const timeout = Math.min(options.timeoutMs ?? this.runner.profile.timeoutMs, this.runner.profile.timeoutMs);
    if (!options.modelIdentity?.accountId || !options.modelIdentity.jobId || !options.modelIdentity.attemptKey)
      throw new ProviderError('visual-similarity', 'bad_request', 'Verified comparison identity required');
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new ProviderError('visual-similarity', 'bad_request', 'Invalid comparison deadline');
    check();
    const subjectLabel = input.subjectLabel;
    const candidateLabel = input.candidateLabel;
    for (const label of [subjectLabel, candidateLabel])
      if (typeof label !== 'string' || !label.trim() || label.length > 160 ||
          [...label].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
        throw new ProviderError('visual-similarity', 'bad_request', 'Invalid comparison labels');
    if ([input.sourceImage, input.candidateImage].some((bytes) =>
      !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 16 * 1024 * 1024))
      throw new ProviderError('visual-similarity', 'bad_request', 'Invalid comparison image size');
    const modelIdentity = { ...options.modelIdentity };
    // Snapshot mutable caller bytes/region before async processing and hashing.
    const sheet = await buildVisualContactSheet({
      ...input, sourceImage: Buffer.from(input.sourceImage), candidateImage: Buffer.from(input.candidateImage),
      sourceRegion: { ...input.sourceRegion },
    }, this.runner.profile.image);
    check();
    const text = 'UNTRUSTED_LABEL_DATA_JSON: ' + JSON.stringify({
      sourceLabel: subjectLabel, candidateLabel,
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    const binding = visualImageSha256(Buffer.from(JSON.stringify({
      source: sheet.sourceImageSha256, candidate: sheet.candidateImageSha256,
      region: sheet.sourceRegion, sheet: sheet.contactSheetSha256,
      labels: text, profile: profileHash(this.runner.profile),
      attemptKey: modelIdentity.attemptKey,
    })));
    const result = await this.runner.run({
      system: VISUAL_SIMILARITY_SYSTEM_PROMPT,
      content: [
        { type: 'text', text },
        { type: 'image', mediaType: 'image/jpeg', base64: sheet.bytes.toString('base64'), width: sheet.width, height: sheet.height },
      ],
      schema: VisualSimilarityWireSchema, schemaName: VISUAL_SIMILARITY_SCHEMA_VERSION,
      validate: validateVisualSimilarity, maxOutputTokens: VISUAL_SIMILARITY_MAX_OUTPUT_TOKENS,
      diagnoseShape: diagnoseVisualSimilarityShape,
    }, {
      ...options, maxRetries: 0, timeoutMs: timeout - (Date.now() - started),
      modelIdentity: { ...modelIdentity, attemptKey: `visual:${binding}` },
    });
    check();
    return {
      ...result.data,
      sourceImageSha256: sheet.sourceImageSha256, candidateImageSha256: sheet.candidateImageSha256,
      contactSheetSha256: sheet.contactSheetSha256, sourceRegion: sheet.sourceRegion,
      model: result.model, profileVersion: this.runner.profile.version,
      schemaVersion: VISUAL_SIMILARITY_SCHEMA_VERSION, experimental: this.experimental,
    };
  }
}
