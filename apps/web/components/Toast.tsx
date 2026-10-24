'use client';

import Link from 'next/link';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface ToastAction {
  label: string;
  onAction: () => void | Promise<void>;
}

export interface ToastInput {
  message: string;
  action?: ToastAction;
  /** Optional quiet link (e.g. "View" the collection something was saved to). */
  link?: { href: string; label: string };
  /** ms before auto-dismiss (default 6000; paused while hovered or focused). */
  duration?: number;
}

interface ToastState extends ToastInput {
  id: number;
}

interface ToastContextValue {
  show: (t: ToastInput) => void;
  /** Polite screen-reader announcement without a visible toast. */
  announce: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Brief confirmations ("Saved to Slow Sunday" + Undo). Announced politely
 * through a persistent live region so screen readers hear saves without the feed.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const timer = useRef<number | null>(null);
  const paused = useRef(false);
  const seq = useRef(0);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const arm = useCallback(
    (duration: number) => {
      clear();
      timer.current = window.setTimeout(() => {
        if (!paused.current) setToast(null);
      }, duration);
    },
    [clear],
  );

  const show = useCallback(
    (t: ToastInput) => {
      seq.current += 1;
      setToast({ ...t, id: seq.current });
      setAnnouncement(t.message);
      arm(t.duration ?? 6000);
    },
    [arm],
  );

  const announce = useCallback((message: string) => {
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(message), 50);
  }, []);

  useEffect(() => clear, [clear]);

  const value = useMemo(() => ({ show, announce }), [show, announce]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {toast && (
        <div
          className="toast"
          key={toast.id}
          onMouseEnter={() => (paused.current = true)}
          onMouseLeave={() => {
            paused.current = false;
            arm(3000);
          }}
          onFocus={() => (paused.current = true)}
          onBlur={() => {
            paused.current = false;
            arm(3000);
          }}
        >
          <span className="toast__message">{toast.message}</span>
          {toast.link && (
            <Link
              href={toast.link.href}
              className="toast__link"
              onClick={() => {
                setToast(null);
                clear();
              }}
            >
              {toast.link.label}
            </Link>
          )}
          {toast.action && (
            <button
              type="button"
              className="toast__action"
              onClick={async () => {
                const action = toast.action!;
                setToast(null);
                clear();
                await action.onAction();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
