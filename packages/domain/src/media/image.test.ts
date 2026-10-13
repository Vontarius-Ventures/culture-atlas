import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { normalizeImage, sniffImageType } from './image';

const LIMITS = { maxBytes: 15 * 1024 * 1024, maxPixels: 40_000_000, maxEdge: 2048 };

async function solid(width: number, height: number, format: 'jpeg' | 'png' | 'webp' | 'avif', options: { exif?: boolean } = {}) {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } });
  if (options.exif) {
    img = img.withMetadata({
      orientation: 6,
      exif: { IFD0: { Make: 'TestCam', Model: 'Unit' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 51/1 24/1', GPSLongitudeRef: 'E', GPSLongitude: '2/1 21/1 7/1' } },
    });
  }
  return new Uint8Array(await img.toFormat(format).toBuffer());
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof AppError ? err.code : 'other';
  }
}

describe('sniffImageType', () => {
  it('identifies accepted formats from magic bytes, not names', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('\0\0\0\x18ftypheic'))).toBe('image/heic');
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns='))).toBeNull();
  });
});

describe('normalizeImage', () => {
  it('applies EXIF orientation, strips metadata (incl. GPS) and hashes the original', async () => {
    const original = await solid(300, 200, 'jpeg', { exif: true });
    const before = await sharp(original).metadata();
    expect(before.exif).toBeDefined();
    const out = await normalizeImage(original, LIMITS);
    // Orientation 6 = rotate 90°: 300x200 becomes 200x300 upright.
    expect([out.width, out.height]).toEqual([200, 300]);
    const after = await sharp(out.derivative).metadata();
    expect(after.format).toBe('jpeg');
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(out.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(out.originalContentType).toBe('image/jpeg');
    expect(out.originalByteSize).toBe(original.byteLength);
  });

  it('bounds the derivative to the 2048 px long edge without enlarging small images', async () => {
    const big = await normalizeImage(await solid(4000, 1000, 'png'), LIMITS);
    expect([big.width, big.height]).toEqual([2048, 512]);
    const small = await normalizeImage(await solid(640, 480, 'webp'), LIMITS);
    expect([small.width, small.height]).toEqual([640, 480]);
  });

  it('is deterministic per input bytes (same hash for the same upload)', async () => {
    const bytes = await solid(50, 50, 'png');
    expect((await normalizeImage(bytes, LIMITS)).sha256).toBe((await normalizeImage(bytes, LIMITS)).sha256);
  });

  it('rejects oversize payloads, too many pixels, unknown/undecodable bytes, AVIF and undecodable HEIC', async () => {
    expect(await code(normalizeImage(await solid(100, 100, 'jpeg'), { ...LIMITS, maxBytes: 10 }))).toBe('payload_too_large');
    expect(await code(normalizeImage(await solid(100, 100, 'png'), { ...LIMITS, maxPixels: 5_000 }))).toBe('unsupported_image');
    expect(await code(normalizeImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), LIMITS))).toBe('unsupported_image');
    expect(await code(normalizeImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), LIMITS))).toBe('unsupported_image');
    expect(await code(normalizeImage(new Uint8Array(), LIMITS))).toBe('unsupported_image');
    expect(await code(normalizeImage(await solid(32, 32, 'avif'), LIMITS))).toBe('unsupported_image');
    const fakeHeic = new Uint8Array([...new TextEncoder().encode('\0\0\0\x18ftypheic\0\0\0\0mif1heic'), ...new Uint8Array(64)]);
    const err = await normalizeImage(fakeHeic, LIMITS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/Export the photo as JPEG/);
  });
});
