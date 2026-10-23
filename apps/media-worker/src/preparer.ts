import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import {
  AppError,
  type MediaPreparationInput,
  type MediaPreparer,
  type PreparedDerivative,
  type PreparedMedia,
} from '@culture-atlas/domain';
import { runTool } from './process';
import { LOCAL_INPUT, probeFile, toolFailure, unsupported, type MediaToolConfig } from './probe';
import { withScratch, writeBounded } from './scratch';

/** Pinned processing versions; a change here is a new version, never an in-place rewrite. */
export const PROCESSING_VERSIONS = {
  normalized: 'normalized-jpeg-v1',
  playback: 'playback-mp4-h264-aac-v1',
  poster: 'poster-jpeg-v1',
  frames: 'frames-v1',
} as const;
export const MAX_FRAMES = 8;
const FRAME_LONG_EDGE = 1024;
const POSTER_LONG_EDGE = 1280;
const STILLS_RESERVE_BYTES = 4 * 1024 * 1024;
const AUDIO_KBPS = 96;

export interface PreparerOptions {
  scratchRoot: string;
  tools: MediaToolConfig;
  /** Total bytes all derivatives of one asset may use (reserved at upload time). */
  derivativeAllowanceBytes: number;
  /** False until this worker passed video qualification; video work then retries later. */
  videoEnabled?: boolean;
  signal?: AbortSignal;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Deterministic frames-v1 targets: n midpoints of equal slices spanning the whole duration. */
export function frameTargets(durationMs: number, max = MAX_FRAMES): number[] {
  const n = Math.min(max, Math.max(1, Math.floor(durationMs / 1000)));
  return Array.from({ length: n }, (_, i) => Math.floor(((i + 0.5) * durationMs) / n));
}
/** Map each target to the nearest real presentation timestamp; duplicates collapse. */
export function nearestFrames(
  ptsMs: number[],
  targets: number[],
): Array<{ index: number; timestampMs: number }> {
  const chosen = new Map<number, number>();
  for (const target of targets) {
    let best = 0;
    for (let i = 1; i < ptsMs.length; i++)
      if (Math.abs(ptsMs[i]! - target) < Math.abs(ptsMs[best]! - target)) best = i;
    if (ptsMs.length) chosen.set(best, ptsMs[best]!);
  }
  return [...chosen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, timestampMs]) => ({ index, timestampMs }));
}
function even(n: number): number {
  return Math.max(2, 2 * Math.round(n / 2));
}
export function fitWithin(width: number, height: number, longEdge: number) {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return { width: even(width * scale), height: even(height * scale) };
}

/**
 * Photo: oriented, metadata-stripped JPEG ≤2048px. Video: probe → validate →
 * remux or transcode to a faststart H.264/AAC MP4 inside the reserved byte budget
 * → poster → ≤8 representative frames with their actual timestamps (frames-v1).
 * Output is written only under the attempt namespace supplied by the domain.
 */
export function createMediaPreparer(options: PreparerOptions): MediaPreparer {
  return {
    prepare(input) {
      if (input.media.kind === 'video' && options.videoEnabled === false)
        throw new AppError('service_unavailable', { message: 'Video preparation is unavailable.' });
      return input.media.kind === 'photo' ? preparePhoto(input) : prepareVideo(input, options);
    },
  };
}

async function readAll(input: MediaPreparationInput, max: number): Promise<Buffer> {
  const object = await input.storage.read(input.originalKey);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of object.body) {
    bytes += chunk.byteLength;
    if (bytes > max) throw new AppError('payload_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function preparePhoto(input: MediaPreparationInput): Promise<PreparedMedia> {
  const source = await readAll(input, input.media.byteSize);
  let output: { data: Buffer; info: { width: number; height: number } };
  try {
    output = await sharp(source, { failOn: 'warning', animated: false, limitInputPixels: 40000000 })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: false })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AppError('unsupported_image', { message: 'This photo could not be prepared.' });
  }
  const key = input.derivativeKey('normalized');
  await input.assertLive();
  await input.storage.put(key, Readable.from([output.data]), 'image/jpeg', output.data.byteLength);
  return {
    derivatives: [
      {
        kind: 'normalized',
        processingVersion: PROCESSING_VERSIONS.normalized,
        objectKey: key,
        checksum: createHash('sha256').update(output.data).digest('hex'),
        byteSize: output.data.byteLength,
        width: output.info.width,
        height: output.info.height,
        // sharp drops EXIF/XMP/ICC metadata unless explicitly kept.
        shareSafe: true,
      },
    ],
  };
}

async function prepareVideo(
  input: MediaPreparationInput,
  options: PreparerOptions,
): Promise<PreparedMedia> {
  const { tools, signal } = options;
  const run = async (args: string[], what: string, timeoutMs = tools.transcodeTimeoutMs) => {
    try {
      return await runTool(tools.ffmpegPath, ['-nostdin', '-hide_banner', '-v', 'error', ...args], {
        timeoutMs,
        signal,
      });
    } catch (error) {
      throw toolFailure(error, what);
    }
  };
  return withScratch(options.scratchRoot, async (dir) => {
    const source = join(dir, 'source');
    const object = await input.storage.read(input.originalKey);
    await writeBounded(object.body, source, input.media.byteSize);
    const probe = await probeFile(source, tools, signal);
    const durationMs = input.media.durationMs ?? probe.durationMs;
    if (!durationMs || durationMs <= 0) throw unsupported('This video has no duration.');
    const hasAudio = !!probe.audio;
    if (hasAudio !== !!input.media.audioPresent)
      throw unsupported('The audio track changed after verification.');

    // Byte budget: playback + poster + frames must fit the reservation made at upload.
    const playbackMax = options.derivativeAllowanceBytes - STILLS_RESERVE_BYTES;
    if (playbackMax <= 0) throw new AppError('quota_exceeded');
    const seconds = durationMs / 1000;
    const longEdge = Math.max(probe.video.displayWidth, probe.video.displayHeight);
    const remux =
      (probe.container === 'mp4' || probe.container === 'mov') &&
      probe.video.codec === 'h264' &&
      probe.video.pixFmt === 'yuv420p' &&
      // Only profiles every browser/phone decoder plays; High 4:4:4/10-bit are transcoded.
      ['Baseline', 'Constrained Baseline', 'Main', 'High'].includes(probe.video.profile ?? '') &&
      probe.video.rotation === 0 &&
      longEdge <= 1920 &&
      (!probe.audio || probe.audio.codec === 'aac') &&
      input.media.byteSize <= playbackMax * 0.9;
    const playback = join(dir, 'playback.mp4');
    const common = [
      '-threads',
      String(tools.threads),
      ...LOCAL_INPUT,
      '-i',
      source,
      '-map',
      '0:v:0',
      ...(hasAudio ? ['-map', '0:a:0'] : []),
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-sn',
      '-dn',
    ];
    if (remux) {
      await run(
        [
          ...common,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-fs',
          String(playbackMax),
          '-f',
          'mp4',
          playback,
        ],
        'prepared',
      );
    } else {
      const totalKbps = Math.floor((playbackMax * 8) / seconds / 1000);
      const videoKbps = Math.max(250, Math.min(4000, Math.floor((totalKbps - AUDIO_KBPS) * 0.85)));
      const edge = Math.min(longEdge, videoKbps >= 2500 ? 1920 : videoKbps >= 1200 ? 1280 : 854);
      // Decoders auto-rotate, so the scale target uses display dimensions.
      const size = fitWithin(probe.video.displayWidth, probe.video.displayHeight, edge);
      await run(
        [
          ...common,
          '-vf',
          `scale=${size.width}:${size.height},format=yuv420p`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-profile:v',
          'high',
          '-crf',
          '23',
          '-maxrate',
          `${videoKbps}k`,
          '-bufsize',
          `${videoKbps * 2}k`,
          ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ac', '2'] : []),
          '-movflags',
          '+faststart',
          '-fs',
          String(playbackMax),
          '-f',
          'mp4',
          playback,
        ],
        'prepared',
      );
    }
    const playbackSize = (await stat(playback)).size;
    // -fs truncates silently; output at the cap is a budget failure, not a playable file.
    if (playbackSize >= playbackMax - 65536)
      throw new AppError('quota_exceeded', {
        message: 'Prepared media exceeds its reserved storage allowance.',
      });
    const out = await probeFile(playback, tools, signal);
    if (out.video.codec !== 'h264') throw unsupported('This video could not be prepared.');
    // Never silently drop or invent audio.
    if (!!out.audio !== hasAudio)
      throw unsupported('The audio track of this video could not be prepared.');

    // Poster near one second (or mid-clip for very short clips), from the playable output.
    const poster = join(dir, 'poster.jpg');
    const posterAt = Math.min(1000, Math.floor(durationMs / 2)) / 1000;
    const posterSize = fitWithin(out.video.displayWidth, out.video.displayHeight, POSTER_LONG_EDGE);
    await run(
      [
        '-threads',
        String(tools.threads),
        '-ss',
        posterAt.toFixed(3),
        ...LOCAL_INPUT,
        '-i',
        playback,
        '-frames:v',
        '1',
        '-vf',
        `scale=${posterSize.width}:${posterSize.height}`,
        '-q:v',
        '3',
        poster,
      ],
      'given a poster',
      tools.probeTimeoutMs * 3,
    );

    // frames-v1: real presentation timestamps of the playback output.
    let packets;
    try {
      packets = await runTool(
        tools.ffprobePath,
        [
          '-v',
          'error',
          ...LOCAL_INPUT,
          '-select_streams',
          'v:0',
          '-show_entries',
          'packet=pts_time',
          '-of',
          'csv=p=0',
          playback,
        ],
        { timeoutMs: tools.probeTimeoutMs, signal, maxStdoutBytes: 2 * 1024 * 1024 },
      );
    } catch (error) {
      throw toolFailure(error, 'indexed');
    }
    const pts = packets.stdout
      .split('\n')
      .map((line) => Number(line.trim().replace(/,$/, '')))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (!pts.length) throw unsupported('This video has no frames.');
    const origin = pts[0]!;
    const ptsMs = pts.map((t) => Math.max(0, Math.floor((t - origin) * 1000)));
    const chosen = nearestFrames(ptsMs, frameTargets(durationMs)).map((f) => ({
      ...f,
      timestampMs: Math.min(f.timestampMs, durationMs - 1),
    }));
    const frameSize = fitWithin(out.video.displayWidth, out.video.displayHeight, FRAME_LONG_EDGE);
    await run(
      [
        '-threads',
        String(tools.threads),
        ...LOCAL_INPUT,
        '-i',
        playback,
        '-map',
        '0:v:0',
        '-vf',
        `select=${chosen.map((f) => `eq(n\\,${f.index})`).join('+')},scale=${frameSize.width}:${frameSize.height}`,
        '-fps_mode',
        'passthrough',
        '-q:v',
        '4',
        join(dir, 'frame-%02d.jpg'),
      ],
      'sampled',
    );

    const derivatives: PreparedDerivative[] = [];
    const publish = async (
      path: string,
      kind: PreparedDerivative['kind'],
      contentType: string,
      processingVersion: string,
      extra: Partial<PreparedDerivative> & { width: number; height: number },
      suffix?: string,
    ) => {
      const size = (await stat(path)).size;
      const key = input.derivativeKey(kind, suffix);
      await input.assertLive();
      await input.storage.put(key, createReadStream(path), contentType, size);
      derivatives.push({
        kind,
        processingVersion,
        objectKey: key,
        checksum: await sha256File(path),
        byteSize: size,
        shareSafe: true,
        ...extra,
      });
    };
    await publish(playback, 'playback', 'video/mp4', PROCESSING_VERSIONS.playback, {
      width: out.video.displayWidth,
      height: out.video.displayHeight,
      durationMs: Math.min(durationMs, Math.max(1, out.durationMs || durationMs)),
    });
    const posterMeta = await sharp(await readFile(poster)).metadata();
    await publish(poster, 'poster', 'image/jpeg', PROCESSING_VERSIONS.poster, {
      width: posterMeta.width!,
      height: posterMeta.height!,
    });
    for (const [i, frame] of chosen.entries()) {
      const path = join(dir, `frame-${String(i + 1).padStart(2, '0')}.jpg`);
      const meta = await sharp(
        await readFile(path).catch(() => {
          throw unsupported('A representative frame could not be extracted.');
        }),
      ).metadata();
      await publish(
        path,
        'frame',
        'image/jpeg',
        `${PROCESSING_VERSIONS.frames}:${frame.timestampMs}`,
        { width: meta.width!, height: meta.height!, timestampMs: frame.timestampMs },
        `${frame.timestampMs}`,
      );
    }
    return { derivatives, extractionVersion: PROCESSING_VERSIONS.frames };
  });
}
