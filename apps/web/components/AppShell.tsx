'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { recordRouteChange } from '@/lib/client/store';
import { Icon, type IconName } from './Icon';

type Section = 'discover' | 'collections' | 'plans' | null;

/** Which primary destination a path belongs to (detail pages stay under Discover). */
export function sectionFor(pathname: string): Section {
  if (pathname === '/' || /^\/(items|captures|references|capture)(\/|$)/.test(pathname))
    return 'discover';
  if (/^\/collections(\/|$)/.test(pathname)) return 'collections';
  if (/^\/plans(\/|$)/.test(pathname)) return 'plans';
  return null;
}

const NAV: Array<{ section: Exclude<Section, null>; href: string; label: string; icon: IconName }> =
  [
    { section: 'discover', href: '/', label: 'Discover', icon: 'search' },
    { section: 'collections', href: '/collections', label: 'Collections', icon: 'bookmark' },
    { section: 'plans', href: '/plans', label: 'Plans', icon: 'plan' },
  ];

/**
 * 72 px header: wordmark left, Discover / Collections / Plans centered with an
 * olive underline on the active item, Capture right. Below 768 px the
 * destinations move to a bottom navigation bar; Capture stays in the header.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const active = sectionFor(pathname);
  useEffect(() => {
    recordRouteChange();
  }, [pathname]);
  return (
    <div className="shell">
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
          <Link
            href="/capture"
            className="button button--primary header__capture"
            aria-current={pathname === '/capture' ? 'page' : undefined}
          >
            <Icon name="plus" />
            <span>Capture</span>
          </Link>
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
      <nav className="bottom-nav" aria-label="Primary">
        <ul>
          {NAV.map((item) => (
            <li key={item.section}>
              <Link
                href={item.href}
                className="bottom-nav__link"
                aria-current={active === item.section ? 'page' : undefined}
              >
                <Icon name={item.icon} size={24} />
                <span>{item.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
