'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Category } from '@culture-atlas/domain';
import type { DiscoveriesResponse, DiscoveryCard as Card } from '@culture-atlas/domain/schemas';
import { api, ApiError } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '@/lib/client/format';
import { UI_LIMITS } from '@/lib/client/limits';
import { cardToTarget, useSave } from '@/lib/client/save';
import { useSession } from '@/lib/client/session';
import { countFresh, dedupeByTitle, feedColumns, mergeLanded, mergeRefreshed } from '@/lib/client/conveyor';
import {
  applyOverrides,
  getFeedCache,
  setFeedCache,
  updateFeedScroll,
  useItemOverrides,
  type FeedCacheEntry,
} from '@/lib/client/store';
import { CaptureStart } from '../CaptureStart';
import { Conveyor } from '../Conveyor';
import { redirectToOnboarding } from '../onboarding/OnboardingGate';
import { Icon } from '../Icon';
import { CardGrid, DiscoveryCard, SkeletonGrid } from '../DiscoveryCard';
import { FilterRow } from '../FilterRow';
import { useToast } from '../Toast';
import { Notice } from '../ui';

const inflight = new Map<string, Promise<DiscoveriesResponse>>();
/** While an account's feed is still the example feed (seed building), look again this often. */
const EXAMPLE_POLL_MS = 8_000;
/** Stop looking after this long without the person doing anything (the feed stays as it is). */
const EXAMPLE_POLL_WINDOW_MS = 3 * 60_000;

/** The server's own hint that more cards are on their way (`expansion`). */
function pollAfter(res: DiscoveriesResponse): number | null {
  return res.expansion?.state === 'running' ? (res.expansion.poll_after_ms ?? EXAMPLE_POLL_MS) : null;
}
/**
 * The floating feed keeps this many cards in its pool, fetching the next page
 * in the background while the drift runs, so the same few cards never loop.
 */
const POOL_TARGET = 48;
/** Once the server has no further page, look for a fresh snapshot this often (visible tab only). */
const TOP_UP_MS = 45_000;
/** Examples step aside once this many personal cards exist. */
const PERSONAL_ENOUGH = 12;
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Discover: "Find more of what you love." with the mixed feed, optional
 * Wear/Play/Watch/Eat filters (only those with results), explicit Load more
 * (consumes the existing feed snapshot; never starts generation) and scroll
 * restoration when returning from a detail page. New visitors also see
 * Take a photo / Upload a photo / Try an example and the AI notice.
 *
 * The grid floats: a conveyor of 2-4 columns drifting upward at staggered
 * speeds, refilled from the loaded pool (components/Conveyor.tsx). Refresh asks
 * for a new snapshot and merges it in front of the pool; an empty or failed
 * refresh keeps every card already shown. Reduce Motion shows the static grid.
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
  const { isAccount } = useSession();
  const [refreshing, setRefreshing] = useState(false);
  // The filter on screen now: a refresh that lands after the filter changed
  // updates its own cache entry but must not replace the visible feed.
  const keyRef = useRef(key);
  useIsoLayoutEffect(() => {
    keyRef.current = key;
  }, [key]);

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
        pollAfterMs: pollAfter(res),
        scrollY: 0,
      };
      setFeedCache(k, entry);
      if (!cat) setAllCategories(res.available_categories);
      setFeed(entry);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'onboarding_required') {
        // The server gate (ONB-01) agrees with the shell's: finish the
        // questionnaire first — but an open dialog (the save that created
        // this account) finishes first, then the shell gate redirects.
        redirectToOnboarding();
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

  const loadMore = async (opts: { quiet?: boolean } = {}) => {
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
      if (keyRef.current === key) setFeed(entry);
      if (!opts.quiet) toast.announce(`${res.items.length} more discoveries loaded`);
    } catch (err) {
      // Background top-ups fail silently; the cards already shown stay.
      if (!opts.quiet)
        setError(err instanceof ApiError ? err.message : 'More discoveries could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  };

  /**
   * Explicit refresh: GET ?refresh=true and merge the new snapshot in front of
   * the pool. Never empties the grid: an empty response or an error keeps
   * every card already loaded. When an account's example feed turns personal,
   * the personal cards replace the examples.
   *
   * `poll` is the background look while the seed is still landing: it reads
   * the latest snapshot the server rebuilt (no `refresh`, so nothing is
   * demoted) and real cards push out the examples they replace.
   */
  const refreshFeed = useCallback(
    async (opts: { quiet?: boolean; poll?: boolean } = {}) => {
      const current = getFeedCache(key);
      if (!current) return;
      if (!opts.poll) setRefreshing(true);
      try {
        const res = await api.request('getDiscoveries', {
          query: {
            limit: UI_LIMITS.feedPageDefault,
            category: category ?? undefined,
            refresh: opts.poll ? undefined : 'true',
          },
        });
        const latest = getFeedCache(key) ?? current;
        if (res.items.length === 0) {
          if (!opts.quiet) toast.announce('No new discoveries yet');
          const idle: FeedCacheEntry = { ...latest, pollAfterMs: pollAfter(res) };
          setFeedCache(key, idle);
          if (keyRef.current === key) setFeed(idle);
          return;
        }
        const becamePersonal = latest.isExampleFeed && !res.is_example_feed;
        // Count what the person will actually see as new (same title = same card).
        const fresh = countFresh(res.items, becamePersonal ? [] : latest.items);
        const entry: FeedCacheEntry = {
          ...latest,
          items: becamePersonal
            ? [...res.items]
            : opts.poll
              ? mergeLanded(res.items, latest.items)
              : mergeRefreshed(res.items, latest.items),
          nextCursor: res.next_cursor,
          isExampleFeed: res.is_example_feed,
          pollAfterMs: pollAfter(res),
          availableCategories: Array.from(
            new Set([...latest.availableCategories, ...res.available_categories]),
          ),
        };
        setFeedCache(key, entry);
        if (!category) setAllCategories(entry.availableCategories);
        if (keyRef.current !== key) return;
        setFeed(entry);
        if (becamePersonal) {
          toast.announce('Your personal feed is ready');
        } else if (!opts.quiet) {
          // Asked for: a visible answer.
          toast.show({
            message:
              fresh === 0
                ? 'No new discoveries yet'
                : `${fresh} new ${fresh === 1 ? 'discovery' : 'discoveries'}`,
            duration: 3500,
          });
        } else if (fresh > 0) {
          toast.announce(`${fresh} new ${fresh === 1 ? 'discovery' : 'discoveries'}`);
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'onboarding_required') {
          // Same hold as the shell gate: a dialog in progress finishes first.
          redirectToOnboarding();
          return;
        }
        // Keep the grid; say so only when the person asked, and offer to try again.
        if (!opts.quiet) {
          toast.show({
            message: err instanceof ApiError ? err.message : 'Discoveries could not be refreshed.',
            action: {
              label: 'Retry',
              // Same path as pressing Refresh again.
              onAction: () =>
                document.querySelector<HTMLButtonElement>('.feed-toolbar__refresh')?.click(),
            },
          });
        }
      } finally {
        if (!opts.poll) setRefreshing(false);
      }
    },
    [key, category, toast],
  );

  // Landing here right after Settings -> Sign out: confirm it, then tidy the URL.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('signed_out') !== '1') return;
    toast.show({ message: 'You’re signed out. Your account stays private.', duration: 4000 });
    url.searchParams.delete('signed_out');
    window.history.replaceState(window.history.state, '', url.pathname + url.search);
  }, [toast]);

  // A feed that never runs out: while the pool is shallow, fetch the next page
  // in the background; once the server has no further page, quietly look for a
  // fresh snapshot now and then. Neither ever removes a card already shown.
  const poolSize = feed?.items.length ?? 0;
  const nextCursor = feed?.nextCursor ?? null;
  useEffect(() => {
    if (!nextCursor || loadingMore || refreshing || poolSize >= POOL_TARGET) return;
    const t = window.setTimeout(() => void loadMore({ quiet: true }), 1200);
    return () => window.clearTimeout(t);
    // loadMore reads the current feed; re-arm only when the pool or cursor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor, poolSize, loadingMore, refreshing]);
  const topUp = Boolean(feed) && !nextCursor && poolSize < POOL_TARGET && !feed?.isExampleFeed && !feed?.pollAfterMs;
  useEffect(() => {
    if (!topUp) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshFeed({ quiet: true });
    }, TOP_UP_MS);
    return () => window.clearInterval(timer);
  }, [topUp, refreshFeed]);

  // An account whose personal feed is still building sees examples: the whole
  // example feed, or (right after onboarding, once the first category lands)
  // a short personal pool topped up with examples while the seed keeps
  // publishing. Look again every few seconds (bounded) so the real cards float
  // in as they land; no reload needed.
  const pollMs = isAccount && !category
    ? (feed?.pollAfterMs ?? (feed?.isExampleFeed ? EXAMPLE_POLL_MS : null))
    : null;
  useEffect(() => {
    if (!pollMs) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - started > EXAMPLE_POLL_WINDOW_MS) {
        window.clearInterval(timer);
        return;
      }
      void refreshFeed({ quiet: true, poll: true });
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, refreshFeed]);

  const categories = (
    allCategories.length ? allCategories : (feed?.availableCategories ?? [])
  ) as Category[];
  const filterOptions = CATEGORY_ORDER.filter((c) => categories.includes(c)).map((c) => ({
    value: c,
    label: CATEGORY_LABELS[c],
  }));
  const pool: Card[] = feed ? dedupeByTitle(applyOverrides(feed.items, overrides)) : [];
  // Once the personal feed has enough of its own, example cards step aside.
  const personal = pool.filter((c) => !c.is_example);
  // Until then, personal cards still lead and examples only fill in behind them.
  const items: Card[] =
    feed && !feed.isExampleFeed
      ? personal.length >= PERSONAL_ENOUGH
        ? personal
        : [...personal, ...pool.filter((c) => c.is_example)]
      : pool;
  const firstVisit = getFeedCache('all')?.isExampleFeed ?? feed?.isExampleFeed ?? false;

  return (
    <div className="page page--discover">
      <h1 className="display">Find more of what you love.</h1>
      {firstVisit && <CaptureStart />}
      <div className="feed-toolbar">
        {filterOptions.length > 0 && (
          <FilterRow
            label="Filter discoveries"
            options={filterOptions}
            value={category}
            onChange={(c) => setCategory(c)}
          />
        )}
        {feed && (
          <button
            type="button"
            className="button button--quiet feed-toolbar__refresh"
            onClick={() => void refreshFeed()}
            disabled={refreshing}
            aria-label="Refresh discoveries"
          >
            <Icon name="refresh" size={16} />
            <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        )}
      </div>
      {error && (
        <Notice tone="error" onRetry={() => void load(category)}>
          {error}
        </Notice>
      )}
      {loading && !feed ? (
        <SkeletonGrid count={8} />
      ) : (
        <>
          {items.length > 0 && (
            <Conveyor
              key={key}
              memoryKey={`discover:${key}`}
              axis="vertical"
              label="Discoveries"
              className="feed-conveyor"
              items={items}
              columns={feedColumns}
              renderItem={(card) => (
                <DiscoveryCard
                  card={card}
                  aspect="portrait"
                  href={`/items/${card.id}?from=discover${card.recommendation_id ? `&rec=${card.recommendation_id}` : ''}`}
                  priority
                  onSave={(c, el) => openSave(cardToTarget(c), el)}
                />
              )}
              fallback={() => (
                <CardGrid label="Discoveries">
                  {items.map((card, i) => (
                    <li key={card.id} className="feed-fade">
                      <DiscoveryCard
                        card={card}
                        href={`/items/${card.id}?from=discover${card.recommendation_id ? `&rec=${card.recommendation_id}` : ''}`}
                        priority={i < 4}
                        onSave={(c, el) => openSave(cardToTarget(c), el)}
                      />
                    </li>
                  ))}
                </CardGrid>
              )}
            />
          )}
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
