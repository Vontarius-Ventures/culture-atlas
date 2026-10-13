import type { CapabilityEntry } from '../capabilities';
import { buildSignedMediaUrl, verifySignedMedia, type MediaVerification } from '../storage/signing';
import type { ObjectStorage, StoredObject } from '../storage/types';

/** In-memory ObjectStorage for tests and STORAGE_DRIVER=memory. Not persistent. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly driver = 'memory' as const;
  readonly objects = new Map<string, StoredObject>();
  constructor(
    private readonly baseUrl = 'http://localhost:3000',
    private readonly secret = 'memory-storage-test-secret',
  ) {}

  capability(): { objects: CapabilityEntry; signedUrls: CapabilityEntry } {
    const ok: CapabilityEntry = { status: 'available', provider: 'memory' };
    return { objects: ok, signedUrls: ok };
  }
  async put(key: string, body: Uint8Array, options: { contentType: string }): Promise<void> {
    this.objects.set(key, { body: new Uint8Array(body), contentType: options.contentType });
  }
  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async deletePrefix(prefix: string): Promise<number> {
    const clean = prefix.replace(/\/+$/, '') + '/';
    let n = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(clean)) {
        this.objects.delete(key);
        n++;
      }
    }
    return n;
  }
  async signedUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string> {
    return buildSignedMediaUrl(this.baseUrl, this.secret, key, options?.expiresInSeconds ?? 300);
  }
  verifySignedRequest(params: URLSearchParams, nowMs?: number): MediaVerification {
    return verifySignedMedia(this.secret, params, nowMs);
  }
}
