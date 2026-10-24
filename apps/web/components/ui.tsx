'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { hasInAppHistory } from '@/lib/client/store';
import { Icon } from './Icon';

/** "← Discover" style back link. Uses history when we came from inside the app (keeps scroll position). */
export function BackLink({ href, label }: { href: string; label: string }) {
  const router = useRouter();
  return (
    <Link
      href={href}
      className="back-link"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (hasInAppHistory()) {
          e.preventDefault();
          router.back();
        }
      }}
    >
      <Icon name="arrowLeft" />
      <span>{label}</span>
    </Link>
  );
}

/** Quiet disclosure, closed by default ("Explore the references", "Why this?", "Sources"). */
export function Disclosure({
  label,
  children,
  defaultOpen = false,
  onOpen,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={`disclosure${open ? ' disclosure--open' : ''}`}>
      <h2 className="disclosure__heading">
        <button
          type="button"
          className="disclosure__button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            setOpen((o) => !o);
            if (!open) onOpen?.();
          }}
        >
          <Icon name="chevronDown" className="disclosure__chevron" />
          <span>{label}</span>
        </button>
      </h2>
      <div id={id} className="disclosure__panel" hidden={!open}>
        {children}
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** Small "More" menu: a button that reveals a list of actions. Escape and outside clicks close it. */
export function MoreMenu({
  label,
  items,
  align = 'end',
}: {
  label: string;
  items: MenuItem[];
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    root.current?.querySelector<HTMLButtonElement>('.more-menu__item:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="more-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="icon-button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" />
      </button>
      <ul id={id} className={`more-menu__list more-menu__list--${align}`} hidden={!open}>
        {items.map((item) => (
          <li key={item.label}>
            <button
              type="button"
              className={`more-menu__item${item.danger ? ' more-menu__item--danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Short invitation for empty states. No marketing filler. */
export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <h2 className="empty-state__title">{title}</h2>
      {children && <div className="empty-state__body">{children}</div>}
      {actions && <div className="empty-state__actions">{actions}</div>}
    </section>
  );
}

/** Unobtrusive notice with an optional single retry action. */
export function Notice({
  children,
  onRetry,
  retryLabel = 'Try again',
  tone = 'quiet',
  busy,
}: {
  children: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  tone?: 'quiet' | 'error';
  busy?: boolean;
}) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <p className="notice__text">{children}</p>
      {onRetry && (
        <button
          type="button"
          className="button button--outline button--small"
          onClick={onRetry}
          disabled={busy}
        >
          <Icon name="refresh" size={16} />
          <span>{busy ? 'Retrying…' : retryLabel}</span>
        </button>
      )}
    </div>
  );
}

export function PageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="page-error">
      <Notice tone="error" onRetry={onRetry}>
        {message}
      </Notice>
    </div>
  );
}

export function LoadingText({ children }: { children: ReactNode }) {
  return (
    <p className="loading-text" role="status">
      {children}
    </p>
  );
}

/**
 * One designed "not here" state for unknown routes and missing or deleted
 * things: a page-level H1, a short explanation and a clear way back.
 */
export function UnavailableState({
  title,
  body,
  primary = { href: '/', label: 'Back to Discover' },
  secondary,
}: {
  title: string;
  body: ReactNode;
  primary?: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    <section className="unavailable" aria-labelledby="unavailable-title">
      <span className="unavailable__mark" aria-hidden="true">
        <Icon name="plan" size={28} />
      </span>
      <h1 id="unavailable-title" className="display display--medium">
        {title}
      </h1>
      <p className="unavailable__body">{body}</p>
      <div className="unavailable__actions">
        <Link href={primary.href} className="button button--primary">
          {primary.label}
        </Link>
        {secondary && (
          <Link href={secondary.href} className="button button--outline">
            {secondary.label}
          </Link>
        )}
      </div>
    </section>
  );
}
