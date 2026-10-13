'use client';

import { forwardRef } from 'react';
import { UI_LIMITS } from '@/lib/client/limits';

/**
 * Compact selection bar, shown only after something is selected. Contains the
 * count and "Make a movie night" (enabled for 2–5 items). The page reserves
 * space for it so it never covers cards or the mobile bottom navigation.
 */
export const SelectionBar = forwardRef<
  HTMLButtonElement,
  { count: number; onMake: () => void; onClear: () => void }
>(function SelectionBar({ count, onMake, onClear }, ref) {
  if (count === 0) return null;
  const ready = count >= UI_LIMITS.planMinItems && count <= UI_LIMITS.planMaxItems;
  return (
    <div className="selection-bar" role="region" aria-label="Selection">
      <p className="selection-bar__count" aria-live="polite">
        {count} selected
      </p>
      <button type="button" className="button button--text selection-bar__clear" onClick={onClear}>
        Clear
      </button>
      <button
        ref={ref}
        type="button"
        className="button button--primary"
        onClick={onMake}
        disabled={!ready}
        aria-describedby={ready ? undefined : 'selection-hint'}
      >
        Make a movie night
      </button>
      {!ready && (
        <p id="selection-hint" className="selection-bar__hint">
          Select {UI_LIMITS.planMinItems} to {UI_LIMITS.planMaxItems} items
        </p>
      )}
    </div>
  );
});
