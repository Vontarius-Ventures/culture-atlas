import type { z } from 'zod';
import type { CallOptions } from '../errors';

export type ModelRole = 'vision_photo' | 'vision_video_frame' | 'research_text' | 'composer';
export interface ModelIdentity {
  accountId: string;
  jobId: string;
  attemptKey: string;
  assetId?: string;
  queueAttemptId?: string;
}

/** CaptureQueue contract seam, stable logical-stage idempotency survives lease renewal/retry. */
export function identityFromCaptureLease(
  lease: { account_id: string; job_id: string; attempt_id: string; asset_id: string | null },
  stageKey: string,
): ModelIdentity {
  return {
    accountId: lease.account_id,
    jobId: lease.job_id,
    queueAttemptId: lease.attempt_id,
    assetId: lease.asset_id ?? undefined,
    attemptKey: stageKey,
  };
}
export type StructuredContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/jpeg'; base64: string; width: number; height: number };
export interface GatewayRequest {
  model: string;
  system: string;
  content: StructuredContent[];
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
}
export interface GatewayResponse {
  id: string | null;
  model: string | null;
  actualProvider: string | null;
  text: string;
  outcome: 'complete' | 'refusal' | 'incomplete' | 'error';
  usage: { inputTokens: number; outputTokens: number } | null;
}
/** One HTTP attempt, no retries, no Anthropic fields, tools, or gateway fallback. */
export type StructuredTransport = (
  request: GatewayRequest,
  options: { signal: AbortSignal },
) => Promise<GatewayResponse>;
export interface GatewayCall<T extends z.ZodType> {
  system: string;
  content: StructuredContent[];
  schemaName: string;
  schema: T;
  maxOutputTokens?: number;
  validate?: (data: z.infer<T>) => void;
}
export interface GatewayOptions extends CallOptions {
  /** Verified server-owned identity, never derived from model output. */
  modelIdentity?: ModelIdentity;
}
