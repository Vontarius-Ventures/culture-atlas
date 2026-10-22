/**
 * Capability matrix: what each provider can actually do in this deployment.
 * Rules (build spec, "Qloo integration contract"):
 *  - Undocumented or inaccessible capabilities are 'unavailable'.
 *  - Never present simulated/replayed data as live; replays are labeled "Example result".
 *  - Qloo capabilities stay 'unverified' until the contract probes pass with a real key
 *    (scripts/probe-qloo.ts, owned by the Qloo adapter), then 'available'.
 */
export const CAPABILITY_NAMES = [
  'vlm.analyze_image',
  'text.generate',
  'research.sources',
  'research.claims',
  'qloo.search',
  'qloo.tags',
  'qloo.insights',
  'qloo.insights.explainability',
  'qloo.trending',
  'qloo.trends_entity',
  'catalog.tracks',
  'music.recognize',
  'storage.objects',
  'storage.signed_urls',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export type CapabilityStatus = 'available' | 'degraded' | 'unverified' | 'unavailable';

export type CapabilityReason =
  | 'not_configured'
  | 'not_implemented'
  | 'probe_pending'
  | 'probe_failed'
  | 'access_denied'
  | 'rate_limited'
  | 'circuit_open'
  | 'provider_error';

export interface CapabilityEntry {
  status: CapabilityStatus;
  reason?: CapabilityReason;
  /** Short operator-facing detail. Never secrets. */
  detail?: string;
  /** ISO time of the last probe/observation. */
  checked_at?: string | null;
  /** Provider/model identifier, e.g. "anthropic:<model>" or "qloo:hackathon". */
  provider?: string;
}

export type CapabilityMatrix = Record<CapabilityName, CapabilityEntry>;

/** Whether calls should be attempted. 'unverified' is attempted; failures then mark it unavailable. */
export function isUsable(entry: CapabilityEntry | undefined): boolean {
  return !!entry && entry.status !== 'unavailable';
}

export function unavailable(reason: CapabilityReason, detail?: string, provider?: string): CapabilityEntry {
  return { status: 'unavailable', reason, detail, checked_at: null, provider };
}

export function emptyMatrix(): CapabilityMatrix {
  return Object.fromEntries(
    CAPABILITY_NAMES.map((n) => [n, unavailable('not_implemented')]),
  ) as CapabilityMatrix;
}
