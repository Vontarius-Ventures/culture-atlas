import type { CapabilityEntry } from '../capabilities';
import type { ObjectStorage, StoredObject } from '../storage/types';

/** In-memory ObjectStorage for tests and STORAGE_DRIVER=memory. Not persistent. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly driver = 'memory' as const;
  readonly objects = new Map<string, StoredObject>();
  constructor(private readonly baseUrl = 'http://localhost:3000') {}

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
    let n = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        n++;
      }
    }
    return n;
  }
  async signedUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + (options?.expiresInSeconds ?? 300);
    return `${this.baseUrl}/v1/media?key=${encodeURIComponent(key)}&exp=${exp}&sig=memory`;
  }
}
