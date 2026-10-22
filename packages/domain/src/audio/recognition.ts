export const MUSIC_RECOGNITION_STATUSES = ['matched', 'ambiguous', 'no_match', 'unavailable'] as const;
export type MusicRecognitionStatus = (typeof MUSIC_RECOGNITION_STATUSES)[number];

export interface MusicRecognitionHit {
  vendor: string;
  vendor_recording_id: string | null;
  title: string | null;
  artist_name: string | null;
  album_title: string | null;
  artist_catalog_id: string | null;
  album_catalog_id: string | null;
  start_ms: number;
  end_ms: number;
  /** Vendor-documented scale only. Never shown as culture atlas confidence. */
  vendor_confidence: number | null;
}

export interface MusicRecognitionResult {
  status: MusicRecognitionStatus;
  reason: string | null;
  hits: MusicRecognitionHit[];
}

export interface MusicRecognitionInput {
  bytes: Uint8Array;
  startMs: number;
  endMs: number;
  signal: AbortSignal;
}

/** Licensed fingerprint adapter. Providers worker replaces the unavailable stub. */
export interface MusicRecognition {
  identify(input: MusicRecognitionInput): Promise<MusicRecognitionResult>;
}

export class UnavailableMusicRecognition implements MusicRecognition {
  constructor(readonly reason = 'not_configured') {}
  async identify(): Promise<MusicRecognitionResult> {
    return { status: 'unavailable', reason: this.reason, hits: [] };
  }
}

export function musicRecognitionFromConfig(): MusicRecognition {
  return new UnavailableMusicRecognition('not_configured');
}

export function publicMusicState(
  status: MusicRecognitionStatus,
): 'identified' | 'possible_matches' | 'no_reliable_match' | 'provider_unavailable' {
  switch (status) {
    case 'matched':
      return 'identified';
    case 'ambiguous':
      return 'possible_matches';
    case 'no_match':
      return 'no_reliable_match';
    case 'unavailable':
      return 'provider_unavailable';
  }
}
