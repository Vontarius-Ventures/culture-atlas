import catalogJson from '../../../../fixtures/onboarding/catalog.json';
import type { Category, ItemKind } from '../enums';
import { OnboardingCatalogFile, type OnboardingCatalogItem, type QlooRef } from '../schemas/onboarding';

/**
 * The pre-resolved onboarding catalog (fixtures/onboarding/catalog.json),
 * built from live Qloo lookups by scripts/build-onboarding-catalog.ts. Every
 * chip and image carries real Qloo tag ids and their retrieval date; the
 * catalog is what keeps onboarding completable while Qloo is down.
 */

let cached: OnboardingCatalogFile | undefined;
let override: OnboardingCatalogFile | undefined;

export function getOnboardingCatalogFile(): OnboardingCatalogFile {
  if (override) return override;
  cached ??= OnboardingCatalogFile.parse(catalogJson);
  return cached;
}

/** Tests only: swap the catalog (pass undefined to restore the committed one). */
export function setOnboardingCatalogForTesting(file: OnboardingCatalogFile | undefined): void {
  override = file ? OnboardingCatalogFile.parse(file) : undefined;
}

export function findCatalogItem(id: string): OnboardingCatalogItem | null {
  return getOnboardingCatalogFile().items.find((i) => i.id === id) ?? null;
}

/** Plain-language labels for Qloo entity types (search results show name and type only). */
const ENTITY_TYPES: Record<string, { label: string; kind: ItemKind; category: Category | null }> = {
  'urn:entity:artist': { label: 'Artist', kind: 'artist', category: 'play' },
  'urn:entity:movie': { label: 'Film', kind: 'film', category: 'watch' },
  'urn:entity:tv_show': { label: 'TV show', kind: 'film', category: 'watch' },
  'urn:entity:brand': { label: 'Brand', kind: 'brand', category: 'wear' },
  'urn:entity:place': { label: 'Place', kind: 'reference', category: null },
  'urn:entity:destination': { label: 'Destination', kind: 'reference', category: null },
  'urn:entity:locality': { label: 'City', kind: 'reference', category: null },
  'urn:entity:album': { label: 'Album', kind: 'reference', category: 'play' },
  'urn:entity:book': { label: 'Book', kind: 'reference', category: null },
  'urn:entity:author': { label: 'Author', kind: 'reference', category: null },
  'urn:entity:director': { label: 'Director', kind: 'reference', category: 'watch' },
  'urn:entity:actor': { label: 'Actor', kind: 'reference', category: 'watch' },
  'urn:entity:person': { label: 'Person', kind: 'reference', category: null },
  'urn:entity:podcast': { label: 'Podcast', kind: 'reference', category: null },
  'urn:entity:videogame': { label: 'Video game', kind: 'reference', category: null },
};

/** Entity types searched per consumer category ("Add an artist, film, brand or place"). */
export const SEARCH_TYPES: Record<Category | 'all', string[]> = {
  all: ['urn:entity:artist', 'urn:entity:movie', 'urn:entity:brand', 'urn:entity:place', 'urn:entity:tv_show'],
  wear: ['urn:entity:brand'],
  play: ['urn:entity:artist'],
  watch: ['urn:entity:movie', 'urn:entity:tv_show'],
  eat: ['urn:entity:place'],
};

/** The supported entity type among Qloo's `types` (first known one wins), or null. */
export function primaryEntityType(types: readonly string[], subtype?: string): string | null {
  if (subtype && ENTITY_TYPES[subtype]) return subtype;
  return types.find((t) => ENTITY_TYPES[t]) ?? null;
}

export function entityTypeInfo(type: string) {
  return ENTITY_TYPES[type] ?? null;
}

const TAG_TYPE_LABELS: [prefix: string, label: string][] = [
  ['urn:tag:cuisine', 'Cuisine'],
  ['urn:tag:specialty_dish', 'Dish'],
  ['urn:tag:genre:music', 'Music genre'],
  ['urn:tag:genre:media', 'Film genre'],
  ['urn:tag:subgenre', 'Film genre'],
  ['urn:tag:keyword', 'Theme'],
  ['urn:tag:decor', 'Style'],
  ['urn:tag:style', 'Style'],
  ['urn:tag:ambience', 'Mood'],
];

/**
 * DiscoveryItem identity for a Qloo ref. Tags become `style` items (`food`
 * when they stand for Eat), entities follow their type; the Qloo id goes into
 * external_ids (`qloo_tag` for tags, `qloo` for entities, as the compiler does).
 */
export function itemForRef(ref: QlooRef, category: Category | null) {
  if (ref.type === 'tag') {
    const label = TAG_TYPE_LABELS.find(([p]) => ref.id.startsWith(`${p}:`))?.[1] ?? 'Style';
    return {
      kind: (category === 'eat' ? 'food' : 'style') as ItemKind,
      category,
      canonical_key: `qloo:${ref.id}`,
      title: ref.name,
      subtitle: label,
      external_ids: { qloo_tag: ref.id, ...(ref.subtype ? { qloo_tag_type: ref.subtype } : {}) },
    };
  }
  const info = ref.subtype ? entityTypeInfo(ref.subtype) : null;
  return {
    kind: info?.kind ?? ('reference' as ItemKind),
    category: info ? info.category ?? category : category,
    canonical_key: `qloo:${ref.id}`,
    title: ref.name,
    subtitle: info?.label ?? null,
    external_ids: { qloo: ref.id, ...(ref.subtype ? { qloo_types: [ref.subtype] } : {}) },
  };
}
