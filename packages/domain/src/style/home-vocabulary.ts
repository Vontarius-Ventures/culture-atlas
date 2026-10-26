import { readFileSync } from 'node:fs';
import { resolveFromWorkspace } from '@culture-atlas/providers';

/**
 * The home-brand catalogue (home-brands-1): real Qloo brand pages for
 * furniture, kitchenware, tableware, ceramics, decor, interior design and
 * coffee, recorded live and committed as fixtures (no network at runtime).
 * Built by scripts/style/build-home-brands.ts; every id and name is verbatim
 * from a recorded response (home-brands.test.ts re-checks this).
 */
export const HOME_BRANDS_VERSION = 'home-brands-1';

export interface HomeBrand {
  id: string;
  name: string;
  popularity: number;
  price_level: string | null;
  /** urn:tag:industry:qloo:* ids: the kind gate (furniture, tableware, coffee, ...). */
  industry_ids: string[];
  /** urn:tag:genre:brand:* ids (product families). */
  genre_ids: string[];
  /** Matchable style tags with their own recorded labels. */
  style_tags: { id: string; name: string }[];
  /** The raw response the brand was first seen on (provenance). */
  seen_on: string;
}

let loaded: readonly HomeBrand[] | undefined;

/** The committed home-brand catalogue (loaded once, lazily, from fixtures/qloo/home-brands). */
export function homeBrands(): readonly HomeBrand[] {
  if (loaded) return loaded;
  const data = JSON.parse(readFileSync(resolveFromWorkspace('fixtures/qloo/home-brands/home-brands.json'), 'utf8')) as { version: string; brands: HomeBrand[] };
  loaded = data.brands;
  return loaded;
}

export function setHomeBrandsForTesting(v: readonly HomeBrand[] | undefined): void {
  loaded = v;
}
