import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, readdir, unlink, rmdir, copyFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  IncompleteUploadInfo,
  MultipartPart,
  MultipartStorage,
  StoredObjectInfo,
} from './multipart-types';
import { validateMediaRange, boundedMediaChunks } from './multipart-types';
import { isSafeObjectKey } from './signing';

/** Filesystem test double only. Durable bytes and multipart receipts, same boundary as S3. */
export class LocalMultipartStorage implements MultipartStorage {
  constructor(
    private readonly root: string,
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}
  private object(key: string): string {
    if (!isSafeObjectKey(key)) throw new Error('Invalid object key');
    return join(this.root, 'objects', key);
  }
  private upload(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid upload');
    return join(this.root, 'multipart', id);
  }
  private async metadata(
    id: string,
  ): Promise<{ key: string; contentType: string; closed: boolean }> {
    return JSON.parse(await readFile(join(this.upload(id), 'metadata.json'), 'utf8'));
  }
  async begin(key: string, contentType: string): Promise<string> {
    this.object(key);
    const id = randomUUID();
    await mkdir(this.upload(id), { recursive: true, mode: 0o700 });
    await writeFile(
      join(this.upload(id), 'metadata.json'),
      JSON.stringify({ key, contentType, closed: false }),
      { mode: 0o600 },
    );
    return id;
  }
  async signPart(key: string, id: string, part: number, expiresInSeconds: number, byteSize: number) {
    const m = await this.metadata(id);
    if (m.key !== key || m.closed) throw new Error('Upload closed');
    if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 8388608)
      throw new Error('Invalid part size');
    const expires = Math.floor(Date.now() / 1000) + Math.min(900, expiresInSeconds);
    const signature = createHmac('sha256', this.secret)
      .update(`${id}:${part}:${expires}:${byteSize}`)
      .digest('hex');
    return {
      part_number: part,
      method: 'PUT' as const,
      url: `${this.baseUrl}/v2/storage/parts/${id}/${part}?expires=${expires}&size=${byteSize}&signature=${signature}`,
      headers: {},
      expires_at: new Date(expires * 1000).toISOString(),
    };
  }
  async acceptSignedPart(
    id: string,
    part: number,
    expires: number,
    signature: string,
    body: AsyncIterable<Uint8Array>,
    byteSize: number,
  ): Promise<string> {
    const expected = Buffer.from(
      createHmac('sha256', this.secret)
        .update(`${id}:${part}:${expires}:${byteSize}`)
        .digest('hex'),
    );
    const got = Buffer.from(signature);
    if (
      !Number.isSafeInteger(byteSize) ||
      !Number.isInteger(expires) ||
      expires <= Date.now() / 1000 ||
      expires > Date.now() / 1000 + 901 ||
      expected.length !== got.length ||
      !timingSafeEqual(expected, got)
    )
      throw new Error('Part authorization expired');
    return this.writePart(id, part, body, byteSize);
  }
  /**
   * Test helper models provider PUT. Production callers use signed instructions.
   * With `exactBytes`, a body of any other length is refused (signed length).
   */
  async writePart(
    id: string,
    part: number,
    body: AsyncIterable<Uint8Array>,
    exactBytes?: number,
  ): Promise<string> {
    if (!Number.isInteger(part) || part < 1 || part > 10000) throw new Error('Invalid part');
    const m = await this.metadata(id);
    if (m.closed) throw new Error('Upload closed');
    let size = 0;
    const hash = createHash('sha256'),
      temp = join(this.upload(id), `${part}.${randomUUID()}.tmp`);
    async function* bounded() {
      for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > (exactBytes ?? 8388608)) throw new Error('Part too large');
        hash.update(chunk);
        yield chunk;
      }
    }
    try {
      await pipeline(
        Readable.from(bounded()),
        createWriteStream(temp, { mode: 0o600, flags: 'wx' }),
      );
      if (exactBytes !== undefined && size !== exactBytes) throw new Error('Part size mismatch');
      // A late PUT can only affect staging, never an immutable committed object.
      if ((await this.metadata(id)).closed) throw new Error('Upload closed');
      await copyFile(temp, join(this.upload(id), `${part}.part`));
      return `"${hash.digest('hex')}"`;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
  async listParts(key: string, id: string): Promise<MultipartPart[]> {
    const m = await this.metadata(id);
    if (m.key !== key) throw new Error('Upload mismatch');
    const files = await readdir(this.upload(id)),
      parts: MultipartPart[] = [];
    for (const name of files.filter((n) => /^\d+\.part$/.test(n))) {
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of createReadStream(join(this.upload(id), name))) {
        size += (chunk as Buffer).byteLength;
        hash.update(chunk);
      }
      parts.push({ part_number: Number(name.split('.')[0]), etag: `"${hash.digest('hex')}"`, size });
    }
    return parts.sort((a, b) => a.part_number - b.part_number);
  }
  async finish(key: string, id: string, parts: MultipartPart[]): Promise<void> {
    const m = await this.metadata(id);
    if (m.key !== key) throw new Error('Upload mismatch');
    if (m.closed) {
      await stat(this.object(key));
      return;
    }
    const found = await this.listParts(key, id);
    if (
      found.length !== parts.length ||
      found.some((p, i) => p.part_number !== parts[i]?.part_number || p.etag !== parts[i]?.etag)
    ) {
      throw new Error('Invalid part receipts');
    }
    const uploadDirectory = this.upload(id);
    async function* joined() {
      for (const part of parts)
        yield* createReadStream(join(uploadDirectory, `${part.part_number}.part`));
    }
    await this.put(key, joined(), m.contentType, 0);
    await writeFile(join(this.upload(id), 'metadata.json'), JSON.stringify({ ...m, closed: true }));
  }
  async abort(key: string, id: string): Promise<void> {
    const m = await this.metadata(id);
    if (m.key !== key) throw new Error('Upload mismatch');
    await writeFile(join(this.upload(id), 'metadata.json'), JSON.stringify({ ...m, closed: true }));
    for (const f of await readdir(this.upload(id))) {
      if (/^\d+\.part$/.test(f)) await unlink(join(this.upload(id), f));
    }
  }
  async read(key: string) {
    const path = this.object(key);
    const metadata = JSON.parse(await readFile(`${path}.json`, 'utf8')) as { contentType: string };
    return {
      body: createReadStream(path),
      byteSize: (await stat(path)).size,
      contentType: metadata.contentType,
    };
  }
  async getRange(key: string, range: { start: number; end: number }) {
    validateMediaRange(range);
    const path = this.object(key),
      size = (await stat(path)).size,
      end = Math.min(range.end, size - 1);
    if (range.start >= size) throw new Error('Media range outside object');
    const metadata = JSON.parse(await readFile(`${path}.json`, 'utf8')) as { contentType: string };
    return {
      body: boundedMediaChunks(
        createReadStream(path, { start: range.start, end, highWaterMark: 65536 }),
        end - range.start + 1,
      ),
      contentType: metadata.contentType,
      byteSize: end - range.start + 1,
      totalSize: size,
      start: range.start,
      end,
    };
  }
  async seal(stagingKey: string, immutableKey: string): Promise<void> {
    const from = this.object(stagingKey),
      to = this.object(immutableKey);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(from, to);
    await copyFile(`${from}.json`, `${to}.json`);
  }
  async put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
    _byteSize: number,
  ): Promise<void> {
    const path = this.object(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await pipeline(Readable.from(body), createWriteStream(path, { mode: 0o600 }));
    await writeFile(`${path}.json`, JSON.stringify({ contentType }), { mode: 0o600 });
  }
  async delete(key: string): Promise<void> {
    const path = this.object(key);
    await unlink(path).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await unlink(`${path}.json`).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  async deletePrefix(prefix: string): Promise<void> {
    const directory = this.object(prefix);
    const walk = async (path: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw e;
      }
      for (const entry of entries) {
        const child = join(path, entry.name);
        // A symlinked directory reports as a symlink here, never as a
        // directory: the link entry itself is removed, never followed.
        if (entry.isDirectory()) await walk(child);
        else await unlink(child);
      }
      // Post-order prune: an emptied namespace leaves no directory shells —
      // the requested prefix's own skeleton included. rmdir only ever removes
      // an empty directory; anything else (a file that could not be deleted,
      // an entry that appeared mid-walk) propagates so the caller keeps the
      // cleanup owed instead of claiming a false completion.
      await rmdir(path).catch((e) => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      });
    };
    await walk(directory);
  }
  async *list(prefix: string): AsyncIterable<StoredObjectInfo> {
    const base = join(this.root, 'objects');
    const start = this.object(prefix.replace(/\/+$/, ''));
    const walk = async function* (path: string): AsyncIterable<StoredObjectInfo> {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return;
        throw e;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) yield* walk(child);
        else if (entry.isFile() && !entry.name.endsWith('.json')) {
          const info = await stat(child);
          yield {
            key: relative(base, child).split(sep).join('/'),
            byteSize: info.size,
            lastModified: info.mtime,
          };
        }
      }
    };
    yield* walk(start);
  }
  async *listIncompleteUploads(prefix: string): AsyncIterable<IncompleteUploadInfo> {
    let ids: string[];
    try {
      ids = await readdir(join(this.root, 'multipart'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const id of ids.sort()) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const metadataPath = join(this.upload(id), 'metadata.json');
      let m: { key: string; closed: boolean };
      try {
        m = JSON.parse(await readFile(metadataPath, 'utf8'));
      } catch {
        continue;
      }
      if (m.closed || !m.key.startsWith(prefix)) continue;
      yield { key: m.key, uploadId: id, initiatedAt: (await stat(metadataPath)).mtime };
    }
  }
}
