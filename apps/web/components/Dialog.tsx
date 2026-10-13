'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsClient } from '@/lib/client/hooks';
import { Icon } from './Icon';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && !el.hasAttribute('hidden'),
  );
}

/** Keeps Tab / Shift+Tab inside `root`. Returns true when the event was handled. */
export function trapTab(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>,
  root: HTMLElement,
): boolean {
  if (event.key !== 'Tab') return false;
  const items = focusableWithin(root);
  if (items.length === 0) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Visually hide the title (it stays the accessible name). */
  hideTitle?: boolean;
  /** 'sheet' becomes a bottom sheet below 768 px; 'dialog' stays centered. */
  variant?: 'sheet' | 'dialog';
  /** Element to focus when the dialog closes (defaults to the element focused at open). */
  returnFocus?: HTMLElement | null;
  /** Selector inside the dialog to focus first (defaults to [data-autofocus] or the first control). */
  initialFocus?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'small' | 'medium';
}

/**
 * Accessible modal: role=dialog + aria-modal, focus trapped, Escape closes,
 * background inert, focus returns to the trigger. Desktop dialog / mobile bottom sheet.
 */
export function Dialog({
  open,
  onClose,
  title,
  hideTitle,
  variant = 'sheet',
  returnFocus,
  initialFocus,
  children,
  footer,
  size = 'medium',
}: DialogProps) {
  const mounted = useIsClient();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open || !mounted) return;
    const opener = (returnFocus ?? document.activeElement) as HTMLElement | null;
    const appRoot = document.getElementById('app-root');
    appRoot?.setAttribute('inert', '');
    appRoot?.setAttribute('aria-hidden', 'true');
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const root = panel.current;
    if (root) {
      const target =
        (initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null) ??
        root.querySelector<HTMLElement>('[data-autofocus]') ??
        focusableWithin(root)[0] ??
        root;
      target.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (panel.current) trapTab(e, panel.current);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      appRoot?.removeAttribute('inert');
      appRoot?.removeAttribute('aria-hidden');
      document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
    // returnFocus/initialFocus are read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  if (!open || !mounted) return null;
  return createPortal(
    <div className={`dialog-layer dialog-layer--${variant}`}>
      <div className="dialog-scrim" onClick={() => onCloseRef.current()} aria-hidden="true" />
      <div
        ref={panel}
        className={`dialog dialog--${variant} dialog--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {variant === 'sheet' && <div className="dialog__handle" aria-hidden="true" />}
        <div className="dialog__header">
          <h2 id={titleId} className={hideTitle ? 'visually-hidden' : 'dialog__title'}>
            {title}
          </h2>
          <button
            type="button"
            className="icon-button dialog__close"
            onClick={() => onCloseRef.current()}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="dialog__body">{children}</div>
        {footer && <div className="dialog__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
