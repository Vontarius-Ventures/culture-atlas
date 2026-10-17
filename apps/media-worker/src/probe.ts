import { AppError } from '@culture-atlas/domain';
import { runTool, ToolError } from './process';

/** Worker-local tool configuration; every operation is time-bounded. */
export interface MediaToolConfig {
  ffmpegPath: string;
  ffprobePath: string;
  /** Decoder/encoder threads per process. */
  threads: number;
  probeTimeoutMs: number;
  decodeTimeoutMs: number;
  transcodeTimeoutMs: number;
}
export const DEFAULT_TOOL_CONFIG: MediaToolConfig = {
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  threads: 2,
  probeTimeoutMs: 20_000,
  decodeTimeoutMs: 180_000,
  transcodeTimeoutMs: 240_000,
};

export type Container = 'mp4' | 'mov' | 'webm';
/** Qualified container/codec combinations. A codec is only accepted after the worker's self-test decodes it. */
export const CODEC_MATRIX: Record<'isobmff' | 'webm', { video: string[]; audio: string[] }> = {
  isobmff: { video: ['h264', 'hevc'], audio: ['aac'] },
  webm: { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'] },
};
export interface QualifiedCodecs {
  video: ReadonlySet<string>;
  audio: ReadonlySet<string>;
}
export interface ProbeResult {
  container: Container;
  durationMs: number;
  bitRate: number | null;
  video: {
    codec: string;
    width: number;
    height: number;
    /** Dimensions after applying the rotation display matrix. */
    displayWidth: number;
    displayHeight: number;
    rotation: number;
    pixFmt: string | null;
    profile: string | null;
  };
  audio: { codec: string } | null;
  videoStreams: number;
  audioStreams: number;
}

/** Input options that keep demuxers on the local scratch file only. */
export const LOCAL_INPUT = ['-protocol_whitelist', 'file'];

export function unsupported(message: string): AppError {
  return new AppError('unsupported_media', { message, retryable: false });
}
/** Missing binaries or killed processes are worker faults (retry); hostile input is not. */
export function toolFailure(error: unknown, what: string): Error {
  if (error instanceof ToolError) {
    if (error.reason === 'spawn_failed')
      return new AppError('service_unavailable', { message: 'Media tools are unavailable.' });
    if (error.reason === 'aborted')
      return new AppError('service_unavailable', { message: 'Media work was interrupted.' });
    if (error.reason === 'timeout' || error.reason === 'output_limit')
      return unsupported(`This video could not be ${what} within the processing limits.`);
    return unsupported(`This video could not be ${what}.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function finite(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function probeFile(
  path: string,
  config: MediaToolConfig,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  let raw: string;
  try {
    raw = (
      await runTool(
        config.ffprobePath,
        [
          '-v',
          'error',
          ...LOCAL_INPUT,
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          path,
        ],
        { timeoutMs: config.probeTimeoutMs, signal },
      )
    ).stdout;
  } catch (error) {
    throw toolFailure(error, 'read');
  }
  let parsed: {
    format?: {
      format_name?: string;
      duration?: string;
      bit_rate?: string;
      tags?: Record<string, string>;
    };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
      profile?: string;
      disposition?: { attached_pic?: number };
      tags?: Record<string, string>;
      side_data_list?: Array<{ rotation?: number }>;
    }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unsupported('This video could not be read.');
  }
  const formatName = parsed.format?.format_name ?? '';
  const names = formatName.split(',');
  let container: Container;
  if (names.includes('mov') || names.includes('mp4')) {
    const brand = (parsed.format?.tags?.major_brand ?? '').trim();
    container = brand === 'qt' ? 'mov' : 'mp4';
  } else if (names.includes('webm') || names.includes('matroska')) container = 'webm';
  else throw unsupported('Use an MP4, MOV or WebM video.');
  const streams = parsed.streams ?? [];
  const videos = streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const v = videos[0];
  if (!v || !v.codec_name) throw unsupported('This file has no video stream.');
  const width = finite(v.width),
    height = finite(v.height);
  if (!width || !height || width < 1 || height < 1)
    throw unsupported('This video has invalid dimensions.');
  const rotationRaw =
    finite(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation) ??
    finite(v.tags?.rotate) ??
    0;
  const rotation = ((Math.round(rotationRaw) % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  const seconds = finite(parsed.format?.duration);
  return {
    container,
    durationMs: seconds && seconds > 0 ? Math.round(seconds * 1000) : 0,
    bitRate: finite(parsed.format?.bit_rate),
    video: {
      codec: v.codec_name,
      width,
      height,
      displayWidth: swap ? height : width,
      displayHeight: swap ? width : height,
      rotation,
      pixFmt: v.pix_fmt ?? null,
      profile: v.profile ?? null,
    },
    audio: audios[0]?.codec_name ? { codec: audios[0].codec_name } : null,
    videoStreams: videos.length,
    audioStreams: audios.length,
  };
}

export function containerFamily(container: Container): 'isobmff' | 'webm' {
  return container === 'webm' ? 'webm' : 'isobmff';
}

/** Declared MIME type, magic bytes, container and codecs must all agree with the qualified matrix. */
export function assertQualified(
  probe: ProbeResult,
  declaredType: string,
  head: Uint8Array,
  qualified: QualifiedCodecs,
): void {
  const family = containerFamily(probe.container);
  const declaredFamily =
    declaredType === 'video/webm'
      ? 'webm'
      : declaredType === 'video/mp4' || declaredType === 'video/quicktime'
        ? 'isobmff'
        : null;
  if (declaredFamily !== family)
    throw unsupported('The file contents do not match the declared video type.');
  if (!hasSignature(head, family))
    throw unsupported('The file contents do not match the declared video type.');
  const matrix = CODEC_MATRIX[family];
  if (!matrix.video.includes(probe.video.codec) || !qualified.video.has(probe.video.codec))
    throw unsupported('This video codec is not supported. Use H.264, HEVC, VP8, VP9 or AV1.');
  if (
    probe.audio &&
    (!matrix.audio.includes(probe.audio.codec) || !qualified.audio.has(probe.audio.codec))
  )
    throw unsupported('This audio codec is not supported. Use AAC, Opus or Vorbis audio.');
  if (probe.videoStreams > 1 || probe.audioStreams > 1)
    throw unsupported('Videos with multiple video or audio tracks are not supported.');
}

export function hasSignature(head: Uint8Array, family: 'isobmff' | 'webm'): boolean {
  if (family === 'webm')
    return (
      head.length >= 4 &&
      head[0] === 0x1a &&
      head[1] === 0x45 &&
      head[2] === 0xdf &&
      head[3] === 0xa3
    );
  if (head.length < 8) return false;
  const box = Buffer.from(head.subarray(4, 8)).toString('latin1');
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box);
}
