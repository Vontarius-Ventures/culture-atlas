import type { ServiceContext } from '../context';
import { notImplemented } from '../errors';
import type {
  ItemDetailResponse,
  ItemQuery,
  RelatedDiscoveryRequest,
  RelatedDiscoveryResponse,
} from '../schemas/items';

/**
 * Item detail and related discoveries. Related results use the item's
 * canonical entities/tags as anchors. Opening a card never triggers
 * generation; only POST .../discoveries starts one bounded discover_related
 * job (dedupe: relatedDiscoveryDedupeKey). Agents: the item must be within a
 * granted collection (pass collection_id) and results stay tied to that origin.
 */

/** GET /v1/items/{id}. TODO(discovery owner): implement. */
export async function getItem(
  ctx: ServiceContext,
  input: { id: string; query: ItemQuery },
): Promise<ItemDetailResponse> {
  void ctx;
  void input;
  notImplemented('items.getItem');
}

/** POST /v1/items/{id}/discoveries — 202. TODO(discovery owner): implement. */
export async function startRelatedDiscovery(
  ctx: ServiceContext,
  input: { id: string; body: RelatedDiscoveryRequest },
): Promise<RelatedDiscoveryResponse> {
  void ctx;
  void input;
  notImplemented('items.startRelatedDiscovery');
}
