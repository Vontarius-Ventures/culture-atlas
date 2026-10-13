import { notImplemented } from '../errors';

/**
 * Image intake (build spec "Cultural compilation pipeline" step 1):
 * validate actual bytes (sniff magic numbers, ignore declared type), decode
 * safely with sharp (limitInputPixels = UPLOAD_MAX_PIXELS), apply EXIF
 * orientation, strip metadata (including location), and produce a JPEG
 * derivative bounded to IMAGE_MAX_EDGE (2048 px) long edge.
 * Accept JPEG, PNG, WebP; HEIC only when the decoder supports it. NOTE: the
 * prebuilt sharp/libvips used here decodes AVIF but NOT HEVC-based HEIC, so
 * HEIC must return `unsupported_image` with conversion guidance.
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

/** TODO(captures owner): implement with sharp as documented above. */
export async function normalizeImage(bytes: Uint8Array, limits: ImageLimits): Promise<NormalizedImage> {
  void bytes;
  void limits;
  notImplemented('media.normalizeImage');
}
