'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { ONBOARDING_PATH, onboardingRedirect } from '@/lib/client/onboarding';
import { hardReplace } from '@/lib/client/navigate';
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

/**
 * The feed-level onboarding gate (Discover answers onboarding_required for an
 * account that still owes the questionnaire) navigates through here so it
 * respects the same hold as the shell gate: a dialog in progress (e.g. the
 * save that just created the account) finishes first, and the shell gate
 * redirects once it closes. Navigating from mid-dialog would interrupt the
 * intended save.
 */
export function redirectToOnboarding(): void {
  if (dialogOpen()) return;
  hardReplace(ONBOARDING_PATH);
}
