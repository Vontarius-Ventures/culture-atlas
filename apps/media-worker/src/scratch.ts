import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@culture-atlas/domain';

/**
 * Disposable per-attempt scratch directories. Scratch never outlives its attempt;
 * startup removes anything a crashed process left behind. Nothing here is a
 * source of truth: durable bytes live only in private object storage.
 */
export async function withScratch<T>(root: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'job-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function cleanStaleScratch(root: string, olderThanMs: number, now = Date.now()) {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  for (const name of entries.filter((n) => n.startsWith('job-'))) {
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs >= olderThanMs) {
      await rm(path, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** Streams to disk with a hard byte cap; returns byte count and the first bytes for signature checks. */
export async function writeBounded(
  body: AsyncIterable<Uint8Array>,
  path: string,
  maxBytes: number,
): Promise<{ bytes: number; head: Buffer }> {
  let bytes = 0;
  const head: Buffer[] = [];
  let headBytes = 0;
  async function* bounded() {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new AppError('payload_too_large');
      if (headBytes < 64) {
        head.push(Buffer.from(chunk.subarray(0, 64 - headBytes)));
        headBytes += Math.min(64, chunk.byteLength);
      }
      yield chunk;
    }
  }
  await pipeline(Readable.from(bounded()), createWriteStream(path, { mode: 0o600, flags: 'wx' }));
  return { bytes, head: Buffer.concat(head).subarray(0, 64) };
}
