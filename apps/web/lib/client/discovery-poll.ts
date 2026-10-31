'use client';

import { useEffect, useState } from 'react';

export const DISCOVERY_POLL_MS = 1500;
export const DISCOVERY_POLL_MAX = 60;
export const DISCOVERY_POLL_DEADLINE_MS = 90_000;

/** Read-only polling, shared by late legacy rails and the independent visual job.
 * The wall-clock deadline also bounds hidden tabs and unanswered requests.
 */
export function useDiscoveryPoll(pending: boolean, load: (signal?: AbortSignal) => Promise<void>) {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) setTimedOut(false);
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let attempts = 0;
    const expire = () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      setTimedOut(true);
    };
    const deadline = setTimeout(expire, DISCOVERY_POLL_DEADLINE_MS);
    const schedule = () => {
      if (controller.signal.aborted || document.visibilityState === 'hidden') return;
      if (attempts >= DISCOVERY_POLL_MAX) {
        expire();
        return;
      }
      timer = setTimeout(tick, DISCOVERY_POLL_MS);
    };
    const tick = async () => {
      timer = null;
      if (controller.signal.aborted || inFlight) return;
      if (document.visibilityState === 'hidden') return;
      inFlight = true;
      attempts += 1;
      try {
        await load(controller.signal);
      } finally {
        inFlight = false;
        schedule();
      }
    };
    const visibility = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (!inFlight) schedule();
    };
    document.addEventListener('visibilitychange', visibility);
    schedule();
    return () => {
      controller.abort();
      clearTimeout(deadline);
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [pending, load]);
  return pending && timedOut;
}
