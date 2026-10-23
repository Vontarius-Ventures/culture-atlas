/**
 * Screen 17 on native (spec amendment 2.2, "Ready notice"): when an analysis
 * that an enrolled phone's user started is published, that phone gets a
 * silent wake. The wake carries only a random reference; the phone then asks
 * GET /v2/media/{id}/analysis/{analysisId} about the analyses it watches and
 * decides what to show. Web, agent and backfill requests never wake a phone.
 *
 * The process that publishes (the worker) installs the listener, normally
 * devicePush.wakeInstallation. Listener errors never fail the publish.
 */
export interface AnalysisReadyEvent {
  accountId: string;
  installationId: string;
  analysisId: string;
  assetId: string;
  state: 'complete' | 'partial' | 'failed';
}

export type AnalysisReadyListener = (event: AnalysisReadyEvent) => Promise<unknown> | unknown;

let listener: AnalysisReadyListener | undefined;

export function setAnalysisReadyListener(next: AnalysisReadyListener | undefined): void {
  listener = next;
}

export function getAnalysisReadyListener(): AnalysisReadyListener | undefined {
  return listener;
}

export async function notifyAnalysisReady(event: AnalysisReadyEvent): Promise<void> {
  if (!listener) return;
  try {
    await listener(event);
  } catch {
    // Best effort: the phone's foreground poll still finds the result.
  }
}
