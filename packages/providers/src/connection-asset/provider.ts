import type { StructuredResponseRunner } from '../model-gateway/runner';
import { profileHash } from '../concentrate/profiles';
import type { ConnectionAssetCheckContext, ConnectionAssetProvider } from './types';
import {
  CONNECTION_ASSET_CHECKER_VERSION, CONNECTION_ASSET_MAX_OUTPUT_TOKENS,
  CONNECTION_ASSET_PROMPT_VERSION, CONNECTION_ASSET_SCHEMA_VERSION, CONNECTION_ASSET_SYSTEM_PROMPT,
  ConnectionAssetMetadataSchema, ConnectionAssetWireSchema, ConnectionAssetEvidenceSchema,
  validateConnectionAssetVerdict, type ConnectionAssetEvidence, type ConnectionAssetMetadata,
} from './schema';
import { safeConnectionAssetUrl, prepareConnectionAssetImage, connectionAssetSha256 } from './image';
import {
  allocateConnectionAssetSlot, assertConnectionAssetCheckActive, acquireConnectionAssetImage,
  finishConnectionAssetSlot, stopConnectionAssetAcquisition,
  assertConnectionAssetReadingSnapshot,
} from './store';

export class UnavailableConnectionAsset implements ConnectionAssetProvider {
  isConfigured(): boolean { return false; }
  async checkConnectionAsset(): Promise<null> { return null; }
}
/** Single candidate only. No source/candidate similarity adapter or fallback. */
export class ConcentrateConnectionAsset implements ConnectionAssetProvider {
  constructor(readonly runner: StructuredResponseRunner, readonly maxChecksPerCapture = 0) {
    const p = runner.profile;
    if (p.role !== 'vision_connection_asset' || p.promptVersion !== CONNECTION_ASSET_PROMPT_VERSION ||
        p.schemaVersion !== CONNECTION_ASSET_SCHEMA_VERSION || p.timeoutMs > 15_000 ||
        p.maxOutputTokens > 400 || p.image.maxCount !== 1 || p.image.maxBytes > 200_000 ||
        p.image.maxDimension > 512 || p.image.maxPixels > 262_144 ||
        !Number.isInteger(maxChecksPerCapture) || maxChecksPerCapture < 0 || maxChecksPerCapture > 3)
      throw new Error('Connection asset role requires its independent bounded profile');
  }
  isConfigured(): boolean { return this.maxChecksPerCapture > 0 && this.runner.ledger.store.durable; }
  async checkConnectionAsset(
    candidateMetadata: ConnectionAssetMetadata, imageUrl: string, context: ConnectionAssetCheckContext,
  ): Promise<ConnectionAssetEvidence | null> {
    let allocated: Awaited<ReturnType<typeof allocateConnectionAssetSlot>> = null;
    let requestBinding = '';
    try {
      if (!this.isConfigured() || context.db.inTransaction || context.signal.aborted ||
          !context.captureId || !context.analysisId || !context.accountId || !context.jobId || !context.workerId ||
          !safeConnectionAssetUrl(imageUrl)) return null;
      const expected = context.expectedImageBinding;
      if (expected !== undefined && (!expected || Array.isArray(expected) ||
          Object.keys(expected).sort().join(',') !== 'modelInputSha256,originalSha256' ||
          !/^[a-f0-9]{64}$/.test(expected.originalSha256) ||
          !/^[a-f0-9]{64}$/.test(expected.modelInputSha256))) return null;
      const expectedHashes = expected ? { ...expected } : null;
      // Private stored reading is ONLY a local SQL fence, not candidate metadata
      // or requestBinding. Exact candidate evidence remains source-independent.
      assertConnectionAssetReadingSnapshot(context.readingSnapshot);
      const metadata = ConnectionAssetMetadataSchema.parse(candidateMetadata);
      await assertConnectionAssetCheckActive(context.db, context);
      const text = 'UNTRUSTED_PUBLIC_CANDIDATE_METADATA_JSON: ' +
        JSON.stringify(metadata).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
      requestBinding = connectionAssetSha256(JSON.stringify({
        metadata, imageUrl, prompt: CONNECTION_ASSET_PROMPT_VERSION, profile: profileHash(this.runner.profile),
      }));
      allocated = await allocateConnectionAssetSlot(context, metadata.candidateId, imageUrl, requestBinding, this.maxChecksPerCapture);
      if (!allocated) return null;
      const original = await acquireConnectionAssetImage(context, imageUrl);
      if (!original) throw new Error('Asset unavailable');
      const prepared = await prepareConnectionAssetImage(original);
      if (expectedHashes && (prepared.originalSha256 !== expectedHashes.originalSha256 ||
          prepared.modelInputSha256 !== expectedHashes.modelInputSha256)) throw new Error('Frozen asset input changed');
      if (prepared.bytes.length > this.runner.profile.image.maxBytes ||
          prepared.width * prepared.height > this.runner.profile.image.maxPixels ||
          Math.max(prepared.width, prepared.height) > this.runner.profile.image.maxDimension) throw new Error('Profile image bound');
      await assertConnectionAssetCheckActive(context.db, context);
      if (!allocated.fresh) {
        // URL is not immutable: re-acquire and verify BOTH hashes before exact cache reuse.
        const cached = ConnectionAssetEvidenceSchema.parse(allocated.slot.evidence);
        return cached.candidateId === metadata.candidateId && cached.imageUrl === imageUrl &&
          cached.originalSha256 === prepared.originalSha256 && cached.modelInputSha256 === prepared.modelInputSha256 ? cached : null;
      }
      const timeout = Math.min(15_000, this.runner.profile.timeoutMs);
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]);
      const binding = connectionAssetSha256(JSON.stringify({
        requestBinding, original: prepared.originalSha256, input: prepared.modelInputSha256,
      }));
      const result = await this.runner.run({
        system: CONNECTION_ASSET_SYSTEM_PROMPT,
        content: [
          { type: 'text', text },
          { type: 'image', mediaType: 'image/jpeg', base64: prepared.bytes.toString('base64'),
            width: prepared.width, height: prepared.height },
        ],
        schema: ConnectionAssetWireSchema, schemaName: CONNECTION_ASSET_SCHEMA_VERSION,
        maxOutputTokens: CONNECTION_ASSET_MAX_OUTPUT_TOKENS, validate: validateConnectionAssetVerdict,
      }, {
        signal, timeoutMs: timeout, maxRetries: 0, budget: context.budget, traceId: context.traceId,
        beforeDispatch: () => assertConnectionAssetCheckActive(context.db, context),
        modelIdentity: { accountId: context.accountId, jobId: context.jobId,
          attemptKey: `connection-asset:${context.captureId}:${allocated.slot.slot}:${binding}` },
      });
      if (signal.aborted) throw new Error('Asset check cancelled');
      await assertConnectionAssetCheckActive(context.db, context);
      const evidence = ConnectionAssetEvidenceSchema.parse({
        version: 'connection_asset_evidence_v1', candidateId: metadata.candidateId, imageUrl,
        originalSha256: prepared.originalSha256, modelInputSha256: prepared.modelInputSha256,
        identity: result.data.identity, image: result.data.image, checkerVersion: CONNECTION_ASSET_CHECKER_VERSION,
      });
      if (!await finishConnectionAssetSlot(context, allocated.slot.slot, requestBinding, evidence)) return null;
      await assertConnectionAssetCheckActive(context.db, context);
      return evidence;
    } catch (error) {
      // No raw model/network/DB error bodies or messages escape into compiler evidence.
      const status = (error as { status?: number } | null)?.status;
      if (status) await stopConnectionAssetAcquisition(context.db, status).catch(() => undefined);
      if (allocated?.fresh)
        await finishConnectionAssetSlot(context, allocated.slot.slot, requestBinding, null).catch(() => undefined);
      return null;
    }
  }
}
