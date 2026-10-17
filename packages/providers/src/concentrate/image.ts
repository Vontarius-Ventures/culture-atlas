import sharp, { type Metadata } from 'sharp';
import { ProviderError } from '../errors';
import type { ModelProfile } from './profiles';

/**
 * Re-encodes a prepared derivative into a profile's qualified image bounds:
 * oriented, metadata stripped, inside maxDimension and maxPixels, a JPEG no
 * larger than maxBytes. The model only ever receives this bounded derivative
 * (as a data URI), never the original upload or a private URL.
 */
export async function boundJpegForProfile(
  input: Uint8Array,
  limits: ModelProfile['image'],
): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (!limits.maxDimension || !limits.maxPixels || !limits.maxBytes)
    throw new ProviderError('model-gateway', 'bad_request', 'Profile does not qualify images');
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 100_000_000, failOn: 'warning' }).metadata();
  } catch {
    throw new ProviderError('model-gateway', 'bad_request', 'Invalid media derivative');
  }
  if (!meta.width || !meta.height || (meta.pages ?? 1) > 1)
    throw new ProviderError('model-gateway', 'bad_request', 'Invalid media derivative');
  const swap = (meta.orientation ?? 1) >= 5;
  const w0 = swap ? meta.height : meta.width;
  const h0 = swap ? meta.width : meta.height;
  let scale = Math.min(
    1,
    limits.maxDimension / Math.max(w0, h0),
    Math.sqrt(limits.maxPixels / (w0 * h0)),
  );
  for (let shrink = 0; shrink < 6; shrink++) {
    const width = Math.max(1, Math.floor(w0 * scale));
    const height = Math.max(1, Math.floor(h0 * scale));
    for (const quality of [85, 75, 65, 55]) {
      const bytes = await sharp(input, { limitInputPixels: 100_000_000 })
        .rotate()
        .resize({ width, height, fit: 'fill' })
        .jpeg({ quality, mozjpeg: false })
        .toBuffer();
      if (bytes.length <= limits.maxBytes && width * height <= limits.maxPixels)
        return { bytes, width, height };
    }
    scale *= 0.75;
  }
  throw new ProviderError(
    'model-gateway',
    'bad_request',
    'Media could not be bounded for the profile',
  );
}
