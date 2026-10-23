import type { AnalysisResponse } from './media-api';

/**
 * Consumer treatment of an exploration (media analysis) request, following the
 * CONCENTRATE "Failure behavior" table and BACKEND-CONTRACTS analysis states
 * (queued/running/partial/complete/failed/cancelled). Pure, so the screen and
 * its tests share one mapping.
 */
export type ExploreState =
  /** complete, or partial with a usable result: open it. */
  | { kind: 'result'; url: string }
  /** Paused by a 429 or by credits: “Waiting to explore” with Cancel. */
  | { kind: 'waiting' }
  /** Queued or running normally. */
  | { kind: 'working' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export const EXPLORE_UNAVAILABLE = 'Exploration is temporarily unavailable.';
export const EXPLORE_COULD_NOT = 'We couldn’t explore this media.';
export const EXPLORE_WAITING = 'Waiting to explore';

/** 401/402/404/422 and unconfigured models: the same unavailable copy (library keeps working). */
const UNAVAILABLE_CODES = new Set([
  'analysis_unavailable',
  'ai_paused',
  'provider_unconfigured',
  'model_unqualified',
  'service_unavailable',
  'provider_unavailable',
]);
/** 400, refusals, incomplete or invalid output: nonretryable for this input. */
const INPUT_CODES = new Set([
  'model_input_rejected',
  'model_declined',
  'model_incomplete',
  'model_invalid_output',
  'media_unreadable',
]);

export function exploreFailureMessage(
  code: string | null | undefined,
  media: { kind: 'photo' | 'video' },
): string {
  if (code && UNAVAILABLE_CODES.has(code))
    return `${EXPLORE_UNAVAILABLE} Your ${media.kind} stays in your library.`;
  if (code && INPUT_CODES.has(code))
    return media.kind === 'video'
      ? `${EXPLORE_COULD_NOT} Choose a different moment and try again. Your video stays in your library.`
      : `${EXPLORE_COULD_NOT} Your photo stays in your library; try exploring a different photo.`;
  if (code === 'analysis_allowance_exhausted')
    return 'You have reached today’s exploring allowance. Your media stays in your library. Try again tomorrow.';
  // 424/5xx, timeouts and deadlines: retryable later, never a fake result.
  return 'Exploring did not finish. Your media is still saved. Try again later.';
}

export function exploreState(
  analysis: Pick<AnalysisResponse, 'state' | 'result_url' | 'waiting_reason' | 'error_code'>,
  media: { kind: 'photo' | 'video' },
): ExploreState {
  switch (analysis.state) {
    case 'complete':
    case 'partial':
      // A partial video reading (some frames failed) is still a usable result.
      return analysis.result_url
        ? { kind: 'result', url: analysis.result_url }
        : { kind: 'failed', message: exploreFailureMessage(analysis.error_code, media) };
    case 'failed':
      return { kind: 'failed', message: exploreFailureMessage(analysis.error_code, media) };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'queued':
      return analysis.waiting_reason ? { kind: 'waiting' } : { kind: 'working' };
    default:
      return { kind: 'working' };
  }
}
