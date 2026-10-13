import type { ServiceContext } from '../context';
import { notImplemented } from '../errors';
import type {
  CaptureResponse,
  CreateCaptureJsonRequest,
  CreateCaptureMultipartFields,
  CreateCaptureResponse,
} from '../schemas/captures';
import type { UploadResponse } from '../schemas/uploads';

/**
 * Capture Intake module.
 * Owner + grant rules: captures:write to create; selected-collection agents may
 * only read captures in granted collections or uploads created by that
 * connection; sensor_bridge tokens may only create captures for their own
 * sensor connection (dedupe connection_id + asset_id via sensor_imports).
 */

export interface UploadInput {
  bytes: Uint8Array;
  filename?: string;
  declaredContentType?: string;
}

export type CreateCaptureInput =
  | { kind: 'multipart'; image: UploadInput; fields: CreateCaptureMultipartFields }
  | { kind: 'json'; body: CreateCaptureJsonRequest };

/**
 * POST /v1/uploads — validate + normalize bytes (media/image.ts), store the
 * derivative privately, create an `uploads` row (expires in 24h).
 * TODO(captures owner): implement.
 */
export async function createUpload(ctx: ServiceContext, input: UploadInput): Promise<UploadResponse> {
  void ctx;
  void input;
  notImplemented('captures.createUpload');
}

/**
 * POST /v1/captures — create the capture (+ its DiscoveryItem kind=capture,
 * canonical_key "capture:<id>"), enqueue `analyze_capture` with
 * analysisDedupeKey(owner, sha256, focus, COMPILER_VERSION) and return 202.
 * Same input reuses the existing capture/job (reused: true). Enforce
 * anonymous/account daily analysis quotas (429 quota_exceeded).
 * Uploading never changes taste.
 * TODO(captures owner): implement.
 */
export async function createCapture(ctx: ServiceContext, input: CreateCaptureInput): Promise<CreateCaptureResponse> {
  void ctx;
  void input;
  notImplemented('captures.createCapture');
}

/**
 * GET /v1/captures/{id} — active analysis summary, references and up to 12
 * recommendation cards (loadCards), available categories, active job id.
 * Not owned / not granted -> 404.
 * TODO(captures owner): implement.
 */
export async function getCapture(ctx: ServiceContext, input: { id: string }): Promise<CaptureResponse> {
  void ctx;
  void input;
  notImplemented('captures.getCapture');
}

/**
 * DELETE /v1/captures/{id} — privacy delete. Immediately: revoke image access
 * (delete objects), cancel unfinished jobs (cancelJobsForResult), remove
 * preference links, personal recommendations, the capture's saved item +
 * memberships and covers, dependent plans; recompute taste; mark deleted with
 * purge_after = now()+24h for the purge job. Selected-collection agents: 403.
 * TODO(captures owner): implement.
 */
export async function deleteCapture(ctx: ServiceContext, input: { id: string }): Promise<void> {
  void ctx;
  void input;
  notImplemented('captures.deleteCapture');
}
