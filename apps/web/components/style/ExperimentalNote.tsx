'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { STYLE_COPY } from '@/lib/client/style';

/**
 * The "Experimental" badge as a button that opens the plain note (D.4 / F.1 §2).
 * Escape and outside clicks close the note; focus stays on the badge.
 */
export function ExperimentalNote({
  label = STYLE_COPY['experimental.badge'],
  note = STYLE_COPY['experimental.note'],
  align = 'start',
}: {
  label?: string;
  note?: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
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
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="experimental-note" ref={root}>
      <button
        ref={button}
        type="button"
        className="experimental-note__badge"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      <span
        id={id}
        role="note"
        className={`experimental-note__popover experimental-note__popover--${align}`}
        hidden={!open}
      >
        {note}
      </span>
    </span>
  );
}
