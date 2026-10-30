'use client';

import Link from 'next/link';
import { useCallback, useId, useState } from 'react';
import type { Category } from '@culture-atlas/domain';
import type {
  OnboardingCatalogResponse,
  OnboardingPick,
  OnboardingSearchResult,
  TastePicksResponse,
} from '@culture-atlas/domain/schemas';
import { FOOD_EXCLUSION_SUGGESTIONS } from '@culture-atlas/domain/schemas';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { pickKindLabel } from '@/lib/client/onboarding';
import { useSession } from '@/lib/client/session';
import { clearFeedCache } from '@/lib/client/store';
import { AccountPrompt } from '../AccountPrompt';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import { PageError } from '../ui';
import { COPY } from '../v2/copy';
import { ExclusionsEditor, PickPill, SearchPicker } from './parts';
import { TasteGraphSection } from './TasteGraphSection';

type GroupKey = Category | 'other';
const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: 'wear', label: COPY['onboarding.group.wear'] },
  { key: 'play', label: COPY['onboarding.group.play'] },
  { key: 'watch', label: COPY['onboarding.group.watch'] },
  { key: 'eat', label: COPY['onboarding.group.eat'] },
  { key: 'other', label: 'More' },
];

function errorText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Screen 18 · /settings/taste. Current picks grouped Wear/Play/Watch/Eat (plus
 * More), each removable; "Add more" opens the onboarding pickers inline for
 * that group; the exclusions editor saves explicitly. Removing below 3 is
 * allowed here; exclusions are preferences, not taste.
 */
export function TasteSettingsView() {
  const { session, isAccount } = useSession();
  const toast = useToast();
  const [data, setData] = useState<TastePicksResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<OnboardingCatalogResponse | null>(null);
  const [open, setOpen] = useState<GroupKey | null>(null);
  /** Search results added or removed on this page: result id -> pick id (null once removed). */
  const [searchPicks, setSearchPicks] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [savedExclusions, setSavedExclusions] = useState<string[]>([]);
  const [savingExclusions, setSavingExclusions] = useState(false);
  const [exclusionStatus, setExclusionStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const exclId = useId();

  const reload = useCallback(async () => {
    try {
      const res = await api.request('listTastePicks', {});
      setData(res);
      setLoadError(null);
      return res;
    } catch (err) {
      setLoadError(errorText(err, 'Your taste could not load.'));
      return null;
    }
  }, []);

  useAsyncEffect(async () => {
    if (!isAccount) return;
    const res = await reload();
    if (res) {
      setExclusions(res.food_exclusions ?? []);
      setSavedExclusions(res.food_exclusions ?? []);
    }
  }, [isAccount, reload]);

  const openGroup = async (key: GroupKey) => {
    setOpen(key);
    if (!catalog) {
      try {
        setCatalog(await api.request('getOnboardingCatalog', {}));
      } catch {
        // Chips are optional here; search still works or reports unavailable.
      }
    }
  };

  const allPicks: OnboardingPick[] = data
    ? [
        ...data.picks.wear,
        ...data.picks.play,
        ...data.picks.watch,
        ...data.picks.eat,
        ...data.picks.other,
      ]
    : [];

  const remove = async (pick: OnboardingPick) => {
    setBusy(pick.id);
    setError(null);
    try {
      await api.request('deleteTastePick', {
        params: { id: pick.id },
        idempotencyKey: newIdempotencyKey(),
      });
      clearFeedCache();
      await reload();
      toast.announce(`${pick.label} removed`);
    } catch (err) {
      setError(errorText(err, 'That pick could not be removed.'));
    } finally {
      setBusy(null);
    }
  };

  const addCatalog = async (catalogItemId: string, label: string) => {
    setBusy(catalogItemId);
    setError(null);
    try {
      await api.request('createTastePick', {
        body: { source: 'catalog', catalog_item_id: catalogItemId },
        idempotencyKey: newIdempotencyKey(),
      });
      clearFeedCache();
      await reload();
      toast.announce(`${label} added`);
    } catch (err) {
      setError(errorText(err, 'That pick could not be saved.'));
    } finally {
      setBusy(null);
    }
  };

  const searchPickId = (r: OnboardingSearchResult): string | null => {
    const local = searchPicks.get(r.result_id);
    return local !== undefined ? local : (r.pick_id ?? null);
  };

  const toggleSearch = async (r: OnboardingSearchResult, added: boolean) => {
    setError(null);
    try {
      if (added) {
        // Remove the pick for this exact result (by id), never one that merely shares its name.
        const id = searchPickId(r);
        const pick = id ? allPicks.find((p) => p.id === id) : undefined;
        if (pick) {
          await remove(pick);
          setSearchPicks((prev) => new Map(prev).set(r.result_id, null));
        }
        return;
      }
      const res = await api.request('createTastePick', {
        body: { source: 'search', result_id: r.result_id },
        idempotencyKey: newIdempotencyKey(),
      });
      setSearchPicks((prev) => new Map(prev).set(r.result_id, res.pick.id));
      clearFeedCache();
      await reload();
      toast.announce(`${r.name} added`);
    } catch (err) {
      setError(errorText(err, 'That pick could not be saved.'));
    }
  };

  const saveExclusions = async () => {
    setSavingExclusions(true);
    setExclusionStatus('');
    try {
      const res = await api.request('putOnboardingExclusions', {
        body: { food_exclusions: exclusions },
        idempotencyKey: newIdempotencyKey(),
      });
      setExclusions(res.food_exclusions);
      setSavedExclusions(res.food_exclusions);
      setExclusionStatus('Saved');
    } catch (err) {
      setExclusionStatus(errorText(err, 'Your exclusions could not be saved.'));
    } finally {
      setSavingExclusions(false);
    }
  };

  if (session && !isAccount)
    return (
      <div className="taste-page">
        <Crumb />
        <div className="settings-head">
          <h1 className="settings-head__title">{COPY['settings_taste.title']}</h1>
        </div>
        <AccountPrompt
          lead="Create an account to keep your saves and shape your feed."
          onCreated={() => undefined}
        />
      </div>
    );

  if (loadError && !data)
    return (
      <div className="taste-page">
        <Crumb />
        <PageError message={loadError} onRetry={() => void reload()} />
      </div>
    );

  const exclusionsChanged =
    exclusions.length !== savedExclusions.length ||
    exclusions.some((e, i) => e !== savedExclusions[i]);

  return (
    <div className="taste-page">
      <Crumb />
      <div className="settings-head">
        <h1 className="settings-head__title">{COPY['settings_taste.title']}</h1>
        <p className="settings-head__lede">{COPY['settings_taste.lede']}</p>
      </div>
      <div className="taste-layout">
        <div className="taste-picks" aria-busy={!data}>
          {GROUPS.map(({ key, label }) => {
            const picks = data?.picks[key] ?? [];
            if (key === 'other' && picks.length === 0) return null;
            const panelId = `add-${key}`;
            const isOpen = open === key;
            const chips = key !== 'other' && catalog ? catalog.chips[key] : [];
            // Same pickers as the questionnaire (amendment 2.2): this group's catalog images too.
            const images =
              key !== 'other' && catalog ? catalog.images.filter((i) => i.category === key) : [];
            return (
              <section key={key} className="taste-group" aria-labelledby={`taste-g-${key}`}>
                <div className="taste-group__head">
                  <h2 className="taste-group__title" id={`taste-g-${key}`}>
                    {label} <span className="taste-group__count">{data ? picks.length : ''}</span>
                  </h2>
                  {key !== 'other' && !isOpen && (
                    <button
                      type="button"
                      className="add-more"
                      aria-expanded={false}
                      aria-controls={panelId}
                      onClick={() => void openGroup(key)}
                    >
                      <Icon name="plus" size={18} />
                      {COPY['settings_taste.add_more']}
                      <span className="visually-hidden"> to {label}</span>
                    </button>
                  )}
                </div>
                {picks.length > 0 && (
                  <ul className="pick-list">
                    {picks.map((p) => (
                      <li key={p.id} className={`pick-chip${p.image ? ' pick-chip--image' : ''}`}>
                        {p.image && <img src={p.image.url} alt="" />}
                        <span className="pick-chip__label">{p.label}</span>
                        {p.source !== 'catalog' && pickKindLabel(p) && (
                          <span className="pick-chip__kind">{pickKindLabel(p)}</span>
                        )}
                        <button
                          type="button"
                          className="pick-chip__remove"
                          aria-label={COPY['settings_taste.remove'].replace('{label}', p.label)}
                          disabled={busy === p.id}
                          onClick={() => void remove(p)}
                        >
                          <Icon name="close" size={18} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {key !== 'other' && (
                  <div className="add-panel" id={panelId} hidden={!isOpen}>
                    {isOpen && (
                      <>
                        {images.length > 0 && (
                          <>
                            <p className="add-panel__title">{COPY['onboarding.images.title']}</p>
                            <ul
                              className="pick-grid add-panel__images"
                              aria-label={`${label} images`}
                            >
                              {images.map((entry) => {
                                const pick = picks.find((p) => p.catalog_item_id === entry.id);
                                return (
                                  <li key={entry.id}>
                                    <button
                                      type="button"
                                      className="pick-tile"
                                      aria-pressed={Boolean(pick)}
                                      disabled={
                                        busy === entry.id || (pick ? busy === pick.id : false)
                                      }
                                      onClick={() =>
                                        void (pick
                                          ? remove(pick)
                                          : addCatalog(entry.id, entry.label))
                                      }
                                    >
                                      <span className="pick-tile__media">
                                        {entry.image && (
                                          <img
                                            src={entry.image.url}
                                            alt=""
                                            width={entry.image.width}
                                            height={entry.image.height}
                                            decoding="async"
                                          />
                                        )}
                                        <span className="pick-tile__mark" aria-hidden="true">
                                          <Icon name="check" size={18} />
                                        </span>
                                      </span>
                                      <span className="pick-tile__label">{entry.label}</span>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </>
                        )}
                        <p className="add-panel__title">{COPY['onboarding.chips.title']}</p>
                        {chips.length > 0 && (
                          <div className="pill-row" role="group" aria-label={`${label} ideas`}>
                            {chips.map((c) => {
                              const pick = picks.find((p) => p.catalog_item_id === c.id);
                              return (
                                <PickPill
                                  key={c.id}
                                  pressed={Boolean(pick)}
                                  disabled={busy === c.id || (pick ? busy === pick.id : false)}
                                  onToggle={() =>
                                    void (pick ? remove(pick) : addCatalog(c.id, c.label))
                                  }
                                >
                                  {c.label}
                                </PickPill>
                              );
                            })}
                          </div>
                        )}
                        <SearchPicker
                          label={COPY['onboarding.search.placeholder']}
                          labelClassName="add-panel__search-label"
                          placeholder="Search"
                          category={key}
                          isAdded={(r) => {
                            const id = searchPickId(r);
                            return Boolean(id && allPicks.some((p) => p.id === id));
                          }}
                          onToggle={toggleSearch}
                        />
                        <div className="add-panel__done">
                          <button
                            type="button"
                            className="button button--outline"
                            aria-expanded={true}
                            aria-controls={panelId}
                            onClick={() => {
                              setOpen(null);
                              // Return focus to the group's "Add more" so keyboard users keep their place.
                              window.setTimeout(
                                () =>
                                  document
                                    .querySelector<HTMLButtonElement>(
                                      `.add-more[aria-controls="${panelId}"]`,
                                    )
                                    ?.focus(),
                                0,
                              );
                            }}
                          >
                            {COPY['settings_taste.done']}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>
            );
          })}
          {error && (
            <p className="onb-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <aside className="taste-panel" aria-labelledby={exclId}>
          <h2 id={exclId}>{COPY['onboarding.exclusions.title']}</h2>
          <p className="taste-panel__note">{COPY['onboarding.exclusions.note']}</p>
          <ExclusionsEditor
            suggestions={FOOD_EXCLUSION_SUGGESTIONS}
            value={exclusions}
            onChange={(next) => {
              setExclusions(next);
              setExclusionStatus('');
            }}
          />
          <button
            type="button"
            className="button button--primary taste-panel__save"
            aria-disabled={savingExclusions || undefined}
            onClick={() => {
              if (savingExclusions) return;
              if (exclusionsChanged) void saveExclusions();
              else setExclusionStatus('Saved');
            }}
          >
            {COPY['settings_taste.save']}
          </button>
          <p className="taste-panel__status" role="status" aria-live="polite">
            {exclusionStatus}
          </p>
        </aside>
      </div>
      <TasteGraphSection />
    </div>
  );
}

function Crumb() {
  return (
    <p className="crumb">
      <Link href="/">culture atlas</Link> / <Link href="/settings">Settings</Link>
    </p>
  );
}
