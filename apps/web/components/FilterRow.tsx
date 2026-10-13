'use client';

/**
 * FilterRow: All plus only the supported filters. Implemented as a group of
 * toggle buttons (aria-pressed) so it never steals arrow keys; scrolls
 * horizontally on mobile without scrolling the page.
 */
export function FilterRow<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T | null) => void;
  label: string;
}) {
  return (
    <div className="filter-row" role="group" aria-label={label}>
      <button
        type="button"
        className="pill"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
      >
        All
      </button>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="pill"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
