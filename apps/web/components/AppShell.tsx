'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { recordRouteChange } from '@/lib/client/store';
import { Icon } from './Icon';
import { V2Icon, type V2IconName } from './v2/V2Icon';
import { UploadStatusBar } from './v2/UploadStatusBar';

type Section = 'discover' | 'library' | 'collections' | 'plans' | null;

/** Which primary destination a path belongs to (detail pages stay under their parent). */
export function sectionFor(pathname: string): Section {
  if (pathname === '/' || /^\/(items|captures|references)(\/|$)/.test(pathname)) return 'discover';
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
export function chromeFor(pathname: string): 'immersive' | 'flow' | 'default' {
  if (/^\/capture\/camera(\/|$)/.test(pathname)) return 'immersive';
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
  const active = sectionFor(pathname);
  const chrome = chromeFor(pathname);
  const settingsActive = /^\/settings(\/|$)/.test(pathname);
  // v1 surfaces (design/cultural-atlas-v1 mockups 01–07) keep Capture in the
  // mobile header, top right, as in mockup 04. Library and uploads follow the
  // v2 reference 08 (Capture pill above the bottom bar, Settings in the header).
  const headerCapture = active === 'discover' || active === 'collections' || active === 'plans';
  useEffect(() => {
    recordRouteChange();
  }, [pathname]);
  // Shared-collection viewers get no private navigation, owner menus or capture actions.
  if (/^\/shared(\/|$)/.test(pathname)) {
    return (
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    );
  }

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
      className={`shell shell--${chrome}${isV2Width(pathname) ? ' shell--v2' : ''}${headerCapture ? ' shell--header-capture' : ''}`}
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
      <main id="main" className="main" tabIndex={-1}>
        {children}
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
          {!headerCapture && (
            <Link href="/capture" className="mobile-dock__capture">
              <Icon name="camera" size={26} />
              <span>Capture</span>
            </Link>
          )}
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
