import type { z } from 'zod';
import type { CallOptions } from '../errors';
import type { StructuredResponseShapeIssue } from './diagnostics';

export type ModelRole =
  | 'vision_photo'
  | 'vision_video_frame'
  | 'research_text'
  | 'composer'
  /** Stage-2 background photo enrichment (spec amendment 2.2). */
  | 'vision_photo_enrich'
  /** Independent background verifier after stage 2 (docs/requalification-plan.md); off by default. */
  | 'vision_verify'
  /** Style reading (prp/2026-10-23-style-analysis §B.2), parallel to stage 1. */
  | 'vision_style'
  /** Independent bounded source/candidate contact-sheet comparison; no fallback. */
  | 'vision_similarity'
  /** Single public candidate image identity/availability; never source similarity. */
  | 'vision_connection_asset';
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
  /**
   * The qualified profile's reasoning effort. Present only when the profile
   * sets one; the transport then sends `reasoning.effort`, otherwise nothing.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
}
export interface GatewayResponse {
  /** Responses object id, when returned. */
  id: string | null;
  /** Gateway request id from a response header, when returned (never invented). */
  requestId?: string | null;
  model: string | null;
  actualProvider: string | null;
  text: string;
  outcome: 'complete' | 'refusal' | 'incomplete' | 'error';
  /** Null when the gateway omits usage or either count: unknown, never zero. */
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
  /** Local failure-only, content-free diagnostic. Never sent to the transport. */
  diagnoseShape?: (value: unknown) => readonly StructuredResponseShapeIssue[];
}
export interface GatewayOptions extends CallOptions {
  /** Server-owned last-moment lease/owner/cancellation fence, after durable reservation. */
  beforeDispatch?: () => Promise<void>;
  /** Verified server-owned identity, never derived from model output. */
  modelIdentity?: ModelIdentity;
}
