'use client';

import { useEffect, useSyncExternalStore, type DependencyList } from 'react';

/**
 * Runs an async loader when `deps` change. The loader starts in a microtask, so
 * any state it sets is an asynchronous update (synchronizing with the API, an
 * external system), never a synchronous cascade inside the effect body.
 */
export function useAsyncEffect(effect: () => unknown, deps: DependencyList) {
  useEffect(() => {
    void Promise.resolve().then(effect);
    // The caller owns the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

const noopSubscribe = () => () => undefined;

/** True after hydration on the client (portals need `document`). */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
