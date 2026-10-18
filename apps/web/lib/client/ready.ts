'use client';

/**
 * Ready notice (spec amendment 2.2, screen 17). Tracks analyses the person
 * started in this tab and tells the shell when one finishes:
 *  - a toast "Your photo is ready" with Open, only when they are no longer on
 *    that result (never for examples or analyses they did not start);
 *  - a "(n) Your photo is ready · culture atlas" title badge while the tab is
 *    hidden, cleared when it is visible again.
 * The poll loop is framework-free (createReadyWatcher) and unit-tested.
 */

export type ReadyPoll = 'active' | 'ready' | 'gone';

export interface ReadyWatch {
  /** Stable key of the result being watched ("capture:<id>", "media:<id>"). */
  key: string;
  /** Where Open goes (may be refined by the poll, e.g. a v2 result URL). */
  url: string;
  thumbnail: string | null;
  /** One status check: still working, finished with a result, or nothing to announce. */
  poll: () => Promise<ReadyPoll | { state: 'ready'; url: string }>;
}

export interface ReadyNotice {
  key: string;
  url: string;
  thumbnail: string | null;
}

export interface ReadyDeps {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  isHidden: () => boolean;
  /** Called when a watched analysis finishes. */
  onReady: (notice: ReadyNotice, ctx: { viewing: boolean; hidden: boolean }) => void;
  intervalMs?: number;
}

const MAX_ERRORS = 6;

export function createReadyWatcher(deps: ReadyDeps) {
  const watches = new Map<string, { watch: ReadyWatch; errors: number; timer: unknown }>();
  let viewing: string | null = null;
  const interval = deps.intervalMs ?? 2500;

  const tick = async (key: string) => {
    const entry = watches.get(key);
    if (!entry) return;
    entry.timer = null;
    try {
      const res = await entry.watch.poll();
      if (watches.get(key) !== entry) return;
      entry.errors = 0;
      if (res === 'active') {
        entry.timer = deps.setTimer(() => void tick(key), interval);
        return;
      }
      watches.delete(key);
      if (res === 'gone') return;
      const url = typeof res === 'object' ? res.url : entry.watch.url;
      deps.onReady(
        { key, url, thumbnail: entry.watch.thumbnail },
        { viewing: viewing === key, hidden: deps.isHidden() },
      );
    } catch {
      if (watches.get(key) !== entry) return;
      entry.errors += 1;
      if (entry.errors >= MAX_ERRORS) {
        watches.delete(key);
        return;
      }
      entry.timer = deps.setTimer(() => void tick(key), interval * 2 ** entry.errors);
    }
  };

  return {
    watch(w: ReadyWatch) {
      const prev = watches.get(w.key);
      if (prev) {
        // Keep the running loop; refresh what it polls.
        prev.watch = w;
        return;
      }
      const entry = { watch: w, errors: 0, timer: null as unknown };
      watches.set(w.key, entry);
      entry.timer = deps.setTimer(() => void tick(w.key), interval);
    },
    unwatch(key: string) {
      const entry = watches.get(key);
      if (entry?.timer) deps.clearTimer(entry.timer);
      watches.delete(key);
    },
    setViewing(key: string | null) {
      viewing = key;
    },
    get viewing() {
      return viewing;
    },
    has(key: string) {
      return watches.has(key);
    },
    stop() {
      for (const e of watches.values()) if (e.timer) deps.clearTimer(e.timer);
      watches.clear();
    },
  };
}

export type ReadyWatcher = ReturnType<typeof createReadyWatcher>;

// ---- shared instance (module scope survives client navigation) ----------------

type Listener = (notice: ReadyNotice, ctx: { viewing: boolean; hidden: boolean }) => void;
const listeners = new Set<Listener>();
let shared: ReadyWatcher | null = null;

function watcher(): ReadyWatcher {
  if (!shared)
    shared = createReadyWatcher({
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      isHidden: () => document.visibilityState === 'hidden',
      onReady: (n, ctx) => listeners.forEach((l) => l(n, ctx)),
    });
  return shared;
}

/** Start (or refresh) watching an analysis this person started. */
export function watchAnalysis(w: ReadyWatch) {
  watcher().watch(w);
}
export function unwatchAnalysis(key: string) {
  watcher().unwatch(key);
}
/** The result page currently on screen (null when leaving it). */
export function setViewingResult(key: string | null) {
  watcher().setViewing(key);
}
export function viewingResult(): string | null {
  return shared?.viewing ?? null;
}
export function onAnalysisReady(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
