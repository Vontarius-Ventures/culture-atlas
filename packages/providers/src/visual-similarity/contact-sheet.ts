import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ProviderError } from '../errors';
import { boundJpegForProfile } from '../concentrate/image';
import type { ModelProfile } from '../concentrate/profiles';
import type { VisualSimilarityRequest, VisualSimilarityRegion } from './types';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_PIXELS = 20_000_000;
export const visualImageSha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const bad = (): never => { throw new ProviderError('visual-similarity', 'bad_request', 'Invalid visual comparison images or region'); };

/** Fixed bitmap letters, not a host font, SVG, supplied label or remote resource. */
const GLYPHS: Record<string, string[]> = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  N: ['10001','11001','11001','10101','10011','10011','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
};
function header(): Buffer {
  const bytes = Buffer.alloc(1024 * 32 * 3, 20);
  for (const [label, left] of [['SOURCE', 16], ['CANDIDATE', 528]] as const)
    [...label].forEach((letter, i) => GLYPHS[letter]!.forEach((row, y) =>
      [...row].forEach((bit, x) => {
        if (bit !== '1') return;
        for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
          const at = ((5 + y * 3 + dy) * 1024 + left + i * 18 + x * 3 + dx) * 3;
          bytes.fill(255, at, at + 3);
        }
      })));
  return bytes;
}

export function validateVisualRegion(region: VisualSimilarityRegion): void {
  if (!region || Object.values(region).length !== 4 ||
      ![region.x, region.y, region.w, region.h].every(Number.isFinite) ||
      region.x < 0 || region.y < 0 || region.w <= 0 || region.h <= 0 ||
      region.x + region.w > 1 || region.y + region.h > 1) bad();
}

async function raster(input: Uint8Array): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (!(input instanceof Uint8Array) || !input.length || input.length > MAX_INPUT_BYTES) bad();
  try {
    const meta = await sharp(input, { failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '') || !meta.width || !meta.height ||
        (meta.pages ?? 1) !== 1 || meta.width * meta.height > MAX_INPUT_PIXELS) bad();
    const result = await sharp(input, { failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS })
      .rotate().flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    return { bytes: result.data, width: result.info.width, height: result.info.height };
  } catch { return bad(); }
}

/**
 * One metadata-free JPEG, 1024x544 before profile bounding. Source crop left,
 * full candidate right, no user-supplied overlay text. Exact input hashes
 * remain server-side; only the bounded sheet is sent to the model.
 */
export async function buildVisualContactSheet(input: VisualSimilarityRequest, limits: ModelProfile['image']) {
  if ([input.sourceImage, input.candidateImage].some((bytes) =>
    !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_INPUT_BYTES)) bad();
  validateVisualRegion(input.sourceRegion);
  if (limits.maxCount !== 1 || limits.maxDimension < 512 || limits.maxPixels < 512 * 272 ||
      limits.maxBytes < 4096) bad();
  const sourceBytes = Buffer.from(input.sourceImage);
  const candidateBytes = Buffer.from(input.candidateImage);
  const r = { ...input.sourceRegion };
  const sourceImageSha256 = visualImageSha256(sourceBytes);
  const candidateImageSha256 = visualImageSha256(candidateBytes);
  if (sourceImageSha256 === candidateImageSha256) bad();
  const source = await raster(sourceBytes);
  const candidate = await raster(candidateBytes);
  if (source.width === candidate.width && source.height === candidate.height &&
      source.bytes.equals(candidate.bytes)) bad();
  const left = Math.floor(r.x * source.width);
  const top = Math.floor(r.y * source.height);
  const width = Math.min(source.width, Math.ceil((r.x + r.w) * source.width)) - left;
  const height = Math.min(source.height, Math.ceil((r.y + r.h) * source.height)) - top;
  if (width < 2 || height < 2) bad();
  const raw = { width: source.width, height: source.height, channels: 3 as const };
  const cropped = await sharp(source.bytes, { raw }).extract({ left, top, width, height }).raw().toBuffer();
  // Reject the normalized source crop echoed as the candidate, too.
  if (candidate.width === width && candidate.height === height && cropped.equals(candidate.bytes)) bad();
  const panels = await Promise.all([
    sharp(cropped, { raw: { width, height, channels: 3 } }),
    sharp(candidate.bytes, { raw: { width: candidate.width, height: candidate.height, channels: 3 } }),
  ].map((pipeline) => pipeline.resize(504, 504, { fit: 'contain', background: '#ffffff' }).png().toBuffer()));
  const sheet = await sharp({ create: { width: 1024, height: 544, channels: 3, background: '#ffffff' } })
    .composite([
      { input: header(), raw: { width: 1024, height: 32, channels: 3 }, left: 0, top: 0 },
      { input: panels[0]!, left: 4, top: 36 },
      { input: panels[1]!, left: 516, top: 36 },
    ]).jpeg({ quality: 85, mozjpeg: false }).toBuffer();
  const image = await boundJpegForProfile(sheet, { ...limits, maxDimension: Math.min(limits.maxDimension, 1024), maxPixels: Math.min(limits.maxPixels, 1024 * 544) });
  // Avoid shrinking labels into illegibility under a byte-starved profile.
  if (image.width < 512 || image.height < 272) bad();
  return { ...image, sourceImageSha256, candidateImageSha256, contactSheetSha256: visualImageSha256(image.bytes), sourceRegion: { x: r.x, y: r.y, w: r.w, h: r.h } };
}
