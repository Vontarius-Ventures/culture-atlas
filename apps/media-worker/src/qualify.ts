import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DEFAULT_CAPTURE_LIMITS,
  type CaptureLease,
  type CaptureLimits,
} from '@culture-atlas/domain';
import type { MultipartStorage } from '@culture-atlas/providers';
import { runTool } from './process';
import { type MediaToolConfig, type QualifiedCodecs } from './probe';
import { createMediaPreparer } from './preparer';
import { createMediaVerifier } from './verifier';
import { withScratch } from './scratch';

/** Bump when the matrix, processing versions or qualification procedure change. */
export const QUALIFIED_MATRIX_VERSION = 'media-worker-2026-10-17.1';

interface Sample {
  video: string;
  audio: string | null;
  container: 'mp4' | 'webm';
  contentType: string;
  encoders: string[];
  args: string[];
}
const SAMPLES: Sample[] = [
  {
    video: 'h264',
    audio: 'aac',
    container: 'mp4',
    contentType: 'video/mp4',
    encoders: ['libx264', 'aac'],
    args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    video: 'hevc',
    audio: 'aac',
    container: 'mp4',
    contentType: 'video/mp4',
    encoders: ['libx265', 'aac'],
    args: [
      '-c:v',
      'libx265',
      '-tag:v',
      'hvc1',
      '-pix_fmt',
      'yuv420p',
      '-x265-params',
      'log-level=error',
      '-c:a',
      'aac',
    ],
  },
  {
    video: 'vp8',
    audio: 'vorbis',
    container: 'webm',
    contentType: 'video/webm',
    encoders: ['libvpx', 'libvorbis'],
    args: ['-c:v', 'libvpx', '-c:a', 'libvorbis'],
  },
  {
    video: 'vp9',
    audio: 'opus',
    container: 'webm',
    contentType: 'video/webm',
    encoders: ['libvpx-vp9', 'libopus'],
    args: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'],
  },
  {
    video: 'av1',
    audio: 'opus',
    container: 'webm',
    contentType: 'video/webm',
    encoders: ['libsvtav1', 'libopus'],
    args: ['-c:v', 'libsvtav1', '-preset', '12', '-pix_fmt', 'yuv420p', '-c:a', 'libopus'],
  },
];

export interface Qualification {
  qualified: QualifiedCodecs;
  /** Heartbeat payload: only true entries were exercised end to end on this host. */
  codecs: Record<string, boolean>;
  /** True when the transcode/poster/frames pipeline itself passed. */
  preparation: boolean;
}

async function toolNames(config: MediaToolConfig, flag: '-decoders' | '-encoders') {
  const { stdout } = await runTool(config.ffmpegPath, ['-hide_banner', flag], {
    timeoutMs: 10_000,
  });
  return new Set(
    stdout
      .split('\n')
      .map((line) => /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line)?.[1])
      .filter((n): n is string => !!n),
  );
}

/** Generates a short synthetic clip with the worker's own encoder (fixed lavfi input, no user data). */
export async function synthesizeClip(
  config: MediaToolConfig,
  path: string,
  options: { args: string[]; seconds: number; size?: string; audio?: boolean; rate?: number },
) {
  await runTool(
    config.ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${options.size ?? '160x120'}:rate=${options.rate ?? 15}:duration=${options.seconds}`,
      ...(options.audio === false
        ? []
        : ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${options.seconds}`]),
      ...options.args,
      ...(options.audio === false ? ['-an'] : ['-shortest']),
      '-y',
      path,
    ],
    { timeoutMs: 60_000 },
  );
}

/**
 * Self-test run at startup (and periodically): every codec is only marked qualified
 * after a synthetic clip passes the same verifier used for customer uploads, and
 * video is only advertised after the full preparation pipeline succeeds here.
 */
export async function qualifyWorker(
  config: MediaToolConfig,
  scratchRoot: string,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): Promise<Qualification> {
  const codecs: Record<string, boolean> = {};
  const video = new Set<string>(),
    audio = new Set<string>();
  let decoders: Set<string>, encoders: Set<string>;
  try {
    [decoders, encoders] = await Promise.all([
      toolNames(config, '-decoders'),
      toolNames(config, '-encoders'),
    ]);
  } catch {
    return { qualified: { video, audio }, codecs, preparation: false };
  }
  let preparation = false;
  await withScratch(scratchRoot, async (dir) => {
    for (const sample of SAMPLES) {
      const key = `${sample.container}/${sample.video}/${sample.audio}`;
      codecs[key] = false;
      if (!sample.encoders.every((e) => encoders.has(e)) || !decoders.has(sample.video)) continue;
      const path = join(dir, `${sample.video}.${sample.container}`);
      try {
        await synthesizeClip(config, path, { args: sample.args, seconds: 1 });
        const bytes = await readFile(path);
        const verifier = createMediaVerifier({
          scratchRoot: dir,
          tools: config,
          qualified: {
            video: new Set([sample.video]),
            audio: new Set(sample.audio ? [sample.audio] : []),
          },
        });
        await verifier.verify({
          body: Readable.from([bytes]),
          kind: 'video',
          contentType: sample.contentType,
          byteSize: bytes.length,
          limits,
        });
        codecs[key] = true;
        video.add(sample.video);
        if (sample.audio) audio.add(sample.audio);
      } catch {
        codecs[key] = false;
      }
    }
    if (video.has('h264') && audio.has('aac')) {
      try {
        preparation = await selfTestPreparation(config, dir, limits);
      } catch {
        preparation = false;
      }
    }
  });
  codecs['prepare/mp4/h264/aac'] = preparation;
  if (!preparation) for (const k of Object.keys(codecs)) codecs[k] = false;
  return {
    qualified: preparation ? { video, audio } : { video: new Set(), audio: new Set() },
    codecs,
    preparation,
  };
}

async function selfTestPreparation(config: MediaToolConfig, dir: string, limits: CaptureLimits) {
  const path = join(dir, 'prepare.webm');
  // A non-remuxable source exercises transcode, poster and frames.
  await synthesizeClip(config, path, {
    args: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'],
    seconds: 2,
  });
  const source = await readFile(path);
  const objects = new Map<string, Buffer>();
  const storage = {
    async read(key: string) {
      const body = objects.get(key);
      if (!body) throw new Error('missing');
      return { body: Readable.from([body]), contentType: 'video/webm', byteSize: body.length };
    },
    async put(key: string, body: AsyncIterable<Uint8Array>) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    },
  } as unknown as MultipartStorage;
  objects.set('self-test/original', source);
  const preparer = createMediaPreparer({
    scratchRoot: dir,
    tools: config,
    derivativeAllowanceBytes: limits.derivativeAllowanceBytes,
  });
  const result = await preparer.prepare({
    lease: { kind: 'prepare_media' } as CaptureLease,
    originalKey: 'self-test/original',
    storage,
    media: {
      kind: 'video',
      byteSize: source.length,
      contentType: 'video/webm',
      width: 160,
      height: 120,
      durationMs: 2000,
      audioPresent: true,
    },
    assertLive: async () => {},
    derivativeKey: (kind, suffix) => `self-test/${kind}${suffix ? `-${suffix}` : ''}`,
  });
  const kinds = result.derivatives.map((d) => d.kind);
  return (
    kinds.includes('playback') &&
    kinds.includes('poster') &&
    kinds.filter((k) => k === 'frame').length >= 1 &&
    result.derivatives.every(
      (d) =>
        objects.has(d.objectKey) &&
        createHash('sha256').update(objects.get(d.objectKey)!).digest('hex') === d.checksum,
    )
  );
}
