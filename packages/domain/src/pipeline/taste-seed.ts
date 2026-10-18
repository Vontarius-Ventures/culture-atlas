import { notImplemented } from '../errors';
import type { JobHandler } from '../jobs/handler';

/**
 * Taste seed (spec amendment 2.2, "Seeding the feed"). Owned by package B
 * (docs/build-plan-v2.2.md). Contract:
 *  - reads the owner's CURRENT onboarding picks (explicit saves of real Qloo
 *    tags/entities) and uses them as Qloo `signal.interests.tags` /
 *    `signal.interests.entities`, one insights request per category in
 *    `payload.categories` (brands for Wear, artists for Play, films for Watch,
 *    places/cuisines for Eat): at most 6 Qloo requests, at most 3 concurrent;
 *  - writes results as recommendations into the owner's feed pool and builds a
 *    new FeedSnapshot (usual feed rules), publishing category by category so
 *    GET /v1/onboarding/seed can report the first ready category;
 *  - never fabricates: a category Qloo returns nothing for stays `empty`; a
 *    Qloo outage leaves it `unavailable` and the job retries (labeled examples
 *    fill the feed meanwhile);
 *  - calls ctx.ensureActive() before publishing (account deletion stops it).
 *
 * Until package B lands, the handler fails without retry so a queued seed
 * never pretends to have produced anything.
 */
export const tasteSeed: JobHandler<'taste_seed'> = async () => {
  notImplemented('The taste seed job');
};
