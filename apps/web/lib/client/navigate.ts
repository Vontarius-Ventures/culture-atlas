/**
 * Navigation seams for the client shell. jsdom defines location methods as
 * non-configurable, so tests cannot spy on window.location.replace directly;
 * routing hard navigations through here keeps them observable (same reason
 * session-sync exposes reloadForSessionChange).
 */

/** Hard navigation that wipes client state (feed caches, open views). */
export function hardReplace(path: string): void {
  window.location.replace(path);
}
