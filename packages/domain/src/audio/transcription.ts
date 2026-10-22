import { AppError } from '../errors';

/**
 * ElevenLabs Scribe is the preferred later transcription candidate.
 * It stays disabled until zero-retention eligibility is proven. Music Mode
 * must not send private audio here in this slice.
 */
export const ELEVENLABS_TRANSCRIPTION = {
  preferred: true,
  enabled: false,
  reason: 'zero_retention_unproven',
  endpoint: 'https://api.elevenlabs.io/v1/speech-to-text',
  model_id: 'scribe_v2',
} as const;

export class DisabledElevenLabsTranscription {
  readonly enabled = false;
  readonly reason = ELEVENLABS_TRANSCRIPTION.reason;

  async transcribe(_input: { bytes: Uint8Array; signal: AbortSignal }): Promise<never> {
    throw new AppError('service_unavailable', {
      message: 'Spoken references are not available yet.',
    });
  }
}
