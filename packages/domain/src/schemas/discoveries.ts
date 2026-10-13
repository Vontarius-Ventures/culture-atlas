import { z } from 'zod';
import { Category } from '../enums';
import { Cursor, DiscoveryCard, PageQuery, Uuid } from './common';

/**
 * GET /v1/discoveries — stable cursor-paginated mixed feed. Never starts
 * generation: pages consume the existing FeedSnapshot. The cursor carries
 * feed snapshot id + taste revision + position.
 */
export const DiscoveriesQuery = PageQuery.extend({
  category: Category.optional(),
  /** Force a new snapshot from the existing pool (explicit refresh). */
  refresh: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
export type DiscoveriesQuery = z.infer<typeof DiscoveriesQuery>;

export const DiscoveriesResponse = z.object({
  items: z.array(DiscoveryCard),
  next_cursor: Cursor.nullable(),
  feed_id: Uuid,
  feed_revision: z.number().int(),
  /** True when the feed is built from reviewed sample items (new users). */
  is_example_feed: z.boolean(),
  /** Categories that currently have results (render only these filters). */
  available_categories: z.array(Category),
});
export type DiscoveriesResponse = z.infer<typeof DiscoveriesResponse>;
