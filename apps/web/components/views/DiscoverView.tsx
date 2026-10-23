'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Category } from '@culture-atlas/domain';
import type { DiscoveriesResponse, DiscoveryCard as Card } from '@culture-atlas/domain/schemas';
import { api, ApiError } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '@/lib/client/format';
import { ONBOARDING_PATH } from '@/lib/client/onboarding';
import { UI_LIMITS } from '@/lib/client/limits';
import { cardToTarget, useSave } from '@/lib/client/save';
import {
  applyOverrides,
  getFeedCache,
  setFeedCache,
  updateFeedScroll,
  useItemOverrides,
  type FeedCacheEntry,
} from '@/lib/client/store';
import { CaptureStart } from '../CaptureStart';
import { CardGrid, DiscoveryCard, SkeletonGrid } from '../DiscoveryCard';
import { FilterRow } from '../FilterRow';
import { useToast } from '../Toast';
import { Notice } from '../ui';

const inflight = new Map<string, Promise<DiscoveriesResponse>>();
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Discover: "Find more of what you love." with the mixed feed, optional
 * Wear/Play/Watch/Eat filters (only those with results), explicit Load more
 * (consumes the existing feed snapshot; never starts generation) and scroll
 * restoration when returning from a detail page. New visitors also see
 * Take a photo / Upload a photo / Try an example and the AI notice.
 */
export function DiscoverView() {
  const [category, setCategory] = useState<Category | null>(null);
  const key = category ?? 'all';
  const cached = getFeedCache(key);
  const [feed, setFeed] = useState<FeedCacheEntry | null>(cached ?? null);
  const [loading, setLoading] = useState(!cached);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allCategories, setAllCategories] = useState<string[]>(
    getFeedCache('all')?.availableCategories ?? [],
  );
  const overrides = useItemOverrides();
  const { openSave } = useSave();
  const toast = useToast();
  const restored = useRef(false);

  const load = useCallback(async (cat: Category | null) => {
    const k = cat ?? 'all';
    const hit = getFeedCache(k);
    if (hit) {
      setFeed(hit);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // One request per feed key even if effects run twice (React strict mode).
      let pending = inflight.get(k);
      if (!pending) {
        pending = api.request('getDiscoveries', {
          query: { limit: UI_LIMITS.feedPageDefault, category: cat ?? undefined },
        });
        inflight.set(k, pending);
        pending.finally(() => inflight.delete(k)).catch(() => undefined);
      }
      const res = await pending;
      const entry: FeedCacheEntry = {
        items: res.items,
        nextCursor: res.next_cursor,
        availableCategories: res.available_categories,
        isExampleFeed: res.is_example_feed,
        scrollY: 0,
      };
      setFeedCache(k, entry);
      if (!cat) setAllCategories(res.available_categories);
      setFeed(entry);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'onboarding_required') {
        // The server gate (ONB-01) agrees with the shell's: finish the questionnaire first.
        window.location.replace(ONBOARDING_PATH);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Discoveries could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useAsyncEffect(() => (getFeedCache(key) ? undefined : load(category)), [key, category, load]);

  // Restore scroll position after returning from a detail page; remember it on the way out.
  useIsoLayoutEffect(() => {
    if (restored.current) return;
    const entry = getFeedCache('all');
    if (entry && entry.scrollY > 0) window.scrollTo(0, entry.scrollY);
    restored.current = true;
  }, []);
  useEffect(() => {
    const onScroll = () => updateFeedScroll(key, window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [key]);

  const loadMore = async () => {
    if (!feed?.nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api.request('getDiscoveries', {
        query: {
          limit: UI_LIMITS.feedPageDefault,
          category: category ?? undefined,
          cursor: feed.nextCursor,
        },
      });
      const seen = new Set(feed.items.map((i) => i.id));
      const entry: FeedCacheEntry = {
        ...feed,
        items: [...feed.items, ...res.items.filter((i) => !seen.has(i.id))],
        nextCursor: res.next_cursor,
      };
      setFeedCache(key, entry);
      setFeed(entry);
      toast.announce(`${res.items.length} more discoveries loaded`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'More discoveries could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  };

  const categories = (
    allCategories.length ? allCategories : (feed?.availableCategories ?? [])
  ) as Category[];
  const filterOptions = CATEGORY_ORDER.filter((c) => categories.includes(c)).map((c) => ({
    value: c,
    label: CATEGORY_LABELS[c],
  }));
  const items: Card[] = feed ? applyOverrides(feed.items, overrides) : [];
  const firstVisit = getFeedCache('all')?.isExampleFeed ?? feed?.isExampleFeed ?? false;

  return (
    <div className="page page--discover">
      <h1 className="display">Find more of what you love.</h1>
      {firstVisit && <CaptureStart />}
      {filterOptions.length > 0 && (
        <FilterRow
          label="Filter discoveries"
          options={filterOptions}
          value={category}
          onChange={(c) => setCategory(c)}
        />
      )}
      {error && (
        <Notice tone="error" onRetry={() => void load(category)}>
          {error}
        </Notice>
      )}
      {loading && !feed ? (
        <SkeletonGrid count={8} />
      ) : (
        <>
          <CardGrid label="Discoveries">
            {items.map((card, i) => (
              <li key={card.id}>
                <DiscoveryCard
                  card={card}
                  href={`/items/${card.id}?from=discover`}
                  priority={i < 4}
                  onSave={(c, el) => openSave(cardToTarget(c), el)}
                />
              </li>
            ))}
          </CardGrid>
          {items.length === 0 && !loading && !error && (
            <p className="muted">
              Nothing here yet. Try another filter, or capture something you like.
            </p>
          )}
          {feed?.nextCursor && (
            <div className="load-more">
              <button
                type="button"
                className="button button--outline"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
