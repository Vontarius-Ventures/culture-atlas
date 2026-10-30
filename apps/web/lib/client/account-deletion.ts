/**
 * Browser-side account-deletion state (VAL-DELETE-001/002).
 *
 * The acceptance revokes every server credential in one transaction — the
 * browser session itself included. The one-time status token is the only
 * credential that keeps answering afterwards (on the public status route,
 * via the `x-atlas-deletion-token` header). The browser therefore:
 *  - GENERATES the token itself (>= 32 random bytes, URL-safe), so a lost
 *    acceptance response can be retried and the same token is echoed back
 *    idempotently instead of being lost with the response;
 *  - keeps it in localStorage of the user's own browser, so the deletion
 *    status page keeps reporting the truthful pending/failed/completed
 *    cleanup after the page is reloaded or revisited while signed out.
 *
 * The stored record is never treated as account data: a live session for a
 * different account ignores it, and the server stores only the token's
 * SHA-256 (losing it only loses this convenience view, never any authority).
 */

/** The locally kept capability: which account's deletion, and its one-time status token. */
export interface StoredAccountDeletion {
  account_id: string;
  status_token: string;
  requested_at: string;
}

const STORAGE_KEY = 'atlas.account-deletion.v1';

/** A fresh URL-safe capability token (32 random bytes, base64url → 43 chars). */
export function generateStatusToken(): string {
  const bytes = new Uint8Array(32);
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i]! = Math.floor(Math.random() * 256);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function readStoredAccountDeletion(): StoredAccountDeletion | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAccountDeletion;
    if (typeof parsed.account_id !== 'string' || typeof parsed.status_token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storeAccountDeletion(entry: StoredAccountDeletion): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Storage unavailable: the status view still works for this visit; the
    // token is simply not remembered across reloads.
  }
}

/** Drops the local record (the server keeps its own durable record either way). */
export function clearStoredAccountDeletion(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Unavailable storage cannot hold a record to clear.
  }
}
