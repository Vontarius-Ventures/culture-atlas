'use client';

/**
 * Small client-side stores shared across routes (module scope survives client
 * navigation, so going Back renders instantly and keeps scroll position):
 *  - item overrides: saved / hidden state changed in this tab;
 *  - pending capture file and capture previews (keep the photo visible while processing);
 *  - feed cache for the Discover grid.
 */
import { useSyncExternalStore } from 'react';
import type { DiscoveryCard } from '@culture-atlas/domain/schemas';

type Listener = () => void;

function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

// ---- saved / hidden overrides ------------------------------------------------

export interface ItemOverride {
  saved?: boolean;
  saved_item_id?: string | null;
  hidden?: boolean;
}

const overrides = createStore<ReadonlyMap<string, ItemOverride>>(new Map());

export function setItemOverride(itemId: string, patch: ItemOverride) {
  const next = new Map(overrides.get());
  next.set(itemId, { ...next.get(itemId), ...patch });
  overrides.set(next);
}

export function useItemOverrides(): ReadonlyMap<string, ItemOverride> {
  return useSyncExternalStore(overrides.subscribe, overrides.get, overrides.get);
}

/** Applies local saved/hidden overrides to cards and drops hidden ones. */
export function applyOverrides(
  cards: readonly DiscoveryCard[],
  map: ReadonlyMap<string, ItemOverride>,
): DiscoveryCard[] {
  const out: DiscoveryCard[] = [];
  for (const card of cards) {
    const o = map.get(card.id);
    if (o?.hidden) continue;
    out.push(
      o && o.saved !== undefined
        ? { ...card, saved: o.saved, saved_item_id: o.saved_item_id ?? card.saved_item_id }
        : card,
    );
  }
  return out;
}

// ---- capture handoff ---------------------------------------------------------

let pendingFile: { file: File; source: 'camera' | 'upload' } | null = null;
const previews = new Map<string, string>();

/** Hands a chosen file from any page to /capture (file inputs need a user gesture where they live). */
export function setPendingCapture(file: File, source: 'camera' | 'upload') {
  pendingFile = { file, source };
}
export function takePendingCapture() {
  const f = pendingFile;
  pendingFile = null;
  return f;
}
export function setCapturePreview(captureId: string, url: string) {
  previews.set(captureId, url);
}
export function getCapturePreview(captureId: string): string | undefined {
  return previews.get(captureId);
}

// ---- Discover feed cache -----------------------------------------------------

export interface FeedCacheEntry {
  items: DiscoveryCard[];
  nextCursor: string | null;
  availableCategories: string[];
  isExampleFeed: boolean;
  /**
   * The server is still adding cards (taste seed publishing after onboarding,
   * an expand wave): poll the first page after this many ms. Null when idle.
   */
  pollAfterMs?: number | null;
  scrollY: number;
}

const feedCache = new Map<string, FeedCacheEntry>();

export function getFeedCache(key: string) {
  return feedCache.get(key);
}
export function setFeedCache(key: string, entry: FeedCacheEntry) {
  feedCache.set(key, entry);
}
export function updateFeedScroll(key: string, scrollY: number) {
  const entry = feedCache.get(key);
  if (entry) entry.scrollY = scrollY;
}
export function clearFeedCache() {
  feedCache.clear();
}

// ---- in-app history ----------------------------------------------------------

let routeChanges = 0;
/** Called by the shell on every pathname change. */
export function recordRouteChange() {
  routeChanges += 1;
}
/** True when Back can return to an earlier page of this app in this tab. */
export function hasInAppHistory(): boolean {
  return routeChanges > 1;
}

// ---- remembered save destination ---------------------------------------------

const LAST_DESTINATION_KEY = 'ca.lastDestination';

export function getLastDestination(): string | null {
  try {
    return window.localStorage.getItem(LAST_DESTINATION_KEY);
  } catch {
    return null;
  }
}
export function setLastDestination(value: string) {
  try {
    window.localStorage.setItem(LAST_DESTINATION_KEY, value);
  } catch {
    // storage unavailable: quick-save memory is a convenience only
  }
}
