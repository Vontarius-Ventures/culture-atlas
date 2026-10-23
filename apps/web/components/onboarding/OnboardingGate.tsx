'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { onboardingRedirect } from '@/lib/client/onboarding';
import { useSession } from '@/lib/client/session';

/** True while a dialog holds the page (Dialog makes #app-root inert). */
function subscribeDialog(onChange: () => void) {
  const root = document.getElementById('app-root');
  if (!root) return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: ['inert'] });
  return () => observer.disconnect();
}
const dialogOpen = () => document.getElementById('app-root')?.hasAttribute('inert') ?? false;

/**
 * Sends a signed-in account that still owes the taste questionnaire to
 * /welcome/taste (after account creation, and once at sign-in for existing
 * accounts with fewer than 3 explicit saves; the server decides). An account
 * created from a dialog (e.g. to complete a save) finishes that dialog first,
 * so the intended save is not interrupted. Returns true while a redirect is
 * pending so the shell does not flash the personal feed.
 */
export function useOnboardingGate(pathname: string): boolean {
  const router = useRouter();
  const { session } = useSession();
  const holding = useSyncExternalStore(subscribeDialog, dialogOpen, () => false);
  const target = onboardingRedirect(pathname, session);
  useEffect(() => {
    if (target && !holding) router.replace(target);
  }, [target, holding, router]);
  return target !== null && !holding;
}
