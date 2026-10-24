import { describe, expect, it } from 'vitest';
import {
  canFlow,
  createConveyor,
  feedColumns,
  laneSpeed,
  mergeLanded,
  mergeRefreshed,
  pickNext,
  reconcile,
  slotsPerLane,
  slotStart,
  step,
  type ConveyorCard,
  type ConveyorGeometry,
  type ConveyorState,
} from './conveyor';

const geo: ConveyorGeometry = { viewport: 700, pitch: 320, size: 300 };

function cards(n: number, pictured: (i: number) => boolean = () => true): ConveyorCard[] {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, pictured: pictured(i) }));
}

/** Invariants that must hold at every moment. */
function assertSound(state: ConveyorState, offsets: readonly number[]) {
  const ids = state.entries.map((e) => e.id);
  expect(new Set(ids).size, 'a card is never on screen twice').toBe(ids.length);
  for (let lane = 0; lane < state.lanes; lane++) {
    const spans = state.entries
      .filter((e) => e.lane === lane)
      .map((e) => [slotStart(e, geo.pitch), slotStart(e, geo.pitch) + geo.size] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]![0], 'cards in a lane never overlap').toBeGreaterThanOrEqual(
        spans[i - 1]![1],
      );
    }
    // Nothing that has fully left the leading edge is still on screen.
    for (const [, end] of spans) expect(end).toBeGreaterThan(offsets[lane]!);
  }
}

/** Runs the conveyor like the frame clock does: drift, then step. */
function run(pool: ConveyorCard[], lanes: number, seconds: number, fps = 30) {
  let state = createConveyor(pool, lanes, slotsPerLane(geo));
  let offsets = Array.from({ length: lanes }, () => 0);
  const left: string[] = [];
  const entered: string[] = [];
  assertSound(state, offsets);
  for (let f = 0; f < seconds * fps; f++) {
    offsets = offsets.map((o, l) => o + laneSpeed(l) / fps);
    const next = step(state, pool, offsets, geo);
    if (next !== state) {
      const before = new Set(state.entries.map((e) => e.id));
      const after = new Set(next.entries.map((e) => e.id));
      for (const id of before) if (!after.has(id)) left.push(id);
      for (const e of next.entries) if (!before.has(e.id)) entered.push(e.id);
    }
    state = next;
    assertSound(state, offsets);
  }
  return { state, offsets, left, entered };
}

describe('feed conveyor model', () => {
  it('fills lanes row by row in pool order with unique cards', () => {
    const state = createConveyor(cards(20), 2, 3);
    expect(state.entries.map((e) => [e.id, e.lane, e.row])).toEqual([
      ['c0', 0, 0],
      ['c1', 1, 0],
      ['c2', 0, 1],
      ['c3', 1, 1],
      ['c4', 0, 2],
      ['c5', 1, 2],
    ]);
  });

  it('drifts for minutes without overlap or duplicates, and keeps every lane covered', () => {
    const pool = cards(30, (i) => i % 3 !== 0);
    const { state, offsets, left, entered } = run(pool, 2, 240);
    expect(left.length).toBeGreaterThan(10);
    expect(entered.length).toBeGreaterThan(10);
    for (let lane = 0; lane < 2; lane++) {
      const rows = state.entries.filter((e) => e.lane === lane).map((e) => e.row);
      const top = Math.min(...rows);
      const bottom = Math.max(...rows);
      // Contiguous slots from the leading edge to past the trailing edge.
      expect(rows.length).toBe(bottom - top + 1);
      expect(top * geo.pitch).toBeLessThanOrEqual(offsets[lane]!);
      expect(bottom * geo.pitch + geo.size).toBeGreaterThanOrEqual(offsets[lane]! + geo.viewport);
    }
  });

  it('lanes move at staggered speeds', () => {
    expect(new Set([0, 1, 2, 3].map(laneSpeed)).size).toBe(4);
    for (const l of [0, 1, 2, 3]) {
      expect(laneSpeed(l)).toBeGreaterThanOrEqual(10);
      expect(laneSpeed(l)).toBeLessThanOrEqual(18);
    }
  });

  it('cards enter after (below) the viewport and leave past the leading edge', () => {
    const pool = cards(30);
    let state = createConveyor(pool, 1, slotsPerLane(geo));
    let offset = 0;
    for (let f = 0; f < 2000; f++) {
      offset += 0.5;
      const next = step(state, pool, [offset], geo);
      for (const e of next.entries) {
        if (!state.entries.some((s) => s.id === e.id)) {
          expect(slotStart(e, geo.pitch) - offset).toBeGreaterThanOrEqual(geo.viewport);
        }
      }
      state = next;
    }
  });

  it('shows fresh cards before recycling, then recycles least recently shown when the pool is small', () => {
    const pool = cards(9);
    expect(slotsPerLane(geo)).toBe(4);
    const { entered, state } = run(pool, 2, 600);
    // c8 (the only card not in the initial 2x4 fill) comes in first.
    expect(entered[0]).toBe('c8');
    // Small pool: cards that scrolled off come back.
    expect(entered.filter((id) => id === 'c0').length).toBeGreaterThan(0);
    expect(new Set(state.entries.map((e) => e.id)).size).toBe(state.entries.length);
  });

  it('never swaps a leaving photo for a poster while photos are waiting', () => {
    const pool: ConveyorCard[] = [
      { id: 'poster-fresh', pictured: false },
      { id: 'photo-seen', pictured: true },
    ];
    const lastShown = new Map([['photo-seen', 1]]);
    expect(pickNext(pool, new Set(), lastShown, { id: 'leaving', pictured: true })).toBe(
      'photo-seen',
    );
    // A leaving poster may be followed by a fresh poster.
    expect(pickNext(pool, new Set(), lastShown, { id: 'leaving', pictured: false })).toBe(
      'poster-fresh',
    );
    // Fresh photos beat everything.
    expect(pickNext([...pool, { id: 'photo-fresh', pictured: true }], new Set(), lastShown)).toBe(
      'photo-fresh',
    );
    // Nothing waiting: null, never a duplicate.
    expect(pickNext(pool, new Set(['poster-fresh', 'photo-seen']), lastShown)).toBeNull();
  });

  it('prefers pictured cards in a long run', () => {
    const pool = cards(40, (i) => i % 2 === 0);
    const { entered } = run(pool, 2, 120);
    const firstSix = entered.slice(0, 6);
    expect(firstSix.every((id) => Number(id.slice(1)) % 2 === 0)).toBe(true);
  });

  it('new cards from a refresh join the conveyor next without resetting it', () => {
    const pool = cards(12);
    let state = createConveyor(pool, 2, slotsPerLane(geo));
    const before = state.entries.map((e) => e.id);
    const refreshed = mergeRefreshed([{ id: 'new1', pictured: true }], pool);
    state = reconcile(state, refreshed);
    expect(state.entries.map((e) => e.id)).toEqual(before);
    let offsets = [0, 0];
    while (!state.entries.some((e) => e.id === 'new1')) {
      offsets = offsets.map((o, l) => o + laneSpeed(l) / 30);
      state = step(state, refreshed, offsets, geo);
      assertSound(state, offsets);
    }
    expect(state.entries.filter((e) => e.id === 'new1')).toHaveLength(1);
  });

  it('a card that disappears from the pool is replaced in its own slot', () => {
    const pool = cards(10);
    const state = createConveyor(pool, 2, 3);
    const gone = state.entries[2]!;
    const next = reconcile(
      state,
      pool.filter((c) => c.id !== gone.id),
    );
    const replacement = next.entries.find((e) => e.lane === gone.lane && e.row === gone.row)!;
    expect(replacement.id).not.toBe(gone.id);
    expect(next.entries.some((e) => e.id === gone.id)).toBe(false);
    expect(new Set(next.entries.map((e) => e.id)).size).toBe(next.entries.length);
  });

  it('refresh merge never empties and puts incoming first without duplicates', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    expect(mergeRefreshed([], existing)).toEqual(existing);
    expect(mergeRefreshed([{ id: 'c' }, { id: 'a' }], existing).map((c) => c.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('only flows when the pool can fill every lane without repeats', () => {
    const needed = 2 * slotsPerLane(geo);
    expect(canFlow(needed, 2, geo)).toBe(true);
    expect(canFlow(needed - 1, 2, geo)).toBe(false);
    expect(canFlow(10, 2, { ...geo, viewport: 0 })).toBe(false);
  });

  it('columns follow width: 2 on phones, up to 4 on wide screens', () => {
    expect(feedColumns(358)).toBe(2);
    expect(feedColumns(704)).toBe(3);
    expect(feedColumns(1344)).toBe(4);
  });
});

describe('mergeLanded (seed landing after onboarding)', () => {
  const ex = (id: string) => ({ id, is_example: true });
  const real = (id: string) => ({ id, is_example: false });

  it('real cards push out the examples the server dropped; known real cards stay', () => {
    const shown = [real('q1'), ex('s1'), ex('s2'), ex('s3')];
    const polled = [real('q2'), real('q1'), ex('s3')];
    expect(mergeLanded(polled, shown).map((c) => c.id)).toEqual(['q2', 'q1', 's3']);
    // A real card the newest page no longer lists is kept.
    expect(mergeLanded([real('q3')], [real('q1'), ex('s1')]).map((c) => c.id)).toEqual(['q3', 'q1']);
  });

  it('an examples-only answer changes nothing it would lose, and never empties the pool', () => {
    const shown = [ex('s1'), ex('s2')];
    expect(mergeLanded([ex('s2')], shown).map((c) => c.id)).toEqual(['s2', 's1']);
    expect(mergeLanded([], shown)).toEqual(shown);
  });
});
