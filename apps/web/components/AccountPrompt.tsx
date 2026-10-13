'use client';

import { useId, useState } from 'react';
import type { CreateAccountRequest } from '@culture-atlas/domain/schemas';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';

export interface AccountPromptProps {
  /** Short lead sentence for the context ("Create an account to keep collections."). */
  lead?: string;
  pendingSave?: CreateAccountRequest['pending_save'];
  onCreated: (result: { claimedSaved: number }) => void;
  /** Optional secondary action (e.g. "Save for this visit"). */
  secondary?: { label: string; onClick: () => void; busy?: boolean };
  compact?: boolean;
}

/**
 * Account creation that claims the current anonymous session (captures and the
 * intended save come along). Shown when saving persistently, creating a
 * collection or connecting an agent; never required for browsing or examples.
 */
export function AccountPrompt({
  lead,
  pendingSave,
  onCreated,
  secondary,
  compact,
}: AccountPromptProps) {
  const nameId = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.request('createAccount', {
        body: {
          display_name: name.trim() || undefined,
          claim_session: true,
          pending_save: pendingSave,
        },
        idempotencyKey: newIdempotencyKey(),
      });
      await api.refreshSession();
      onCreated({ claimedSaved: res.claimed.saved_items });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`account-prompt${compact ? ' account-prompt--compact' : ''}`}>
      <p className="account-prompt__lead">
        {lead ?? 'Create an account to keep your saves and build private collections.'}
      </p>
      <p className="account-prompt__note">
        Photos and saves from this visit come with you. Without an account they expire after 24
        hours.
      </p>
      <form
        className="account-prompt__form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label htmlFor={nameId} className="field-label">
          Your name <span className="field-optional">(optional)</span>
        </label>
        <input
          id={nameId}
          className="input"
          value={name}
          maxLength={80}
          autoComplete="name"
          onChange={(e) => setName(e.target.value)}
          data-autofocus
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="account-prompt__actions">
          <button type="submit" className="button button--primary button--wide" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
          {secondary && (
            <button
              type="button"
              className="button button--quiet button--wide"
              onClick={secondary.onClick}
              disabled={busy || secondary.busy}
            >
              {secondary.label}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
