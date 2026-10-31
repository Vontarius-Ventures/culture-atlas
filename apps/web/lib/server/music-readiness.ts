/**
 * Music Mode Explore readiness. Shazam runs on the phone and sends its answer as
 * a hint, so the server only needs Qloo to ground it. Transcripts are off unless
 * a deployment configures them. Presence of configuration only; never probes.
 */
export function musicMatchAvailability(
  env: Record<string, string | undefined> = process.env,
): { available: boolean; reasons: string[] } {
  if (env.QLOO_API_KEY?.trim()) return { available: true, reasons: [] };
  return { available: false, reasons: ['qloo_unconfigured'] };
}
