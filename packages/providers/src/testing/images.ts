import sharp from 'sharp';

/** A solid-color JPEG for offline tests (fixtures stay synthetic, never real media). */
export function solidJpeg(width: number, height: number, background: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })
    .jpeg()
    .toBuffer();
}
