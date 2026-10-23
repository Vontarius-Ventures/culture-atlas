/**
 * Music Mode Explore readiness. Never probes a paid fingerprint or transcript
 * API: presence of configuration only. Fingerprint matching stays unavailable
 * until a licensed vendor is wired (`music.recognize`).
 */
export function musicMatchAvailability(
  env: Record<string, string | undefined> = process.env,
): { available: boolean; reasons: string[] } {
  const transcript = !!env.ELEVENLABS_API_KEY?.trim();
  const qloo = !!env.QLOO_API_KEY?.trim();
  if (transcript && qloo) return { available: true, reasons: [] };
  return {
    available: false,
    reasons: [
      'fingerprint_unavailable',
      ...(!transcript ? ['transcript_unconfigured'] : []),
      ...(!qloo ? ['qloo_unconfigured'] : []),
    ],
  };
}
