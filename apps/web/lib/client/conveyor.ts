/**
 * Feed conveyor model (pure, no DOM).
 *
 * The Discover feed and the "Similar" rail float: each lane (a column on the
 * feed, the single row of the rail) is a stack of fixed-pitch slots that drifts
 * steadily along its axis. A card occupies one slot (`row`) of one lane for its
 * whole life on screen, so two cards can never share space: slot `row` of a
 * lane sits at `row * pitch`, and rows only grow. When a card has fully left
 * the leading edge it is dropped; when the trailing edge needs more, the next
 * waiting card from the pool is appended to that lane.
 *
 * Selection (`pickNext`):
 *  - never a card that is already on screen;
 *  - fresh (never shown) before recycled, pictured before poster;
 *  - a leaving photo is never replaced by a poster while a photo is waiting;
 *  - recycled cards come back least-recently-shown first.
 *
 * Positions are derived (`slotStart`), and identity is the card id.
 */

export interface ConveyorCard {
  id: string;
  /** True when the card has a real picture (otherwise it renders a poster). */
  pictured: boolean;
}

export interface ConveyorEntry {
  id: string;
  lane: number;
  /** Slot index along the lane; the slot starts at `row * pitch`. */
  row: number;
  /** Insertion order (DOM / reading order). */
  seq: number;
}

export interface ConveyorState {
  lanes: number;
  /** Cards on screen, in insertion order. */
  entries: ConveyorEntry[];
  /** Next free slot per lane. */
  nextRow: number[];
  seq: number;
  /** Card id -> tick when it was last placed on screen (recycle order). */
  lastShown: Map<string, number>;
  tick: number;
}

export interface ConveyorGeometry {
  /** Visible length of the viewport along the drift axis. */
  viewport: number;
  /** Slot length along the axis (card size + gap). */
  pitch: number;
  /** Card size along the axis (pitch minus the gap). */
  size: number;
}

/** Slots each lane must hold to cover the viewport plus one waiting below/after it. */
export function slotsPerLane(geo: ConveyorGeometry): number {
  return Math.ceil(geo.viewport / geo.pitch) + 1;
}

/** True when the pool is large enough to keep every lane full without repeats on screen. */
export function canFlow(poolSize: number, lanes: number, geo: ConveyorGeometry): boolean {
  if (lanes < 1 || geo.pitch <= 0 || geo.viewport <= 0) return false;
  return poolSize >= lanes * slotsPerLane(geo);
}

export function slotStart(entry: Pick<ConveyorEntry, 'row'>, pitch: number): number {
  return entry.row * pitch;
}

/** Chooses the next card for a lane, or null when every pool card is already on screen. */
export function pickNext(
  pool: readonly ConveyorCard[],
  onScreen: ReadonlySet<string>,
  lastShown: ReadonlyMap<string, number>,
  leaving?: ConveyorCard,
): string | null {
  let freshPictured: ConveyorCard | undefined;
  let freshPoster: ConveyorCard | undefined;
  let oldPictured: ConveyorCard | undefined;
  let oldPoster: ConveyorCard | undefined;
  const age = (c: ConveyorCard) => lastShown.get(c.id) ?? 0;
  for (const card of pool) {
    if (onScreen.has(card.id)) continue;
    if (!lastShown.has(card.id)) {
      if (card.pictured) freshPictured ??= card;
      else freshPoster ??= card;
    } else if (card.pictured) {
      if (!oldPictured || age(card) < age(oldPictured)) oldPictured = card;
    } else if (!oldPoster || age(card) < age(oldPoster)) {
      oldPoster = card;
    }
  }
  if (leaving?.pictured) {
    const photo = freshPictured ?? oldPictured;
    if (photo) return photo.id;
  }
  return (freshPictured ?? freshPoster ?? oldPictured ?? oldPoster)?.id ?? null;
}

function place(state: ConveyorState, id: string, lane: number, row?: number): ConveyorEntry {
  const entry: ConveyorEntry = { id, lane, row: row ?? state.nextRow[lane]!, seq: state.seq++ };
  if (row === undefined) state.nextRow[lane] = entry.row + 1;
  state.lastShown.set(id, ++state.tick);
  return entry;
}

function clone(state: ConveyorState): ConveyorState {
  return {
    ...state,
    entries: [...state.entries],
    nextRow: [...state.nextRow],
    lastShown: new Map(state.lastShown),
  };
}

/**
 * Fills `lanes` lanes row by row (reading order) with up to `rows` cards each.
 * `lastShown` carries recycle history across rebuilds (filter or width change).
 */
export function createConveyor(
  pool: readonly ConveyorCard[],
  lanes: number,
  rows: number,
  lastShown: ReadonlyMap<string, number> = new Map(),
): ConveyorState {
  const tick = Math.max(0, ...lastShown.values());
  const state: ConveyorState = {
    lanes,
    entries: [],
    nextRow: Array.from({ length: lanes }, () => 0),
    seq: 0,
    lastShown: new Map(lastShown),
    tick,
  };
  // Initial fill uses pool order (the server's ranking), row by row.
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let l = 0; l < lanes; l++) {
      const card = pool[i++];
      if (!card) return state;
      state.entries.push(place(state, card.id, l));
    }
  }
  return state;
}

/**
 * Advances the model for the current lane offsets: drops cards that have fully
 * left the leading edge, then appends cards while a lane's trailing edge (plus
 * one waiting slot) is uncovered. Returns the same object when nothing changed.
 */
export function step(
  state: ConveyorState,
  pool: readonly ConveyorCard[],
  offsets: readonly number[],
  geo: ConveyorGeometry,
): ConveyorState {
  if (!needsStep(state, pool, offsets, geo)) return state;
  const byId = new Map(pool.map((c) => [c.id, c]));
  const next = clone(state);
  let changed = false;

  // 1. Remove cards whose far edge has passed the leading edge.
  const leftByLane = new Map<number, ConveyorCard>();
  next.entries = next.entries.filter((entry) => {
    const offset = offsets[entry.lane] ?? 0;
    if (slotStart(entry, geo.pitch) + geo.size > offset) return true;
    changed = true;
    // Recycle order counts from when a card left the screen.
    next.lastShown.set(entry.id, ++next.tick);
    const card = byId.get(entry.id);
    if (card) leftByLane.set(entry.lane, card);
    return false;
  });

  // 2. Append while a lane's next slot starts before the viewport end + one waiting slot.
  const onScreen = new Set(next.entries.map((e) => e.id));
  for (let lane = 0; lane < next.lanes; lane++) {
    const offset = offsets[lane] ?? 0;
    // A lane that ran far ahead (e.g. after a long frame gap) restarts at the
    // first slot still ahead of the leading edge instead of filling the past.
    const minRow = Math.max(0, Math.floor(offset / geo.pitch));
    for (;;) {
      const row = Math.max(next.nextRow[lane]!, minRow);
      if (row * geo.pitch >= offset + geo.viewport + geo.pitch) break;
      const id = pickNext(pool, onScreen, next.lastShown, leftByLane.get(lane));
      if (!id) break;
      next.nextRow[lane] = row;
      next.entries.push(place(next, id, lane));
      onScreen.add(id);
      leftByLane.delete(lane);
      changed = true;
    }
  }
  return changed ? next : state;
}

/** Cheap per-frame check: does `step` have anything to do? (No allocation in the common case.) */
function needsStep(
  state: ConveyorState,
  pool: readonly ConveyorCard[],
  offsets: readonly number[],
  geo: ConveyorGeometry,
): boolean {
  for (const entry of state.entries) {
    if (slotStart(entry, geo.pitch) + geo.size <= (offsets[entry.lane] ?? 0)) return true;
  }
  if (pool.length <= state.entries.length) return false;
  for (let lane = 0; lane < state.lanes; lane++) {
    const offset = offsets[lane] ?? 0;
    const row = Math.max(state.nextRow[lane]!, Math.floor(offset / geo.pitch));
    if (row * geo.pitch < offset + geo.viewport + geo.pitch) return true;
  }
  return false;
}

/**
 * Keeps on-screen cards in sync with the pool (hidden or filtered-out cards):
 * a missing card is replaced in its own slot by the next waiting card, or its
 * slot is left empty when none is waiting. Never adds a duplicate.
 */
export function reconcile(state: ConveyorState, pool: readonly ConveyorCard[]): ConveyorState {
  const ids = new Set(pool.map((c) => c.id));
  if (state.entries.every((e) => ids.has(e.id))) return state;
  const next = clone(state);
  next.entries = [];
  const onScreen = new Set(state.entries.filter((e) => ids.has(e.id)).map((e) => e.id));
  for (const entry of state.entries) {
    if (ids.has(entry.id)) {
      next.entries.push(entry);
      continue;
    }
    const id = pickNext(pool, onScreen, next.lastShown);
    if (!id) continue;
    onScreen.add(id);
    next.entries.push(place(next, id, entry.lane, entry.row));
  }
  return next;
}

/**
 * Refresh merge: incoming cards first (fresh ones float in next), then every
 * card already known. An empty or failed refresh therefore never empties the
 * pool; the caller keeps the previous pool on error.
 */
export function mergeRefreshed<T extends { id: string }>(
  incoming: readonly T[],
  existing: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const card of [...incoming, ...existing]) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    out.push(card);
  }
  return out;
}

/**
 * A background poll while the seed is landing: incoming cards first, then the
 * known ones, except that once the server sends real cards, examples it no
 * longer includes leave the pool (they float out as the real cards float in).
 * Real cards already known always stay. Never empties a non-empty pool.
 */
export function mergeLanded<T extends { id: string; is_example: boolean }>(
  incoming: readonly T[],
  existing: readonly T[],
): T[] {
  if (!incoming.some((c) => !c.is_example)) return mergeRefreshed(incoming, existing);
  const still = new Set(incoming.map((c) => c.id));
  return mergeRefreshed(
    incoming,
    existing.filter((c) => !c.is_example || still.has(c.id)),
  );
}

/** Feed columns by viewport width: 2 on phones, up to 4 on wide screens. */
export function feedColumns(width: number): number {
  if (width < 600) return 2;
  if (width < 900) return 3;
  return 4;
}

/** Per-lane drift speeds (px/s), staggered so lanes never move in lockstep. */
export const LANE_SPEEDS = [14, 11, 17, 12.5] as const;

export function laneSpeed(lane: number): number {
  return LANE_SPEEDS[lane % LANE_SPEEDS.length]!;
}
