import type { QlooEntity, QlooEntityType } from '@culture-atlas/providers';
import type { Category, ItemKind } from '../enums';

/** Qloo entity type queried for each consumer category (Eat uses the composer, not Qloo). */
export const CATEGORY_ENTITY_TYPE: Partial<Record<Category, QlooEntityType>> = {
  wear: 'urn:entity:brand',
  play: 'urn:entity:artist',
  watch: 'urn:entity:movie',
};

export const CATEGORY_ITEM_KIND: Record<Category, ItemKind> = {
  wear: 'brand',
  play: 'artist',
  watch: 'film',
  eat: 'food',
};

// Which Qloo lookup (if any) a candidate gets, and which result counts as
// the same thing, is decided in ./grounding.ts (planLookup / acceptMatch).

/** Release year for films, when Qloo returned one. */
export function entityYear(entity: Pick<QlooEntity, 'properties'>): number | null {
  const raw = entity.properties.release_year ?? entity.properties.release_date;
  const year = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw.slice(0, 4), 10) : NaN;
  return Number.isInteger(year) && year > 1800 && year < 2200 ? year : null;
}
