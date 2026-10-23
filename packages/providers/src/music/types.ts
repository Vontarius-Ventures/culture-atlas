import type { CapabilityEntry } from '../capabilities';
import type { CallOptions } from '../errors';

/**
 * Future music-recognition adapter (AUDIO-AND-MULTIMODAL.md). Concentrate is
 * not a music-identification service. Until a licensed fingerprint/catalog
 * provider is procured and qualified, the registry exposes an unavailable
 * stub that never fabricates matches.
 *
 * Outcomes stay in the documented set. Confidence stays on the vendor's own
 * scale and is never compared across vendors.
 */
export const MUSIC_MATCH_OUTCOMES = ['matched', 'ambiguous', 'no_match', 'unavailable'] as const;
export type MusicMatchOutcome = (typeof MUSIC_MATCH_OUTCOMES)[number];

export interface MusicRecognitionRequest {
  /** Bounded owner-authorized snippet. Never a full original upload. */
  audio: { bytes: Uint8Array; mediaType: string };
  durationMs?: number;
}

export interface MusicRecognitionMatch {
  recordingId: string;
  artist: string | null;
  title: string | null;
  release: string | null;
  startMs: number | null;
  endMs: number | null;
  /** Provider-native confidence; never compared across vendors. */
  confidence: { scale: string; value: number } | null;
}

export interface MusicRecognitionResult {
  outcome: MusicMatchOutcome;
  matches: MusicRecognitionMatch[];
  provider: string;
}

export interface MusicRecognitionProvider {
  readonly id: string;
  capability(): CapabilityEntry;
  recognize(
    input: MusicRecognitionRequest,
    options?: CallOptions,
  ): Promise<MusicRecognitionResult>;
}
