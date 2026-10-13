import { z } from 'zod';
import { CollectionFilter, LIMITS } from '../enums';
import { Cursor, DiscoveryCard, Image, PageQuery, Timestamp, Uuid } from './common';

export const CollectionSummary = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  item_count: z.number().int().nonnegative(),
  /** Up to four cover images for the mosaic. */
  cover: z.array(Image).max(4),
  revision: z.number().int().positive(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type CollectionSummary = z.infer<typeof CollectionSummary>;

/** GET /v1/collections — agents see granted collections only. */
export const CollectionsListResponse = z.object({
  collections: z.array(CollectionSummary),
  /** Virtual "Saved for later" (unfiled saves). null when not visible (selected-collection agents). */
  unfiled: z.object({ item_count: z.number().int().nonnegative(), cover: z.array(Image).max(4) }).nullable(),
});
export type CollectionsListResponse = z.infer<typeof CollectionsListResponse>;

/** POST /v1/collections — returns 201 CollectionSummary. */
export const CreateCollectionRequest = z.strictObject({
  name: z.string().trim().min(1).max(LIMITS.collectionNameMax),
  description: z.string().trim().max(LIMITS.collectionDescriptionMax).nullable().optional(),
});
export type CreateCollectionRequest = z.infer<typeof CreateCollectionRequest>;

/** GET /v1/collections/{id} */
export const CollectionQuery = PageQuery.extend({ filter: CollectionFilter.optional() });
export type CollectionQuery = z.infer<typeof CollectionQuery>;

export const CollectionMember = z.object({
  membership_id: Uuid,
  saved_item_id: Uuid,
  position: z.number().int(),
  added_at: Timestamp,
  item: DiscoveryCard,
});
export type CollectionMember = z.infer<typeof CollectionMember>;

export const CollectionDetailResponse = z.object({
  collection: CollectionSummary,
  items: z.array(CollectionMember),
  next_cursor: Cursor.nullable(),
  available_filters: z.array(CollectionFilter),
});
export type CollectionDetailResponse = z.infer<typeof CollectionDetailResponse>;

/** PATCH /v1/collections/{id} — successful mutation increments revision. */
export const UpdateCollectionRequest = z
  .strictObject({
    expected_revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(LIMITS.collectionNameMax).optional(),
    description: z.string().trim().max(LIMITS.collectionDescriptionMax).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'Provide name and/or description',
  });
export type UpdateCollectionRequest = z.infer<typeof UpdateCollectionRequest>;

export const CollectionItemParams = z.object({ id: Uuid, item_id: Uuid });
export type CollectionItemParams = z.infer<typeof CollectionItemParams>;

/**
 * PUT /v1/collections/{id}/items/{item_id} — item_id is a DiscoveryItem id.
 * Saves the accessible item if needed, then adds membership idempotently.
 * Body optional.
 */
export const AddCollectionItemRequest = z.strictObject({
  expected_revision: z.number().int().positive().optional(),
});
export type AddCollectionItemRequest = z.infer<typeof AddCollectionItemRequest>;

export const AddCollectionItemResponse = z.object({
  collection_id: Uuid,
  membership_id: Uuid,
  saved_item_id: Uuid,
  collection_revision: z.number().int().positive(),
  /** false when the membership already existed (idempotent). */
  created: z.boolean(),
  /** true when this call also created the SavedItem. */
  saved: z.boolean(),
});
export type AddCollectionItemResponse = z.infer<typeof AddCollectionItemResponse>;

/** DELETE /v1/collections/{id}/items/{item_id} — removes this membership only. */
export const RemoveCollectionItemResponse = z.object({
  collection_id: Uuid,
  collection_revision: z.number().int().positive(),
  removed: z.boolean(),
});
export type RemoveCollectionItemResponse = z.infer<typeof RemoveCollectionItemResponse>;

/** PUT /v1/collections/{id}/order — same members exactly once. */
export const ReorderCollectionRequest = z.strictObject({
  expected_revision: z.number().int().positive(),
  membership_ids: z.array(Uuid).max(1000),
});
export type ReorderCollectionRequest = z.infer<typeof ReorderCollectionRequest>;

export const ReorderCollectionResponse = z.object({
  collection_id: Uuid,
  collection_revision: z.number().int().positive(),
});
export type ReorderCollectionResponse = z.infer<typeof ReorderCollectionResponse>;
