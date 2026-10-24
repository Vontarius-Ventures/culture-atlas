import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CAPTURE_LIMITS,
  type CaptureLease,
  type CaptureLimits,
  type MediaPreparationInput,
} from '@culture-atlas/domain';
import type { MultipartStorage } from '@culture-atlas/providers';
import { createMediaPreparer, frameTargets, nearestFrames, PROCESSING_VERSIONS } from './preparer';
import { DEFAULT_TOOL_CONFIG, probeFile } from './probe';
import { qualifyWorker, type Qualification } from './qualify';
import { corrupt, makeFixture, writeFixture, type FixtureName } from './test-fixtures';
import { createMediaVerifier } from './verifier';

let dir: string, scratch: string, qualification: Qualification;
const fixtures = new Map<FixtureName, Buffer>();
// Real ffmpeg work competes with the rest of the suite for CPU.
vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ca-media-fixtures-'));
  scratch = join(dir, 'scratch');
  qualification = await qualifyWorker(DEFAULT_TOOL_CONFIG, scratch);
  for (const name of [
    'h264-aac',
    'h264-silent',
    'vp9-opus',
    'vp8-silent',
    'rotated',
    'high444',
    'mpeg4',
    'long',
  ] as const)
    fixtures.set(name, await makeFixture(dir, name));
}, 300_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fixture = (name: FixtureName) => fixtures.get(name)!;
function verify(
  bytes: Buffer,
  contentType: string,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
) {
  return createMediaVerifier({
    scratchRoot: scratch,
    tools: DEFAULT_TOOL_CONFIG,
    qualified: qualification.qualified,
  }).verify({
    body: Readable.from([bytes]),
    kind: 'video',
    contentType,
    byteSize: bytes.length,
    limits,
  });
}
function memoryStorage() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const storage = {
    async read(key: string) {
      const o = objects.get(key);
      if (!o) throw new Error('missing');
      return { body: Readable.from([o.body]), contentType: o.contentType, byteSize: o.body.length };
    },
    async put(key: string, body: AsyncIterable<Uint8Array>, contentType: string) {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(Buffer.from(c));
      objects.set(key, { body: Buffer.concat(chunks), contentType });
    },
  } as unknown as MultipartStorage;
  return { objects, storage };
}
async function prepare(
  name: FixtureName,
  contentType: string,
  overrides: Partial<MediaPreparationInput['media']> = {},
) {
  const bytes = fixture(name);
  const verified = await verify(bytes, contentType);
  const { objects, storage } = memoryStorage();
  objects.set('original', { body: bytes, contentType });
  let liveChecks = 0;
  const result = await createMediaPreparer({
    scratchRoot: scratch,
    tools: DEFAULT_TOOL_CONFIG,
    derivativeAllowanceBytes: DEFAULT_CAPTURE_LIMITS.derivativeAllowanceBytes,
  }).prepare({
    lease: { kind: 'prepare_media' } as CaptureLease,
    originalKey: 'original',
    storage,
    media: { ...verified, kind: 'video', byteSize: bytes.length, ...overrides },
    assertLive: async () => {
      liveChecks++;
    },
    derivativeKey: (kind, suffix) => `attempt/${kind}${suffix ? `-${suffix}` : ''}`,
  });
  return { result, objects, verified, liveChecks };
}

describe('worker qualification', () => {
  it('qualifies only codecs that pass the real verifier and the full preparation pipeline', () => {
    expect(qualification.preparation).toBe(true);
    expect(qualification.codecs['prepare/mp4/h264/aac']).toBe(true);
    expect(qualification.codecs['mp4/h264/aac']).toBe(true);
    expect(qualification.codecs['webm/vp9/opus']).toBe(true);
    // The product contract on every supported host: MP4/H.264/AAC and WebM/VP9/Opus qualify.
    expect([...qualification.qualified.video]).toEqual(expect.arrayContaining(['h264', 'vp9']));
    expect([...qualification.qualified.audio]).toEqual(expect.arrayContaining(['aac', 'opus']));
    // Other codecs depend on the host's ffmpeg build (e.g. VP8 is self-tested with libvorbis, which
    // Debian's ffmpeg ships and some builds do not). Whatever qualifies must be exactly what passed
    // the real verifier here, never a hardcoded host list.
    const passed = Object.entries(qualification.codecs)
      .filter(([key, ok]) => ok && !key.startsWith('prepare/'))
      .map(([key]) => key.split('/'));
    expect(new Set(passed.map(([, video]) => video))).toEqual(qualification.qualified.video);
    expect(new Set(passed.map(([, , audio]) => audio).filter(Boolean))).toEqual(
      qualification.qualified.audio,
    );
  });
  it('an unqualified worker defers video instead of rejecting customer files', async () => {
    const verifier = createMediaVerifier({
      scratchRoot: scratch,
      tools: DEFAULT_TOOL_CONFIG,
      qualified: { video: new Set(), audio: new Set() },
    });
    await expect(
      verifier.verify({
        body: Readable.from([fixture('h264-aac')]),
        kind: 'video',
        contentType: 'video/mp4',
        byteSize: fixture('h264-aac').length,
        limits: DEFAULT_CAPTURE_LIMITS,
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable', retryable: true });
  });
});

describe('MED-03 video verification with real ffprobe/ffmpeg', () => {
  it('accepts qualified MP4/H.264/AAC and WebM/VP9/Opus with decoded duration and audio state', async () => {
    expect(await verify(fixture('h264-aac'), 'video/mp4')).toMatchObject({
      contentType: 'video/mp4',
      width: 320,
      height: 240,
      audioPresent: true,
      container: 'mp4',
      codecs: ['h264', 'aac'],
    });
    const mp4 = await verify(fixture('h264-aac'), 'video/mp4');
    expect(mp4.durationMs).toBeGreaterThanOrEqual(1900);
    expect(mp4.durationMs).toBeLessThanOrEqual(2200);
    expect(await verify(fixture('vp9-opus'), 'video/webm')).toMatchObject({
      container: 'webm',
      audioPresent: true,
      codecs: ['vp9', 'opus'],
    });
    // VP8 is accepted exactly when this host qualified it, and refused as unsupported otherwise.
    if (qualification.qualified.video.has('vp8')) {
      expect(await verify(fixture('vp8-silent'), 'video/webm')).toMatchObject({
        container: 'webm',
        audioPresent: false,
        codecs: ['vp8'],
      });
    } else {
      await expect(verify(fixture('vp8-silent'), 'video/webm')).rejects.toMatchObject({
        code: 'unsupported_media',
        retryable: false,
      });
    }
    // QuickTime-declared ISO media is the same family (iPhone .mov uploads).
    expect(await verify(fixture('h264-silent'), 'video/quicktime')).toMatchObject({
      audioPresent: false,
    });
  });
  it('reports display dimensions for rotated phone video', async () => {
    expect(await verify(fixture('rotated'), 'video/mp4')).toMatchObject({
      width: 180,
      height: 320,
    });
  });
  it('rejects corrupt, truncated, mislabeled, non-video and unqualified-codec input', async () => {
    const cases: Array<[Buffer, string]> = [
      [corrupt(fixture('h264-aac')), 'video/mp4'],
      [fixture('h264-aac').subarray(0, 3000), 'video/mp4'],
      [fixture('h264-aac'), 'video/webm'],
      [fixture('vp9-opus'), 'video/mp4'],
      [
        await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
          .png()
          .toBuffer(),
        'video/mp4',
      ],
      [fixture('mpeg4'), 'video/mp4'],
    ];
    for (const [bytes, type] of cases)
      await expect(verify(bytes, type)).rejects.toMatchObject({
        code: 'unsupported_media',
        retryable: false,
      });
  });
  it('rejects excessive resolution and caps decoding of overlong video', async () => {
    await expect(
      verify(fixture('h264-aac'), 'video/mp4', {
        ...DEFAULT_CAPTURE_LIMITS,
        photoMaxPixels: 320 * 239,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_media' });
    // The decoder stops at limit+1s, so a 4s clip against a 1.5s limit reports > limit.
    const long = await verify(fixture('long'), 'video/mp4', {
      ...DEFAULT_CAPTURE_LIMITS,
      videoMaxDurationMs: 1500,
    });
    expect(long.durationMs).toBeGreaterThan(1500);
  });
  it('rejects bytes beyond the declared bound while streaming to scratch', async () => {
    await expect(
      verify(fixture('h264-aac'), 'video/mp4', { ...DEFAULT_CAPTURE_LIMITS, videoMaxBytes: 1000 }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    expect((await readdir(scratch)).filter((n) => n.startsWith('job-'))).toEqual([]);
  });
});

describe('video preparation', () => {
  it('produces a playable faststart MP4, poster and frames-v1 frames at real timestamps', async () => {
    const { result, objects, verified, liveChecks } = await prepare('vp9-opus', 'video/webm');
    const kinds = result.derivatives.map((d) => d.kind);
    expect(kinds.filter((k) => k === 'playback')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'poster')).toHaveLength(1);
    const frames = result.derivatives.filter((d) => d.kind === 'frame');
    expect(frames).toHaveLength(3);
    expect(result.extractionVersion).toBe(PROCESSING_VERSIONS.frames);
    const ts = frames.map((f) => f.timestampMs!);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts[0]).toBeGreaterThan(0);
    expect(ts.at(-1)).toBeLessThan(verified.durationMs!);
    expect(frames.map((f) => f.processingVersion)).toEqual(ts.map((t) => `frames-v1:${t}`));
    for (const d of result.derivatives) {
      const stored = objects.get(d.objectKey)!.body;
      expect(createHash('sha256').update(stored).digest('hex')).toBe(d.checksum);
      expect(stored.length).toBe(d.byteSize);
      expect(d.shareSafe).toBe(true);
    }
    expect(liveChecks).toBe(result.derivatives.length);
    const playback = result.derivatives.find((d) => d.kind === 'playback')!;
    const path = await writeFixture(dir, 'out.mp4', objects.get(playback.objectKey)!.body);
    const probe = await probeFile(path, DEFAULT_TOOL_CONFIG);
    expect(probe).toMatchObject({
      container: 'mp4',
      video: { codec: 'h264', pixFmt: 'yuv420p' },
      audio: { codec: 'aac' },
    });
    // faststart: the moov box precedes mdat.
    const body = objects.get(playback.objectKey)!.body;
    expect(body.indexOf('moov')).toBeLessThan(body.indexOf('mdat'));
  });
  it('keeps silent video silent, remuxes compatible H.264 and transcodes High 4:4:4', async () => {
    const silent = await prepare('h264-silent', 'video/mp4');
    const silentPath = await writeFixture(
      dir,
      'silent.mp4',
      silent.objects.get(silent.result.derivatives.find((d) => d.kind === 'playback')!.objectKey)!
        .body,
    );
    expect((await probeFile(silentPath, DEFAULT_TOOL_CONFIG)).audio).toBeNull();
    const high = await prepare('high444', 'video/mp4');
    const highPath = await writeFixture(
      dir,
      'high.mp4',
      high.objects.get(high.result.derivatives.find((d) => d.kind === 'playback')!.objectKey)!.body,
    );
    expect((await probeFile(highPath, DEFAULT_TOOL_CONFIG)).video).toMatchObject({
      pixFmt: 'yuv420p',
      profile: 'High',
    });
  });
  it('applies rotation so playback, poster and frames are upright', async () => {
    const { result } = await prepare('rotated', 'video/mp4');
    for (const d of result.derivatives) expect(d.height).toBeGreaterThan(d.width);
  });
  it('fails closed when the derivative budget cannot hold the playback output', async () => {
    const bytes = fixture('h264-aac');
    const { objects, storage } = memoryStorage();
    objects.set('original', { body: bytes, contentType: 'video/mp4' });
    await expect(
      createMediaPreparer({
        scratchRoot: scratch,
        tools: DEFAULT_TOOL_CONFIG,
        derivativeAllowanceBytes: 4 * 1024 * 1024 + 70_000,
      }).prepare({
        lease: { kind: 'prepare_media' } as CaptureLease,
        originalKey: 'original',
        storage,
        media: { ...(await verify(bytes, 'video/mp4')), kind: 'video', byteSize: bytes.length },
        assertLive: async () => {},
        derivativeKey: (kind) => `attempt/${kind}`,
      }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect([...objects.keys()]).toEqual(['original']);
  });
  it('photos become a metadata-stripped oriented JPEG', async () => {
    const photo = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: '#335577' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const { objects, storage } = memoryStorage();
    objects.set('original', { body: photo, contentType: 'image/jpeg' });
    const result = await createMediaPreparer({
      scratchRoot: scratch,
      tools: DEFAULT_TOOL_CONFIG,
      derivativeAllowanceBytes: DEFAULT_CAPTURE_LIMITS.derivativeAllowanceBytes,
    }).prepare({
      lease: { kind: 'prepare_media' } as CaptureLease,
      originalKey: 'original',
      storage,
      media: {
        kind: 'photo',
        byteSize: photo.length,
        contentType: 'image/jpeg',
        width: 3000,
        height: 1000,
      },
      assertLive: async () => {},
      derivativeKey: (kind) => `attempt/${kind}`,
    });
    const [normalized] = result.derivatives;
    expect(normalized).toMatchObject({
      kind: 'normalized',
      width: 683,
      height: 2048,
      shareSafe: true,
    });
    const meta = await sharp(objects.get(normalized!.objectKey)!.body).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });
});

describe('frames-v1 selection', () => {
  it('spans the whole duration with at most eight deterministic targets', () => {
    expect(frameTargets(120000)).toHaveLength(8);
    expect(frameTargets(120000)[0]).toBe(7500);
    expect(frameTargets(120000).at(-1)).toBe(112500);
    expect(frameTargets(500)).toEqual([250]);
    expect(frameTargets(3000)).toEqual([500, 1500, 2500]);
  });
  it('snaps to real frames and collapses duplicates', () => {
    expect(nearestFrames([0, 400, 800], [100, 150, 790])).toEqual([
      { index: 0, timestampMs: 0 },
      { index: 2, timestampMs: 800 },
    ]);
  });
});
