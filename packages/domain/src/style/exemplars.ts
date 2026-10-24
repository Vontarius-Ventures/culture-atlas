import type { AcceptedTag } from './map-tags';
import type { ExemplarBrand } from './vocabulary';

/**
 * Exemplar anchors from a local tag-space match (style design R-1). For a
 * garment with no identified brand, the harvested brand matrix
 * (fixtures/qloo/style-vocab/brands.json, real Qloo tags only) is scored
 * against the subject's accepted tag ids; the top qualifying brands become
 * entity SIGNALS for one filtered, explainable insights call (the probe's
 * i04 recipe). Exemplars are never cards and never named in reasons.
 */
export const EXEMPLAR_MIN_POPULARITY = 0.8;
export const EXEMPLAR_MIN_TAGS = 2;
export const EXEMPLARS_MAX = 3;

export interface Exemplar {
  id: string;
  name: string;
  score: number;
  popularity: number;
  shared: string[];
}

export function selectExemplars(
  brands: readonly ExemplarBrand[],
  accepted: readonly AcceptedTag[],
  filterTag: string | null,
  options: { exclude?: ReadonlySet<string>; max?: number } = {},
): Exemplar[] {
  const weight = new Map<string, number>();
  for (const t of accepted) weight.set(t.id, Math.max(weight.get(t.id) ?? 0, t.weight));
  const scored: Exemplar[] = [];
  for (const b of brands) {
    if (options.exclude?.has(b.id) || b.popularity < EXEMPLAR_MIN_POPULARITY) continue;
    if (filterTag && !b.style_tag_ids.includes(filterTag)) continue;
    const shared = b.style_tag_ids.filter((id) => weight.has(id));
    if (shared.length < EXEMPLAR_MIN_TAGS) continue;
    scored.push({ id: b.id, name: b.name, popularity: b.popularity, shared, score: shared.reduce((s, id) => s + weight.get(id)!, 0) });
  }
  // Deterministic: score, then popularity, then id.
  scored.sort((a, b) => b.score - a.score || b.popularity - a.popularity || a.id.localeCompare(b.id));
  return scored.slice(0, options.max ?? EXEMPLARS_MAX);
}
