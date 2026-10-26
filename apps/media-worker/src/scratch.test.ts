import type { PathLike, RmOptions } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanStaleScratch, removeScratchDir, withScratch } from './scratch';

/**
 * `rm` is wrapped so a test can make a removal fail the way a live writer does
 * (ENOTEMPTY). The mock is file-wide, which is why these tests live here rather than
 * in worker.test.ts / media.test.ts: those suites use real recursive removal all over
 * and a leaked mock would corrupt them.
 */
const fault = vi.hoisted(() => ({ path: '', code: 'ENOTEMPTY', failures: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    rm: async (path: PathLike, options?: RmOptions) => {
      if (fault.failures > 0 && String(path) === fault.path) {
        fault.failures--;
        throw Object.assign(new Error(`simulated ${fault.code}`), { code: fault.code });
      }
      return actual.rm(path, options);
    },
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-scratch-'));
  fault.path = '';
  fault.code = 'ENOTEMPTY';
  fault.failures = 0;
});
afterEach(async () => {
  fault.failures = 0;
  await rm(root, { recursive: true, force: true });
});

async function staleJob(name = 'job-stale'): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'part-1'), 'bytes');
  return dir;
}

/** Sweep from a moment after the directory was written, so it is unambiguously stale. */
const sweep = () => cleanStaleScratch(root, 0, Date.now() + 60_000);

describe('scratch removal tolerates a leftover that cannot be emptied in one pass', () => {
  it('retries past ENOTEMPTY and still counts the stale directory as removed', async () => {
    const dir = await staleJob();
    fault.path = dir;
    fault.failures = 1; // one racing writer, then quiet
    expect(await sweep()).toBe(1);
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });

  it('never throws when a directory stays busy, and the next sweep reaps it', async () => {
    const dir = await staleJob();
    fault.path = dir;
    fault.failures = 99; // every attempt fails
    await expect(sweep()).resolves.toBe(0); // worker startup survives
    fault.failures = 0;
    expect(await sweep()).toBe(1);
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });

  it('keeps the attempt result when its own cleanup hits ENOTEMPTY', async () => {
    const scratch = join(root, 'scratch');
    const result = await withScratch(scratch, async (dir) => {
      fault.path = dir;
      fault.failures = 1;
      await writeFile(join(dir, 'frames'), 'bytes');
      return 'prepared';
    });
    expect(result).toBe('prepared');
    expect(await readdir(scratch)).toEqual([]);
  });

  it('does not throw on a non-retryable removal error', async () => {
    const dir = await staleJob();
    fault.path = dir;
    fault.code = 'EACCES';
    fault.failures = 99;
    await expect(sweep()).resolves.toBe(0);
    fault.failures = 0;
    expect(await removeScratchDir(dir)).toBe(true); // and a later attempt still succeeds
  });
});
