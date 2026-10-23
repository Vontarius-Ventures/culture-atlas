import { join } from 'node:path';
import {
  AppError,
  photoMediaVerifier,
  type MediaVerifier,
  type VerifiedMedia,
} from '@culture-atlas/domain';
import { runTool } from './process';
import {
  LOCAL_INPUT,
  assertQualified,
  probeFile,
  toolFailure,
  unsupported,
  type MediaToolConfig,
  type QualifiedCodecs,
} from './probe';
import { withScratch, writeBounded } from './scratch';

export const MAX_VIDEO_EDGE = 8192;

export interface VerifierOptions {
  scratchRoot: string;
  tools: MediaToolConfig;
  qualified: QualifiedCodecs;
  signal?: AbortSignal;
}

/**
 * Server-side content verification. Photos use the bounded sharp decoder.
 * Videos are written to a private scratch file, probed, checked against the
 * declared type, magic bytes and the qualified codec matrix, then fully decoded
 * (video and audio) with a duration cap. Any decoder error rejects the file:
 * multithreaded ffmpeg can exit 0 on damaged streams, so stderr is authoritative.
 */
export function createMediaVerifier(options: VerifierOptions): MediaVerifier {
  return {
    async verify(input): Promise<VerifiedMedia> {
      if (input.kind === 'photo') return photoMediaVerifier.verify(input);
      // An unqualified worker must not reject customer video as invalid; the job retries.
      if (!options.qualified.video.size)
        throw new AppError('service_unavailable', {
          message: 'Video verification is unavailable.',
        });
      return withScratch(options.scratchRoot, async (dir) => {
        const path = join(dir, 'source');
        const { head } = await writeBounded(input.body, path, input.limits.videoMaxBytes);
        const probe = await probeFile(path, options.tools, options.signal);
        assertQualified(probe, input.contentType, head, options.qualified);
        const { displayWidth: width, displayHeight: height } = probe.video;
        if (
          width > MAX_VIDEO_EDGE ||
          height > MAX_VIDEO_EDGE ||
          width * height > input.limits.photoMaxPixels
        )
          throw unsupported('This video resolution is larger than supported.');
        const capSeconds = (input.limits.videoMaxDurationMs + 1000) / 1000;
        let decoded;
        try {
          decoded = await runTool(
            options.tools.ffmpegPath,
            [
              '-nostdin',
              '-hide_banner',
              '-v',
              'error',
              '-xerror',
              '-threads',
              String(options.tools.threads),
              ...LOCAL_INPUT,
              '-i',
              path,
              '-map',
              '0:v:0',
              ...(probe.audio ? ['-map', '0:a:0'] : []),
              '-t',
              String(capSeconds),
              '-f',
              'null',
              '-',
              '-progress',
              'pipe:1',
              '-nostats',
            ],
            { timeoutMs: options.tools.decodeTimeoutMs, signal: options.signal },
          );
        } catch (error) {
          throw toolFailure(error, 'decoded');
        }
        if (decoded.stderr.trim())
          throw unsupported('This video is damaged and could not be decoded.');
        const times = [...decoded.stdout.matchAll(/^out_time_us=(\d+)$/gm)].map((m) =>
          Number(m[1]),
        );
        const decodedMs = Math.round((times.at(-1) ?? 0) / 1000);
        const durationMs = Math.max(probe.durationMs, decodedMs);
        if (!decodedMs || durationMs <= 0) throw unsupported('This video has no decodable frames.');
        return {
          contentType: input.contentType,
          width,
          height,
          durationMs,
          audioPresent: !!probe.audio,
          container: probe.container,
          codecs: [probe.video.codec, ...(probe.audio ? [probe.audio.codec] : [])],
        };
      });
    },
  };
}
