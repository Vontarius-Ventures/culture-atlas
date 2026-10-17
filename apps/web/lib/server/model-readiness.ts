import { getProviders, type ModelGateway, type ModelRole } from '@culture-atlas/providers';

/**
 * Read-only model readiness for the v2 capture surfaces. Never sends a model
 * request (no paid probe): it reads profiles, qualification artifacts and the
 * durable spend ledger (credit pause, throttle, role circuits).
 */
export type AnalysisAvailability = 'available' | 'waiting' | 'unavailable';

const ROLE_FOR_MODE: Record<'photo' | 'selected_frame' | 'sampled_video', ModelRole> = {
  photo: 'vision_photo',
  selected_frame: 'vision_video_frame',
  sampled_video: 'vision_video_frame',
};

export async function roleAvailability(
  role: ModelRole,
  gateway: ModelGateway | undefined = getProviders().modelGateway,
  hasFallback: boolean = !!getProviders().fallbackVlm,
): Promise<AnalysisAvailability> {
  const primary = await gatewayAvailability(role, gateway);
  // MODEL_FALLBACK=elorian (explicit operator choice): the worker sends vision
  // work to Elorian when the gateway cannot serve the role.
  return primary === 'unavailable' && hasFallback ? 'available' : primary;
}

async function gatewayAvailability(
  role: ModelRole,
  gateway: ModelGateway | undefined,
): Promise<AnalysisAvailability> {
  // v2 media analysis runs on the Concentrate gateway (plus the explicit
  // MODEL_FALLBACK above). A Featherless/Anthropic rollback is not rerouted here.
  if (!gateway) return 'unavailable';
  try {
    const detail = (await gateway.readiness())[role];
    if (detail.state === 'qualified' || detail.state === 'available') return 'available';
    // Credits/throttling pause AI only: accept and queue; work resumes after recovery.
    if (detail.state === 'degraded') return 'waiting';
    if (
      detail.state === 'unavailable' &&
      (detail.reason === 'credits' || detail.reason === 'cost_overrun')
    )
      return 'waiting';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export function analysisAvailability(
  mode: 'photo' | 'selected_frame' | 'sampled_video',
): Promise<AnalysisAvailability> {
  return roleAvailability(ROLE_FOR_MODE[mode]);
}

/** `concentrate_analysis_enabled`: key + qualified profile + privacy + budget + readiness, right now. */
export async function photoAnalysisReady(): Promise<boolean> {
  return (await roleAvailability('vision_photo')) === 'available';
}

/**
 * Readiness input for the server-side feature flags (identity-ops flag
 * evaluation). Read-only: derived from the same gateway readiness as above.
 * A credit/throttle pause keeps the provider "ready" (work queues and resumes)
 * but reports the budget as unavailable, so the capability stays off.
 */
export async function photoAnalysisReadiness(): Promise<{
  budgetAvailable: boolean;
  providerReady: boolean;
}> {
  const availability = await roleAvailability('vision_photo');
  return {
    providerReady: availability !== 'unavailable',
    budgetAvailable: availability === 'available',
  };
}
