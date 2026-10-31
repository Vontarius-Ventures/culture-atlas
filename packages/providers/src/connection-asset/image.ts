import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import https from 'node:https';
import sharp from 'sharp';

export const CONNECTION_ASSET_IMAGE_LIMITS = Object.freeze({
  originalBytes: 8 * 1024 * 1024, originalPixels: 20_000_000,
  maxBytes: 200_000, maxDimension: 512, maxPixels: 262_144,
  downloadMs: 20_000, spacingMs: 1100, maxDownloadChunks: 8192,
});
export const connectionAssetSha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export function safeConnectionAssetUrl(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length <= 2048 &&
    /^https:\/\/images\.qloo\.com\/i\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/.test(value);
}
export function publicConnectionAssetIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some(p => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) return false;
  const [a, b, c] = parts.map(Number) as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
export interface ConnectionAssetDownload { bytes: Buffer | null; status: number }

/** One credential-free GET, DNS-pinned public IPv4, no proxy, redirects or retry. */
export async function fetchPublicConnectionImage(url: string, signal: AbortSignal): Promise<ConnectionAssetDownload> {
  if (!safeConnectionAssetUrl(url) || signal.aborted) return { bytes: null, status: 0 };
  return new Promise(resolve => {
    let done = false;
    const active: { request?: ReturnType<typeof https.get> } = {};
    const finish = (bytes: Buffer | null, status = 0) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({ bytes, status });
    };
    const abort = () => { finish(null); active.request?.destroy(); };
    const timer = setTimeout(abort, CONNECTION_ASSET_IMAGE_LIMITS.downloadMs);
    signal.addEventListener('abort', abort, { once: true });
    try {
    active.request = https.get(url, {
      agent: false,
      headers: { Accept: 'image/jpeg,image/png,image/webp', 'Accept-Encoding': 'identity' },
      lookup: (_host, options, cb) => {
        lookup('images.qloo.com', { family: 4, all: true }, (error, addresses) => {
          if (error || !addresses.length || addresses.some(a => !publicConnectionAssetIPv4(a.address))) {
            cb(new Error('Image DNS rejected'), '', 4); return;
          }
          const pinned = addresses[0]!;
          // Node's lookup callback supports either one address or {all:true}.
          if (options.all) cb(null, [pinned]);
          else cb(null, pinned.address, 4);
        });
      },
    }, res => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const size = res.headers['content-length'];
      if (status !== 200 || !['image/jpeg', 'image/png', 'image/webp'].includes(type) ||
        (size !== undefined && (!/^\d+$/.test(size) || Number(size) > CONNECTION_ASSET_IMAGE_LIMITS.originalBytes)) ||
        (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        finish(null, status); res.destroy(); return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > CONNECTION_ASSET_IMAGE_LIMITS.originalBytes ||
            chunks.length >= CONNECTION_ASSET_IMAGE_LIMITS.maxDownloadChunks) { finish(null, status); res.destroy(); }
        else chunks.push(Buffer.from(chunk));
      });
      res.on('end', () => finish(bytes ? Buffer.concat(chunks) : null, status));
      res.on('error', () => finish(null, status));
      res.on('aborted', () => finish(null, status));
    });
    active.request.on('error', () => finish(null));
    } catch { finish(null); }
    if (signal.aborted) abort();
  });
}

/** Header inspection MUST complete before the first pixel decode. No SVG or animation. */
export async function prepareConnectionAssetImage(input: Uint8Array): Promise<{
  bytes: Buffer; width: number; height: number; originalSha256: string; modelInputSha256: string;
}> {
  const original = Buffer.from(input);
  if (!original.length || original.length > CONNECTION_ASSET_IMAGE_LIMITS.originalBytes) throw new Error('Image bound');
  const header = inspectConnectionAssetRasterHeader(original);
  const options = { failOn: 'warning' as const, limitInputPixels: CONNECTION_ASSET_IMAGE_LIMITS.originalPixels };
  const meta = await sharp(original, options).metadata();
  if (meta.format !== header.format || meta.width !== header.width || meta.height !== header.height ||
      !meta.width || !meta.height ||
      meta.width * meta.height > CONNECTION_ASSET_IMAGE_LIMITS.originalPixels ||
      (meta.pages ?? 1) !== 1 || meta.pageHeight || meta.delay?.length) throw new Error('Image header rejected');
  for (const quality of [85, 75, 65, 55]) {
    const { data, info } = await sharp(original, options).timeout({ seconds: 5 }).rotate().flatten({ background: '#ffffff' }).removeAlpha()
      .toColourspace('srgb').resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: false }).toBuffer({ resolveWithObject: true });
    if (data.length <= CONNECTION_ASSET_IMAGE_LIMITS.maxBytes && info.width * info.height <= 262_144)
      return { bytes: data, width: info.width, height: info.height,
        originalSha256: connectionAssetSha256(original), modelInputSha256: connectionAssetSha256(data) };
  }
  throw new Error('Model image bound');
}

/** Dimensions and bounded container walks precede even Sharp.metadata(). */
export function inspectConnectionAssetRasterHeader(bytes: Buffer): { format: 'jpeg' | 'png' | 'webp'; width: number; height: number } {
  const dimensions = (format: 'jpeg' | 'png' | 'webp', width: number, height: number) => {
    if (!width || !height || width * height > CONNECTION_ASSET_IMAGE_LIMITS.originalPixels)
      throw new Error('Unsafe raster dimensions');
    return { format, width, height };
  };
  if (bytes.length < 12 || bytes.length > CONNECTION_ASSET_IMAGE_LIMITS.originalBytes) throw new Error('Raster header bound');
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    for (let segments = 0; segments < 256 && offset <= 262_144; segments++) {
      if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG marker');
      let fills = 0;
      while (bytes[offset] === 0xff && ++fills <= 16) offset++;
      const marker = bytes[offset++];
      if (fills > 16 || marker === undefined || offset + 2 > bytes.length) throw new Error('Truncated JPEG header');
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length || offset + length > 262_144) throw new Error('JPEG header bound');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        const components = bytes[offset + 7];
        if (length < 11 || bytes[offset + 2] !== 8 || !components ||
            ![1, 3, 4].includes(components) || length !== 8 + 3 * components)
          throw new Error('Unsupported JPEG frame');
        return dimensions('jpeg', bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      }
      if (marker === 0xda || marker === 0xd9 || (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)))
        throw new Error('JPEG frame unavailable');
      offset += length;
    }
    throw new Error('JPEG header complexity');
  }
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR')
      throw new Error('PNG dimensions unavailable');
    const header = dimensions('png', bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    let chunks = 0;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      if (++chunks > 2048) throw new Error('PNG container complexity');
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) throw new Error('Invalid PNG chunk');
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('Animated PNG rejected');
      if (type === 'IHDR' && offset !== 8) throw new Error('Multiple PNG frames');
      offset += length + 12;
      if (type === 'IEND') {
        if (length !== 0 || offset !== bytes.length) throw new Error('Invalid PNG end');
        return header;
      }
    }
    throw new Error('Incomplete PNG container');
  }
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Invalid WebP size');
    let canvas: ReturnType<typeof dimensions> | undefined;
    let frame: ReturnType<typeof dimensions> | undefined;
    let chunks = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      if (++chunks > 256) throw new Error('WebP container complexity');
      const length = bytes.readUInt32LE(offset + 4);
      if (length > bytes.length - offset - 8) throw new Error('Invalid WebP chunk');
      const type = bytes.toString('ascii', offset, offset + 4);
      const data = offset + 8;
      if (type === 'ANIM' || type === 'ANMF' ||
          (type === 'VP8X' && length > 0 && (bytes[data]! & 2))) throw new Error('Animated WebP rejected');
      if (type === 'VP8X') {
        if (canvas || frame || length !== 10) throw new Error('Invalid extended WebP header');
        canvas = dimensions('webp', bytes.readUIntLE(data + 4, 3) + 1, bytes.readUIntLE(data + 7, 3) + 1);
      }
      if (type === 'VP8 ') {
        if (frame || length < 10 || (bytes[data]! & 1) ||
            !bytes.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 0x01, 0x2a])))
          throw new Error('Invalid WebP keyframe');
        frame = dimensions('webp', bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff);
      }
      if (type === 'VP8L') {
        if (frame || length < 5 || bytes[data] !== 0x2f) throw new Error('Invalid lossless WebP header');
        const packed = bytes.readUInt32LE(data + 1);
        if (packed >>> 29) throw new Error('Unsupported lossless WebP version');
        frame = dimensions('webp', (packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
      }
      offset += 8 + length + (length % 2);
      if (offset > bytes.length) throw new Error('Invalid WebP padding');
      if (offset === bytes.length) {
        if (!frame || (canvas && (canvas.width !== frame.width || canvas.height !== frame.height)))
          throw new Error('WebP dimensions mismatch');
        return frame;
      }
    }
    throw new Error('Incomplete WebP container');
  }
  throw new Error('Unsupported raster signature');
}
