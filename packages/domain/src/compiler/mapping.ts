import type { QlooEntity, QlooEntityType } from '@culture-atlas/providers';
import type { Category, ItemKind, ReferenceType } from '../enums';

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

/** Candidate reference types resolved through tag lookup rather than entity search. */
export const TAG_RESOLVED_TYPES: ReadonlySet<ReferenceType> = new Set(['style', 'tradition', 'cuisine']);

/** Entity types searched for each candidate reference type (undefined = any type). */
export function searchTypesFor(type: ReferenceType): QlooEntityType[] | undefined {
  switch (type) {
    case 'brand':
      return ['urn:entity:brand'];
    case 'creator':
      return ['urn:entity:artist', 'urn:entity:director', 'urn:entity:person', 'urn:entity:author'];
    case 'work':
      return ['urn:entity:movie', 'urn:entity:album', 'urn:entity:book', 'urn:entity:tv_show'];
    case 'place':
      return ['urn:entity:place', 'urn:entity:destination', 'urn:entity:locality'];
    default:
      return undefined;
  }
}

/** Release year for films, when Qloo returned one. */
export function entityYear(entity: Pick<QlooEntity, 'properties'>): number | null {
  const raw = entity.properties.release_year ?? entity.properties.release_date;
  const year = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw.slice(0, 4), 10) : NaN;
  return Number.isInteger(year) && year > 1800 && year < 2200 ? year : null;
}
