'use client';

import { useId, useState } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { Dialog } from '../Dialog';
import { STYLE_COPY } from '@/lib/client/style';

export const CITY_MAX = 80;

/**
 * One-field sheet behind "Add city" (C.6): PUT /v1/me/city with the city the
 * person types. It is the only place a city comes from (no EXIF, no IP lookup),
 * and it travels in the JSON body, never in a URL.
 */
export function CitySheet({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (city: string) => void;
}) {
  const [city, setCity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const value = city.trim();
  return (
    <Dialog open={open} onClose={onClose} title={STYLE_COPY['style.add_city']} size="small">
      <form
        className="city-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!value) return;
          setBusy(true);
          setError(null);
          try {
            await api.request('setCity', {
              body: { city: value },
              idempotencyKey: newIdempotencyKey(),
            });
            onSaved(value);
            setCity('');
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'That didn’t work. Try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="field-help">{STYLE_COPY['style.no_city']}</p>
        <label htmlFor={id} className="field-label">
          City
        </label>
        <input
          id={id}
          className="input"
          data-autofocus
          autoComplete="address-level2"
          value={city}
          maxLength={CITY_MAX}
          onChange={(e) => setCity(e.target.value)}
          placeholder="Los Angeles, CA"
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="button button--primary" disabled={busy || !value}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="button button--text" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
