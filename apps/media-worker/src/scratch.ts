import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@culture-atlas/domain';

/**
 * Recursive removal can lose a race with a live writer: a second worker sharing the
 * scratch root, or an attempt whose bytes are still being flushed, leaves the directory
 * non-empty between our readdir and rmdir. `force` only silences ENOENT, so ENOTEMPTY
 * (and its EBUSY/EPERM siblings) used to escape as a hard failure.
 */
const RETRYABLE_REMOVE = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE']);

/** Empties a directory without caring what is in it; used before retrying a failed rm. */
async function clearScratchContents(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries.map((name) =>
      rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

/**
 * Best-effort scratch removal that never throws: a directory we cannot empty must not
 * fail an attempt or stop the worker from starting. Retryable failures clear the
 * contents and try again; anything still left behind is reaped by the periodic sweep.
 */
export async function removeScratchDir(path: string, attempts = 3): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true;
      if (!RETRYABLE_REMOVE.has(code ?? '')) return false;
      await clearScratchContents(path);
    }
  }
  return false;
}

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
    await removeScratchDir(dir);
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
    // A leftover we cannot remove is not worth failing startup over: the next sweep
    // retries it, and scratch is never a source of truth.
    if (info && now - info.mtimeMs >= olderThanMs && (await removeScratchDir(path))) removed++;
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
