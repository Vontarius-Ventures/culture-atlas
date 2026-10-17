import type { Db, Queryable } from '../db/pool';
import type { MultipartStorage } from '@culture-atlas/providers';

export interface InstallationAuthority {
  kind: 'installation';
  accountId: string;
  installationId: string;
  sessionId: string;
  expiresAt: Date;
}
export type CaptureAuthority =
  { kind: 'account'; accountId: string; sessionId: string | null } | InstallationAuthority;

export interface CaptureLimits {
  photoMaxBytes: number;
  photoMaxPixels: number;
  videoMaxBytes: number;
  videoMaxDurationMs: number;
  captureVideoMaxDurationMs: number;
  accountQuotaBytes: number;
  derivativeAllowanceBytes: number;
}
export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  photoMaxBytes: 15728640,
  photoMaxPixels: 40000000,
  videoMaxBytes: 262144000,
  videoMaxDurationMs: 120000,
  captureVideoMaxDurationMs: 60000,
  accountQuotaBytes: 5368709120,
  derivativeAllowanceBytes: 33554432,
};
export interface VerifiedMedia {
  contentType: string;
  width: number;
  height: number;
  durationMs?: number;
  audioPresent?: boolean;
  container?: string;
  codecs?: string[];
}
export interface MediaVerificationInput {
  body: AsyncIterable<Uint8Array>;
  kind: 'photo' | 'video';
  contentType: string;
  byteSize: number;
  limits: CaptureLimits;
}
/** Verifier MUST fully consume the bounded stream and decode/probe actual content. */
export interface MediaVerifier {
  verify(input: MediaVerificationInput): Promise<VerifiedMedia>;
}
export interface CaptureIdentityAdapter {
  requireRecoverableAccount(accountId: string, sessionId: string | null): Promise<void>;
  consumeNativeEnrollmentGrant(
    tx: Db,
    token: string,
    platform: 'ios' | 'android',
    now: Date,
  ): Promise<{ accountId: string; authenticatedAt: Date }>;
  peekNativeEnrollmentGrant(
    tx: Db,
    token: string,
    platform: 'ios' | 'android',
    now: Date,
  ): Promise<{ accountId: string; authenticatedAt: Date }>;
  issueNativeSession(
    tx: Db,
    input: { accountId: string; installationId: string; authenticatedAt: Date },
    now: Date,
  ): Promise<{
    access_token: string;
    refresh_token: string;
    access_expires_at: string;
    [key: string]: unknown;
  }>;
  revokeInstallationSessions(
    tx: Db,
    accountId: string,
    installationId: string,
    now: Date,
  ): Promise<void>;
}
export interface CaptureV2Context {
  db: Db;
  authority: CaptureAuthority;
  storage: MultipartStorage;
  verifier: MediaVerifier;
  limits: CaptureLimits;
  now(): Date;
  /** Server-qualified intersection, not raw client flags. */
  glassesEnabled: boolean;
  mediaCreationEnabled: boolean;
  videoEnabled: boolean;
  identity?: CaptureIdentityAdapter;
  /** Set only by P5's live-authorized façade, never directly from client JSON. */
  agent?: { connectionId: string; authorizationVersion: number };
  agentAuthorization?: CaptureAgentAuthorization;
  /** Compatibility adapter retains the existing capture/collection/taste deletion rules. */
  deleteAnalysisCapture?: (tx: Db, accountId: string, captureId: string) => Promise<void>;
  readLegacyObject?: MultipartStorage['read'];
}
export interface AuthorityEnded {
  accountId: string;
  installationId: string | null;
  sessionId: string | null;
  reason: string;
  now: Date;
}
export type CaptureWorkKind =
  'verify_upload' | 'prepare_media' | 'purge_media' | 'cleanup_upload' | 'analyze_media';
export interface CaptureLease {
  job_id: string;
  account_id: string;
  asset_id: string | null;
  upload_id: string | null;
  analysis_id: string | null;
  created_by_agent_connection_id: string | null;
  authorization_version: number | null;
  generation: number;
  kind: CaptureWorkKind;
  attempt_id: string;
  lease_token: string;
  lease_expires_at: Date;
  attempts: number;
}
export interface PreparedDerivative {
  kind: 'normalized' | 'playback' | 'poster' | 'frame';
  /** Include a timestamp suffix for distinct frames, e.g. frames-v1:1500. */
  processingVersion: string;
  objectKey: string;
  checksum: string;
  byteSize: number;
  width: number;
  height: number;
  durationMs?: number;
  timestampMs?: number;
  /** True only for qualified metadata-stripped output; default false. */
  shareSafe?: boolean;
}
export interface PreparedMedia {
  derivatives: PreparedDerivative[];
  /** Exact effective frame timestamps, not requested approximations. */
  extractionVersion?: string;
}
export interface MediaPreparationInput {
  lease: CaptureLease;
  originalKey: string;
  media: VerifiedMedia & { kind: 'photo' | 'video'; byteSize: number };
  storage: MultipartStorage;
  /** Call before external work and before writing derivative bytes. Publish rechecks transactionally. */
  assertLive(): Promise<void>;
  /** Server-generated immutable key namespace, includes generation and attempt id. */
  derivativeKey(kind: PreparedDerivative['kind'], suffix?: string): string;
}
export interface MediaPreparer {
  prepare(input: MediaPreparationInput): Promise<PreparedMedia>;
}
/** P5 injects live grant checks at command creation and delivery, never cached scope expansion. */
export interface CaptureAgentAuthorization {
  authorize(
    db: Queryable,
    input: {
      accountId: string;
      connectionId: string;
      operation: CaptureAgentOperation;
      resourceId: string | null;
      authorizationVersion?: number;
    },
  ): Promise<{ authorizationVersion: number }>;
}
export type CaptureAgentOperation =
  | 'upload.create'
  | 'upload.read'
  | 'upload.part'
  | 'upload.complete'
  | 'upload.abort'
  | 'media.read'
  | 'media.download'
  | 'media.delete'
  | 'media.update'
  | 'media.prepare'
  | 'media.analyze'
  | 'analysis.read'
  | 'command.create'
  | 'command.claim';
