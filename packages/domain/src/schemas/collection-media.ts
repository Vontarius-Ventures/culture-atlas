import { z } from 'zod';
import { Timestamp, Uuid } from './common';
export const CollectionMediaParams = z.object({ id: Uuid, asset_id: Uuid });
export const CollectionMediaResult = z.object({ collection_id: Uuid, asset_id: Uuid });
export const CollectionMediaResponse = z.object({
  items: z.array(z.object({
    id: Uuid, kind: z.enum(['photo', 'video']), title: z.string().nullable(), status: z.string(),
    generation: z.number().int(), source: z.string(), created_at: Timestamp,
  })), next_cursor: z.string().nullable(),
});
