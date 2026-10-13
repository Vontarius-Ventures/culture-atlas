import { z } from 'zod';
import { Category, ItemKind } from '../enums';
import { Uuid } from './common';

/** GET /v1/taste — explicit interest summary. Selected-collection agents must pass collection_id. */
export const TasteQuery = z.object({ collection_id: Uuid.optional() });
export type TasteQuery = z.infer<typeof TasteQuery>;

export const TasteResponse = z.object({
  scope: z.enum(['global', 'collection']),
  collection_id: Uuid.nullable(),
  revision: z.number().int().nonnegative(),
  interests: z.array(
    z.object({
      label: z.string(),
      kind: ItemKind,
      category: Category.nullable(),
      item_id: Uuid.nullable(),
      reference_id: Uuid.nullable(),
      /** Plain-language strength; never a raw score. */
      strength: z.enum(['strong', 'some']),
    }),
  ),
  saved_count: z.number().int().nonnegative(),
  hidden_count: z.number().int().nonnegative(),
});
export type TasteResponse = z.infer<typeof TasteResponse>;
