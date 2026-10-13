import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityEntry } from '../capabilities';
import { ProviderError } from '../errors';
import { buildSignedMediaUrl, isSafeObjectKey, verifySignedMedia, type MediaVerification } from './signing';
import type { ObjectStorage, StoredObject } from './types';

/**
 * Private local-filesystem storage (STORAGE_DRIVER=local). Objects live under
 * STORAGE_LOCAL_DIR; the content type is kept in a sidecar file. Links are
 * HMAC-signed /v1/media URLs that expire after SIGNED_URL_TTL_SECONDS.
 */
export class LocalFsStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly options: { baseUrl: string; secret: string; ttlSeconds: number; ephemeralSecret?: boolean },
  ) {
    this.root = path.resolve(rootDir);
  }

  capability(): { objects: CapabilityEntry; signedUrls: CapabilityEntry } {
    return {
      objects: { status: 'available', provider: 'local', detail: 'Local filesystem (single host)' },
      signedUrls: this.options.ephemeralSecret
        ? { status: 'degraded', reason: 'not_configured', provider: 'local', detail: 'STORAGE_SIGNING_SECRET unset: links are valid only in this process' }
        : { status: 'available', provider: 'local' },
    };
  }

  private pathFor(key: string): string {
    if (!isSafeObjectKey(key)) throw new ProviderError('storage', 'bad_request', 'invalid object key');
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new ProviderError('storage', 'bad_request', 'invalid object key');
    return full;
  }

  async put(key: string, body: Uint8Array, options: { contentType: string }): Promise<void> {
    const file = this.pathFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await writeFile(`${file}.meta`, JSON.stringify({ contentType: options.contentType }), { mode: 0o600 });
    await rename(tmp, file);
  }

  async get(key: string): Promise<StoredObject | null> {
    const file = this.pathFor(key);
    try {
      const [body, meta] = await Promise.all([readFile(file), readFile(`${file}.meta`, 'utf8').catch(() => '{}')]);
      const contentType = (JSON.parse(meta) as { contentType?: string }).contentType ?? 'application/octet-stream';
      return { body: new Uint8Array(body), contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const file = this.pathFor(key);
    await rm(file, { force: true });
    await rm(`${file}.meta`, { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const clean = prefix.replace(/\/+$/, '');
    if (!isSafeObjectKey(clean)) throw new ProviderError('storage', 'bad_request', 'invalid prefix');
    const dir = this.pathFor(clean);
    let count = 0;
    const walk = async (d: string) => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(d, e.name));
        else if (!e.name.endsWith('.meta') && !e.name.endsWith('.tmp')) count++;
      }
    };
    await walk(dir);
    await rm(dir, { recursive: true, force: true });
    return count;
  }

  async signedUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string> {
    if (!isSafeObjectKey(key)) throw new ProviderError('storage', 'bad_request', 'invalid object key');
    return buildSignedMediaUrl(this.options.baseUrl, this.options.secret, key, options?.expiresInSeconds ?? this.options.ttlSeconds);
  }

  verifySignedRequest(params: URLSearchParams, nowMs?: number): MediaVerification {
    return verifySignedMedia(this.options.secret, params, nowMs);
  }
}
