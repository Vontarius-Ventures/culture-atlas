'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { OnboardingPick, TasteSeedStatus } from '@culture-atlas/domain/schemas';
import { api } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { pickKindLabel, seedPollDelay, seedView } from '@/lib/client/onboarding';
import { useSession } from '@/lib/client/session';
import { clearFeedCache } from '@/lib/client/store';
import { Icon } from '../Icon';
import { COPY } from '../v2/copy';
import { ClockIcon } from './parts';

/** After this long without a ready category, say so honestly instead of spinning. */
const GIVE_UP_MS = 20_000;
/** Lets the polite "Ready" status be heard before moving on. */
const ADVANCE_DELAY_MS = 700;

/**
 * Screen 15 · /welcome/building. A quiet collage of the person's own picks,
 * "Building your feed…" and per-category progress from the taste seed job;
 * moves to Discover as soon as the first category is ready. If Qloo is
 * unavailable: "We'll keep building in the background." with Go to Discover
 * (Discover shows labeled example results meanwhile). Nothing is fabricated.
 */
export function BuildingFeedView() {
  const router = useRouter();
  const { session, isAccount } = useSession();
  const [picks, setPicks] = useState<OnboardingPick[] | null>(null);
  const [seed, setSeed] = useState<TasteSeedStatus | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const advanced = useRef(false);

  useEffect(() => {
    if (session && !isAccount) router.replace('/');
  }, [session, isAccount, router]);

  useAsyncEffect(async () => {
    if (!isAccount) return;
    try {
      const state = await api.request('getOnboardingState', {});
      setPicks(state.picks);
      setSeed(state.seed);
    } catch {
      setPicks([]);
    }
  }, [isAccount]);

  // Poll the seed status while it is active (server hint for the interval).
  const view = seedView(seed, timedOut);
  const active = Boolean(seed) && !view.advance && !view.done && !view.unavailable;
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(async () => {
      try {
        setSeed(await api.request('getOnboardingSeed', {}));
      } catch {
        // Keep the last status; the give-up timer turns this into the honest unavailable state.
      }
    }, seedPollDelay(seed));
    return () => window.clearTimeout(t);
  }, [active, seed]);

  useEffect(() => {
    const t = window.setTimeout(() => setTimedOut(true), GIVE_UP_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (advanced.current || !(view.advance || view.done)) return;
    advanced.current = true;
    clearFeedCache();
    const t = window.setTimeout(() => router.replace('/'), view.advance ? ADVANCE_DELAY_MS : 0);
    return () => window.clearTimeout(t);
  }, [view.advance, view.done, router]);

  const tiles = (picks ?? []).slice(0, 4);
  return (
    <div className="onb-page">
      <header className="onb-header">
        <div className="onb-header__inner">
          <Link href="/" className="wordmark">
            culture atlas
          </Link>
        </div>
      </header>
      <main id="main" className="building" tabIndex={-1} aria-busy={!view.unavailable}>
        {tiles.length > 0 && (
          <ul className="collage" aria-label="Your picks">
            {tiles.map((p, i) => (
              <li key={p.id}>
                {p.image ? (
                  <img
                    src={p.image.url}
                    alt={p.label}
                    width={p.image.width}
                    height={p.image.height}
                  />
                ) : (
                  <div className={`collage__text${i % 3 === 2 ? ' collage__text--dark' : ''}`}>
                    <strong>{p.label}</strong>
                    {pickKindLabel(p) && <span>{pickKindLabel(p)}</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <h1 className="building__title">{COPY['building.title']}</h1>
        <p className="building__lede">{COPY['building.lede']}</p>
        {!view.unavailable ? (
          <ul className="seed" role="status" aria-live="polite" aria-label="Feed progress">
            {view.categories.map((c) => (
              <li key={c.category} className={c.ready ? 'is-ready' : undefined}>
                {c.ready ? <Icon name="check" size={16} /> : <ClockIcon size={16} />}
                {c.label}{' '}
                {c.ready ? (
                  <span className="seed__state">{COPY['building.category_ready']}</span>
                ) : c.state === 'pending' ? (
                  <span className="seed__state">{COPY['building.category_looking']}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="building-unavailable" role="status" aria-live="polite">
            <p className="building-unavailable__lede">{COPY['building.unavailable']}</p>
            <Link className="button button--primary button--large" href="/">
              {COPY['building.go']}
            </Link>
            <p className="building-unavailable__note">{COPY['building.examples']}</p>
          </div>
        )}
      </main>
    </div>
  );
}
