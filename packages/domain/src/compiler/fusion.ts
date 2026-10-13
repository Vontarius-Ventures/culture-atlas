import type { Exploration } from '../enums';

/**
 * Recommendation ranking rules (build spec "Recommendation and memory rules"):
 *  - within a provider query, order by that query's ranking;
 *  - apply explicit exclusions first;
 *  - across sources, combine ranked candidates with rank-based fusion
 *    (Reciprocal Rank Fusion), never by averaging raw affinity scores from
 *    different queries;
 *  - add diversity by category and by reference origin.
 */

export interface RankedCandidate<T = unknown> {
  /** Stable identity used for dedupe (canonical key). */
  key: string;
  /** Contributing reference ids (diversity by reference origin). */
  originRefs: readonly string[];
  payload: T;
}

export interface RankedList<T = unknown> {
  source: string;
  /** Already in provider order (rank 1 first). */
  items: readonly RankedCandidate<T>[];
}

export interface FusedCandidate<T = unknown> extends RankedCandidate<T> {
  score: number;
  /** Sources that returned this candidate, with their 1-based rank. */
  ranks: { source: string; rank: number }[];
}

export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: score = Σ 1 / (k + rank). Ties keep first-seen order.
 * Excluded keys are removed BEFORE ranking so they never shift positions.
 */
export function reciprocalRankFusion<T>(lists: readonly RankedList<T>[], options: { exclude?: ReadonlySet<string>; k?: number } = {}): FusedCandidate<T>[] {
  const k = options.k ?? RRF_K;
  const fused = new Map<string, FusedCandidate<T> & { firstSeen: number }>();
  let seen = 0;
  for (const list of lists) {
    let rank = 0;
    const inList = new Set<string>();
    for (const item of list.items) {
      if (options.exclude?.has(item.key) || inList.has(item.key)) continue;
      inList.add(item.key);
      rank++;
      const existing = fused.get(item.key);
      if (existing) {
        existing.score += 1 / (k + rank);
        existing.ranks.push({ source: list.source, rank });
        existing.originRefs = [...new Set([...existing.originRefs, ...item.originRefs])];
      } else {
        fused.set(item.key, { ...item, originRefs: [...item.originRefs], score: 1 / (k + rank), ranks: [{ source: list.source, rank }], firstSeen: seen++ });
      }
    }
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.firstSeen - b.firstSeen)
    .map(({ firstSeen: _f, ...rest }) => rest);
}

/**
 * Pick up to `limit` candidates, preferring variety of contributing reference:
 * a candidate whose origin references were all already used is deferred while
 * candidates from unused references remain. Exploration widens the pool:
 * familiar keeps the strongest connections, adventurous draws from deeper
 * ranks while keeping the top candidate as a meaningful anchor.
 */
export function selectDiverse<T>(candidates: readonly FusedCandidate<T>[], limit: number, exploration: Exploration = 'balanced'): FusedCandidate<T>[] {
  if (limit <= 0 || candidates.length === 0) return [];
  const pool = exploration === 'familiar' ? candidates.slice(0, Math.max(limit, 1)) : candidates;
  const picked: FusedCandidate<T>[] = [];
  const usedRefs = new Set<string>();
  const remaining = [...pool];

  if (exploration === 'adventurous' && remaining.length > limit) {
    // Keep the strongest anchor, then step through the wider pool.
    picked.push(remaining.shift()!);
    for (const r of picked[0]!.originRefs) usedRefs.add(r);
    const stride = Math.max(1, Math.floor(remaining.length / Math.max(1, limit - 1)));
    for (let i = stride - 1; i < remaining.length && picked.length < limit; i += stride) picked.push(remaining[i]!);
    return picked;
  }

  while (picked.length < limit && remaining.length > 0) {
    const idx = remaining.findIndex((c) => c.originRefs.length === 0 || c.originRefs.some((r) => !usedRefs.has(r)));
    const next = remaining.splice(idx >= 0 ? idx : 0, 1)[0]!;
    picked.push(next);
    for (const r of next.originRefs) usedRefs.add(r);
  }
  return picked;
}

/**
 * Interleave per-category lists so that no more than `maxRun` consecutive
 * items share a category while alternatives exist. Category order is the
 * given priority order; within a category, order is preserved.
 */
export function interleaveCategories<T extends { category: string | null }>(byCategory: readonly (readonly T[])[], maxRun = 2): T[] {
  const queues = byCategory.map((l) => [...l]);
  const out: T[] = [];
  let run = 0;
  let last: string | null | undefined;
  let cursor = 0;
  const total = queues.reduce((n, q) => n + q.length, 0);
  while (out.length < total) {
    let chosen = -1;
    for (let step = 0; step < queues.length; step++) {
      const i = (cursor + step) % queues.length;
      const q = queues[i]!;
      if (q.length === 0) continue;
      const cat = q[0]!.category;
      if (cat === last && run >= maxRun) {
        // Only allowed when every other queue is empty.
        if (queues.some((other, j) => j !== i && other.length > 0)) continue;
      }
      chosen = i;
      break;
    }
    if (chosen < 0) chosen = queues.findIndex((q) => q.length > 0);
    const item = queues[chosen]!.shift()!;
    run = item.category === last ? run + 1 : 1;
    last = item.category;
    out.push(item);
    cursor = (chosen + 1) % queues.length;
  }
  return out;
}
