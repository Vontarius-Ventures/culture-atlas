'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Category } from '@culture-atlas/domain';
import type {
  OnboardingCatalogEntry,
  OnboardingCatalogResponse,
  OnboardingPick,
  OnboardingSearchResult,
} from '@culture-atlas/domain/schemas';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import {
  BUILDING_PATH,
  clampStep,
  counterText,
  MIN_PICKS,
  stepLabel,
} from '@/lib/client/onboarding';
import { useSession } from '@/lib/client/session';
import { clearFeedCache, hasInAppHistory } from '@/lib/client/store';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import { PageError } from '../ui';
import { COPY } from '../v2/copy';
import { ExclusionsEditor, PickPill, SearchPicker } from './parts';

const GROUPS: Category[] = ['wear', 'play', 'watch', 'eat'];
const GROUP_COPY = {
  wear: COPY['onboarding.group.wear'],
  play: COPY['onboarding.group.play'],
  watch: COPY['onboarding.group.watch'],
  eat: COPY['onboarding.group.eat'],
} as const;

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; catalog: OnboardingCatalogResponse };

function message(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Screen 14 · /welcome/taste. The required sign-up questionnaire: images,
 * Wear/Play/Watch/Eat chips with live search, optional food exclusions, a
 * live counter and "Build my feed" (aria-disabled with its reason below 3).
 * Desktop is one page; below 768 px the same sections are three steps.
 * Every pick is saved as it is made, so leaving mid-way keeps them.
 */
export function TastePicksView() {
  const router = useRouter();
  const toast = useToast();
  const { session, isAccount, refresh } = useSession();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [picks, setPicks] = useState<OnboardingPick[]>([]);
  /** Optimistic catalog toggles while their request is in flight. */
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());
  /** Search results added or removed in this visit (result_id -> pick id, or null when removed). */
  const [searchPicks, setSearchPicks] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [step, setStepState] = useState<1 | 2 | 3>(1);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(new Set<string>());
  const exclusionsTimer = useRef<number | null>(null);
  const exclusionsDirty = useRef(false);
  const exclusionsRef = useRef<string[]>([]);
  const headings = useRef<Array<HTMLHeadingElement | null>>([]);

  const fetchAll = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const [catalog, state] = await Promise.all([
        api.request('getOnboardingCatalog', {}),
        api.request('getOnboardingState', {}),
      ]);
      setPicks(state.picks);
      setExclusions(state.food_exclusions);
      exclusionsRef.current = state.food_exclusions;
      setLoad({ state: 'ready', catalog });
      // Finished already (or the questionnaire is switched off): edit in Settings instead.
      if (!state.state.required && state.state.completed_at) router.replace('/');
    } catch (err) {
      setLoad({ state: 'error', message: message(err, 'The questionnaire could not load.') });
    }
  }, [router]);

  // Anonymous visitors never see the questionnaire (ONB-01).
  useEffect(() => {
    if (session && !isAccount) router.replace('/');
  }, [session, isAccount, router]);

  useAsyncEffect(() => (isAccount ? fetchAll() : undefined), [isAccount, fetchAll]);

  useEffect(() => {
    const initial = clampStep(new URLSearchParams(window.location.search).get('step'));
    if (initial !== 1) void Promise.resolve().then(() => setStepState(initial));
  }, []);

  const setStep = (next: 1 | 2 | 3) => {
    setStepState(next);
    const url = new URL(window.location.href);
    url.searchParams.set('step', String(next));
    window.history.replaceState(window.history.state, '', url);
    window.scrollTo(0, 0);
    // Move focus to the new step's heading so keyboard and screen-reader users land on it.
    window.setTimeout(() => headings.current[next - 1]?.focus(), 0);
  };

  // ---- picks -----------------------------------------------------------------

  const catalogPicked = (entry: OnboardingCatalogEntry) =>
    pending.get(entry.id) ?? picks.some((p) => p.catalog_item_id === entry.id);

  const catalogIds = new Set(picks.filter((p) => p.catalog_item_id).map((p) => p.catalog_item_id!));
  for (const [id, on] of pending) {
    if (on) catalogIds.add(id);
    else catalogIds.delete(id);
  }
  const count = catalogIds.size + picks.filter((p) => !p.catalog_item_id).length;
  const ready = count >= MIN_PICKS;

  const setPendingFor = (id: string, value: boolean | null) =>
    setPending((prev) => {
      const next = new Map(prev);
      if (value === null) next.delete(id);
      else next.set(id, value);
      return next;
    });

  const toggleCatalog = async (entry: OnboardingCatalogEntry) => {
    if (inflight.current.has(entry.id)) return;
    inflight.current.add(entry.id);
    const on = !catalogPicked(entry);
    setPendingFor(entry.id, on);
    setError(null);
    try {
      if (on) {
        const res = await api.request('createOnboardingPick', {
          body: { source: 'catalog', catalog_item_id: entry.id },
          idempotencyKey: newIdempotencyKey(),
        });
        setPicks((prev) => [...prev.filter((p) => p.id !== res.pick.id), res.pick]);
      } else {
        const pick = picks.find((p) => p.catalog_item_id === entry.id);
        if (pick) {
          await api.request('deleteOnboardingPick', {
            params: { id: pick.id },
            idempotencyKey: newIdempotencyKey(),
          });
          setPicks((prev) => prev.filter((p) => p.id !== pick.id));
        }
      }
    } catch (err) {
      setError(message(err, 'That pick could not be saved. Try again.'));
    } finally {
      inflight.current.delete(entry.id);
      setPendingFor(entry.id, null);
    }
  };

  const searchAdded = (r: OnboardingSearchResult) => {
    // Matched by pick id, never by name: several results can share one ("Nina · Place", "Nina · Film").
    const local = searchPicks.get(r.result_id);
    const id = local !== undefined ? local : (r.pick_id ?? null);
    if (id) return picks.some((p) => p.id === id);
    return local === undefined && r.picked;
  };

  const toggleSearch = async (r: OnboardingSearchResult, added: boolean) => {
    setError(null);
    try {
      if (!added) {
        const res = await api.request('createOnboardingPick', {
          body: { source: 'search', result_id: r.result_id },
          idempotencyKey: newIdempotencyKey(),
        });
        setPicks((prev) => [...prev.filter((p) => p.id !== res.pick.id), res.pick]);
        setSearchPicks((prev) => new Map(prev).set(r.result_id, res.pick.id));
        toast.announce(`${r.name} added`);
      } else {
        const id = searchPicks.get(r.result_id) ?? r.pick_id ?? null;
        if (!id) return;
        await api.request('deleteOnboardingPick', {
          params: { id },
          idempotencyKey: newIdempotencyKey(),
        });
        setPicks((prev) => prev.filter((p) => p.id !== id));
        setSearchPicks((prev) => new Map(prev).set(r.result_id, null));
        toast.announce(`${r.name} removed`);
      }
    } catch (err) {
      setError(message(err, 'That pick could not be saved. Try again.'));
    }
  };

  // ---- exclusions (saved as they change; never counted) ----------------------

  const saveExclusions = useCallback(async () => {
    if (exclusionsTimer.current !== null) window.clearTimeout(exclusionsTimer.current);
    exclusionsTimer.current = null;
    if (!exclusionsDirty.current) return;
    exclusionsDirty.current = false;
    await api.request('putOnboardingExclusions', {
      body: { food_exclusions: exclusionsRef.current },
      idempotencyKey: newIdempotencyKey(),
    });
  }, []);

  const changeExclusions = (next: string[]) => {
    setExclusions(next);
    exclusionsRef.current = next;
    exclusionsDirty.current = true;
    if (exclusionsTimer.current !== null) window.clearTimeout(exclusionsTimer.current);
    exclusionsTimer.current = window.setTimeout(() => {
      saveExclusions().catch((err) =>
        setError(message(err, 'Your exclusions could not be saved.')),
      );
    }, 600);
  };

  useEffect(
    () => () => {
      if (exclusionsTimer.current !== null) window.clearTimeout(exclusionsTimer.current);
      if (exclusionsDirty.current) void saveExclusions().catch(() => undefined);
    },
    [saveExclusions],
  );

  // ---- build -------------------------------------------------------------------

  const build = async () => {
    if (!ready) {
      toast.announce(COPY['onboarding.primary_disabled']);
      return;
    }
    if (building) return;
    setBuilding(true);
    setError(null);
    try {
      await saveExclusions();
      await api.request('completeOnboarding', { body: {}, idempotencyKey: newIdempotencyKey() });
      clearFeedCache();
      await refresh().catch(() => undefined);
      router.push(BUILDING_PATH);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'conflict'
          ? COPY['onboarding.primary_disabled']
          : message(err, 'Your feed could not start. Try again.'),
      );
      setBuilding(false);
    }
  };

  // ---- render -----------------------------------------------------------------

  const header = (
    <header className="onb-header">
      <div className="onb-header__inner">
        <Link href="/" className="wordmark">
          culture atlas
        </Link>
        <div className="onb-steps">
          <span>{stepLabel(step)}</span>
          <span className="onb-steps__bar" aria-hidden="true">
            {[1, 2, 3].map((n) => (
              <span key={n} className={n <= step ? 'is-current' : undefined} />
            ))}
          </span>
        </div>
      </div>
    </header>
  );

  if (load.state !== 'ready')
    return (
      <div className="onb-page">
        {header}
        <main id="main" className="onb" tabIndex={-1} aria-busy={load.state === 'loading'}>
          {load.state === 'error' ? (
            <PageError message={load.message} onRetry={() => void fetchAll()} />
          ) : (
            <p className="visually-hidden" role="status">
              Loading…
            </p>
          )}
        </main>
      </div>
    );

  const { catalog } = load;
  const startBack = hasInAppHistory() ? (
    <button type="button" className="onb-back onb-back--start" onClick={() => router.back()}>
      <Icon name="arrowLeft" />
      {COPY['onboarding.back']}
    </button>
  ) : (
    <Link className="onb-back onb-back--start" href="/">
      <Icon name="arrowLeft" />
      {COPY['onboarding.back']}
    </Link>
  );

  return (
    <div className="onb-page">
      {header}
      <main id="main" className="onb" data-step={step} tabIndex={-1}>
        <div className="onb-top">
          {startBack}
          <button
            type="button"
            className="onb-back onb-back--step"
            onClick={() => setStep(Math.max(1, step - 1) as 1 | 2 | 3)}
          >
            <Icon name="arrowLeft" />
            {COPY['onboarding.back']}
          </button>
        </div>

        <section className="onb-section" data-step-section="1" aria-labelledby="onb-s1">
          <div className="onb-head">
            <div>
              <h1
                className="onb-title"
                id="onb-s1"
                tabIndex={-1}
                ref={(el) => {
                  headings.current[0] = el;
                }}
              >
                {COPY['onboarding.images.title']}
              </h1>
              <p className="onb-hint">{COPY['onboarding.hint']}</p>
            </div>
          </div>
          <ul className="pick-grid">
            {catalog.images.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="pick-tile"
                  aria-pressed={catalogPicked(entry)}
                  onClick={() => void toggleCatalog(entry)}
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
            ))}
          </ul>
        </section>

        <section className="onb-section" data-step-section="2" aria-labelledby="onb-s2">
          <div className="onb-head">
            <h2
              className="onb-subtitle"
              id="onb-s2"
              tabIndex={-1}
              ref={(el) => {
                headings.current[1] = el;
              }}
            >
              {COPY['onboarding.chips.title']}
            </h2>
          </div>
          <div className="chip-groups">
            {GROUPS.map((g) =>
              catalog.chips[g].length ? (
                <div key={g} className="chip-group" role="group" aria-labelledby={`onb-g-${g}`}>
                  <h3 className="chip-group__title" id={`onb-g-${g}`}>
                    {GROUP_COPY[g]}
                  </h3>
                  <div className="pill-row">
                    {catalog.chips[g].map((entry) => (
                      <PickPill
                        key={entry.id}
                        pressed={catalogPicked(entry)}
                        onToggle={() => void toggleCatalog(entry)}
                      >
                        {entry.label}
                      </PickPill>
                    ))}
                  </div>
                </div>
              ) : null,
            )}
          </div>
          <div className="search-block">
            <SearchPicker
              label={COPY['onboarding.search.placeholder']}
              labelClassName="search-block__label"
              placeholder={COPY['onboarding.search.placeholder']}
              isAdded={searchAdded}
              onToggle={toggleSearch}
            />
          </div>
        </section>

        <section className="onb-section" data-step-section="3" aria-labelledby="onb-s3">
          <div className="onb-head">
            <div>
              <h2
                className="onb-subtitle"
                id="onb-s3"
                tabIndex={-1}
                ref={(el) => {
                  headings.current[2] = el;
                }}
              >
                {COPY['onboarding.exclusions.title']}
                <span className="optional-badge">{COPY['onboarding.exclusions.optional']}</span>
              </h2>
              <p className="onb-note">{COPY['onboarding.exclusions.note']}</p>
            </div>
          </div>
          <ExclusionsEditor
            suggestions={catalog.exclusion_suggestions}
            value={exclusions}
            onChange={changeExclusions}
          />
        </section>
        {error && (
          <p className="onb-error" role="alert">
            {error}
          </p>
        )}
      </main>

      <div className={`pick-bar${ready ? ' is-ready' : ''}`} data-step={step}>
        <div className="pick-bar__inner">
          <div className="pick-bar__status">
            <span className="pick-progress" aria-hidden="true">
              {Array.from({ length: MIN_PICKS }, (_, i) => (
                <span key={i} className={i < count ? 'is-done' : undefined} />
              ))}
            </span>
            <p className="pick-counter" role="status" aria-live="polite">
              {counterText(count)}
            </p>
          </div>
          <div className="pick-bar__end">
            <p className="pick-reason" id="onb-build-reason" hidden={ready}>
              {COPY['onboarding.primary_disabled']}
            </p>
            <button
              type="button"
              className="button button--outline pick-bar__next"
              onClick={() => setStep(Math.min(3, step + 1) as 1 | 2 | 3)}
            >
              {COPY['onboarding.next']}
              <Icon name="arrowRight" />
            </button>
            <button
              type="button"
              className="button button--primary button--large"
              data-primary
              aria-disabled={!ready || building}
              aria-describedby={ready ? undefined : 'onb-build-reason'}
              onClick={() => void build()}
            >
              {COPY['onboarding.primary']}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
