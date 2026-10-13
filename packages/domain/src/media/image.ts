import { createHash } from 'node:crypto';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { AppError } from '../errors';

/**
 * Image intake (build spec "Cultural compilation pipeline" step 1):
 * validate actual bytes (sniff magic numbers, ignore declared type), decode
 * safely with sharp (limitInputPixels = UPLOAD_MAX_PIXELS), apply EXIF
 * orientation, strip metadata (including location), and produce a JPEG
 * derivative bounded to IMAGE_MAX_EDGE (2048 px) long edge.
 * Accept JPEG, PNG, WebP; HEIC only when the decoder supports it. NOTE: the
 * prebuilt sharp/libvips used here decodes AVIF but NOT HEVC-based HEIC, so
 * HEIC is attempted and otherwise returns `unsupported_image` with conversion
 * guidance. AVIF is not in the spec's accepted list and is rejected.
 * Errors: payload_too_large (bytes > UPLOAD_MAX_BYTES), unsupported_image
 * (unknown format / undecodable / too many pixels).
 */

export type SniffedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/heif' | 'image/avif';

export interface NormalizedImage {
  /** JPEG derivative bytes (oriented, metadata stripped, <= maxEdge). */
  derivative: Uint8Array;
  derivativeContentType: 'image/jpeg';
  width: number;
  height: number;
  /** sha256 hex of the ORIGINAL bytes (dedupe/cache key). */
  sha256: string;
  originalContentType: SniffedType;
  originalByteSize: number;
}

export interface ImageLimits {
  maxBytes: number;
  maxPixels: number;
  maxEdge: number;
}

export const ACCEPTED_FORMATS_MESSAGE = 'Use a JPEG, PNG or WebP photo up to 15 MB.';
export const HEIC_GUIDANCE =
  'HEIC photos can’t be read here yet. Export the photo as JPEG (on iPhone: Settings › Camera › Formats › Most Compatible) and try again.';

/** Identify the image type from magic bytes; null when not an accepted image. */
export function sniffImageType(bytes: Uint8Array): SniffedType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (brand === 'mif1' || brand === 'msf1') return 'image/heif';
  }
  return null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function unsupported(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('unsupported_image', { message, details });
}

/**
 * Validates and normalizes an uploaded image. Never trusts the declared
 * content type or filename. The returned derivative carries no EXIF/XMP/ICC
 * metadata (so no GPS location) and is already rotated upright.
 */
export async function normalizeImage(bytes: Uint8Array, limits: ImageLimits): Promise<NormalizedImage> {
  if (bytes.byteLength === 0) throw unsupported(ACCEPTED_FORMATS_MESSAGE, { reason: 'empty' });
  if (bytes.byteLength > limits.maxBytes) {
    throw new AppError('payload_too_large', { details: { max_bytes: limits.maxBytes } });
  }
  const type = sniffImageType(bytes);
  if (!type) throw unsupported(ACCEPTED_FORMATS_MESSAGE, { reason: 'unknown_format' });
  if (type === 'image/avif') throw unsupported(ACCEPTED_FORMATS_MESSAGE, { reason: 'format_not_accepted', format: 'avif' });
  const isHeic = type === 'image/heic' || type === 'image/heif';

  let meta: Metadata;
  try {
    // Header-only read; no pixel decode yet.
    meta = await sharp(bytes, { failOn: 'error', limitInputPixels: false }).metadata();
  } catch {
    throw unsupported(isHeic ? HEIC_GUIDANCE : ACCEPTED_FORMATS_MESSAGE, { reason: isHeic ? 'heic_not_supported' : 'undecodable' });
  }
  if (!meta.width || !meta.height) throw unsupported(ACCEPTED_FORMATS_MESSAGE, { reason: 'undecodable' });
  if (meta.width * meta.height > limits.maxPixels) {
    throw unsupported(`Photos can be up to ${Math.floor(limits.maxPixels / 1_000_000)} megapixels.`, {
      reason: 'too_many_pixels',
      max_pixels: limits.maxPixels,
    });
  }

  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await sharp(bytes, { failOn: 'error', limitInputPixels: limits.maxPixels, pages: 1 })
      .rotate() // apply EXIF orientation, then drop the tag
      .resize({ width: limits.maxEdge, height: limits.maxEdge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw unsupported(isHeic ? HEIC_GUIDANCE : ACCEPTED_FORMATS_MESSAGE, { reason: isHeic ? 'heic_not_supported' : 'undecodable' });
  }

  return {
    derivative: new Uint8Array(out.data),
    derivativeContentType: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
    sha256: sha256Hex(bytes),
    originalContentType: type,
    originalByteSize: bytes.byteLength,
  };
}
