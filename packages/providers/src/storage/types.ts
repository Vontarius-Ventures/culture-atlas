import type { CapabilityEntry } from '../capabilities';
import type { MediaVerification } from './signing';

/**
 * Private object storage for images. Keys are opaque, e.g.
 * "captures/<owner>/<capture_id>/derivative.jpg". Links are short-lived.
 */
export interface StoredObject {
  body: Uint8Array;
  contentType: string;
}

export interface ObjectStorage {
  readonly driver: 'local' | 's3' | 'memory';
  capability(): { objects: CapabilityEntry; signedUrls: CapabilityEntry };
  put(key: string, body: Uint8Array, options: { contentType: string }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Removes every object under a prefix (capture deletion/purge). */
  deletePrefix(prefix: string): Promise<number>;
  /**
   * Short-lived URL. Local driver: `${APP_BASE_URL}/v1/media?...` HMAC-signed
   * and served by apps/web; S3 driver: presigned GET.
   */
  signedUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string>;
  /**
   * Drivers that sign /v1/media links (local, memory) verify them here;
   * S3 uses presigned URLs and does not implement it.
   */
  verifySignedRequest?(params: URLSearchParams, nowMs?: number): MediaVerification;
}
