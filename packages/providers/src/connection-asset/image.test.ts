import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import https, { type RequestOptions } from 'node:https';
import { lookup } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  safeConnectionAssetUrl, publicConnectionAssetIPv4, fetchPublicConnectionImage,
  prepareConnectionAssetImage, connectionAssetSha256,
  inspectConnectionAssetRasterHeader,
} from './image';

vi.mock('node:https', () => ({ default: { get: vi.fn() } }));
vi.mock('node:dns', () => ({ lookup: vi.fn() }));
const imageUrl = 'https://images.qloo.com/i/public-image.jpg';
const png = () => sharp({ create: { width: 1000, height: 600, channels: 3, background: '#336699' } }).png().toBuffer();
const controller = () => new AbortController();
function mockHttp(
  status = 200, bytes = Buffer.from('public image bytes'), headers: Record<string, string | undefined> = { 'content-type': 'image/jpeg' },
  hold = false, chunks?: Buffer[],
) {
  const request = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  request.destroy = vi.fn();
  let observed: RequestOptions = {};
  vi.mocked(https.get).mockImplementation(((url: string, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    expect(url).toBe(imageUrl);
    observed = options;
    queueMicrotask(() => {
      const customLookup = options.lookup as (host: string, opts: { all: boolean },
        cb: (error: Error | null, address: unknown) => void) => void;
      customLookup('images.qloo.com', { all: false }, error => {
        if (error) { request.emit('error', error); return; }
        if (hold) return;
        const response = Object.assign(new PassThrough(), { statusCode: status, headers });
        callback(response as unknown as IncomingMessage);
        if (chunks) {
          for (const chunk of chunks) response.write(chunk);
          response.end();
        } else response.end(bytes);
      });
    });
    return request as unknown as ClientRequest;
  }) as typeof https.get);
  return { request, options: () => observed };
}
beforeEach(() => {
  vi.mocked(lookup).mockImplementation(((_host: string, _options: unknown, cb: (error: null, rows: { address: string; family: number }[]) => void) =>
    cb(null, [{ address: '8.8.8.8', family: 4 }])) as typeof lookup);
});
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe('public candidate image acquisition (mocked HTTP/DNS only)', () => {
  it.each([
    'http://images.qloo.com/i/a.jpg', 'https://images.qloo.com/i/a.jpg?token=x',
    'https://images.qloo.com/i/a.jpg#x', 'https://token@images.qloo.com/i/a.jpg',
    'https://images.qloo.com:443/i/a.jpg', 'https://images.qloo.com./i/a.jpg',
    'https://images.qloo.com.evil/i/a.jpg', 'https://evil/images.qloo.com/i/a.jpg',
    'https://images.qloo.com/i/../a.jpg', 'https://images.qloo.com/i/a%2Fsecret.jpg',
    'https://images.qloo.com/i/a.svg', 'https://images.qloo.com/i/a.gif', 'file:///i/a.jpg',
    'https://images.qloo.com/i/a.jpg\n', ' https://images.qloo.com/i/a.jpg',
  ])('rejects URL credentials, query, fragments, arbitrary hosts/path or unsupported format: %s', async value => {
    expect(safeConnectionAssetUrl(value)).toBe(false);
    expect(await fetchPublicConnectionImage(value, controller().signal)).toEqual({ bytes: null, status: 0 });
    expect(https.get).not.toHaveBeenCalled();
  });
  it.each(['0.0.0.0', '10.1.1.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '100.64.0.1', '192.0.0.8', '198.18.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '255.255.255.255', '::1', '::ffff:127.0.0.1', '08.8.8.8', '999.1.1.1'])('rejects nonpublic/invalid IPv4: %s', value => {
    expect(publicConnectionAssetIPv4(value)).toBe(false);
  });
  it('uses pinned public DNS with no auth/cookies/proxy/redirect/retry and no external URL sent to a model', async () => {
    const mock = mockHttp();
    expect(await fetchPublicConnectionImage(imageUrl, controller().signal)).toEqual({ bytes: Buffer.from('public image bytes'), status: 200 });
    expect(lookup).toHaveBeenCalledWith('images.qloo.com', { family: 4, all: true }, expect.any(Function));
    expect(mock.options()).toMatchObject({
      agent: false, headers: { Accept: 'image/jpeg,image/png,image/webp', 'Accept-Encoding': 'identity' },
    });
    expect(Object.keys(mock.options().headers!)).not.toEqual(expect.arrayContaining(['Cookie', 'Authorization']));
    expect(https.get).toHaveBeenCalledTimes(1);
  });
  it('rejects mixed public/private DNS answers before any response use', async () => {
    vi.mocked(lookup).mockImplementation(((_host: string, _options: unknown, cb: (error: null, rows: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])) as typeof lookup);
    mockHttp();
    expect(await fetchPublicConnectionImage(imageUrl, controller().signal)).toEqual({ bytes: null, status: 0 });
  });
  it.each([301, 302, 307, 308, 401, 403, 404, 429, 503])('does not follow or retry HTTP %i', async status => {
    mockHttp(status, Buffer.from('ignored'), { 'content-type': 'image/jpeg', location: 'https://evil.test/secret' });
    expect(await fetchPublicConnectionImage(imageUrl, controller().signal)).toEqual({ bytes: null, status });
    expect(https.get).toHaveBeenCalledTimes(1);
  });
  it.each([
    { 'content-type': 'image/svg+xml' },
    { 'content-type': 'image/jpeg', 'content-encoding': 'gzip' },
    { 'content-type': 'image/jpeg', 'content-length': '8388609' },
    { 'content-type': 'image/jpeg', 'content-length': 'invalid' },
  ])('rejects content headers before body retention: %j', async headers => {
    mockHttp(200, Buffer.from('ignored'), headers);
    expect((await fetchPublicConnectionImage(imageUrl, controller().signal)).bytes).toBeNull();
  });
  it('enforces streamed 8MiB bound even when content length is missing', async () => {
    mockHttp(200, Buffer.alloc(8 * 1024 * 1024 + 1));
    expect((await fetchPublicConnectionImage(imageUrl, controller().signal)).bytes).toBeNull();
  });
  it.each([8192, 8193])('bounds tiny response chunks independently of byte count: %i chunks', async count => {
    mockHttp(200, undefined, undefined, false, Array.from({ length: count }, () => Buffer.from('x')));
    const result = await fetchPublicConnectionImage(imageUrl, controller().signal);
    expect(result.bytes?.length ?? null).toBe(count === 8192 ? 8192 : null);
    expect(https.get).toHaveBeenCalledTimes(1);
  });
  it('honors abort before GET and during GET', async () => {
    const c = controller();
    c.abort();
    expect((await fetchPublicConnectionImage(imageUrl, c.signal)).bytes).toBeNull();
    expect(https.get).not.toHaveBeenCalled();
    const next = controller();
    const mock = mockHttp(200, undefined, undefined, true);
    const pending = fetchPublicConnectionImage(imageUrl, next.signal);
    next.abort();
    expect((await pending).bytes).toBeNull();
    expect(mock.request.destroy).toHaveBeenCalledTimes(1);
  });
  it('has a 20s total download deadline, not just an idle socket timeout', async () => {
    vi.useFakeTimers();
    const mock = mockHttp(200, undefined, undefined, true);
    const pending = fetchPublicConnectionImage(imageUrl, controller().signal);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await pending).bytes).toBeNull();
    expect(mock.request.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('candidate-only JPEG preparation, no model calls', () => {
  it('hashes original and model bytes separately, strips metadata and bounds before model dispatch', async () => {
    const original = await sharp(await png()).withMetadata({ orientation: 6 }).png().toBuffer();
    const a = await prepareConnectionAssetImage(original);
    const b = await prepareConnectionAssetImage(original);
    expect(a).toEqual(b);
    expect(a.originalSha256).toBe(connectionAssetSha256(original));
    expect(a.modelInputSha256).toBe(connectionAssetSha256(a.bytes));
    expect(a.originalSha256).not.toBe(a.modelInputSha256);
    const meta = await sharp(a.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(a.width, a.height)).toBeLessThanOrEqual(512);
    expect(a.width * a.height).toBeLessThanOrEqual(262144);
    expect(a.bytes.length).toBeLessThanOrEqual(200000);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });
  it('rejects SVG, malformed raster, byte bombs, GIF and animated PNG/WebP containers before pixel decode', async () => {
    const still = await png();
    const chunk = Buffer.alloc(12);
    chunk.write('acTL', 4);
    const apng = Buffer.concat([still.subarray(0, 33), chunk, still.subarray(33)]);
    const webp = Buffer.alloc(22);
    webp.write('RIFF'); webp.write('WEBP', 8); webp.write('ANIM', 12); webp.writeUInt32LE(2, 16);
    for (const bytes of [
      Buffer.from('<svg width="500000" height="500000"></svg>'), Buffer.from('not an image'),
      Buffer.from('GIF89a'), Buffer.alloc(8 * 1024 * 1024 + 1), apng, webp,
    ]) await expect(prepareConnectionAssetImage(bytes)).rejects.toThrow();
  });
  it('checks decoded header dimensions before doing any actual pixel decode', async () => {
    const original = await png();
    original.writeUInt32BE(50000, 16); original.writeUInt32BE(50000, 20);
    await expect(prepareConnectionAssetImage(original)).rejects.toThrow();
  });
  it.each(['jpeg', 'progressive_jpeg', 'png', 'webp', 'lossless_webp'] as const)(
    'reads actual %s dimensions without Sharp and then prepares bounded model bytes', async format => {
      const image = sharp(await png());
      const bytes = format === 'jpeg' ? await image.jpeg().toBuffer()
        : format === 'progressive_jpeg' ? await image.jpeg({ progressive: true }).toBuffer()
          : format === 'png' ? await image.png().toBuffer()
            : await image.webp({ lossless: format === 'lossless_webp' }).toBuffer();
      expect(inspectConnectionAssetRasterHeader(bytes)).toEqual({
        format: format.includes('jpeg') ? 'jpeg' : format.includes('webp') ? 'webp' : 'png',
        width: 1000, height: 600,
      });
      expect((await prepareConnectionAssetImage(bytes)).bytes.length).toBeLessThanOrEqual(200000);
    },
  );
  it('rejects oversized JPEG, PNG and extended WebP dimensions in the pure pre-Sharp parser', async () => {
    const jpeg = await sharp(await png()).jpeg().toBuffer();
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    jpeg.writeUInt16BE(50000, sof + 5);
    jpeg.writeUInt16BE(50000, sof + 7);
    const oversizedPng = await png();
    oversizedPng.writeUInt32BE(50000, 16);
    oversizedPng.writeUInt32BE(50000, 20);
    const webp = Buffer.alloc(30);
    webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBP', 8);
    webp.write('VP8X', 12); webp.writeUInt32LE(10, 16);
    webp.writeUIntLE(49999, 24, 3); webp.writeUIntLE(49999, 27, 3);
    for (const bytes of [jpeg, oversizedPng, webp])
      expect(() => inspectConnectionAssetRasterHeader(bytes)).toThrow('Unsafe raster dimensions');
  });
});
