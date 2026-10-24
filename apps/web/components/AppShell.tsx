'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { recordRouteChange } from '@/lib/client/store';
import { Icon } from './Icon';
import { V2Icon, type V2IconName } from './v2/V2Icon';
import { UploadStatusBar } from './v2/UploadStatusBar';
import { useOnboardingGate } from './onboarding/OnboardingGate';
import { useSession } from '@/lib/client/session';

type Section = 'discover' | 'library' | 'collections' | 'plans' | null;

/**
 * Which primary destination a path belongs to (detail pages stay under their
 * parent). Captures, items and references are reached from more than one
 * place: `from=library` (or a capture/item opened from the library) keeps the
 * Library tab lit, `from=collection` keeps Collections, `from=plan` keeps Plans.
 */
export function sectionFor(pathname: string, from?: string | null): Section {
  if (/^\/(items|captures|references)(\/|$)/.test(pathname)) {
    if (from === 'library' || from === 'upload') return 'library';
    if (from === 'collection' || from === 'later') return 'collections';
    if (from === 'plan') return 'plans';
    return 'discover';
  }
  if (pathname === '/') return 'discover';
  if (/^\/(library|uploads)(\/|$)/.test(pathname)) return 'library';
  if (/^\/collections(\/|$)/.test(pathname)) return 'collections';
  if (/^\/plans(\/|$)/.test(pathname)) return 'plans';
  return null;
}

/**
 * How much app chrome a route gets.
 *  - immersive: the camera owns the whole screen (no header, no navigation).
 *  - flow: capture chooser, glasses, devices setup and media detail. Desktop
 *    keeps the header; mobile uses the page's own Back header and hides the
 *    bottom bar (PRODUCT-AND-ARCHITECTURE "Camera and media detail use Back
 *    and no bottom bar").
 *  - default: header, footer and (mobile) bottom navigation with Capture above it.
 */
export function chromeFor(pathname: string): 'immersive' | 'welcome' | 'flow' | 'default' {
  if (/^\/capture\/(camera|music)(\/|$)/.test(pathname)) return 'immersive';
  // Amendment 2.2 screens 14-15: a plain header the page owns, no navigation.
  if (/^\/welcome(\/|$)/.test(pathname)) return 'welcome';
  if (
    pathname === '/capture' ||
    /^\/capture\/glasses(\/|$)/.test(pathname) ||
    /^\/library\/(media\/)?[^/]+$/.test(pathname) ||
    /^\/settings\/devices\/.+/.test(pathname)
  )
    return 'flow';
  return 'default';
}

/** v2 capture surfaces use the 1200 px content width (SCREEN-CONTRACT). */
function isV2Width(pathname: string) {
  return (
    /^\/(library|uploads|capture|settings\/devices)(\/|$)/.test(pathname) &&
    !/^\/capture\/photo/.test(pathname)
  );
}

const noSubscribe = () => () => undefined;
/**
 * The `from` query parameter, read from location on every render (a route
 * change re-renders the shell). Avoids useSearchParams, which would force a
 * Suspense boundary around the whole shell; the server snapshot is null.
 */
function useFromParam(): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () => {
      const q = new URLSearchParams(window.location.search);
      // `via` carries the original section through a chain (library photo -> result -> item).
      return q.get('via') ?? q.get('from');
    },
    () => null,
  );
}

const NAV: Array<{
  section: Exclude<Section, null>;
  href: string;
  label: string;
  icon: V2IconName | 'bookmark';
}> = [
  { section: 'discover', href: '/', label: 'Discover', icon: 'home' },
  { section: 'library', href: '/library', label: 'Library', icon: 'library' },
  { section: 'collections', href: '/collections', label: 'Collections', icon: 'bookmark' },
  { section: 'plans', href: '/plans', label: 'Plans', icon: 'calendar' },
];

/**
 * 72 px header: wordmark left; Discover, Library, Collections, Plans centered
 * with an olive underline on the active item; Capture (primary action) and
 * Settings right. Below 768 px the four destinations move to a bottom bar with
 * a distinct Capture action above it; Settings stays in the header.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const from = useFromParam();
  const active = sectionFor(pathname, from);
  const chrome = chromeFor(pathname);
  const settingsActive = /^\/settings(\/|$)/.test(pathname);
  const { session, isAccount } = useSession();
  // One header on every route: wordmark, Capture and Settings (a gear on
  // phones) — so the header never changes shape between tabs. Signed-out
  // visitors also get a Sign in entry, which goes to the one sign-in form in
  // Settings.
  const signedOut = session !== null && !isAccount;
  useEffect(() => {
    recordRouteChange();
  }, [pathname]);
  // Amendment 2.2: an account that still owes the taste questionnaire goes there first.
  const gated = useOnboardingGate(pathname);
  // Shared-collection viewers get no private navigation, owner menus or capture actions.
  if (/^\/shared(\/|$)/.test(pathname)) {
    return (
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    );
  }

  if (chrome === 'welcome')
    return <div className="shell shell--welcome">{children}</div>;

  if (chrome === 'immersive')
    return (
      <div className="shell shell--immersive">
        <main id="main" className="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    );

  return (
    <div
      className={`shell shell--${chrome}${isV2Width(pathname) ? ' shell--v2' : ''} shell--header-capture`}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="header">
        <div className="header__inner">
          <Link href="/" className="wordmark">
            culture atlas
          </Link>
          <nav className="header__nav" aria-label="Primary">
            <ul>
              {NAV.map((item) => (
                <li key={item.section}>
                  <Link
                    href={item.href}
                    className="header__link"
                    aria-current={active === item.section ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="header__actions">
            {signedOut && (
              <Link href="/identity" className="header__signin">
                Sign in
              </Link>
            )}
            <Link
              href="/capture"
              className="button button--primary header__capture"
              aria-current={pathname === '/capture' ? 'page' : undefined}
            >
              <Icon name="plus" size={20} />
              <span>Capture</span>
            </Link>
            <Link
              href="/settings"
              className="header__settings"
              aria-current={settingsActive ? 'page' : undefined}
            >
              <V2Icon name="gear" size={24} className="header__settings-icon" />
              <span>Settings</span>
            </Link>
          </div>
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1} aria-busy={gated || undefined}>
        {gated ? null : children}
      </main>
      <footer className="footer">
        <div className="footer__inner">
          <Link href="/settings" className="footer__link">
            Settings
          </Link>
          <span className="footer__note">Your collections are private.</span>
        </div>
      </footer>
      {chrome === 'default' && (
        <div className="mobile-dock">
          {pathname !== '/uploads' && <UploadStatusBar variant="mobile" />}
        </div>
      )}
      {chrome === 'default' && (
        <nav className="bottom-nav" aria-label="Primary">
          <ul>
            {NAV.map((item) => (
              <li key={item.section}>
                <Link
                  href={item.href}
                  className="bottom-nav__link"
                  aria-current={active === item.section ? 'page' : undefined}
                >
                  {item.icon === 'bookmark' ? (
                    <Icon name="bookmark" size={26} />
                  ) : (
                    <V2Icon name={item.icon} size={26} />
                  )}
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
