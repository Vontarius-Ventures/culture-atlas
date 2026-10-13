import type { ServiceContext } from '../context';
import { notImplemented } from '../errors';
import type { DiscoveriesQuery, DiscoveriesResponse } from '../schemas/discoveries';

/**
 * Discovery Feed module. New users: reviewed sample items (is_example_feed).
 * Returning users: bounded pool of supported recommendations connected to
 * explicit saves. Interleave categories, dedupe canonical items, suppress
 * hidden items, avoid >2 consecutive cards of one category when alternatives
 * exist. Pages read a FeedSnapshot (cursor = snapshot id + taste revision +
 * position); fetching a page NEVER starts generation. Selected-collection
 * agents cannot read the global feed (403).
 */

/** GET /v1/discoveries. TODO(discovery owner): implement. */
export async function getDiscoveries(ctx: ServiceContext, query: DiscoveriesQuery): Promise<DiscoveriesResponse> {
  void ctx;
  void query;
  notImplemented('discovery.getDiscoveries');
}

/**
 * Pure ordering helper (unit-tested by the discovery owner): interleave by
 * category, dedupe by canonical key, drop excluded keys, cap runs at 2.
 * TODO(discovery owner): implement.
 */
export function interleaveFeed<T extends { id: string; canonical_key: string; category: string | null }>(
  candidates: readonly T[],
  excludedKeys: ReadonlySet<string>,
): T[] {
  void candidates;
  void excludedKeys;
  notImplemented('discovery.interleaveFeed');
}
