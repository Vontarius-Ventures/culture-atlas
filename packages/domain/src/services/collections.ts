import type { ServiceContext } from '../context';
import { notImplemented } from '../errors';
import type {
  AddCollectionItemRequest,
  AddCollectionItemResponse,
  CollectionDetailResponse,
  CollectionQuery,
  CollectionSummary,
  CollectionsListResponse,
  CreateCollectionRequest,
  RemoveCollectionItemResponse,
  ReorderCollectionRequest,
  ReorderCollectionResponse,
  UpdateCollectionRequest,
} from '../schemas/collections';

/**
 * Collections module. Private by default; account-only. Every successful
 * mutation increments collections.revision; expected_revision mismatches
 * return 409 revision_conflict. Agents: list/read limited to granted
 * collections (grantedCollectionFilter); create requires collections:write +
 * whole-library; adding an UNSAVED item additionally requires taste:write.
 */

/** GET /v1/collections. TODO(collections owner): implement. */
export async function listCollections(ctx: ServiceContext): Promise<CollectionsListResponse> {
  void ctx;
  notImplemented('collections.listCollections');
}

/** POST /v1/collections (201). TODO(collections owner): implement. */
export async function createCollection(ctx: ServiceContext, body: CreateCollectionRequest): Promise<CollectionSummary> {
  void ctx;
  void body;
  notImplemented('collections.createCollection');
}

/** GET /v1/collections/{id}. TODO(collections owner): implement. */
export async function getCollection(
  ctx: ServiceContext,
  input: { id: string; query: CollectionQuery },
): Promise<CollectionDetailResponse> {
  void ctx;
  void input;
  notImplemented('collections.getCollection');
}

/** PATCH /v1/collections/{id}. TODO(collections owner): implement. */
export async function updateCollection(
  ctx: ServiceContext,
  input: { id: string; body: UpdateCollectionRequest },
): Promise<CollectionSummary> {
  void ctx;
  void input;
  notImplemented('collections.updateCollection');
}

/**
 * DELETE /v1/collections/{id} — removes collection + memberships; saved items
 * with no remaining memberships become unfiled; plans keep their snapshot and
 * get source_collection_id = NULL (FK ON DELETE SET NULL).
 * TODO(collections owner): implement.
 */
export async function deleteCollection(ctx: ServiceContext, input: { id: string }): Promise<void> {
  void ctx;
  void input;
  notImplemented('collections.deleteCollection');
}

/**
 * PUT /v1/collections/{id}/items/{item_id} — item_id is a DiscoveryItem id.
 * Saves the accessible item if needed and adds membership idempotently.
 * TODO(collections owner): implement.
 */
export async function addCollectionItem(
  ctx: ServiceContext,
  input: { id: string; item_id: string; body: AddCollectionItemRequest },
): Promise<AddCollectionItemResponse> {
  void ctx;
  void input;
  notImplemented('collections.addCollectionItem');
}

/** DELETE /v1/collections/{id}/items/{item_id} — this membership only. TODO(collections owner). */
export async function removeCollectionItem(
  ctx: ServiceContext,
  input: { id: string; item_id: string },
): Promise<RemoveCollectionItemResponse> {
  void ctx;
  void input;
  notImplemented('collections.removeCollectionItem');
}

/** PUT /v1/collections/{id}/order — exactly the current members once each. TODO(collections owner). */
export async function reorderCollection(
  ctx: ServiceContext,
  input: { id: string; body: ReorderCollectionRequest },
): Promise<ReorderCollectionResponse> {
  void ctx;
  void input;
  notImplemented('collections.reorderCollection');
}
