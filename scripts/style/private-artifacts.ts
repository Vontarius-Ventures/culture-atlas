/** Shared local-only I/O. Never emits paths or parser/provider payloads in errors. */
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

export class LocalInputError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'LocalInputError';
  }
}
export function fail(code: string): never {
  throw new LocalInputError(code);
}
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const record = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : fail('invalid_record');
export const enumValue = <T extends string>(x: unknown, values: readonly T[]): T =>
  typeof x === 'string' && values.includes(x as T) ? (x as T) : fail('invalid_enum');
export const integer = (x: unknown, min: number, max: number): number =>
  Number.isSafeInteger(x) && Number(x) >= min && Number(x) <= max
    ? Number(x)
    : fail('invalid_integer');
export const token = (x: unknown): string =>
  typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(x) ? x : fail('invalid_token');
export const digest = (x: unknown): string =>
  typeof x === 'string' && /^[a-f0-9]{64}$/.test(x) ? x : fail('invalid_hash');

/** Reject symlink components, including ancestors; no lexical containment alone. */
export async function noSymlinks(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) fail('absolute_canonical_path_required');
  let current = parse(path).root;
  for (const component of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) fail('symlink_not_allowed');
  }
  if ((await realpath(path)) !== path) fail('noncanonical_path');
  return path;
}
export async function outsideGit(path: string) {
  let current = await noSymlinks(path);
  while (true) {
    try {
      await lstat(join(current, '.git'));
      fail('private_output_inside_git');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}
export async function privateDirectory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) fail('absolute_canonical_path_required');
  await outsideGit(dirname(path));
  await mkdir(path, { mode: 0o700 }); // exclusive, never reuse existing directory
  await noSymlinks(path);
}
export async function writeExclusive(path: string, value: string | Uint8Array) {
  await noSymlinks(dirname(path));
  const f = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await f.writeFile(value);
  } finally {
    await f.close();
  }
}
export async function readBytes(path: string, max: number): Promise<Buffer> {
  await noSymlinks(path);
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.size > max) fail('input_limit_exceeded');
    const chunks: Buffer[] = [];
    let n = 0;
    while (true) {
      const b = Buffer.alloc(Math.min(65536, max + 1 - n));
      const { bytesRead } = await f.read(b);
      if (!bytesRead) break;
      n += bytesRead;
      if (n > max) fail('input_limit_exceeded');
      chunks.push(b.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally {
    await f.close();
  }
}
export async function readJson(path: string, max = 8 * 1024 * 1024): Promise<unknown> {
  const bytes = await readBytes(path, max);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return fail('invalid_json');
  }
}
interface SharpPipeline {
  metadata(): Promise<{ width?: number; height?: number; pages?: number; format?: string }>;
  rotate(): SharpPipeline;
  jpeg(options: { quality: number }): SharpPipeline;
  toBuffer(options: {
    resolveWithObject: true;
  }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
}
type SharpFactory = (
  bytes: Uint8Array,
  options: { limitInputPixels: number; failOn: string },
) => SharpPipeline;
// Use the domain's already installed, pinned decoder; no new package or network install.
const sharp = createRequire(new URL('../../packages/domain/package.json', import.meta.url))(
  'sharp',
) as SharpFactory;
export async function canonicalImage(bytes: Uint8Array) {
  const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning' });
  const meta = await image.metadata();
  if (
    !meta.width ||
    !meta.height ||
    meta.width > 8192 ||
    meta.height > 8192 ||
    meta.width * meta.height > 20_000_000 ||
    (meta.pages ?? 1) !== 1 ||
    !['jpeg', 'png', 'webp'].includes(meta.format ?? '')
  )
    fail('invalid_image');
  const result = await image.rotate().jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  if (result.data.length > 8_000_000) fail('image_limit_exceeded');
  return {
    bytes: result.data,
    width: result.info.width,
    height: result.info.height,
    hash: sha256(result.data),
  };
}
export function cliError(error: unknown): string {
  return error instanceof LocalInputError ? error.code : 'local_operation_failed';
}
