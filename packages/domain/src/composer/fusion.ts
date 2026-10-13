import type { Exploration } from '../enums';

/**
 * Ranking rules (spec "Recommendation and memory rules"):
 *  - Within each provider query keep the provider's ranking; apply explicit
 *    exclusions first (hidden items, dietary exclusions, inputs).
 *  - Across sources, combine with rank-based fusion (reciprocal rank fusion),
 *    never by averaging raw scores: affinity values from different queries are
 *    not comparable.
 *  - Add diversity by category and by reference origin.
 *  - Familiar favors the strongest connections; Adventurous draws from a wider
 *    set of supported candidates while retaining at least one meaningful anchor.
 * Everything here is pure and deterministic.
 */

export interface RankedCandidate {
  /** Stable identity used for dedupe (e.g. "qloo:<entity_id>"). */
  key: string;
}

export interface RankedList<T extends RankedCandidate> {
  /** Identifies the source query/list (provider_query id, analysis id...). */
  id: string;
  /** Already in provider rank order (best first). */
  items: readonly T[];
  /** Optional list weight (default 1). Still rank-based: multiplies 1/(k+rank). */
  weight?: number;
}

export interface FusedCandidate<T extends RankedCandidate> {
  key: string;
  item: T;
  /** RRF score: sum of weight / (k + rank) over lists containing the key. */
  fused: number;
  /** Best (lowest, 1-based) rank seen in any list. */
  bestRank: number;
  /** Ids of every list that returned this candidate (provenance). */
  sources: string[];
}

export const RRF_K = 60;

/** Drop excluded keys BEFORE fusion so exclusions never influence ranks of others. */
export function applyExclusions<T extends RankedCandidate>(
  lists: readonly RankedList<T>[],
  excluded: (item: T) => boolean,
): RankedList<T>[] {
  return lists.map((l) => ({ ...l, items: l.items.filter((i) => !excluded(i)) }));
}

/**
 * Reciprocal rank fusion. Ties break by best rank, then by first appearance
 * (list order, then position), so results are stable.
 */
export function reciprocalRankFusion<T extends RankedCandidate>(
  lists: readonly RankedList<T>[],
  k = RRF_K,
): FusedCandidate<T>[] {
  const out = new Map<string, FusedCandidate<T> & { order: number }>();
  let order = 0;
  for (const list of lists) {
    const w = list.weight ?? 1;
    const seenInList = new Set<string>();
    list.items.forEach((item, idx) => {
      if (seenInList.has(item.key)) return; // a provider list never counts one key twice
      seenInList.add(item.key);
      const rank = idx + 1;
      const existing = out.get(item.key);
      if (existing) {
        existing.fused += w / (k + rank);
        existing.bestRank = Math.min(existing.bestRank, rank);
        existing.sources.push(list.id);
      } else {
        out.set(item.key, { key: item.key, item, fused: w / (k + rank), bestRank: rank, sources: [list.id], order: order++ });
      }
    });
  }
  return [...out.values()]
    .sort((a, b) => b.fused - a.fused || a.bestRank - b.bestRank || a.order - b.order)
    .map(({ order: _o, ...rest }) => rest);
}

/**
 * Greedy diversity re-ranking: walk the fused order and penalize candidates
 * whose group (category, reference origin...) is already represented.
 * `penalty` in (0, 1]: effective score = fused * penalty^(times group used).
 */
export function diversify<T extends RankedCandidate>(
  fused: readonly FusedCandidate<T>[],
  groupOf: (c: FusedCandidate<T>) => string | null,
  n: number,
  penalty = 0.5,
): FusedCandidate<T>[] {
  const pool = [...fused];
  const used = new Map<string, number>();
  const picked: FusedCandidate<T>[] = [];
  while (picked.length < n && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    pool.forEach((c, idx) => {
      const g = groupOf(c);
      const times = g ? (used.get(g) ?? 0) : 0;
      const score = c.fused * penalty ** times;
      if (score > bestScore + 1e-12) {
        bestScore = score;
        bestIdx = idx;
      }
    });
    const [chosen] = pool.splice(bestIdx, 1);
    picked.push(chosen!);
    const g = groupOf(chosen!);
    if (g) used.set(g, (used.get(g) ?? 0) + 1);
  }
  return picked;
}

/** How wide a window of fused candidates each exploration level draws from. */
export const EXPLORATION_WINDOW: Record<Exploration, number> = {
  familiar: 1,
  balanced: 2,
  adventurous: 4,
};

/**
 * Select `n` candidates for an exploration level.
 *  familiar:    the top n fused candidates (strongest connections), lightly diversified.
 *  balanced:    diversified picks from the top 2n.
 *  adventurous: diversified picks favoring the deeper part of the top 4n, but
 *               always keeping the strongest candidate (a meaningful anchor).
 */
export function selectForExploration<T extends RankedCandidate>(
  fused: readonly FusedCandidate<T>[],
  exploration: Exploration,
  n: number,
  groupOf: (c: FusedCandidate<T>) => string | null = () => null,
): FusedCandidate<T>[] {
  if (n <= 0 || fused.length === 0) return [];
  const window = fused.slice(0, Math.max(n, n * EXPLORATION_WINDOW[exploration]));
  if (exploration === 'familiar') return diversify(window, groupOf, n, 0.9);
  if (exploration === 'balanced') return diversify(window, groupOf, n, 0.5);
  // Adventurous: keep the strongest anchor, then prefer less obvious candidates.
  const [anchor, ...rest] = window;
  const deeper = rest
    .map((c, idx) => ({ ...c, fused: c.fused * (1 + idx / Math.max(1, rest.length)) }))
    .sort((a, b) => b.fused - a.fused);
  const others = diversify(deeper, groupOf, n - 1, 0.4);
  const byKey = new Map(fused.map((c) => [c.key, c]));
  return [anchor!, ...others.map((c) => byKey.get(c.key)!)];
}
