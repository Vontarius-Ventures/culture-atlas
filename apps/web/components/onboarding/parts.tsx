'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Category } from '@culture-atlas/domain';
import type { OnboardingSearchResult } from '@culture-atlas/domain/schemas';
import { api, ApiError } from '@/lib/client/api';
import { exclusionLabel, normalizeExclusion, toggleExclusion } from '@/lib/client/onboarding';
import { Icon } from '../Icon';
import { COPY } from '../v2/copy';

/** A pick chip: a real toggle button; selected = olive surface plus a check, never color alone. */
export function PickPill({
  pressed,
  onToggle,
  children,
  disabled,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="pill pick-pill"
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onToggle();
      }}
    >
      <Icon name="check" size={16} className="pick-pill__check" />
      {children}
    </button>
  );
}

export function InfoNotice({ children }: { children: ReactNode }) {
  return (
    <p className="onb-notice" role="status">
      <InfoIcon />
      <span>{children}</span>
    </p>
  );
}

function InfoIcon() {
  return (
    <svg
      className="icon"
      width={20}
      height={20}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5M10 6.5v.01" />
    </svg>
  );
}

export function ClockIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.5 1.5" />
    </svg>
  );
}

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; results: OnboardingSearchResult[] }
  | { status: 'unavailable' };

/**
 * Live Qloo entity search ("Add an artist, film, brand or place"). Results
 * show name and type only and are toggle buttons; adding sends only the
 * server-signed `result_id`, so a client can never submit its own Qloo id.
 * Qloo down: "Search is taking a break. Pick from the ideas above."
 */
export function SearchPicker({
  label,
  labelClassName,
  placeholder,
  category,
  isAdded,
  onToggle,
  forceUnavailable,
}: {
  label: string;
  labelClassName: string;
  placeholder: string;
  category?: Category;
  /** Whether this result is already one of the person's picks. */
  isAdded: (r: OnboardingSearchResult) => boolean;
  onToggle: (r: OnboardingSearchResult, added: boolean) => Promise<void>;
  forceUnavailable?: boolean;
}) {
  const inputId = useId();
  const listId = useId();
  const [q, setQ] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    const mine = ++seq.current;
    if (term.length < 2) {
      const t = window.setTimeout(() => {
        if (mine === seq.current) setState({ status: 'idle' });
      }, 0);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(async () => {
      setState({ status: 'loading' });
      try {
        const res = await api.request('searchOnboarding', { query: { q: term, category } });
        if (mine !== seq.current) return;
        setState(
          res.status === 'ok' ? { status: 'ok', results: res.results } : { status: 'unavailable' },
        );
      } catch (err) {
        if (mine !== seq.current) return;
        // Throttled or down: the catalog above still completes onboarding.
        setState(
          err instanceof ApiError && err.status === 400
            ? { status: 'idle' }
            : { status: 'unavailable' },
        );
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [q, category]);

  const unavailable = forceUnavailable || state.status === 'unavailable';
  const results = state.status === 'ok' ? state.results : [];
  return (
    <>
      <label className={labelClassName} htmlFor={inputId}>
        {label}
      </label>
      <div className="onb-search">
        <Icon name="search" />
        <input
          className="input onb-input"
          id={inputId}
          type="search"
          value={q}
          placeholder={placeholder}
          autoComplete="off"
          aria-controls={results.length ? listId : undefined}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {unavailable ? (
        <InfoNotice>{COPY['onboarding.search.unavailable']}</InfoNotice>
      ) : results.length > 0 ? (
        <ul className="search-results" id={listId} aria-label="Search results">
          {results.map((r) => {
            const added = isAdded(r);
            return (
              <li key={r.result_id}>
                <button
                  type="button"
                  className="search-result"
                  aria-pressed={added}
                  aria-busy={busy === r.result_id || undefined}
                  onClick={async () => {
                    if (busy) return;
                    setBusy(r.result_id);
                    try {
                      await onToggle(r, added);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <span className="search-result__name">{r.name}</span>
                  <span className="search-result__type">{r.type_label}</span>
                  <span className="search-result__mark">
                    {added ? (
                      <>
                        <Icon name="check" size={18} />
                        {COPY['onboarding.search.added']}
                      </>
                    ) : (
                      <>
                        <Icon name="plus" size={18} />
                        {COPY['onboarding.search.add']}
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : state.status === 'ok' && q.trim().length >= 2 ? (
        <p className="visually-hidden" role="status">
          0 results
        </p>
      ) : null}
    </>
  );
}

/**
 * Food exclusions: the plan-constraint suggestions plus free text. They are
 * preferences, not taste, and never count as picks.
 */
export function ExclusionsEditor({
  suggestions,
  value,
  onChange,
}: {
  suggestions: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const otherId = useId();
  const [other, setOther] = useState('');
  const custom = value.filter((v) => !suggestions.some((s) => s.toLowerCase() === v.toLowerCase()));
  const has = (term: string) => value.some((v) => v.toLowerCase() === term.toLowerCase());
  return (
    <>
      <div className="pill-row" role="group" aria-label="Foods to leave out">
        {[...suggestions, ...custom].map((term) => (
          <PickPill
            key={term}
            pressed={has(term)}
            onToggle={() => onChange(toggleExclusion(value, term))}
          >
            {exclusionLabel(term)}
          </PickPill>
        ))}
      </div>
      <form
        className="exclusion-other"
        onSubmit={(e) => {
          e.preventDefault();
          const term = normalizeExclusion(other, value);
          if (term) onChange(toggleExclusion(value, term));
          setOther('');
        }}
      >
        <label className="visually-hidden" htmlFor={otherId}>
          Something else to leave out
        </label>
        <input
          className="input onb-input"
          id={otherId}
          value={other}
          maxLength={40}
          placeholder={COPY['onboarding.exclusions.other']}
          autoComplete="off"
          onChange={(e) => setOther(e.target.value)}
        />
        <button type="submit" className="button button--outline">
          {COPY['onboarding.search.add']}
        </button>
      </form>
    </>
  );
}
