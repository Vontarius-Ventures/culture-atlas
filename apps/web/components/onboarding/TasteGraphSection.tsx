'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type {
  InterestGraphSettings,
  InterestGraphSummaryResponse,
} from '@culture-atlas/domain/schemas';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import { PageError } from '../ui';

function errorText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Settings → Taste · background discovery (VAL-FEED-001). Everything here is
 * server truth read from the interest-graph summary: the confirmed interests
 * (saves and picks), the tentative affinities your photos suggested, and the
 * pause that stops background expansion without touching projection. Controls
 * are desired-state PATCHes carrying the revision they read; a conflict
 * reloads the summary instead of faking a saved state, and a failed control
 * leaves the row exactly as the server has it.
 */
export function TasteGraphSection() {
  const { isAccount } = useSession();
  const [data, setData] = useState<InterestGraphSummaryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api.request('getMyInterestGraph', { query: {} });
      setData(res);
      setLoadError(null);
      return res;
    } catch (err) {
      setLoadError(errorText(err, 'Your background discovery summary could not load.'));
      return null;
    }
  }, []);

  useAsyncEffect(async () => {
    if (isAccount) await reload();
  }, [isAccount, reload]);

  if (!isAccount) return null;

  /** Desired-state control: on revision conflict, refetch and show the latest. */
  const runControl = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    try {
      await run();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'revision_conflict') {
        setNotice('Just updated elsewhere. Showing the latest state.');
        await reload();
      } else {
        setNotice('That could not be updated right now.');
      }
    } finally {
      setBusy(null);
    }
  };

  const applySettings = (settings: InterestGraphSettings) => {
    setData((prev) => (prev ? { ...prev, settings } : prev));
  };

  const togglePause = () => {
    if (!data) return;
    const next = !data.settings.discovery_paused;
    void runControl('pause', async () => {
      const res = await api.request('updateMyInterestGraphSettings', {
        body: { expected_revision: data.settings.revision, discovery_paused: next },
        idempotencyKey: newIdempotencyKey(),
      });
      applySettings(res.settings);
    });
  };

  const setInterestState = (edgeId: string, state: 'suppressed' | 'tentative') => {
    if (!data) return;
    void runControl(edgeId, async () => {
      const res = await api.request('updateMyInterestGraphInterest', {
        params: { id: edgeId },
        body: { expected_revision: data.settings.revision, state },
        idempotencyKey: newIdempotencyKey(),
      });
      setData((prev) =>
        prev
          ? {
              ...prev,
              settings: res.settings,
              counts: {
                ...prev.counts,
                tentative:
                  res.state === 'suppressed' ? Math.max(0, prev.counts.tentative - 1) : prev.counts.tentative + 1,
                suppressed:
                  res.state === 'suppressed' ? prev.counts.suppressed + 1 : Math.max(0, prev.counts.suppressed - 1),
              },
              tentative: {
                ...prev.tentative,
                items: prev.tentative.items.map((t) => (t.edge_id === res.edge_id ? { ...t, state: res.state } : t)),
              },
            }
          : prev,
      );
    });
  };

  /**
   * Loads the next page of one list only. The response echoes the other
   * list's FIRST page, so that page is discarded: the requested list is
   * merged (deduped by stable row id), everything else stays as loaded.
   */
  const loadMore = (list: 'interests' | 'tentative') => {
    if (!data) return;
    const cursor = data[list].next_cursor;
    if (!cursor) return;
    void runControl(`more-${list}`, async () => {
      const res = await api.request('getMyInterestGraph', {
        query: list === 'interests' ? { interests_cursor: cursor } : { tentative_cursor: cursor },
      });
      setData((prev) => {
        if (!prev) return prev;
        if (list === 'interests') {
          const merged = [...prev.interests.items, ...res.interests.items].filter(
            (item, i, all) => all.findIndex((o) => o.item_id === item.item_id) === i,
          );
          return { ...prev, settings: res.settings, projection: res.projection, interests: { items: merged, next_cursor: res.interests.next_cursor } };
        }
        const merged = [...prev.tentative.items, ...res.tentative.items].filter(
          (item, i, all) => all.findIndex((o) => o.edge_id === item.edge_id) === i,
        );
        return { ...prev, settings: res.settings, projection: res.projection, tentative: { items: merged, next_cursor: res.tentative.next_cursor } };
      });
    });
  };

  const projectionLine = (p: InterestGraphSummaryResponse['projection']) => {
    if (p.state === 'failed') return 'Background discovery hit a problem and will retry with your next change.';
    if (p.state === 'never_projected') return 'Background discovery follows what you save and pick.';
    if (p.lagging || p.state === 'queued' || p.state === 'running') return 'Catching up on your recent changes.';
    return 'Up to date with your saves and picks.';
  };

  return (
    <section className="taste-graph" aria-labelledby="taste-graph-heading" aria-busy={!data && !loadError}>
      <div className="taste-graph__head">
        <h2 id="taste-graph-heading" className="taste-graph__title">
          Background discovery
        </h2>
        <button
          type="button"
          className="taste-graph__pause"
          aria-pressed={Boolean(data?.settings.discovery_paused)}
          disabled={!data || busy === 'pause'}
          onClick={togglePause}
        >
          {data?.settings.discovery_paused ? 'Resume background discovery' : 'Pause background discovery'}
        </button>
      </div>

      {loadError && !data && <PageError message={loadError} onRetry={() => void reload()} />}

      {data && (
        <>
          <p className="taste-graph__status" role="status">
            {data.settings.discovery_paused
              ? 'Background discovery is paused. Your graph still follows your saves and picks.'
              : projectionLine(data.projection)}
          </p>
          {notice && (
            <p className="onb-error" role="alert">
              {notice}
            </p>
          )}

          <div className="taste-graph__lists">
            <div className="taste-graph__list">
              <h3 className="taste-graph__list-title">
                From your saves and picks ({data.counts.confirmed})
              </h3>
              {data.interests.items.length === 0 ? (
                <p className="taste-graph__empty">Nothing here yet. What you save and pick will appear.</p>
              ) : (
                <ul className="taste-graph__items">
                  {data.interests.items.map((interest) => (
                    <li key={interest.item_id} className="taste-graph__item">
                      <Link href={`/items/${interest.item_id}`} className="taste-graph__item-link">
                        {interest.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {data.interests.next_cursor && (
                <button
                  type="button"
                  className="taste-graph__more"
                  disabled={busy === 'more-interests'}
                  onClick={() => loadMore('interests')}
                >
                  Show more from your saves and picks
                </button>
              )}
            </div>

            <div className="taste-graph__list">
              <h3 className="taste-graph__list-title">
                Also picked up from your photos ({data.counts.tentative})
              </h3>
              {data.tentative.items.length === 0 ? (
                <p className="taste-graph__empty">Affinities your photos suggest will appear here.</p>
              ) : (
                <ul className="taste-graph__items">
                  {data.tentative.items.map((t) => (
                    <li
                      key={t.edge_id}
                      className={`taste-graph__item${t.state === 'suppressed' ? ' taste-graph__item--suppressed' : ''}`}
                    >
                      <span className="taste-graph__item-link">{t.name}</span>
                      <button
                        type="button"
                        className="taste-graph__toggle"
                        disabled={busy === t.edge_id}
                        aria-label={t.state === 'suppressed' ? `Show again ${t.name}` : `Stop showing ${t.name}`}
                        onClick={() =>
                          setInterestState(t.edge_id, t.state === 'suppressed' ? 'tentative' : 'suppressed')
                        }
                      >
                        {t.state === 'suppressed' ? 'Show again' : 'Stop showing'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {data.tentative.next_cursor && (
                <button
                  type="button"
                  className="taste-graph__more"
                  disabled={busy === 'more-tentative'}
                  onClick={() => loadMore('tentative')}
                >
                  Show more from your photos
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
