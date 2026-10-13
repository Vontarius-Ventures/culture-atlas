import type { ServiceContext } from '../context';
import type { Category, ItemKind, RecommendationOrigin } from '../enums';
import { ownerOf, ownerPredicate } from '../principal';
import type { DiscoveryCard, Image } from '../schemas/common';
import { readDisplayMetadata, type DisplayImage } from './display';

/**
 * Shared DiscoveryItem -> DiscoveryCard mapping used by feed, captures,
 * items, collections, saved and plans. Enforces visibility: only sample items
 * or items owned by the principal's owner are returned (others are silently
 * dropped). Agent grant checks are the caller's job (filter ids first).
 */

export interface CardRecommendationContext {
  id: string;
  origin: RecommendationOrigin;
  display_reason: string | null;
}

interface CardRow {
  id: string;
  kind: ItemKind;
  category: Category | null;
  title: string;
  display_metadata: unknown;
  is_sample: boolean;
  reference_id: string | null;
  saved_item_id: string | null;
}

export async function resolveImage(ctx: ServiceContext, image: DisplayImage | null | undefined): Promise<Image | null> {
  if (!image) return null;
  let url: string | undefined = image.url;
  if (image.object_key) {
    try {
      url = await ctx.providers.storage.signedUrl(image.object_key);
    } catch {
      url = undefined;
    }
  }
  if (!url) return null;
  return { url, width: image.width ?? null, height: image.height ?? null, alt: image.alt ?? '' };
}

export async function loadCards(
  ctx: ServiceContext,
  itemIds: readonly string[],
  options: { recommendations?: ReadonlyMap<string, CardRecommendationContext> } = {},
): Promise<DiscoveryCard[]> {
  if (itemIds.length === 0) return [];
  const owner = ownerOf(ctx.principal);
  const ownDi = ownerPredicate(owner, 'di', 2);
  const ownSi = ownerPredicate(owner, 'si', 2);
  const { rows } = await ctx.db.query<CardRow>(
    `SELECT di.id, di.kind, di.category, di.title, di.display_metadata, di.is_sample, di.reference_id,
            si.id AS saved_item_id
       FROM discovery_items di
       LEFT JOIN saved_items si ON si.discovery_item_id = di.id AND ${ownSi.sql}
      WHERE di.id = ANY($1::uuid[]) AND (di.is_sample OR ${ownDi.sql})`,
    [itemIds, ...ownDi.params],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cards: DiscoveryCard[] = [];
  for (const id of itemIds) {
    const row = byId.get(id);
    if (!row) continue;
    const meta = readDisplayMetadata(row.display_metadata);
    const rec = options.recommendations?.get(id);
    const subtitle = meta.subtitle ?? (meta.year ? String(meta.year) : null);
    cards.push({
      id: row.id,
      kind: row.kind,
      category: row.category,
      title: row.title,
      subtitle: subtitle ?? null,
      image: await resolveImage(ctx, meta.image),
      is_example: row.is_sample || rec?.origin === 'sample' || rec?.origin === 'replay',
      saved: row.saved_item_id !== null,
      saved_item_id: row.saved_item_id,
      recommendation_id: rec?.id ?? null,
      evidence_available: Boolean(rec?.display_reason) || row.reference_id !== null,
    });
  }
  return cards;
}
