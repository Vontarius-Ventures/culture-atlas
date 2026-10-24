'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { DiscoveryCard as Card } from '@culture-atlas/domain/schemas';
import {
  canFlow,
  createConveyor,
  laneSpeed,
  reconcile,
  slotsPerLane,
  slotStart,
  step,
  type ConveyorCard,
  type ConveyorEntry,
  type ConveyorGeometry,
  type ConveyorState,
} from '@/lib/client/conveyor';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// ---- prefers-reduced-motion ----------------------------------------------------

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReduced(cb: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

/** Live `prefers-reduced-motion: reduce` (false on the server). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () =>
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia(REDUCED_QUERY).matches
        : false,
    () => false,
  );
}

// ---- layout ---------------------------------------------------------------------

interface Layout {
  lanes: number;
  /** Space between lanes (vertical feeds). */
  gapCross: number;
  /** Card box width and height in px. */
  width: number;
  height: number;
  geo: ConveyorGeometry;
}

export type ConveyorAxis = 'vertical' | 'horizontal';

function cssPx(el: HTMLElement, name: string, fallback: number): number {
  const v = parseFloat(getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

function measure(
  el: HTMLElement,
  axis: ConveyorAxis,
  columns: (w: number) => number,
): Layout | null {
  const width = el.clientWidth;
  if (width <= 0) return null;
  const meta = cssPx(el, '--conveyor-meta', 84);
  const gapMain = cssPx(el, '--conveyor-gap-main', 20);
  const gapCross = cssPx(el, '--conveyor-gap-cross', 16);
  if (axis === 'vertical') {
    const lanes = columns(width);
    const laneW = (width - gapCross * (lanes - 1)) / lanes;
    const size = laneW * 1.25 + meta; // 4:5 image + title block
    const viewport = el.clientHeight;
    if (viewport <= 0) return null;
    return {
      lanes,
      gapCross,
      width: laneW,
      height: size,
      geo: { viewport, pitch: size + gapMain, size },
    };
  }
  const itemW = cssPx(el, '--conveyor-item', 180);
  const height = itemW * 1.25 + meta;
  return {
    lanes: 1,
    gapCross: 0,
    width: itemW,
    height,
    geo: { viewport: width, pitch: itemW + gapMain, size: itemW },
  };
}

// ---- memory across navigation --------------------------------------------------

interface Memory {
  lanes: number;
  model: ConveyorState;
  offsets: number[];
}
const memory = new Map<string, Memory>();

/** Forgets remembered conveyor positions (e.g. after a refresh resets the feed). */
export function forgetConveyor(key: string) {
  memory.delete(key);
}

// ---- component ------------------------------------------------------------------

export interface ConveyorProps {
  items: readonly Card[];
  axis: ConveyorAxis;
  /** Accessible name of the list. */
  label: string;
  /** Lane count for a measured width (vertical feeds). */
  columns?: (width: number) => number;
  renderItem: (card: Card) => ReactNode;
  /** Static, non-moving rendering (Reduce Motion or a pool too small to flow). */
  fallback: () => ReactNode;
  /** Remembers the floating position across navigation (Back keeps the place). */
  memoryKey?: string;
  className?: string;
}

const oneLane = () => 1;

type PauseReason = 'hover' | 'focus' | 'touch' | 'wheel' | 'scroll' | 'hidden' | 'user';

/**
 * Conveyor: cards drift continuously along `axis` in fixed-pitch slots and are
 * refilled from `items` (see lib/client/conveyor.ts). Positions are applied as
 * CSS transforms from a requestAnimationFrame clock; React only re-renders when
 * a card enters or leaves. Hover, focus, touch, wheel and page scrolling pause
 * the drift (touch/scroll resume ~2s after the last input); a focused card is
 * brought fully into view. Reduce Motion renders `fallback` instead.
 */
export function Conveyor({
  items,
  axis,
  label,
  columns = oneLane,
  renderItem,
  fallback,
  memoryKey,
  className,
}: ConveyorProps) {
  const reduced = usePrefersReducedMotion();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [model, setModel] = useState<ConveyorState | null>(null);
  const [userPaused, setUserPaused] = useState(false);

  const pool = useMemo<ConveyorCard[]>(
    () => items.map((c) => ({ id: c.id, pictured: Boolean(c.image) })),
    [items],
  );
  const cards = useMemo(() => new Map(items.map((c) => [c.id, c])), [items]);
  const flowing = !reduced && layout !== null && canFlow(pool.length, layout.lanes, layout.geo);
  // Before the first measurement we cannot know; render the moving shell (empty) and decide before paint.
  const showConveyor = !reduced && (layout === null || flowing);

  // Mutable animation state lives in refs; React state only mirrors membership.
  const poolRef = useRef(pool);
  const layoutRef = useRef<Layout | null>(null);
  const modelRef = useRef<ConveyorState | null>(null);
  const offsetsRef = useRef<number[]>([]);
  const nodesRef = useRef(new Map<string, HTMLLIElement>());
  const pausesRef = useRef(new Set<PauseReason>());
  const timersRef = useRef(new Map<PauseReason, number>());

  useEffect(() => {
    poolRef.current = pool;
  }, [pool]);

  const commit = useCallback((next: ConveyorState) => {
    if (next === modelRef.current) return;
    modelRef.current = next;
    setModel(next);
  }, []);

  const position = useCallback(
    (entry: ConveyorEntry): [number, number] => {
      const l = layoutRef.current!;
      const along = slotStart(entry, l.geo.pitch) - (offsetsRef.current[entry.lane] ?? 0);
      return axis === 'vertical' ? [entry.lane * (l.width + l.gapCross), along] : [along, 0];
    },
    [axis],
  );

  const applyTransforms = useCallback(() => {
    const m = modelRef.current;
    if (!m || !layoutRef.current) return;
    for (const entry of m.entries) {
      const node = nodesRef.current.get(entry.id);
      if (!node) continue;
      const [x, y] = position(entry);
      node.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    }
  }, [position]);

  // Measure (and build or rebuild the model) whenever the viewport resizes.
  useIsoLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || reduced) return;
    const update = () => {
      const next = measure(el, axis, columns);
      if (!next) return;
      const prev = layoutRef.current;
      layoutRef.current = next;
      setLayout(next);
      const p = poolRef.current;
      if (!canFlow(p.length, next.lanes, next.geo)) return;
      if (modelRef.current && prev && prev.lanes === next.lanes) {
        // Same lanes, new size: keep cards, rescale offsets to the new pitch.
        if (prev.geo.pitch !== next.geo.pitch) {
          offsetsRef.current = offsetsRef.current.map((o) => (o * next.geo.pitch) / prev.geo.pitch);
        }
        commit(step(reconcile(modelRef.current, p), p, offsetsRef.current, next.geo));
        return;
      }
      const remembered = memoryKey ? memory.get(memoryKey) : undefined;
      if (remembered && remembered.lanes === next.lanes) {
        offsetsRef.current = [...remembered.offsets];
        commit(step(reconcile(remembered.model, p), p, offsetsRef.current, next.geo));
        return;
      }
      offsetsRef.current = Array.from({ length: next.lanes }, () => 0);
      commit(
        createConveyor(
          p,
          next.lanes,
          slotsPerLane(next.geo),
          modelRef.current?.lastShown ?? new Map(),
        ),
      );
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [axis, columns, reduced, memoryKey, commit, showConveyor]);

  // Remember the place on the way out (Back from a detail page keeps it).
  useEffect(() => {
    const nodes = nodesRef.current;
    return () => {
      if (memoryKey && modelRef.current && layoutRef.current) {
        memory.set(memoryKey, {
          lanes: layoutRef.current.lanes,
          model: modelRef.current,
          offsets: [...offsetsRef.current],
        });
      }
      nodes.clear();
    };
  }, [memoryKey]);

  // Position freshly rendered cards before paint.
  useIsoLayoutEffect(() => {
    applyTransforms();
  }, [model, layout, applyTransforms]);

  // The frame clock: drift, refill, keep membership in sync with the pool.
  useEffect(() => {
    if (!flowing) return;
    let raf = 0;
    let last = 0;
    let reconciledPool: readonly ConveyorCard[] | null = null;
    const frame = (t: number) => {
      const dt = last ? Math.min((t - last) / 1000, 0.1) : 0;
      last = t;
      const l = layoutRef.current;
      const m = modelRef.current;
      if (l && m) {
        if (pausesRef.current.size === 0 && dt > 0) {
          const offsets = offsetsRef.current;
          for (let lane = 0; lane < offsets.length; lane++)
            offsets[lane] = (offsets[lane] ?? 0) + laneSpeed(lane) * dt;
        }
        applyTransforms();
        const p = poolRef.current;
        // Reconcile (allocates a Set of the pool) only when the pool changed, not every frame.
        const synced = p === reconciledPool ? m : reconcile(m, p);
        reconciledPool = p;
        commit(step(synced, p, offsetsRef.current, l.geo));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [flowing, applyTransforms, commit]);

  const pause = useCallback((reason: PauseReason) => {
    const t = timersRef.current.get(reason);
    if (t) window.clearTimeout(t);
    timersRef.current.delete(reason);
    pausesRef.current.add(reason);
  }, []);
  const resume = useCallback((reason: PauseReason, delay: number) => {
    const t = timersRef.current.get(reason);
    if (t) window.clearTimeout(t);
    if (delay <= 0) {
      pausesRef.current.delete(reason);
      timersRef.current.delete(reason);
      return;
    }
    timersRef.current.set(
      reason,
      window.setTimeout(() => {
        pausesRef.current.delete(reason);
        timersRef.current.delete(reason);
      }, delay),
    );
  }, []);

  // Page scrolling, touch release and tab visibility.
  useEffect(() => {
    if (!flowing) return;
    const timers = timersRef.current;
    const onScroll = () => {
      pause('scroll');
      resume('scroll', 2000);
    };
    const onRelease = () => {
      if (pausesRef.current.has('touch')) resume('touch', 2000);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') pause('hidden');
      else resume('hidden', 0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
      document.removeEventListener('visibilitychange', onVisibility);
      timers.forEach((t) => window.clearTimeout(t));
      timers.clear();
    };
  }, [flowing, pause, resume]);

  /** Keyboard focus: stop, and slide the focused card's lane so the card is fully visible. */
  const reveal = (target: EventTarget | null) => {
    const l = layoutRef.current;
    const m = modelRef.current;
    if (!l || !m || !(target instanceof Node)) return;
    let found: ConveyorEntry | undefined;
    for (const entry of m.entries) {
      if (nodesRef.current.get(entry.id)?.contains(target)) found = entry;
    }
    if (!found) return;
    const start = slotStart(found, l.geo.pitch);
    const offset = offsetsRef.current[found.lane] ?? 0;
    let nextOffset = offset;
    if (start - offset < 0) nextOffset = start;
    else if (start - offset + l.geo.size > l.geo.viewport)
      nextOffset = start + l.geo.size - l.geo.viewport;
    if (nextOffset !== offset) {
      offsetsRef.current = offsetsRef.current.map((o, i) =>
        i === found!.lane ? Math.max(0, nextOffset) : o,
      );
      applyTransforms();
    }
  };

  const toggleUserPause = () => {
    if (userPaused) resume('user', 0);
    else pause('user');
    setUserPaused(!userPaused);
  };

  if (!showConveyor) return <>{fallback()}</>;

  return (
    <div className={`conveyor conveyor--${axis}${className ? ` ${className}` : ''}`}>
      <div
        ref={viewportRef}
        className="conveyor__viewport"
        style={layout && axis === 'horizontal' ? { height: layout.height } : undefined}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') pause('hover');
        }}
        onPointerMove={(e) => {
          // A cursor already resting over the feed when it loaded never fires pointerenter.
          if (e.pointerType === 'mouse' && !pausesRef.current.has('hover')) pause('hover');
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') resume('hover', 400);
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'mouse') pause('touch');
        }}
        onWheel={() => {
          pause('wheel');
          resume('wheel', 2000);
        }}
        onFocus={(e) => {
          pause('focus');
          reveal(e.target);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume('focus', 0);
        }}
        onScroll={(e) => {
          // overflow: clip should prevent this; undo any focus-driven scroll so transforms stay true.
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
      >
        <ul className="conveyor__track" aria-label={label}>
          {layout &&
            model?.entries.map((entry) => {
              const card = cards.get(entry.id);
              if (!card) return null;
              return (
                <li
                  key={entry.id}
                  ref={(node) => {
                    if (node) nodesRef.current.set(entry.id, node);
                    else nodesRef.current.delete(entry.id);
                  }}
                  className="conveyor__item"
                  data-card-id={entry.id}
                  data-lane={entry.lane}
                  data-row={entry.row}
                  style={{ width: layout.width, height: layout.height }}
                >
                  {renderItem(card)}
                </li>
              );
            })}
        </ul>
      </div>
      <div className="conveyor__controls">
        <button
          type="button"
          className="text-button conveyor__pause"
          aria-pressed={userPaused}
          onClick={toggleUserPause}
        >
          {userPaused ? 'Resume motion' : 'Pause motion'}
        </button>
      </div>
    </div>
  );
}
