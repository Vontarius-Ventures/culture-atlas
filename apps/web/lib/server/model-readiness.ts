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
 * Each flag input has exactly one cause, so an unqualified role reports only
 * model_unqualified: budget comes from the spend ledger (credit/cost pause),
 * provider readiness from gateway health (circuit, auth, configuration).
 */
export async function photoAnalysisReadiness(
  gateway: ModelGateway | undefined = getProviders().modelGateway,
  hasFallback: boolean = !!getProviders().fallbackVlm,
): Promise<{
  budgetAvailable: boolean;
  providerReady: boolean;
  qualityQualified: boolean;
  enrichReady: boolean;
  verifyReady: boolean;
  experimental: boolean;
  /** How vision_photo got its runner (style design §D.1): experimental_production, demo_override, qualified... */
  access?: string;
  /** Style design §D.3: the style reading's own availability (photo analysis stays available without it). */
  styleReady?: boolean;
}> {
  // Stage-2 enrichment (fast_analysis_two_stage) never falls back to Elorian.
  const enrich = await roleAvailability('vision_photo_enrich', gateway, false);
  // Neither does the verifier (analysis_verifier_enabled).
  const verify = await roleAvailability('vision_verify', gateway, false);
  // The style reading never falls back either; without it photo analysis still runs (style "failed: unavailable").
  const style = await roleAvailability('vision_style', gateway, false);
  const base = { enrichReady: enrich === 'available', verifyReady: verify === 'available', styleReady: style === 'available' };
  let detail: Awaited<ReturnType<ModelGateway['readiness']>>['vision_photo'] | undefined;
  try {
    detail = gateway ? (await gateway.readiness()).vision_photo : undefined;
  } catch {
    detail = undefined;
  }
  const primaryReady = !!detail && (detail.state === 'qualified' || detail.state === 'available');
  if (hasFallback && !primaryReady)
    return { ...base, budgetAvailable: true, providerReady: true, qualityQualified: true, experimental: false };
  if (!detail)
    return { ...base, budgetAvailable: true, providerReady: false, qualityQualified: true, experimental: false };
  const budgetPaused = detail.reason === 'credits' || detail.reason === 'cost_overrun';
  const qualityQualified = detail.reason !== 'not_qualified';
  const providerReady =
    primaryReady ||
    detail.state === 'degraded' ||
    budgetPaused ||
    // An unqualified role is a quality gate, not a provider outage.
    !qualityQualified;
  return {
    ...base,
    budgetAvailable: !budgetPaused,
    providerReady,
    qualityQualified,
    experimental: detail.experimental === true,
    ...(detail.access ? { access: detail.access } : {}),
  };
}
