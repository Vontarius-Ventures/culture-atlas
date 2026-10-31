import type { GatewayDb } from '../model-gateway/postgres';
import type { GatewayOptions } from '../model-gateway/types';
import type { ConnectionAssetEvidence, ConnectionAssetMetadata } from './schema';

/** Pool-level DB only. No source image, source URL, cookies, or credentials accepted. */
export interface ConnectionAssetCheckContext {
  db: GatewayDb;
  captureId: string;
  analysisId: string;
  accountId: string;
  jobId: string;
  workerId: string;
  /** JSON.stringify(current guarded stored style reading). Local DB fence only;
   * never model content, request/cache identity, logs, or returned evidence. */
  readingSnapshot: string;
  /** Optional frozen evaluation inputs. Checked before any model dispatch;
   * neither these hashes nor a source photograph enter model content. */
  expectedImageBinding?: { originalSha256: string; modelInputSha256: string };
  signal: AbortSignal;
  ensureActive(): Promise<void>;
  /** Existing shared paid-call budget/tracing, never an alternate transport/identity. */
  budget?: GatewayOptions['budget'];
  traceId?: string;
}
export interface ConnectionAssetProvider {
  isConfigured(): boolean;
  checkConnectionAsset(
    candidateMetadata: ConnectionAssetMetadata,
    imageUrl: string,
    context: ConnectionAssetCheckContext,
  ): Promise<ConnectionAssetEvidence | null>;
}
