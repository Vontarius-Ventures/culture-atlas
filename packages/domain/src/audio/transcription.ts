import { AppError } from '../errors';

/**
 * ElevenLabs Scribe is the preferred Music Mode transcript adapter.
 * The compile-time default stays disabled until an API key is present.
 * Explore still requests music_match only; transcription is an internal
 * seed for Qloo artist search, not a client-facing speech_references task.
 */
export const ELEVENLABS_TRANSCRIPTION = {
  preferred: true,
  enabled: false,
  reason: 'api_key_missing',
  endpoint: 'https://api.elevenlabs.io/v1/speech-to-text',
  model_id: 'scribe_v2',
} as const;

export interface TranscriptWord {
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface TranscriptResult {
  text: string;
  words: TranscriptWord[];
}

export interface TranscribeInput {
  bytes: Uint8Array;
  signal: AbortSignal;
  /** Stored MIME. Native Music Mode records AAC locally but uploads PCM WAV (iOS CaptureController keep path, Android AudioModels), so originals are audio/wav today. */
  mediaType?: string;
}

export interface AudioTranscription {
  readonly enabled: boolean;
  readonly reason: string;
  transcribe(input: TranscribeInput): Promise<TranscriptResult>;
}

const AUDIO_UPLOAD: Record<string, { type: string; filename: string }> = {
  'audio/wav': { type: 'audio/wav', filename: 'clip.wav' },
  'audio/wave': { type: 'audio/wav', filename: 'clip.wav' },
  'audio/x-wav': { type: 'audio/wav', filename: 'clip.wav' },
  'audio/mp4': { type: 'audio/mp4', filename: 'clip.m4a' },
  'audio/m4a': { type: 'audio/mp4', filename: 'clip.m4a' },
  'audio/x-m4a': { type: 'audio/mp4', filename: 'clip.m4a' },
  'audio/aac': { type: 'audio/aac', filename: 'clip.aac' },
  'audio/mpeg': { type: 'audio/mpeg', filename: 'clip.mp3' },
  'audio/mp3': { type: 'audio/mpeg', filename: 'clip.mp3' },
  'audio/flac': { type: 'audio/flac', filename: 'clip.flac' },
  'audio/webm': { type: 'audio/webm', filename: 'clip.webm' },
  'audio/ogg': { type: 'audio/ogg', filename: 'clip.ogg' },
};

/** Prefer the stored MIME, then sniff, then fail closed as octet-stream. Never relabel AAC as WAV. */
export function audioUploadFile(input: { bytes: Uint8Array; mediaType?: string }): {
  type: string;
  filename: string;
} {
  const declared = input.mediaType?.trim().toLowerCase();
  if (declared && AUDIO_UPLOAD[declared]) return AUDIO_UPLOAD[declared];
  const sniffed = sniffAudioType(input.bytes);
  if (sniffed && AUDIO_UPLOAD[sniffed]) return AUDIO_UPLOAD[sniffed];
  if (declared && declared.startsWith('audio/')) {
    return { type: declared, filename: 'clip.bin' };
  }
  return { type: 'application/octet-stream', filename: 'clip.bin' };
}

export function sniffAudioType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'audio/wav';
  const box = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
  if (box === 'ftyp') return 'audio/mp4';
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg';
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return 'audio/flac';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm';
  return null;
}

export class DisabledElevenLabsTranscription implements AudioTranscription {
  readonly enabled = false;
  constructor(readonly reason = ELEVENLABS_TRANSCRIPTION.reason) {}

  async transcribe(_input: TranscribeInput): Promise<never> {
    throw new AppError('service_unavailable', {
      message: 'Spoken references are not available yet.',
    });
  }
}

export interface ElevenLabsScribeOptions {
  apiKey: string;
  modelId?: string;
  requireZeroRetention?: boolean;
  endpoint?: string;
  fetch?: typeof fetch;
}

interface ScribeWord {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  type?: unknown;
}

interface ScribeResponse {
  text?: unknown;
  words?: ScribeWord[];
}

function secondsToMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 1000);
}

function parseScribe(body: ScribeResponse): TranscriptResult {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const words: TranscriptWord[] = [];
  for (const word of body.words ?? []) {
    if (word.type === 'spacing') continue;
    const token = typeof word.text === 'string' ? word.text.trim() : '';
    const start_ms = secondsToMs(word.start);
    const end_ms = secondsToMs(word.end);
    if (!token || start_ms === null || end_ms === null || end_ms <= start_ms) continue;
    words.push({ text: token, start_ms, end_ms });
  }
  return { text, words };
}

/**
 * POST /v1/speech-to-text with Scribe v2. Owner-approved Music Mode route:
 * send enable_logging=false only when requireZeroRetention is set (enterprise).
 */
export class ElevenLabsScribeTranscription implements AudioTranscription {
  readonly enabled = true;
  readonly reason = 'configured';
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly requireZeroRetention: boolean;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ElevenLabsScribeOptions) {
    this.apiKey = options.apiKey;
    this.modelId = options.modelId ?? ELEVENLABS_TRANSCRIPTION.model_id;
    this.requireZeroRetention = options.requireZeroRetention === true;
    this.endpoint = options.endpoint ?? ELEVENLABS_TRANSCRIPTION.endpoint;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    const upload = audioUploadFile({ bytes: input.bytes, mediaType: input.mediaType });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(input.bytes)], { type: upload.type }), upload.filename);
    form.append('model_id', this.modelId);
    form.append('timestamps_granularity', 'word');
    form.append('diarize', 'false');
    if (this.requireZeroRetention) form.append('enable_logging', 'false');
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: form,
      signal: input.signal,
    });
    if (!response.ok) {
      throw new AppError('service_unavailable', {
        message: 'Transcript lookup is unavailable.',
        details: { status: response.status },
      });
    }
    const body = (await response.json()) as ScribeResponse;
    return parseScribe(body);
  }
}

export function elevenLabsFromConfig(config: {
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_TRANSCRIPTION_MODEL?: string;
  ELEVENLABS_REQUIRE_ZERO_RETENTION?: boolean;
}): AudioTranscription {
  const apiKey = config.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return new DisabledElevenLabsTranscription('api_key_missing');
  return new ElevenLabsScribeTranscription({
    apiKey,
    modelId: config.ELEVENLABS_TRANSCRIPTION_MODEL,
    requireZeroRetention: config.ELEVENLABS_REQUIRE_ZERO_RETENTION === true,
  });
}
