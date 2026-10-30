'use client';

/**
 * Cross-tab session revocation (VAL-CROSS-005 account-switch isolation).
 *
 * Signing out in one tab must end the private surfaces every OTHER same-origin
 * tab is still holding: a second tab keeps rendering the signed-out account's
 * Taste/feed/photos (and would apply a late private response landing after
 * the switch) until it is told the session identity changed. The signing-out
 * tab writes a sentinel to shared storage right before it navigates away;
 * the session provider reloads every other tab on that write, so the stale
 * document — and any in-flight private response bound to it — is destroyed
 * before another account can be signed in on this browser.
 */
export const SESSION_SIGNOUT_KEY = 'ca.session.signout';

/** Called by the tab that signs out, just before it navigates away. */
export function broadcastSessionSignOut() {
  try {
    window.localStorage.setItem(SESSION_SIGNOUT_KEY, String(Date.now()));
  } catch {
    // Storage unavailable: other tabs re-check their session on their next
    // navigation; nothing further can be done from this tab.
  }
}

/** Called by the session provider in every other tab when the sentinel lands. */
export function reloadForSessionChange() {
  window.location.reload();
}
