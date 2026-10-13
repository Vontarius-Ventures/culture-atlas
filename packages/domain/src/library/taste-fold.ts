import type { Category, ItemKind } from '../enums';

/**
 * Preference folding: the derived taste profile is a pure function of the
 * owner's CURRENT explicit preferences (saved items + hides). Rules (spec
 * "Recommendation and memory rules"):
 *  - Saving an individual item endorses only that item (weight 1) and lends
 *    its resolved anchors a smaller weight.
 *  - Saving an inspiration (a capture) endorses the capture as a whole and its
 *    current focus: its resolved anchors contribute weighted inputs; anchors the
 *    user selected/confirmed count fully.
 *  - Saving the same item into more collections never multiplies its weight:
 *    the input is the set of SavedItems (unique per owner + item), not memberships.
 *  - Hide excludes that item only, never a whole culture or category.
 *  - Uploading, viewing or opening never appears here.
 */

export interface FoldAnchor {
  reference_id: string;
  name: string;
  /** Selected/confirmed by the user ("What caught your eye?" / correction). */
  user_selected: boolean;
}

export interface FoldSave {
  saved_item_id: string;
  item_id: string;
  kind: ItemKind;
  category: Category | null;
  title: string;
  canonical_key: string;
  reference_id: string | null;
  anchors: FoldAnchor[];
}

export interface TasteInterest {
  label: string;
  kind: ItemKind;
  category: Category | null;
  item_id: string | null;
  reference_id: string | null;
  strength: 'strong' | 'some';
  weight: number;
}

export interface TasteSummary {
  interests: TasteInterest[];
  anchors: { reference_id: string; name: string; weight: number }[];
  categories: Partial<Record<Category, number>>;
  saved_count: number;
}

export const WEIGHTS = {
  item: 1,
  itemAnchor: 0.5,
  captureAnchor: 0.6,
  selectedAnchor: 1,
  anchorCap: 3,
  strongAt: 1,
} as const;

const round = (n: number) => Math.round(n * 1000) / 1000;

export function foldPreferences(saves: readonly FoldSave[], hidden: ReadonlySet<string> = new Set(), limit = 50): TasteSummary {
  // Dedupe defensively: one contribution per saved discovery item.
  const unique = new Map<string, FoldSave>();
  for (const s of saves) if (!unique.has(s.item_id)) unique.set(s.item_id, s);

  const anchors = new Map<string, { name: string; weight: number }>();
  const items: TasteInterest[] = [];
  const categories: Partial<Record<Category, number>> = {};

  for (const s of unique.values()) {
    if (hidden.has(s.canonical_key)) continue;
    if (s.category) categories[s.category] = (categories[s.category] ?? 0) + 1;
    const isCapture = s.kind === 'capture';
    if (!isCapture) {
      items.push({
        label: s.title,
        kind: s.kind,
        category: s.category,
        item_id: s.item_id,
        reference_id: s.reference_id,
        strength: 'strong',
        weight: WEIGHTS.item,
      });
    }
    // Each reference counts once per saved item.
    const seen = new Set<string>();
    for (const a of s.anchors) {
      if (seen.has(a.reference_id)) continue;
      seen.add(a.reference_id);
      const w = a.user_selected ? WEIGHTS.selectedAnchor : isCapture ? WEIGHTS.captureAnchor : WEIGHTS.itemAnchor;
      const cur = anchors.get(a.reference_id) ?? { name: a.name, weight: 0 };
      cur.weight = Math.min(WEIGHTS.anchorCap, cur.weight + w);
      anchors.set(a.reference_id, cur);
    }
  }

  const itemRefs = new Set(items.map((i) => i.reference_id).filter(Boolean));
  const refInterests: TasteInterest[] = [...anchors.entries()]
    .filter(([id]) => !itemRefs.has(id))
    .map(([id, a]) => ({
      label: a.name,
      kind: 'reference' as const,
      category: null,
      item_id: null,
      reference_id: id,
      strength: a.weight >= WEIGHTS.strongAt ? ('strong' as const) : ('some' as const),
      weight: round(a.weight),
    }));

  const interests = [...items, ...refInterests]
    .sort((x, y) => y.weight - x.weight || x.label.localeCompare(y.label))
    .slice(0, limit);

  return {
    interests,
    anchors: [...anchors.entries()]
      .map(([reference_id, a]) => ({ reference_id, name: a.name, weight: round(a.weight) }))
      .sort((x, y) => y.weight - x.weight || x.name.localeCompare(y.name)),
    categories,
    saved_count: unique.size,
  };
}
